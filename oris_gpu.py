"""
ORIS GPU path — the heavy per-pixel passes of oris.py as OpenGL shaders (moderngl).

oris.Frame calls into this when Engine.gpu is set; otherwise the numpy code in oris.py runs (same picture,
slower). The frame lives on the GPU as a float texture from the first map pass to the last post pass;
only the vector overlays (drawn by Pillow on the CPU), the film-grain noise (numpy, so it matches the CPU path
grain for grain) and the finished 8-bit frame cross the bus.

The shaders are in shaders/ (one per pass, plus common.glsl). Set ORIS_GPU=0 to force the numpy path.
On laptops with two GPUs this asks the NVIDIA driver for the discrete one (SHIM_MCCOMPAT).
"""
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SHADERS = os.path.join(getattr(sys, "_MEIPASS", HERE), "shaders")
SOFTWARE = ("gdi generic", "llvmpipe", "softpipe", "swiftshader", "microsoft basic render")
PASSES = ("map", "layer", "dots", "light", "reveal", "zone", "hazards", "wedge", "reveal_swept", "clouds", "fog",
          "tint", "over", "post", "final", "resample", "box", "bloom_add")
MAX_EMITTERS = 64


def _src(name):
    with open(os.path.join(SHADERS, name), encoding="utf-8") as f:
        return f.read()


# ─────────────── Pillow's resize and blur coefficients (so bloom matches the CPU path) ───────────────
def resize_coeffs(in_size, out_size):
    """Pillow's precompute_coeffs + normalize_coeffs_8bpc for BILINEAR, as rows [first, count, k * 2^22 ...]."""
    scale = in_size / out_size
    fscale = max(scale, 1.0)
    support = 1.0 * fscale
    ksize = int(math.ceil(support)) * 2 + 1
    rows = np.zeros((out_size, ksize + 2), np.int32)
    for xx in range(out_size):
        center = (xx + 0.5) * scale
        xmin = max(int(center - support + 0.5), 0)
        xmax = min(int(center + support + 0.5), in_size) - xmin
        k = [max(0.0, 1.0 - abs((x + xmin - center + 0.5) / fscale)) for x in range(xmax)]
        ww = sum(k)
        k = [v / ww for v in k] if ww else k
        rows[xx, 0], rows[xx, 1] = xmin, xmax
        for x, v in enumerate(k):
            rows[xx, 2 + x] = int(-0.5 + v * (1 << 22)) if v < 0 else int(0.5 + v * (1 << 22))
    return rows


def box_params(radius, passes=3):
    """Pillow's GaussianBlur(radius) → box radius, integer part, ww and fw of its fixed-point box blur."""
    sigma2 = np.float32(radius) * np.float32(radius) / passes
    L = math.sqrt(12.0 * sigma2 + 1.0)
    l = math.floor((L - 1.0) / 2.0)
    a = (2 * l + 1) * (l * (l + 1) - 3 * sigma2)
    a /= 6 * (sigma2 - (l + 1) * (l + 1))
    r = float(np.float32(l + a))
    ri = int(r)
    ww = int((1 << 24) / (r * 2 + 1))
    fw = ((1 << 24) - (ri * 2 + 1) * ww) // 2
    return ri, ww, fw


def _rows(H):
    return [tuple(float(v) for v in H[i]) for i in range(3)]


class GPU:
    """One OpenGL context per render process (each worker makes its own)."""

    def __init__(self, W, H, eng_arrays):
        if os.name == "nt":
            os.environ.setdefault("SHIM_MCCOMPAT", "0x800000001")   # Optimus laptops: use the NVIDIA GPU
        import moderngl
        self.mgl = moderngl
        self.W, self.H = W, H
        ctx = self.ctx = moderngl.create_standalone_context(require=330)
        self.name = ctx.info.get("GL_RENDERER", "?")
        if any(s in self.name.lower() for s in SOFTWARE):
            ctx.release()
            raise RuntimeError(f"software OpenGL only ({self.name})")
        common, vert = _src("common.glsl"), _src("fullscreen.vert")
        self.prog, self.vao = {}, {}
        for p in PASSES:
            frag = common + "\n#line 1\n" + _src(p + ".frag")
            self.prog[p] = ctx.program(vertex_shader=vert, fragment_shader=frag)
            self.vao[p] = ctx.vertex_array(self.prog[p], [])

        def tex(w, h, comps, dtype, data=None):
            t = ctx.texture((w, h), comps, data, dtype=dtype, alignment=1)
            t.filter = (moderngl.NEAREST, moderngl.NEAREST)
            t.repeat_x = t.repeat_y = False
            return t

        self._tex = tex
        # the frame: ping-pong float textures
        self.img = [tex(W, H, 4, "f4") for _ in range(2)]
        self.fbo = [ctx.framebuffer([t]) for t in self.img]
        self.cur = 0
        vig, edge, dots = eng_arrays
        self.eng = tex(W, H, 4, "f4", np.dstack([vig[..., 0], edge, dots, np.zeros_like(dots)]).astype(np.float32).tobytes())
        self.noise = tex(W, H, 1, "f4")
        self.ovt = tex(W, H, 4, "f1")
        self.ovt2 = None          # 2x overlay canvas, made on first use
        self.out = tex(W, H, 4, "f1")
        self.out_fbo = ctx.framebuffer([self.out])
        # bloom: thresholded frame shrunk 4x (Pillow resize), blurred twice, grown back
        sw, sh = W // 4, H // 4
        self.k_dh, self.k_dv = self._coef(resize_coeffs(W, sw)), self._coef(resize_coeffs(H, sh))
        self.k_uh, self.k_uv = self._coef(resize_coeffs(sw, W)), self._coef(resize_coeffs(sh, H))
        self.b_h = self._target(sw, H)
        self.b_s = [self._target(sw, sh) for _ in range(3)]
        self.b_u = [self._target(W, sh) for _ in range(2)]
        self.maps = {}

    # ─────────────── plumbing ───────────────
    def _coef(self, rows):
        h, w = rows.shape
        t = self.ctx.texture((w, h), 1, np.ascontiguousarray(rows).tobytes(), dtype="i4", alignment=1)
        t.filter = (self.mgl.NEAREST, self.mgl.NEAREST)
        return t

    def _target(self, w, h):
        t = self._tex(w, h, 4, "f1")
        return t, self.ctx.framebuffer([t])

    def release(self):
        self.ctx.release()

    def map_tex(self, im):
        """GPU copy of a Pillow 'L' image (map level, cloud noise), uploaded once per process."""
        hit = self.maps.get(id(im))
        if hit is None:
            hit = self.maps[id(im)] = (self._tex(im.size[0], im.size[1], 1, "f1", im.tobytes()), im)  # im kept alive: id stays unique
        return hit[0]

    def _draw(self, p, fbo, tex, uni):
        prog = self.prog[p]
        for u, (name, t) in enumerate(tex.items()):
            if name in prog:
                t.use(u)
                prog[name].value = u
        for k, v in uni.items():
            if k in prog:
                if k == "uEm":
                    prog[k].write(v)
                else:
                    prog[k].value = v
        fbo.use()
        self.vao[p].render(self.mgl.TRIANGLES, vertices=3)

    def step(self, p, tex=None, **uni):
        """Run pass p over the frame: reads the current image, writes the other one, swaps."""
        t = {"uImg": self.img[self.cur], "uEng": self.eng}
        t.update(tex or {})
        uni.setdefault("uSize", (float(self.W), float(self.H)))
        self._draw(p, self.fbo[1 - self.cur], t, uni)
        self.cur = 1 - self.cur

    def clear(self):
        self.fbo[self.cur].clear(0, 0, 0, 0)

    def upload(self, a):
        a = np.broadcast_to(np.asarray(a, np.float32), (self.H, self.W, 3))
        self.img[self.cur].write(np.dstack([a, np.zeros((self.H, self.W, 1), np.float32)]).tobytes())

    def download(self):
        a = np.frombuffer(self.img[self.cur].read(), np.float32).reshape(self.H, self.W, 4)
        return a[..., :3].copy()

    # ─────────────── effects ───────────────
    def bloom(self, thr, strength, radius, s):
        sw = self.W // 4
        self._draw("resample", self.b_h[1], {"uSrc": self.img[self.cur], "uCoef": self.k_dh}, dict(uAxis=0, uThr=float(thr)))
        self._draw("resample", self.b_s[0][1], {"uSrc": self.b_h[0], "uCoef": self.k_dv}, dict(uAxis=1, uThr=-1.0))
        ups = []
        for j, r in enumerate((radius * s / 4, radius * 3 * s / 4)):
            ri, ww, fw = box_params(r)
            src, a, b = self.b_s[0][0], self.b_s[1], self.b_s[2]
            for axis in (0, 0, 0, 1, 1, 1):
                self._draw("box", a[1], {"uSrc": src}, dict(uAxis=axis, uRad=ri, uWW=ww, uFW=fw))
                src, a, b = a[0], b, a
            self._draw("resample", self.b_u[j][1], {"uSrc": src, "uCoef": self.k_uh}, dict(uAxis=0, uThr=-1.0))
            ups.append(self.b_u[j][0])
        self.step("bloom_add", {"uG1": ups[0], "uG2": ups[1], "uCoef": self.k_uv}, uStrength=float(strength))

    def overlay(self, rgba, ss, k=1.0, g=1.0):
        """Composite an overlay canvas: 8-bit premultiplied RGBA at ss x the frame size (ss = 1 or 2)."""
        t = self.ovt if ss == 1 else self.ovt2
        if t is None:
            t = self.ovt2 = self._tex(self.W * 2, self.H * 2, 4, "f1")
        t.write(rgba)
        self.step("over", {"uOv": t}, uSS=int(ss), uK=float(k), uG=float(g))

    def final(self, noise, flick, fade):
        self.noise.write(noise.tobytes())
        t = {"uImg": self.img[self.cur], "uEng": self.eng, "uNoise": self.noise}
        self._draw("final", self.out_fbo, t, dict(uFlick=float(flick), uFade=float(fade)))
        return self.out_fbo.read(components=3, alignment=1)


def create(W, H, eng_arrays):
    """A GPU for this process, or None (then the numpy path runs). ORIS_GPU=0 turns it off."""
    if os.environ.get("ORIS_GPU", "1").strip().lower() in ("0", "off", "no", "false", "cpu"):
        return None
    try:
        return GPU(W, H, eng_arrays)
    except Exception as ex:  # no moderngl, no OpenGL 3.3, shader compile error, software renderer...
        if not os.environ.get("_ORIS_GPU_WARNED"):
            os.environ["_ORIS_GPU_WARNED"] = "1"
            print(f"  GPU not used ({type(ex).__name__}: {str(ex).strip().splitlines()[0] if str(ex).strip() else ''}) "
                  "- rendering on the CPU", flush=True)
        return None
