"""
ORIS — procedural tactical-HUD animation engine.

Everything is drawn from code: no After Effects, no stock footage.
A scene file (see scene_demo.py) describes shots on a timeline; this module
renders them frame by frame and pipes the frames into ffmpeg.

Needs: Python 3.9+, numpy, Pillow, and ffmpeg on PATH. With moderngl and an OpenGL 3.3 GPU the per-pixel passes
run as shaders (oris_gpu.py, shaders/); without, the numpy code below does the same work on the CPU.

Coordinates
  world  : the map plane, 0..1 on both axes (textures cover exactly this square)
  design : the screen, always 1920x1080 regardless of output size
"""
import argparse
import importlib.util
import math
import os
import subprocess
import sys
import time
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import oris_gpu

FROZEN = getattr(sys, "frozen", False)           # running inside ORIS.exe
HERE = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
RES = getattr(sys, "_MEIPASS", HERE)               # files bundled inside ORIS.exe (fonts, pick.html)
CACHE = os.environ.get("ORIS_CACHE") or os.path.join(HERE, "cache")        # ORIS.exe keeps it in app data
RENDERS = os.environ.get("ORIS_RENDERS") or os.path.join(HERE, "renders")  # ORIS.exe uses Videos\\ORIS


def ffmpeg_exe():
    """FFmpeg to use: $ORIS_FFMPEG, the copy bundled with imageio-ffmpeg (ORIS.exe ships it), or ffmpeg on PATH."""
    if os.environ.get("ORIS_FFMPEG"):
        return os.environ["ORIS_FFMPEG"]
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def video_codec(H):
    """Encoder settings: NVIDIA's hardware H.264 encoder when it works here, else libx264 (as before).
    NVENC constant-quality 19 (1080p) / 17 (smaller) measured to match libx264 veryfast CRF 19 on ORIS footage
    (SSIM and PSNR against a lossless render, at about the same file size). ORIS_ENCODER=libx264 forces x264."""
    x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"]
    if os.environ.get("ORIS_ENCODER", "").lower() in ("libx264", "x264", "cpu"):
        return "libx264", x264
    nv = ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19" if H >= 1080 else "17",
          "-b:v", "0", "-maxrate", "200M", "-bufsize", "400M", "-spatial-aq", "1", "-temporal-aq", "1",
          "-bf", "3", "-b_ref_mode", "middle", "-rc-lookahead", "20", "-profile:v", "high"]
    try:  # a short test encode: is there an NVIDIA GPU, a new enough driver, and an ffmpeg built with NVENC?
        r = subprocess.run([ffmpeg_exe(), "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x144:r=30", "-frames:v", "4"]
                           + nv + ["-pix_fmt", "yuv420p", "-f", "null", "-"], capture_output=True, timeout=30,
                           creationflags=0x08000000 if os.name == "nt" else 0)
        if r.returncode == 0:
            return "h264_nvenc", nv
    except (OSError, subprocess.SubprocessError):
        pass
    return "libx264", x264
DW, DH = 1920, 1080

# ─────────────────────────── palette ───────────────────────────
def hexc(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)

MARK = "⊙ℝ⥍§"             # the ORIS glyph mark
GLYPH_SCRAMBLE = "⊕⊗⊘⊚⊛⊜⊝ℤℚℂℕℙ⥊⥋⥌⥎⥏∮∯∰¶†‡※⌬⍟◬◈◇◆"
INK = hexc("#d9e0da")     # HUD white-grey
DIM = hexc("#7d8882")
ACC = hexc("#f4dd55")     # warning yellow
PALE = hexc("#efe6b4")    # pale scan light
RED = hexc("#ea4259")
PINK = hexc("#ff9aa8")
DARK = hexc("#0b0e0d")
MAP_TINT = hexc("#cdd6d1")

# ─────────────────────────── time helpers ───────────────────────────
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x

EASE = {
    "linear": lambda x: x,
    "in": lambda x: x * x * x,
    "out": lambda x: 1 - (1 - x) ** 3,
    "inout": lambda x: 4 * x ** 3 if x < .5 else 1 - (-2 * x + 2) ** 3 / 2,
    "expo": lambda x: 1.0 if x >= 1 else 1 - 2 ** (-10 * x),
    "hold": lambda x: 0.0,
}

def lerp(a, b, u):
    if isinstance(a, (tuple, list, np.ndarray)):
        return type(a)(x + (y - x) * u for x, y in zip(a, b)) if not isinstance(a, np.ndarray) else a + (b - a) * u
    return a + (b - a) * u

def ramp(t, t0, t1, ease="inout"):
    """0 before t0, 1 after t1, eased in between."""
    if t1 <= t0:
        return float(t >= t0)
    return EASE[ease](clamp((t - t0) / (t1 - t0)))

def win(t, t_in, t_out, fade=0.3, ease="inout"):
    """Fades in at t_in, out at t_out."""
    return ramp(t, t_in, t_in + fade, ease) * (1 - ramp(t, t_out - fade, t_out, ease))

def key(t, keys):
    """Keyframes: [(time, value), (time, value, 'ease into this key'), ...]."""
    if t <= keys[0][0]:
        return keys[0][1]
    for k0, k1 in zip(keys, keys[1:]):
        if t <= k1[0]:
            e = EASE[k1[2] if len(k1) > 2 else "inout"]
            return lerp(k0[1], k1[1], e((t - k0[0]) / (k1[0] - k0[0])))
    return keys[-1][1]

def hsh(*v):
    """Deterministic pseudo-random 0..1 from any numbers (same input, same output)."""
    x = math.sin(sum(float(a) * (12.9898 + i * 78.233) for i, a in enumerate(v)) + 0.5) * 43758.5453
    return x - math.floor(x)

SCRAMBLE = "#%&@$*+=/<>0123456789ABCDEFXZ"

def typed(s, t, t0, cps=24):
    """Type-on text with a scrambling lead character."""
    n = int(clamp((t - t0) * cps, 0, len(s)))
    if n >= len(s):
        return s
    if t < t0:
        return ""
    return s[:n] + SCRAMBLE[int(hsh(t * 30, n) * len(SCRAMBLE))]

# ─────────────────────────── fonts ───────────────────────────
FONTS = {
    "mono": ["fonts/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
             "C:/Windows/Fonts/consola.ttf", "/System/Library/Fonts/Menlo.ttc"],
    "monob": ["fonts/DejaVuSansMono-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
              "C:/Windows/Fonts/consolab.ttf"],
    "thin": ["fonts/DejaVuSans-ExtraLight.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-ExtraLight.ttf",
             "C:/Windows/Fonts/segoeuil.ttf"],
    "glyph": ["fonts/FreeMono.ttf", "/usr/share/fonts/truetype/freefont/FreeMono.ttf"],
    "bold": ["fonts/DejaVuSansCondensed-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
             "C:/Windows/Fonts/arialbd.ttf"],
}

@lru_cache(maxsize=256)
def font(kind, px):
    px = max(6, int(round(px)))
    for p in FONTS.get(kind, FONTS["mono"]):
        paths = [p] if os.path.isabs(p) or ":" in p else [os.path.join(HERE, p), os.path.join(RES, p)]
        for path in paths:
            if os.path.exists(path):
                return ImageFont.truetype(path, px)
    return ImageFont.load_default(size=px)

# ─────────────────────────── procedural textures ───────────────────────────
def _noise(n, cells, rng):
    a = rng.random((cells + 3, cells + 3), dtype=np.float32)
    return np.asarray(Image.fromarray(a).resize((n, n), Image.BICUBIC, box=(1, 1, cells + 1, cells + 1)), np.float32)

def fbm(n, base, octaves, seed, gain=0.5):
    """Fractal noise, normalized 0..1."""
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n), np.float32)
    amp = tot = 0.0
    amp = 1.0
    for i in range(octaves):
        cells = base * 2 ** i
        if cells > n // 2:
            break
        out += amp * _noise(n, cells, rng)
        tot += amp
        amp *= gain
    out /= tot
    lo, hi = np.percentile(out[::4, ::4], (1, 99))
    return np.clip((out - lo) / (hi - lo + 1e-6), 0, 1)

def _to_img(a):
    return Image.fromarray(np.clip(a * 255 + .5, 0, 255).astype(np.uint8))

def _walk(draw, rng, n, start, steps, step, turn, width, val, ang=None, bias=None):
    x, y = start
    a = rng.uniform(0, 2 * math.pi) if ang is None else ang
    pts = [(x, y)]
    for _ in range(steps):
        a += rng.normal(0, turn)
        if bias is not None:  # pull heading outward from a point
            ba = math.atan2(y - bias[1], x - bias[0])
            a += 0.08 * math.sin(ba - a)
        x += math.cos(a) * step
        y += math.sin(a) * step
        pts.append((x, y))
        if not (-50 < x < n + 50 and -50 < y < n + 50):
            break
    draw.line(pts, fill=val, width=width, joint="curve")

def build_terrain(n=2560, seed=7, center=(0.515, 0.49)):
    """Mountain terrain: hillshade + roads + town lights, plus a contour-line layer."""
    rng = np.random.default_rng(seed + 3)
    h = 0.5 * fbm(n, 2, 9, seed, gain=0.47)
    r = fbm(n, 3, 8, seed + 1, gain=0.45)
    ridge = (1 - np.abs(2 * r - 1)) ** 2.4
    del r
    m = fbm(n, 2, 3, seed + 2)
    h += 0.55 * ridge * (0.3 + 0.9 * m)
    del ridge, m
    g = (np.arange(n, dtype=np.float32) + .5) / n
    dc = np.hypot(g[None, :] - center[0], g[:, None] - center[1])
    basin = np.exp(-(dc / 0.11) ** 2)
    h = h * (1 - 0.35 * basin) + 0.08 * basin
    gy, gx = np.gradient(h)
    k = n * 0.9
    L = np.array([-0.55, -0.65, 0.52], np.float32)
    L /= np.linalg.norm(L)
    shade = np.clip((-gx * k * L[0] - gy * k * L[1] + L[2]) / np.sqrt((gx * k) ** 2 + (gy * k) ** 2 + 1), 0, 1)
    lum = 0.02 + 0.9 * shade ** 1.8 * (0.18 + 0.82 * h ** 1.2)
    del shade
    # contour lines (anti-aliased, every 4th line brighter)
    lv = h * 46
    fr = lv % 1
    gm = np.hypot(gx, gy) * 46
    con = np.clip(1.25 - np.minimum(fr, 1 - fr) / np.maximum(gm, 1e-5), 0, 1)
    con *= 0.5 + 0.5 * (np.floor(lv) % 4 == 0)
    del lv, fr, gm, gx, gy
    # roads and rivers
    roads = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(roads)
    s = n / 2560
    c = (center[0] * n, center[1] * n)
    for _ in range(3):
        _walk(d, rng, n, (rng.uniform(0, n), -40), 900, 7 * s, 0.12, max(1, int(3 * s)), 70, ang=math.pi / 2)
    for _ in range(26):
        st = (c[0] + rng.normal(0, 40 * s), c[1] + rng.normal(0, 40 * s))
        _walk(d, rng, n, st, int(rng.uniform(120, 520)), 5 * s, 0.16, max(1, int(rng.choice([1, 1, 2]) * s)),
              int(rng.uniform(80, 170)), bias=c)
    for _ in range(70):
        st = (rng.uniform(0, n), rng.uniform(0, n))
        _walk(d, rng, n, st, int(rng.uniform(40, 220)), 5 * s, 0.2, 1, int(rng.uniform(50, 120)))
    road = np.asarray(roads.filter(ImageFilter.GaussianBlur(0.6 * s)), np.float32) / 255
    near = np.exp(-(dc / 0.22) ** 2)
    lum += road * (0.22 + 0.3 * near)
    del road
    sp = fbm(n, 90, 3, seed + 4)
    lum += np.clip((sp - 0.55) * 3, 0, 1) * np.exp(-(dc / 0.07) ** 2) * 0.22
    return {"map": _to_img(lum), "contours": _to_img(con)}

def build_city(n=2048, seed=11):
    """Top-down city block map: districts, buildings, ring road, river."""
    rng = np.random.default_rng(seed)
    base = fbm(n, 6, 7, seed)
    img = _to_img(0.09 + 0.10 * base)
    d = ImageDraw.Draw(img)
    cen = rng.random((16, 2)) * n
    ang = rng.uniform(0, math.pi / 2, 16)
    bsz = rng.uniform(30, 58, 16) * n / 2048
    lab = np.zeros((128, 128), np.int32)
    gg = (np.arange(128) + .5) * n / 128
    best = np.full((128, 128), 1e18)
    for i, (cx, cy) in enumerate(cen):
        dd = (gg[None, :] - cx) ** 2 + (gg[:, None] - cy) ** 2
        lab = np.where(dd < best, i, lab)
        best = np.minimum(best, dd)
    mid = n / 2
    for i in range(16):
        ca, sa, b = math.cos(ang[i]), math.sin(ang[i]), bsz[i]
        street = b * rng.uniform(0.12, 0.2)
        span = int(n * 0.8 / b)
        for gi in range(-span, span):
            for gj in range(-span, span):
                u, v = gi * b, gj * b
                bx, by = cen[i][0] + u * ca - v * sa, cen[i][1] + u * sa + v * ca
                if not (0 <= bx < n and 0 <= by < n) or lab[int(by * 128 / n), int(bx * 128 / n)] != i:
                    continue
                def q(px, py, ox=0, oy=0):
                    return (bx + px * ca - py * sa + ox, by + px * sa + py * ca + oy)
                hw = (b - street) / 2
                park = rng.random() < 0.08
                d.polygon([q(-hw, -hw), q(hw, -hw), q(hw, hw), q(-hw, hw)], fill=int(36 if park else rng.uniform(52, 78)))
                if park:
                    continue
                for _ in range(int(rng.uniform(3, 9))):
                    w2, h2 = rng.uniform(.12, .45) * hw, rng.uniform(.12, .45) * hw
                    px, py = rng.uniform(-hw + w2, hw - w2), rng.uniform(-hw + h2, hw - h2)
                    sh = rng.uniform(1.5, 4) * n / 2048
                    d.polygon([q(px - w2, py - h2, sh, sh), q(px + w2, py - h2, sh, sh), q(px + w2, py + h2, sh, sh),
                               q(px - w2, py + h2, sh, sh)], fill=14)
                    d.polygon([q(px - w2, py - h2), q(px + w2, py - h2), q(px + w2, py + h2), q(px - w2, py + h2)],
                              fill=int(rng.uniform(60, 135)))
    # river
    pts = [(-60, n * .78)]
    for k in range(1, 40):
        x = k * n / 36
        pts.append((x, n * (.78 + .07 * math.sin(k * .35) - .1 * k / 40)))
    d.line(pts, fill=95, width=int(78 * n / 2048), joint="curve")
    d.line(pts, fill=16, width=int(66 * n / 2048), joint="curve")
    # ring roads and radials
    for R, w, val in ((0.36, 12, 125), (0.19, 8, 110)):
        ph = rng.uniform(0, 6.28)
        ring = [(mid + n * R * (1 + .07 * math.sin(3 * a + ph) + .04 * math.sin(5 * a)) * math.cos(a),
                 mid + n * R * (1 + .07 * math.sin(3 * a + ph) + .04 * math.sin(5 * a)) * math.sin(a))
                for a in np.linspace(0, 2 * math.pi, 400)]
        d.line(ring, fill=val, width=int(w * n / 2048), joint="curve")
    for k in range(8):
        a = k * math.pi / 4 + rng.uniform(-.2, .2)
        pts = [(mid + math.cos(a + .15 * math.sin(r * 4)) * r * n, mid + math.sin(a + .15 * math.sin(r * 4)) * r * n)
               for r in np.linspace(0.04, 0.8, 60)]
        d.line(pts, fill=100, width=int(7 * n / 2048), joint="curve")
    a = np.asarray(img, np.float32) / 255
    relief = fbm(n, 3, 6, seed + 5)
    gy, gx = np.gradient(relief)
    a *= 0.8 + 0.5 * np.clip(0.5 - (gx + gy) * n * 0.6, 0, 1)
    a *= 0.85 + 0.3 * fbm(n, 120, 3, seed + 6)
    return {"map": _to_img(np.clip(a, 0, 1))}

def build_clouds(n=1024, seed=21):
    return {"noise": _to_img(fbm(n, 4, 8, seed, gain=0.55))}

# ─────────────────────────── camera ───────────────────────────
def _T(x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1]], np.float64)

class Cam:
    """2.5D camera over the world plane.
    center: world point at screen center, span: world width visible across the screen,
    rot: radians, tilt: 0 (top-down) .. 0.7 (strong perspective)."""

    def __init__(self, center=(0.5, 0.5), span=1.0, rot=0.0, tilt=0.0):
        self.center, self.span, self.rot, self.tilt = center, span, rot, min(tilt, 0.75)

    def H(self):
        s = DW / self.span
        c, sn = math.cos(self.rot), math.sin(self.rot)
        A = np.array([[s * c, -s * sn, 0], [s * sn, s * c, 0], [0, 0, 1]]) @ _T(-self.center[0], -self.center[1])
        k = -self.tilt * 1.3 / DH
        P = np.array([[1, 0, 0], [0, 1 - 0.25 * self.tilt, 0], [0, k, 1]])
        return _T(DW / 2, DH / 2 + self.tilt * 50) @ P @ A

    def proj(self, pts):
        """World points (N,2) → design-px points (N,2)."""
        p = np.asarray(pts, np.float64).reshape(-1, 2)
        q = np.c_[p, np.ones(len(p))] @ self.H().T
        return q[:, :2] / q[:, 2:3]

    def pt(self, p):
        x, y = self.proj([p])[0]
        return (float(x), float(y))

class CamPath:
    """Camera keyframes: (time, center, span, rot, tilt, ease). Zoom is interpolated in log space,
    so a 100x zoom feels as steady as a 2x one."""

    def __init__(self):
        self.keys = []

    def add(self, t, center, span, rot=0.0, tilt=0.3, ease="inout"):
        self.keys.append((t, center, span, rot, tilt, ease))
        return self

    def at(self, t):
        k = self.keys
        if t <= k[0][0]:
            _, c, s, r, tl, _ = k[0]
            return Cam(c, s, r, tl)
        for k0, k1 in zip(k, k[1:]):
            if t <= k1[0]:
                u = EASE[k1[5]]((t - k0[0]) / max(1e-6, k1[0] - k0[0]))
                span = math.exp(math.log(k0[2]) + (math.log(k1[2]) - math.log(k0[2])) * u)
                # pan follows the zoom so the path doesn't swing wide when zooming far
                c = (k0[1][0] + (k1[1][0] - k0[1][0]) * u, k0[1][1] + (k1[1][1] - k0[1][1]) * u)
                return Cam(c, span, k0[3] + (k1[3] - k0[3]) * u, k0[4] + (k1[4] - k0[4]) * u)
        _, c, s, r, tl, _ = k[-1]
        return Cam(c, s, r, tl)


# ─────────────────────────── overlay (vector layer) ───────────────────────────
class Overlay:
    """Anti-aliased vector drawing in design px (premultiplied RGBA, supersampled)."""

    def __init__(self, eng):
        self.e = eng
        self.f = eng.W / DW * eng.ss
        self.buf = None
        size = (eng.W * eng.ss, eng.H * eng.ss)
        if eng.gpu and eng.shared_canvas:
            # GPU path: Pillow draws straight into a numpy buffer that goes to the GPU as is (no copy, no reduce)
            self.buf = np.zeros((size[1], size[0], 4), np.uint8)
            self.im = Image.frombuffer("RGBA", size, self.buf, "raw", "RGBA", 0, 1)
            self.im.readonly = 0
        else:
            self.im = Image.new("RGBA", size, (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)
        self.used = False

    def gpu_canvas(self):
        """(RGBA buffer, scale) for oris_gpu.GPU.overlay."""
        if self.buf is not None and self.e.ss in (1, 2):
            return self.buf, self.e.ss
        return self.reduced().tobytes(), 1

    def _c(self, col, a):
        a = clamp(float(a))
        return (int(col[0] * a * 255 + .5), int(col[1] * a * 255 + .5), int(col[2] * a * 255 + .5), int(a * 255 + .5))

    def _p(self, pts):
        return [(float(x) * self.f, float(y) * self.f) for x, y in pts]

    def _w(self, w):
        return max(1, int(round(w * self.f)))

    def line(self, pts, col=INK, a=1.0, w=1.0):
        if a <= 0.004 or len(pts) < 2:
            return
        self.used = True
        self.d.line(self._p(pts), fill=self._c(col, a), width=self._w(w), joint="curve" if len(pts) > 2 else None)

    def dashed(self, pts, col=INK, a=1.0, w=1.0, dash=10, gap=7, phase=0.0):
        if a <= 0.004:
            return
        P = np.asarray(pts, np.float64).reshape(-1, 2)
        if len(P) < 2:
            return
        seglen = np.hypot(*(P[1:] - P[:-1]).T)
        cum = np.r_[0, np.cumsum(seglen)]
        total = cum[-1]
        period = max(dash + gap, 1e-3)
        if total <= 0 or total / period > 20000:
            return

        def at(d):
            i = min(max(int(np.searchsorted(cum, d, "right")) - 1, 0), len(seglen) - 1)
            u = 0.0 if seglen[i] == 0 else (d - cum[i]) / seglen[i]
            return P[i] + (P[i + 1] - P[i]) * u, i

        start = (phase % period) - period
        d0 = start
        while d0 < total:
            a0, a1 = max(d0, 0.0), min(d0 + dash, total)
            if a1 > a0:
                p0, i0 = at(a0)
                p1, i1 = at(a1)
                self.line([tuple(p0)] + [tuple(P[j]) for j in range(i0 + 1, i1 + 1)] + [tuple(p1)], col, a, w)
            d0 += period

    def poly(self, pts, col=INK, a=1.0, fill=True, w=1.0):
        if a <= 0.004:
            return
        self.used = True
        if fill:
            self.d.polygon(self._p(pts), fill=self._c(col, a))
        else:
            self.d.polygon(self._p(pts), outline=self._c(col, a), width=self._w(w))

    def rect(self, x, y, w, h, col=INK, a=1.0, fill=False, lw=1.0):
        if a <= 0.004:
            return
        self.used = True
        box = [x * self.f, y * self.f, (x + w) * self.f, (y + h) * self.f]
        if fill:
            self.d.rectangle(box, fill=self._c(col, a))
        else:
            self.d.rectangle(box, outline=self._c(col, a), width=self._w(lw))

    def circle(self, c, r, col=INK, a=1.0, w=1.0, fill=False):
        if a <= 0.004:
            return
        self.used = True
        box = [(c[0] - r) * self.f, (c[1] - r) * self.f, (c[0] + r) * self.f, (c[1] + r) * self.f]
        if fill:
            self.d.ellipse(box, fill=self._c(col, a))
        else:
            self.d.ellipse(box, outline=self._c(col, a), width=self._w(w))

    def pie(self, c, r, a0, a1, col=INK, a=1.0):
        if a <= 0.004:
            return
        self.used = True
        box = [(c[0] - r) * self.f, (c[1] - r) * self.f, (c[0] + r) * self.f, (c[1] + r) * self.f]
        self.d.pieslice(box, a0, a1, fill=self._c(col, a))

    def erase_circle(self, c, r):
        box = [(c[0] - r) * self.f, (c[1] - r) * self.f, (c[0] + r) * self.f, (c[1] + r) * self.f]
        self.d.ellipse(box, fill=(0, 0, 0, 0))

    def text(self, xy, s, col=INK, a=1.0, size=12, kind="mono", anchor="la", spacing=0.0):
        if a <= 0.004 or not s:
            return
        self.used = True
        fnt = font(kind, size * self.f)
        x, y = xy[0] * self.f, xy[1] * self.f
        if not spacing:
            self.d.text((x, y), s, fill=self._c(col, a), font=fnt, anchor=anchor)
            return
        total = self.text_w(s, size, kind, spacing) * self.f
        if anchor[0] == "r":
            x -= total
        elif anchor[0] == "m":
            x -= total / 2
        for ch in s:
            self.d.text((x, y), ch, fill=self._c(col, a), font=fnt, anchor="l" + anchor[1])
            x += fnt.getlength(ch) + spacing * self.f

    def image(self, gray, x, y, w, h, col=INK, a=1.0):
        """Place a grayscale array (0..1, any size) tinted with col; brightness = opacity (hologram look)."""
        if a <= 0.004:
            return
        self.used = True
        W, H = max(1, int(w * self.f)), max(1, int(h * self.f))
        g = np.asarray(Image.fromarray((np.clip(gray, 0, 1) * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR),
                       np.float32) / 255 * a
        rgba = np.dstack([g * col[0], g * col[1], g * col[2], g])
        self.im.paste(Image.fromarray((rgba * 255 + .5).astype(np.uint8), "RGBA"), (int(x * self.f), int(y * self.f)))

    def text_w(self, s, size=12, kind="mono", spacing=0.0):
        fnt = font(kind, size * self.f)
        return (fnt.getlength(s) + spacing * self.f * max(0, len(s) - 1)) / self.f

    def reduced(self):
        return self.im.reduce(self.e.ss) if self.e.ss > 1 else self.im

    def arrays(self):
        a = np.asarray(self.reduced(), np.float32) / 255
        return a[..., :3], a[..., 3:4]

# ─────────────────────────── textures ───────────────────────────
class Tex:
    def __init__(self, img):
        self.levels = [img]
        while self.levels[-1].size[0] > 600:
            w = self.levels[-1].size[0] // 2
            self.levels.append(self.levels[-1].resize((w, w), Image.LANCZOS))

# ─────────────────────────── frame (compositor) ───────────────────────────
class Frame:
    def __init__(self, eng, t, f):
        self.e, self.t, self.f = eng, t, f
        self.g = eng.gpu           # GPU passes (oris_gpu.py), or None for the numpy path
        self._img = None if self.g else np.zeros((eng.H, eng.W, 3), np.float32)
        if self.g:
            self.g.clear()
        self.ov = Overlay(eng)     # world-space graphics: fogged and bloomed
        self.hud = Overlay(eng)    # screen chrome: always on top
        self.cam = None
        self._w = None
        self.glitch = 0.0
        self.fade = 1.0
        self.post = {}
        self.hud_alpha = 1.0     # HUD power-on
        self.reveal_y = 1.0      # boot scan line: map shown above this fraction of the screen
        self.scan_y = None       # bright scan line at this fraction of the screen height

    # the image: numpy array on the CPU path; on the GPU path it lives on the GPU and is only
    # copied over when a scene touches fr.img directly (then copied back before the next GPU pass)
    @property
    def img(self):
        if self._img is None:
            self._img = self.g.download()
        return self._img

    @img.setter
    def img(self, v):
        self._img = v

    def _gpu(self):
        g = self.g
        if g is not None and self._img is not None:
            g.upload(self._img)
            self._img = None
        return g

    def _cam_u(self):
        Hi = np.linalg.inv(self.Hr).astype(np.float32)
        return dict(uH0=tuple(map(float, Hi[0])), uH1=tuple(map(float, Hi[1])), uH2=tuple(map(float, Hi[2])))

    @staticmethod
    def _tu(c):
        """Pillow transform coefficients (6 affine or 8 perspective) as shader rows."""
        c = [float(v) for v in c]
        if len(c) == 6:
            c += [0.0, 0.0]
        return dict(uT0=(c[0], c[1], c[2]), uT1=(c[3], c[4], c[5]), uT2=(c[6], c[7], 1.0))

    # camera
    def set_cam(self, cam):
        self.cam = cam
        s = self.e.W / DW
        self.Hr = np.diag([s, s, 1.0]) @ cam.H()
        self._w = None

    def P(self, p):
        return self.cam.pt(p)

    def world(self):
        """Per-pixel world coordinates (wx, wy) for the current camera."""
        if self._w is None:
            Hi = np.linalg.inv(self.Hr).astype(np.float32)
            X, Y = self.e.X, self.e.Y
            den = Hi[2, 0] * X + Hi[2, 1] * Y + Hi[2, 2]
            self._w = ((Hi[0, 0] * X + Hi[0, 1] * Y + Hi[0, 2]) / den,
                       (Hi[1, 0] * X + Hi[1, 1] * Y + Hi[1, 2]) / den)
        return self._w

    def _view(self, tex, rect=None):
        """Mip level and Pillow PERSPECTIVE coefficients that show `tex` through the camera."""
        x0, y0, size = rect or (0.0, 0.0, 1.0)
        lvl = tex.levels[-1]
        for L in tex.levels:
            if L.size[0] * self.cam.span / (size * self.e.W) <= 1.5:
                lvl = L
                break
        n = lvl.size[0]
        inv = np.linalg.inv(self.Hr @ _T(x0, y0) @ np.diag([size / n, size / n, 1.0]))
        inv /= inv[2, 2]
        return lvl, tuple(inv.flatten()[:8])

    def _tex_u(self, tex, rect=None):
        lvl, co = self._view(tex, rect)
        return {"uTex": self.g.map_tex(lvl)}, self._tu(co)

    def sample(self, tex, rect=None):
        """The texture as seen through the camera (float HxW, 0..1).
        rect = (x0, y0, size): where the texture sits in world coords (default: the whole 0..1 square)."""
        lvl, co = self._view(tex, rect)
        out = lvl.transform((self.e.W, self.e.H), Image.PERSPECTIVE, co, Image.BILINEAR)
        return np.asarray(out, np.float32) / 255

    # map layers
    def map(self, tex, tint=MAP_TINT, gain=1.0, dots=0.18):
        if self.g:
            self._img = None   # replaced entirely
            t, u = self._tex_u(tex)
            self.g.step("map", t, uGain=float(gain), uDots=float(dots or 0.0), uTint=tuple(map(float, tint)), **u)
            return
        m = self.sample(tex) * gain
        if dots:
            m *= 1 - dots * (1 - self.e.dots)
        self.img = m[..., None] * tint

    def rect_mask(self, rect, feather=0.08):
        """1 inside a world rect, feathered to 0 at its edges."""
        x0, y0, size = rect
        wx, wy = self.world()
        u, v = (wx - x0) / size, (wy - y0) / size
        edge = np.minimum(np.minimum(u, 1 - u), np.minimum(v, 1 - v))
        return np.clip(edge / feather, 0, 1)

    def map_layers(self, layers, dots=0.18):
        """Several map textures placed in one world, coarse first, detail on top (feathered edges).
        layer = dict(tex=Tex, rect=(x0, y0, size) or None, a=opacity, tint=rgb, gain=float)"""
        if self.g:
            self._img = None
            g = self.g
            g.clear()
            cu = self._cam_u()
            for L in layers:
                a = L.get("a", 1.0)
                if a <= 0.003:
                    continue
                t, u = self._tex_u(L["tex"], L.get("rect"))
                rect = L.get("rect")
                g.step("layer", t, uGain=float(L.get("gain", 1.0)), uA=float(a), uHasRect=int(bool(rect)),
                       uRect=tuple(map(float, rect)) if rect else (0.0, 0.0, 1.0), uFeather=float(L.get("feather", .08)),
                       uTint=tuple(map(float, L.get("tint", MAP_TINT))), **u, **cu)
            if dots:
                g.step("dots", uDots=float(dots))
            return
        img = np.zeros((self.e.H, self.e.W, 3), np.float32)
        for L in layers:
            a = L.get("a", 1.0)
            if a <= 0.003:
                continue
            m = self.sample(L["tex"], L.get("rect")) * L.get("gain", 1.0)
            mask = a * (self.rect_mask(L["rect"], L.get("feather", .08)) if L.get("rect") else 1.0)
            if np.isscalar(mask):
                mask = np.full_like(m, mask)
            col = L.get("tint", MAP_TINT)
            img = img * (1 - mask[..., None]) + (m * mask)[..., None] * col
        if dots:
            img *= 1 - dots * (1 - self.e.dots)[..., None]
        self.img = img

    def footprint(self):
        """World coords of the screen corners (what the camera sees)."""
        if self._w is not None:
            wx, wy = self._w
            H, W = wx.shape
            return [(float(wx[j, i]), float(wy[j, i])) for j, i in ((0, 0), (0, W - 1), (H - 1, W - 1), (H - 1, 0))]
        # same float32 math as world(), just for the four corner pixels
        Hi = np.linalg.inv(self.Hr).astype(np.float32)
        W, H = self.e.W, self.e.H
        X = np.array([.5, W - .5, W - .5, .5], np.float32)
        Y = np.array([.5, .5, H - .5, H - .5], np.float32)
        den = Hi[2, 0] * X + Hi[2, 1] * Y + Hi[2, 2]
        wx = (Hi[0, 0] * X + Hi[0, 1] * Y + Hi[0, 2]) / den
        wy = (Hi[1, 0] * X + Hi[1, 1] * Y + Hi[1, 2]) / den
        return [(float(x), float(y)) for x, y in zip(wx, wy)]

    def light(self, center, sigma, amb=0.35, gain=1.4):
        if self._gpu():
            self.g.step("light", uC=tuple(map(float, center)), uSigma=float(sigma), uAmb=float(amb), uGainL=float(gain),
                        **self._cam_u())
            return
        wx, wy = self.world()
        d2 = ((wx - center[0]) ** 2 + (wy - center[1]) ** 2) / (sigma * sigma)
        self.img *= (amb + gain * np.exp(-d2))[..., None]

    def reveal(self, tex, center, radius, col=PALE, a=0.6, soft=0.015, rect=None):
        """Add a texture (e.g. contour lines) inside a world-space circle."""
        if radius <= 0 or a <= 0:
            return
        if self._gpu():
            t, u = self._tex_u(tex, rect)
            self.g.step("reveal", t, uHasRect=int(bool(rect)), uRect=tuple(map(float, rect)) if rect else (0.0, 0.0, 1.0),
                        uC=tuple(map(float, center)), uR=float(radius), uA=float(a), uSoft=float(soft),
                        uCol=tuple(map(float, col)), **u, **self._cam_u())
            return
        c = self.sample(tex, rect)
        if rect:
            c = c * self.rect_mask(rect)
        wx, wy = self.world()
        m = np.clip((radius - np.hypot(wx - center[0], wy - center[1])) / soft, 0, 1)
        self.img += (c * m * a)[..., None] * col

    def zone(self, center, R, col=RED, fill=0.5, soft_px=1.5):
        """Tinted disk on the map (keeps terrain detail visible)."""
        if R <= 0 or fill <= 0:
            return
        if self._gpu():
            self.g.step("zone", uC=tuple(map(float, center)), uR=float(R), uFill=float(fill),
                        uPpw=float(self.e.W / self.cam.span), uSoftPx=float(soft_px), uCol=tuple(map(float, col)),
                        **self._cam_u())
            return
        wx, wy = self.world()
        d = np.hypot(wx - center[0], wy - center[1])
        ppw = self.e.W / self.cam.span
        m = np.clip((R - d) * ppw / soft_px, 0, 1)
        k = (m * fill * (0.45 + 0.55 * np.clip(d / R, 0, 1) ** 4))[..., None]
        self.img = self.img * (1 - k) + k * col * (0.22 + 1.7 * self.img)

    def hazards(self, noise, emitters, col=ACC):
        """Clouds that bloom out of world points. emitter: dict(p=(x,y), t=start, r=radius, grow=seconds)."""
        live = [e for e in emitters if self.t > e["t"]]
        if not live:
            return
        if self._gpu():
            em = np.zeros((oris_gpu.MAX_EMITTERS, 3), np.float32)
            live = live[:oris_gpu.MAX_EMITTERS]
            for i, e in enumerate(live):
                g = ramp(self.t, e["t"], e["t"] + e.get("grow", 2.0), "out")
                em[i] = (e["p"][0], e["p"][1], max(e["r"] * g, 1e-4))
            t, u = self._tex_u(noise)
            self.g.step("hazards", t, uEm=em.tobytes(), uN=len(live), uCol=tuple(map(float, col)), **u, **self._cam_u())
            return
        wx, wy = self.world()
        N = self.sample(noise)
        A = np.zeros_like(wx)
        for e in live:
            g = ramp(self.t, e["t"], e["t"] + e.get("grow", 2.0), "out")
            r = max(e["r"] * g, 1e-4)
            fall = np.clip(1 - np.hypot(wx - e["p"][0], wy - e["p"][1]) / r, 0, 1)
            A = np.maximum(A, np.clip((fall * 1.25 + N * 1.0 - 1.05) * 1.7, 0, 1) * (0.55 + 0.45 * fall))
        k = A[..., None]
        speck = np.clip((N - .62) * 6, 0, 1)[..., None]
        self.img = self.img * (1 - 0.6 * k) + k * col * (0.25 + 0.95 * N[..., None]) * (1 - .5 * speck)

    def _polar(self, center):
        wx, wy = self.world()
        dx, dy = wx - center[0], wy - center[1]
        return np.hypot(dx, dy), np.arctan2(dy, dx)

    def wedge(self, center, R, ang, width=0.6, col=PALE, a=0.35):
        """Radar sweep: bright leading edge at angle `ang` (radians), fading trail behind it."""
        if a <= 0 or R <= 0:
            return
        if self._gpu():
            self.g.step("wedge", uC=tuple(map(float, center)), uR=float(R), uAng=float(ang), uWidth=float(width),
                        uA=float(a), uCol=tuple(map(float, col)), **self._cam_u())
            return
        d, th = self._polar(center)
        behind = (ang - th) % (2 * np.pi)
        trail = np.exp(-behind / width) * np.clip((R - d) / (R * .08), 0, 1)
        self.img += (trail * a)[..., None] * col * (0.35 + self.img)

    def reveal_swept(self, tex, center, R, a0, swept, col=PALE, a=0.5):
        """Reveal a texture (contours) in the wake of a sweep that started at a0 and has turned `swept` radians."""
        if swept <= 0 or a <= 0:
            return
        if self._gpu():
            t, u = self._tex_u(tex)
            self.g.step("reveal_swept", t, uC=tuple(map(float, center)), uR=float(R), uA0=float(a0), uSwept=float(swept),
                        uA=float(a), uCol=tuple(map(float, col)), **u, **self._cam_u())
            return
        c = self.sample(tex)
        d, th = self._polar(center)
        done = ((th - a0) % (2 * np.pi)) <= swept
        m = done * np.clip((R - d) / (R * .06), 0, 1)
        self.img += (c * m * a)[..., None] * col

    def clouds(self, strength=1.0, col=hexc("#1a1d1c"), reach=1.0):
        """Dark cloud banks creeping in from the screen edges."""
        if strength <= 0:
            return
        e = self.e
        cl = e.cloud.levels[0]
        n = cl.size[0]
        sc = n / (e.W * 1.6)
        co = (sc, 0, n * .1 + self.t * 4, 0, sc, n * .15)
        if self._gpu():
            self.g.step("clouds", {"uTex": self.g.map_tex(cl)}, uStrength=float(strength), uReach=float(reach),
                        uCol=tuple(map(float, col)), **self._tu(co))
            return
        C = np.asarray(cl.transform((e.W, e.H), Image.AFFINE, co, Image.BILINEAR), np.float32) / 255
        a = np.clip((C * .9 + e.edge * 1.25 * reach - 1.05) * 2.6, 0, 1)[..., None] * strength
        self.img = self.img * (1 - a) + a * col * (.6 + .8 * C[..., None])

    def tint(self, col, amount):
        if amount > 0 and self._gpu():
            self.g.step("tint", uCol=tuple(map(float, col)), uAmount=float(amount))
        elif amount > 0:
            self.img = self.img * (1 - amount) + self.img * col * amount * 1.4

    def fog(self, amount, zoom=1.0, drift=(0.0, 0.0), col=hexc("#c9cdcb")):
        """Screen-space cloud bank (fly-through transition)."""
        if amount <= 0:
            return
        W, H = self.e.W, self.e.H
        cl = self.e.cloud.levels[0]
        n = cl.size[0]
        sc = n / (W * 1.15) / zoom
        co = (sc, 0, n / 2 - sc * W / 2 + drift[0] * n, 0, sc, n / 2 - sc * H / 2 + drift[1] * n)
        if self._gpu():
            self.g.step("fog", {"uTex": self.g.map_tex(cl)}, uAmount=float(amount), uK=float(clamp(amount * 2.2)),
                        uCol=tuple(map(float, col)), **self._tu(co))
            return
        C = np.asarray(cl.transform((W, H), Image.AFFINE, co, Image.BILINEAR), np.float32) / 255
        a = np.clip((C - (1 - amount) * 1.05) * 3.0, 0, 1) * clamp(amount * 2.2)
        self.img = self.img * (1 - a[..., None]) + a[..., None] * col * (0.7 + 0.4 * C[..., None])

    # final
    def finish(self):
        if self._gpu():
            return self._finish_gpu()
        e = self.e
        img = self.img
        if self.ov.used:
            pm, a = self.ov.arrays()
            img = img * (1 - a) + pm
        img = bloom(img, e)
        if self.reveal_y < 1:
            edge = self.reveal_y * e.H
            m = np.clip((edge - e.Y[:, :1]) / (14 * e.s), 0, 1)[..., None]  # soft edge above the scan line
            img = img * m
        if self.scan_y is not None:
            d = np.abs(e.Y[:, :1] - self.scan_y * e.H) / e.s
            glow = (np.exp(-d / 1.2) * .9 + np.exp(-d / 18) * .18)[..., None]
            img = img + glow * PALE
        if self.hud.used and self.hud_alpha > 0:
            pm, a = self.hud.arrays()
            k = self.hud_alpha
            img = img * (1 - a * k) + pm * 0.95 * k
            img = bloom(img, e, thr=0.85, strength=0.25, radius=6)
        img *= e.vignette
        img *= 1 - 0.035 * hsh(self.f, 3)
        rng = np.random.default_rng(self.f + 99)
        img += (rng.standard_normal((e.H, e.W), dtype=np.float32) * 0.028)[..., None] * (0.35 + img)
        if self.glitch > 0:
            img = glitch(img, self.glitch, self.f, e.W / DW)
        img *= self.fade
        return (np.clip(img, 0, 1) * 255 + .5).astype(np.uint8)

    def _finish_gpu(self):
        """finish() on the GPU: same steps, same order; returns the 8-bit RGB frame."""
        e, g = self.e, self.g
        if self.ov.used:
            g.overlay(*self.ov.gpu_canvas())
        g.bloom(0.55, 0.55, 16, e.s)
        if self.reveal_y < 1 or self.scan_y is not None:
            g.step("post", uReveal=int(self.reveal_y < 1), uEdge=float(self.reveal_y * e.H), uS=float(e.s),
                   uScan=int(self.scan_y is not None), uScanY=float((self.scan_y or 0) * e.H), uPale=tuple(map(float, PALE)))
        if self.hud.used and self.hud_alpha > 0:
            g.overlay(*self.hud.gpu_canvas(), k=self.hud_alpha, g=0.95)
            g.bloom(0.85, 0.25, 6, e.s)
        rng = np.random.default_rng(self.f + 99)
        noise = rng.standard_normal((e.H, e.W), dtype=np.float32)
        out = g.final(noise, 1 - 0.035 * hsh(self.f, 3), self.fade)
        if self.glitch > 0:  # glitch only moves pixels around, so it can run on the finished 8-bit frame
            a = glitch(np.frombuffer(out, np.uint8).reshape(e.H, e.W, 3), self.glitch, self.f, e.W / DW)
            return np.ascontiguousarray(a)
        return np.frombuffer(out, np.uint8).reshape(e.H, e.W, 3)

def bloom(img, e, thr=0.55, strength=0.55, radius=16):
    W, H = e.W, e.H
    b = np.clip((img - thr) * 2, 0, 1)
    small = Image.fromarray((b * 255).astype(np.uint8)).resize((W // 4, H // 4), Image.BILINEAR)
    s = W / DW
    g1 = small.filter(ImageFilter.GaussianBlur(radius * s / 4)).resize((W, H), Image.BILINEAR)
    g2 = small.filter(ImageFilter.GaussianBlur(radius * 3 * s / 4)).resize((W, H), Image.BILINEAR)
    return img + (np.asarray(g1, np.float32) * 0.6 + np.asarray(g2, np.float32) * 0.4) / 255 * strength

def glitch(img, amt, f, s):
    rng = np.random.default_rng(f * 7 + 3)
    H, W = img.shape[:2]
    img = img.copy()
    for _ in range(int(3 + amt * 9)):
        y0 = int(rng.integers(0, H))
        h = int(rng.integers(2, int(H * 0.07 * amt) + 4))
        img[y0:y0 + h] = np.roll(img[y0:y0 + h], int(rng.normal(0, 60 * amt * s)), axis=1)
    k = int(round(7 * amt * s))
    if k:
        img[..., 0] = np.roll(img[..., 0], k, 1)
        img[..., 2] = np.roll(img[..., 2], -k, 1)
    return img

# ─────────────────────────── engine ───────────────────────────
def _canvas_shares_memory():
    """Does Pillow draw into an Image.frombuffer image in place? (Overlay relies on it on the GPU path.)"""
    try:
        buf = np.zeros((4, 4, 4), np.uint8)
        im = Image.frombuffer("RGBA", (4, 4), buf, "raw", "RGBA", 0, 1)
        im.readonly = 0
        ImageDraw.Draw(im).point((1, 2), fill=(1, 2, 3, 4))
        im.paste(Image.new("RGBA", (1, 1), (5, 6, 7, 8)), (3, 3))
        return buf[2, 1].tolist() == [1, 2, 3, 4] and buf[3, 3].tolist() == [5, 6, 7, 8]
    except Exception:
        return False


class Engine:
    def __init__(self, W=1920, H=1080, ss=2):
        self.W, self.H, self.ss = W, H, ss
        self.s = W / DW
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        self.X, self.Y = xs + .5, ys + .5
        r = np.hypot((self.X / W - .5) * 1.6, (self.Y / H - .5) * 1.6 * H / W * 1.3)
        self.vignette = np.clip(1 - 0.6 * r ** 2.4, 0, 1)[..., None].astype(np.float32)
        self.edge = np.clip(r, 0, 1.2).astype(np.float32)
        p = max(3.0, 4 * self.s)
        self.dots = (((self.X % p) < p * .45) & ((self.Y % p) < p * .45)).astype(np.float32)
        self.gpu = oris_gpu.create(W, H, (self.vignette, self.edge, self.dots))
        self.shared_canvas = self.gpu is not None and _canvas_shares_memory()
        self.cloud = self.textures("clouds", build_clouds)["noise"]

    def textures(self, name, builder, tag=None, **kw):
        """Build once, then load from cache/. Delete cache/ to rebuild."""
        os.makedirs(CACHE, exist_ok=True)
        tag = (tag or name + "".join(f"_{k}{v}" for k, v in sorted(kw.items()))) + "_" + name
        probe = [f for f in os.listdir(CACHE) if f.startswith(tag + "__")]
        if probe:
            return {f[len(tag) + 2:-4]: Tex(Image.open(os.path.join(CACHE, f)).convert("L")) for f in probe}
        print(f"  building texture '{name}' (first run only)...", flush=True)
        out = builder(**kw)
        for k, im in out.items():
            im.save(os.path.join(CACHE, f"{tag}__{k}.png"))
        return {k: Tex(v) for k, v in out.items()}

def place_path():
    """Path of the place file passed with --place, or None."""
    return os.environ.get("ORIS_PLACE")


class Scene:
    duration = 10.0
    fps = 30
    name = "oris"

    def setup(self, e):
        pass

    def frame(self, fr):
        raise NotImplementedError

# ─────────────────────────── runner ───────────────────────────
_W = {}

def _load_scene(path, cls):
    name = os.path.splitext(os.path.basename(path))[0]
    if FROZEN:  # inside ORIS.exe the scene is a bundled module, not a file
        return getattr(importlib.import_module(name), cls)
    spec = importlib.util.spec_from_file_location("oris_scene", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["oris_scene"] = mod
    spec.loader.exec_module(mod)
    return getattr(mod, cls)

GPU_WORKERS = 8

def _init(path, cls, W, H, ss):
    e = Engine(W, H, ss)
    sc = _load_scene(path, cls)()
    sc.setup(e)
    _W["e"], _W["s"] = e, sc

def _render(f):
    e, sc = _W["e"], _W["s"]
    fr = Frame(e, f / sc.fps, f)
    sc.frame(fr)
    return fr.finish().tobytes()

def main(scene_cls, scene_file):
    ap = argparse.ArgumentParser(description="Render an ORIS scene")
    ap.add_argument("--preview", action="store_true", help="960x540, quicker")
    ap.add_argument("--still", type=float, help="render one PNG at this time (seconds)")
    ap.add_argument("--from", dest="t0", type=float, default=0.0)
    ap.add_argument("--to", dest="t1", type=float)
    ap.add_argument("--workers", type=int, help="render processes (default: all CPU cores; fewer when the GPU is used)")
    ap.add_argument("--out", help="output path (default renders/<name>.mp4)")
    ap.add_argument("--place", help="place file from pick.html (places/<file>.json) — renders a real location")
    ap.add_argument("--coords", action="store_true", help="show the place's real lat/lon in the HUD (hidden by default)")
    ap.add_argument("--no-audio", action="store_true", help="video only, no sound")
    ap.add_argument("--mux", metavar="VIDEO", help="add the scene's sound to an existing video (e.g. one rendered in parts)")
    a = ap.parse_args()
    if a.place:
        if not os.path.exists(a.place):
            sys.exit(f"place file not found: {a.place}")
        os.environ["ORIS_PLACE"] = os.path.abspath(a.place)
        os.environ["ORIS_COORDS"] = "1" if a.coords else ""
    W, H = (960, 540) if a.preview else (1920, 1080)
    sc = scene_cls()
    if a.place:
        stem = os.path.splitext(os.path.basename(a.place))[0]
        sc.name += "_" + (stem[6:] if stem.startswith("place_") else stem)
    path, cls = os.path.abspath(scene_file), scene_cls.__name__
    os.makedirs(RENDERS, exist_ok=True)
    print(f"ORIS :: {sc.name}  {W}x{H} @ {sc.fps}fps")
    _init(path, cls, W, H, 2)  # also warms the texture cache before workers start
    scene = _W["s"]
    gpu = _W["e"].gpu
    print(f"  GPU: {gpu.name}" if gpu else "  GPU: none, numpy path")

    if a.mux:
        add_sound(scene, a.mux)
        return

    if a.still is not None:
        f = int(round(a.still * sc.fps))
        out = a.out or os.path.join(RENDERS, f"{sc.name}_{a.still:05.2f}s.png")
        Image.frombytes("RGB", (W, H), _render(f)).save(out)
        print("saved", out)
        return

    scene.name = sc.name
    sc = scene  # the set-up scene knows its real duration (routes are longer)
    f0 = int(a.t0 * sc.fps)
    f1 = int((a.t1 if a.t1 is not None else sc.duration) * sc.fps)
    out = a.out or os.path.join(RENDERS, f"{sc.name}{'_preview' if a.preview else ''}.mp4")
    codec, vargs = video_codec(H)
    workers = a.workers or max(1, os.cpu_count() or 2)
    if gpu and not a.workers:  # with the GPU doing the pixels, one process per physical core is the sweet spot
        workers = min(GPU_WORKERS, max(2, workers // 2))   # (cap: each process holds its own VRAM)
    print(f"  encoder: {codec}, {workers} render process{'es' if workers > 1 else ''}", flush=True)
    if workers > 1 and gpu:
        gpu.release()        # the workers make their own
        _W["e"].gpu = None
    ff = subprocess.Popen([ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                           "-s", f"{W}x{H}", "-r", str(sc.fps), "-i", "-"] + vargs +
                          ["-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    t_start = time.time()
    frames = range(f0, f1)

    def report(i):
        if i % 15 == 0 or i == len(frames):
            el = time.time() - t_start
            eta = el / max(i, 1) * (len(frames) - i)
            print(f"  frame {i}/{len(frames)}  {el:5.0f}s elapsed  ~{eta:4.0f}s left", flush=True)

    if workers > 1:
        import multiprocessing as mp
        with mp.Pool(workers, initializer=_init, initargs=(path, cls, W, H, 2)) as pool:
            for i, buf in enumerate(pool.imap(_render, frames, chunksize=2), 1):
                ff.stdin.write(buf)
                report(i)
    else:
        for i, f in enumerate(frames, 1):
            ff.stdin.write(_render(f))
            report(i)
    ff.stdin.close()
    ff.wait()
    if not a.no_audio and f0 == 0 and f1 >= int(sc.duration * sc.fps):
        add_sound(scene, out)
    print("saved", out, f"({time.time() - t_start:.0f}s)")


def add_sound(scene, video):
    """Synthesize the scene's sound track and mux it into `video` (in place)."""
    if not hasattr(scene, "sounds") or not getattr(scene, "opt", {}).get("sound", True):
        return
    import sound
    mix = sound.Mix(scene.duration)
    scene.sounds(mix)
    wav = video + ".wav"
    tmp = video + ".tmp.mp4"
    mix.write(wav)
    r = subprocess.run([ffmpeg_exe(), "-y", "-loglevel", "error", "-i", video, "-i", wav, "-map", "0:v", "-map", "1:a",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", tmp])
    os.remove(wav)
    if r.returncode == 0:
        os.replace(tmp, video)
        print("  sound added")
    else:
        print("  (sound could not be added)")
