"""
ORIS HUD kit — reusable screen chrome, panels, labels and map markers.
All coordinates are design px (1920x1080). `ov` is a Frame overlay (fr.hud or fr.ov).
"""
import math

import numpy as np

from oris import INK, DIM, ACC, RED, PINK, PALE, DARK, MARK, GLYPH_SCRAMBLE, clamp, ramp, typed, hsh, lerp


def _col(alert):
    return INK * (1 - alert) + RED * alert


# ─────────────────────────── screen chrome ───────────────────────────
def chrome(ov, t, f, cfg, alert=0.0, low_fps=False):
    clock = cfg.get("clock", 21 * 3600 + 6 * 60) + int(t)
    hh, mm, ss = clock // 3600 % 24, clock // 60 % 60, clock % 60
    fps = str(int(5 + 4 * hsh(f // 4))) if low_fps else "30"
    ov.text((8, 6), "FPS:", INK, .85, 13)
    ov.text((50, 6), fps, RED if low_fps else INK, .95, 13)
    ov.text((80, 6), f"PING: {41 + int(4 * hsh(f // 20))} MS   PACKET LOSS: 0 %   "
                     f"CORE: {70 + int(5 * hsh(f // 45, 2))}°   {hh:02d}:{mm:02d}:{ss:02d}", INK, .85, 13)
    # top rule
    ov.line([(40, 40), (1880, 40)], INK, .16, 3)
    ov.line([(40, 40), (440, 40)], INK, .45, 3)
    ov.text((44, 48), cfg.get("header", "TACTICAL SURVEILLANCE"), INK, .6, 12, spacing=1.2)
    # faint title block
    title = cfg.get("title", MARK)
    ov.text((44, 66), title, INK, .16, 48, kind="glyph" if title == MARK else "bold")
    for i, l in enumerate(cfg.get("title_lines", [])):
        ov.text((46, 124 + i * 15), l, INK, .13, 11)
    # frame + corner brackets
    x0, y0, x1, y1 = 40, 60, 1880, 1044
    ov.rect(x0, y0, x1 - x0, y1 - y0, INK, .07)
    for cx, cy, sx, sy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        ov.line([(cx + 26 * sx, cy), (cx, cy), (cx, cy + 26 * sy)], INK, .45, 2)
    ov.line([(1800, 118), (1840, 118), (1840, 760)], INK, .1, 1)
    # left scale ticks
    for i, lab in enumerate(cfg.get("left_ticks", ["0700", "0800", "0900", "1000"])):
        y = 380 + i * 45
        ov.line([(66, y), (86, y)], INK, .3)
        ov.text((92, y - 7), lab, INK, .25, 10)
    # left system block
    for i, l in enumerate(cfg.get("sys_left", [])):
        ov.text((130, 806 + i * 15), l, INK, .38, 10)
    # right system block
    for i, l in enumerate(cfg.get("sys_right", [])):
        ov.text((1782, 184 + i * 15), l, INK, .55, 10, anchor="ra")
    ov.text((1782, 300), f"LATENCY: {8 + int(3 * hsh(f // 15, 5))}ms", INK, .75, 11, anchor="ra")
    # bottom ticker
    for i in range(11):
        x = 720 + i * 78
        a = .16 + .5 * (hsh(i, f // 8) > .62)
        ov.text((x, 1013), f"AOI-{2031 + i % 3}", INK, a, 9)
        ov.text((x, 1027), f"LAT-{1184 + (i * 7) % 5}", INK, a * .8, 9)
    for i, l in enumerate(cfg.get("footer_left", [])):
        ov.text((70 + i * 205, 1020), l, INK, .32, 9)
    # running digits
    ov.text((8, 1061), "".join(str(int(hsh(f, i) * 10)) for i in range(22)), INK, .55, 12)
    brand(ov, 1650, 1018, cfg)


def brand(ov, x, y, cfg):
    ov.poly([(x, y), (x + 22, y - 12), (x + 44, y), (x + 22, y + 12), (x + 22, y + 4), (x + 32, y), (x + 22, y - 4),
             (x + 12, y)], INK, .3)
    ov.text((x + 54, y - 13), cfg.get("brand", "ORIS"), INK, .38, 14, kind="bold")
    ov.text((x + 54, y + 4), cfg.get("brand_sub", "SURVEILLANCE SYSTEMS"), INK, .3, 9, spacing=1)


def mark(ov, cx, cy, size, t, f, col=ACC, a=1.0):
    """The ⊙ℝ⥍§ glyph mark (corner logo) — glitches now and then."""
    glitching = hsh(f // 2, 9) > .8
    dx = (hsh(f, 1) - .5) * 16 if glitching else 0
    if glitching:
        ov.text((cx + dx + 6, cy), MARK, RED, .55 * a, size, kind="glyph", anchor="mm")
        ov.text((cx + dx - 4, cy), MARK, PALE, .3 * a, size, kind="glyph", anchor="mm")
    ov.text((cx + dx, cy), MARK, col, a, size, kind="glyph", anchor="mm")


def mark_resolve(ov, cx, cy, size, t, t0, step=.12, scramble=.12, col=ACC, a=1.0, spacing=0.0):
    """The glyph mark appearing glyph by glyph: each one scrambles through symbols, then locks.
    Returns the time the last glyph locks."""
    w = ov.text_w(MARK, size, "glyph", spacing)
    x = cx - w / 2
    for i, ch in enumerate(MARK):
        ts = t0 + i * step
        cw = ov.text_w(ch, size, "glyph")
        if t >= ts:
            if t < ts + scramble:
                g = GLYPH_SCRAMBLE[int(hsh(t * 40, i) * len(GLYPH_SCRAMBLE))]
                ov.text((x + cw / 2, cy), g, PALE, a * .7, size, kind="glyph", anchor="mm")
            else:
                pop = 1 + .25 * (1 - ramp(t, ts + scramble, ts + scramble + .12, "out"))
                ov.text((x + cw / 2, cy), ch, col, a, size * pop, kind="glyph", anchor="mm")
        x += cw + spacing
    return t0 + (len(MARK) - 1) * step + scramble


def sigil(ov, cx, cy, s, t, f, col=ACC):
    """The yellow ORIS mark in the corner — glitches now and then."""
    g = hsh(f // 2, 9)
    glitching = g > .8
    dx = (hsh(f, 1) - .5) * 16 if glitching else 0

    lw = max(4, s / 10)

    def draw(ox, c, a):
        ov.circle((cx + ox, cy), s * .55, c, a, w=lw)
        ov.line([(cx + ox, cy - s * .9), (cx + ox, cy + s * .9)], c, a, lw)
        ov.line([(cx + ox, cy - s * .32), (cx + ox + s * .5, cy - s * .32)], c, a, lw)
        ov.circle((cx + ox - s * .24, cy + s * .26), s * .08, c, a, fill=True)

    if glitching:
        draw(dx + 7, RED, .55)
        draw(dx - 5, PALE, .3)
    draw(dx, col, 1.0)


# ─────────────────────────── panels ───────────────────────────
def _signal_lost(ov, x, y, w, h):
    ov.rect(x, y, w, h, RED, .06, fill=True)
    ov.line([(x, y + h), (x + w, y)], RED, .45, 1.5)
    ov.text((x + w - 12, y + h - 20), "SIGNAL_LOST", RED, .8, 10, anchor="ra")


def subject_picture(gray, t, f, glitch=0.0):
    """Turn a grayscale subject picture into a HUD feed: scanlines, moving scan band, flicker, glitch tears."""
    H, W = gray.shape
    g = gray.copy()
    g[::3] *= .45                                            # scanlines
    band = (t * .45) % 1 * H
    rows = np.arange(H)[:, None]
    g *= 1 + .6 * np.exp(-((rows - band) / (H * .04)) ** 2)  # bright scan band
    g *= .9 + .1 * hsh(f, 21)                                # flicker
    if glitch > 0 or hsh(f // 3, 23) > .93:                  # occasional tear
        rng = np.random.default_rng(f)
        for _ in range(3):
            y0 = int(rng.integers(0, H - 4))
            hh = int(rng.integers(2, max(3, H // 12)))
            g[y0:y0 + hh] = np.roll(g[y0:y0 + hh], int(rng.normal(0, W * .08)), axis=1)
    return g


def subject_panel(ov, x, y, w, h, t, f, cfg, alert=0.0, picture=None):
    c = _col(alert)
    ov.rect(x, y, w, h, c, .4)
    ov.line([(x, y), (x + 40, y)], c, .9, 3)
    ov.text((x + 10, y + 10), cfg.get("subject_head", "SUBJECT"), c, .85, 12, kind="monob")
    tag = cfg.get("subject_tag", "RD-1")
    tw = ov.text_w(tag, 12, "monob") + 12
    ov.rect(x + w - tw - 6, y + 7, tw, 19, c, .8, fill=True)
    ov.text((x + w - 12, y + 9), tag, DARK, 1, 12, kind="monob", anchor="ra")
    if alert > .5:
        _signal_lost(ov, x, y, w, h)
        return
    for i, (l, r) in enumerate(cfg.get("subject_lines", [])):
        ov.text((x + 10, y + 36 + i * 13), l, INK, .45, 9)
        ov.text((x + w - 10, y + 36 + i * 13), r, INK, .45, 9, anchor="ra")
    if picture is not None:
        ov.image(subject_picture(picture, t, f), x + 8, y + 80, w - 30, h - 88, INK, .85)
        for i in range(6):
            ov.rect(x + w - 16, y + h - 80 + i * 10, 6, 4 + 4 * hsh(i, f // 10), INK, .45, fill=True)
        return
    cx, cy = x + w * .5, y + h * .64
    for k in range(5):
        r = 16 + k * 15
        rot = t * .35 * (1 if k % 2 else -1) + k * .4
        pts = [(cx + r * math.cos(rot + i * math.pi / 3), cy + r * math.sin(rot + i * math.pi / 3)) for i in range(7)]
        ov.line(pts, INK, .1 + .06 * k, 1)
    ov.circle((cx, cy), 4, ACC, .5 + .5 * (math.sin(t * 6) > 0), fill=True)
    sy = y + 80 + ((t * .45) % 1) * (h - 100)
    ov.line([(x + 8, sy), (x + w - 8, sy)], PALE, .35, 1)
    for i in range(6):
        ov.rect(x + w - 16, y + h - 80 + i * 10, 6, 4 + 4 * hsh(i, f // 10), INK, .45, fill=True)


def grid_fix(ov, x, y, w, h, t, f, cfg, alert=0.0, mini=None):
    """GRID FIX as a live minimap. mini = dict(img=gray array, map=fn(world)->(u, v) in 0..1, foot=[world pts],
    route=[world pts], stops=[(world pt, label, done)], target=world pt, hdg=deg, fov_m=m, tgt_m=m)."""
    if mini is None:
        return radar_panel(ov, x, y, w, h, t, f, cfg, alert)
    c = _col(alert)
    ov.rect(x, y, w, h, c, .35)
    ov.line([(x, y), (x + 34, y)], c, .9, 3)
    ov.text((x + 10, y + 10), cfg.get("radar_head", "GRID FIX"), c, .85, 11, kind="monob")
    if alert > .5:
        _signal_lost(ov, x, y, w, h)
        return

    def dist(m):
        return f"{m / 1000:.1f} KM" if m >= 1000 else f"{m:.0f} M"

    ov.text((x + w - 10, y + 11), f"HDG {mini['hdg']:03.0f}°", ACC, .85, 9, anchor="ra")
    ov.text((x + 10, y + 30), f"FOV {dist(mini['fov_m'])}", INK, .55, 8)
    ov.text((x + w - 10, y + 30), f"TGT {dist(mini['tgt_m'])}", INK, .55, 8, anchor="ra")
    ms = min(w - 20, h - 56)
    mx, my = x + (w - ms) / 2, y + 46
    ov.image(mini["img"], mx, my, ms, ms, INK, .5)
    ov.rect(mx, my, ms, ms, INK, .35)

    def P(pt):
        u, v = mini["map"](pt)
        return (mx + min(max(u, -.02), 1.02) * ms, my + min(max(v, -.02), 1.02) * ms)

    if mini.get("route"):
        ov.dashed([P(q) for q in mini["route"]], ACC, .6, 1, 3, 3, t * 12)
    for q, lab, done in mini.get("stops", []):
        p = P(q)
        ov.circle(p, 3, ACC if not done else INK, .95, fill=True)
        ov.text((p[0] + 5, p[1] - 11), lab, ACC if not done else INK, .8, 8)
    if mini.get("target") is not None:
        p = P(mini["target"])
        ov.circle(p, 4 + 2 * (math.sin(t * 6) > 0), PALE, .9, w=1)
    foot = [P(q) for q in mini["foot"]]
    ov.line(foot + foot[:1], PALE, .95, 1.4)
    fx, fy = sum(p[0] for p in foot) / 4, sum(p[1] for p in foot) / 4
    ov.line([(fx - 4, fy), (fx + 4, fy)], PALE, .8, 1)
    ov.line([(fx, fy - 4), (fx, fy + 4)], PALE, .8, 1)
    sweep = (t * 1.3) % 1
    ov.line([(mx, my + sweep * ms), (mx + ms, my + sweep * ms)], ACC, .18, 1)


def radar_panel(ov, x, y, w, h, t, f, cfg, alert=0.0):
    c = _col(alert)
    ov.rect(x, y, w, h, c, .35)
    ov.text((x + 10, y + 10), cfg.get("radar_head", "GRID FIX"), c, .85, 11, kind="monob")
    for i, l in enumerate(cfg.get("radar_lines", [])):
        ov.text((x + 10, y + 30 + i * 12), l, INK, .35, 8)
    if alert > .5:
        _signal_lost(ov, x, y, w, h)
        return
    cx, cy, R = x + w / 2, y + h * .68, w * .38
    arc = [(cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a))) for a in range(205, 336, 3)]
    ov.line(arc, INK, .55, 1.5)
    ov.line([(x + 14, cy), (x + w - 14, cy)], INK, .4, 1)
    ov.dashed([(cx, cy - R - 10), (cx, y + h - 14)], INK, .3, 1, 4, 4)
    sweep = 205 + (t * 45) % 130
    for k in range(5):
        a = math.radians(sweep - k * 4)
        ov.line([(cx, cy), (cx + R * math.cos(a), cy + R * math.sin(a))], ACC, .7 - k * .13, 1)
    a = math.radians(250)
    ov.line([(cx, cy), (cx + R * 1.25 * math.cos(a), cy + R * 1.25 * math.sin(a))], INK, .35, 1)
    ov.line([(x + 14, cy + 20), (x + w - 14, cy - 18)], ACC, .25, 1)
    ov.circle((cx + 14, cy - 8), 3, ACC, .4 + .6 * ((t * 2) % 1 > .5), fill=True)
    ov.text((x + 12, y + h - 16), cfg.get("radar_foot", "28-10-31-64-35"), INK, .3, 8)
    ov.text((x + w - 12, y + h - 16), cfg.get("radar_foot", "28-10-31-64-35"), INK, .3, 8, anchor="ra")


# ─────────────────────────── map graphics ───────────────────────────
def ring(fr, c, r, col=INK, a=.6, w=1.2, reveal=1.0, start=0.0, dash=None, phase=0.0, n=220):
    """World-space circle (draws as an ellipse under tilt). reveal 0..1 sweeps it on."""
    if reveal <= 0 or a <= 0:
        return
    ang = np.linspace(start, start + 2 * math.pi * reveal, max(8, int(n * reveal)))
    pts = fr.cam.proj(np.c_[c[0] + r * np.cos(ang), c[1] + r * np.sin(ang)])
    if dash:
        fr.ov.dashed(pts, col, a, w, dash[0], dash[1], phase)
    else:
        fr.ov.line(pts, col, a, w)


def ticks(fr, c, r, col=INK, a=.5, every=10, length=.008, rot=0.0, w=1.0):
    for d in range(0, 360, every):
        q = math.radians(d) + rot
        l = length * (2 if d % 90 == 0 else 1)
        p = fr.cam.proj([(c[0] + r * math.cos(q), c[1] + r * math.sin(q)),
                         (c[0] + (r - l) * math.cos(q), c[1] + (r - l) * math.sin(q))])
        fr.ov.line(p, col, a, w)


def beam(ov, p0, p1, t, col=PALE, a=1.0, reveal=1.0, w=1.6, arrows=2, speed=.45, seed=0):
    """Light beam from p0 (screen) to p1 (screen), brighter at the target, with travelling arrowheads."""
    if reveal <= 0 or a <= 0:
        return
    end = (p0[0] + (p1[0] - p0[0]) * reveal, p0[1] + (p1[1] - p0[1]) * reveal)
    n = 14
    for i in range(n):
        u0, u1 = i / n, (i + 1) / n
        ov.line([(p0[0] + (end[0] - p0[0]) * u0, p0[1] + (end[1] - p0[1]) * u0),
                 (p0[0] + (end[0] - p0[0]) * u1, p0[1] + (end[1] - p0[1]) * u1)], col, a * (.08 + .92 * u1 ** 1.6), w)
    ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    for k in range(arrows):
        u = ((t * speed + k / arrows + seed * .37) % 1) ** .8 * reveal
        q = (p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u)
        arrow(ov, q, ang, 9, col, a * clamp(u * 3) * .95)


def arrow(ov, p, ang, s, col, a):
    ca, sa = math.cos(ang), math.sin(ang)
    pts = [(s, 0), (-s * .7, s * .55), (-s * .35, 0), (-s * .7, -s * .55)]
    ov.poly([(p[0] + x * ca - y * sa, p[1] + x * sa + y * ca) for x, y in pts], col, a)


def craft(ov, p, ang, col=ACC, a=1.0, s=16):
    """Generic top-down craft marker (an original chevron, not any real vehicle)."""
    ca, sa = math.cos(ang), math.sin(ang)
    pts = [(s * 1.2, 0), (-s * .3, s * .25), (-s * .9, s * .95), (-s * .55, 0), (-s * .9, -s * .95), (-s * .3, -s * .25)]
    ov.poly([(p[0] + x * ca - y * sa, p[1] + x * sa + y * ca) for x, y in pts], col, a)
    ov.circle(p, s * 2.1, col, a * .25, w=1)


def target(ov, p, t, col=PALE, a=1.0):
    pulse = (t * 1.1) % 1
    ov.circle(p, 6, col, a, fill=True)
    ov.circle(p, 10 + 40 * pulse, col, a * (1 - pulse) * .7, w=1.5)
    for k in range(4):
        q = k * math.pi / 2 + t * .6
        ov.line([(p[0] + 16 * math.cos(q), p[1] + 16 * math.sin(q)), (p[0] + 24 * math.cos(q), p[1] + 24 * math.sin(q))],
                col, a * .8, 1.5)


def trefoil(ov, p, s, col=ACC, a=1.0):
    """Radiation-style hazard symbol."""
    if a <= 0:
        return
    for k in range(3):
        ov.pie(p, s, -90 + k * 120 - 30, -90 + k * 120 + 30, col, a)
    ov.erase_circle(p, s * .28)
    ov.circle(p, s * .18, col, a, fill=True)
    ov.circle(p, s * 1.25, col, a * .6, w=1.5)


def sigil_draw(ov, cx, cy, s, circle=1.0, spine=1.0, tick=1.0, dot=1.0, col=ACC, a=1.0):
    """The ORIS sigil drawn stroke by stroke (each part 0..1)."""
    if a <= 0:
        return
    lw = max(4, s / 10)
    if circle > 0:
        n = max(3, int(120 * circle))
        ang = np.linspace(-math.pi / 2, -math.pi / 2 + 2 * math.pi * circle, n)
        ov.line([(cx + s * .55 * math.cos(q), cy + s * .55 * math.sin(q)) for q in ang], col, a, lw)
    if spine > 0:
        h = s * .9 * spine
        ov.line([(cx, cy - h), (cx, cy + h)], col, a, lw)
    if tick > 0:
        ov.line([(cx, cy - s * .32), (cx + s * .5 * tick, cy - s * .32)], col, a, lw)
    if dot > 0:
        ov.circle((cx - s * .24, cy + s * .26), s * .08 * (1 + .6 * (1 - dot)), col, a * dot, fill=True)


def lockon(ov, p, t, t0, col=PALE, a=1.0):
    """Corner brackets that snap in onto a point, then hold with a small pulse."""
    if a <= 0 or t < t0:
        return
    u = ramp(t, t0, t0 + .22, "out")
    s = 34 - 22 * u + 1.5 * math.sin((t - t0) * 9) * (u >= 1)
    L = 6
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        cx, cy = p[0] + sx * s, p[1] + sy * s
        ov.line([(cx - sx * L, cy), (cx, cy), (cx, cy - sy * L)], col, a * (.4 + .6 * u), 1.5)
    ov.circle(p, 2.5, col, a, fill=True)


def node(ov, p, s, col=ACC, a=1.0):
    """Survey marker: ringed diamond."""
    if a <= 0:
        return
    ov.poly([(p[0], p[1] - s), (p[0] + s, p[1]), (p[0], p[1] + s), (p[0] - s, p[1])], col, a * .9)
    ov.circle(p, s * 1.9, col, a * .6, w=1.5)


def xmark(ov, p, s, col=RED, a=1.0):
    ov.line([(p[0] - s, p[1] - s), (p[0] + s, p[1] + s)], col, a, 2)
    ov.line([(p[0] - s, p[1] + s), (p[0] + s, p[1] - s)], col, a, 2)


def tri(ov, p, s, col=RED, a=1.0):
    ov.poly([(p[0], p[1] - s), (p[0] + s * .9, p[1] + s * .6), (p[0] - s * .9, p[1] + s * .6)], col, a)


def tag(ov, anchor, t, t0, big, line1, line2="", col2=ACC, alert=0.0, alert_text=("HAZARD ALERT", ""),
        offset=(90, -36)):
    """Big ID + boxed caption + status line, typed on from t0, with a leader line to the anchor."""
    a = ramp(t, t0, t0 + .25)
    if a <= 0:
        return
    x, y = anchor[0] + offset[0], anchor[1] + offset[1]
    wide = max(ov.text_w(big, 50, "thin"), ov.text_w(line1, 13, spacing=.6) + 16, ov.text_w(line2, 12, spacing=.8))
    if x + wide > 1590:  # would run into the right-hand panels: put the label on the left of the target
        x = anchor[0] - offset[0] - wide
        ov.line([anchor, (x + wide + 14, y + 18), (x + wide + 4, y + 18)], INK, .55 * a, 1)
    else:
        ov.line([anchor, (x - 14, y + 18), (x - 4, y + 18)], INK, .55 * a, 1)
    ov.text((x, y + 18), typed(big, t, t0, 16), INK, .95 * a, 50, kind="thin", anchor="ls")
    y1 = y + 30
    s1 = typed(line1, t, t0 + .3, 30)
    if s1:
        w1 = ov.text_w(line1, 13, spacing=.6) + 16
        ov.rect(x, y1, w1 * ramp(t, t0 + .3, t0 + .5), 20, INK, .7 * a, fill=True)
        ov.text((x + 8, y1 + 3), s1, DARK, a, 13, spacing=.6)
    y2 = y1 + 28
    if alert > 0:
        aw = ov.text_w(alert_text[0], 14, "monob", .8) + 20
        ov.rect(x, y2 - 2, aw, 22, RED, .85 * alert, fill=True)
        ov.text((x + 10, y2 + 1), alert_text[0], INK, alert, 14, kind="monob", spacing=.8)
        if alert_text[1]:
            ov.text((x, y2 + 30), alert_text[1], INK, .8 * alert, 12, spacing=.8)
        return
    s2 = typed(line2, t, t0 + .7, 28)
    cur = "_" if (t * 3) % 1 > .5 else " "
    ov.text((x, y2), s2 + (cur if s2 == line2 else ""), col2, .9 * a, 12, spacing=.8)
