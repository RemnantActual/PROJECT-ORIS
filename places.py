"""
ORIS places — turn a place file from pick.html into ORIS map textures.

A place file holds real data for one spot:
  terrain : elevation grid + major roads + water for the big square
  city    : every street, building, water body and green area for the close-up square
Coordinates in the file are already normalized to 0..1 inside each square, north up.
"""
import base64
import io
import json
import math
import os
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from oris import fbm, _to_img


_LOADED = {}


def load(path, part=None):
    """Load a place file, or one part of a route file: part='overview' or 'stop0', 'stop1', …"""
    key = (path, os.path.getmtime(path))
    if key not in _LOADED:
        with open(path, encoding="utf-8") as f:
            _LOADED.clear()
            _LOADED[key] = json.load(f)
    p = _LOADED[key]
    if p.get("oris_route") == 1:
        if part is None:
            return p
        if part == "overview":
            return {"name": p["name"], "center": p["center"], "terrain": p["overview"], "options": p.get("options", {})}
        st = p["stops"][int(part[4:])]
        return dict(st, options=p.get("options", {}))
    if p.get("oris_place") != 1:
        raise ValueError(f"{path} is not an ORIS place or route file")
    return p


def is_route(path):
    return load(path).get("oris_route") == 1


M_LAT, M_LON = 110540, 111320


def route_layout(r):
    """Where each stop sits in the overview's world square (0..1), and the size of its terrain and close-up squares."""
    lat0, lon0 = r["center"]
    O = r["overview"]["half_m"]
    out = []
    for st in r["stops"]:
        lat, lon = st["center"]
        x = (lon - lon0) * M_LON * math.cos(math.radians(lat0))
        y = (lat0 - lat) * M_LAT
        wx, wy = (x + O) / (2 * O), (y + O) / (2 * O)
        ts = st["terrain"]["half_m"] / O
        cs = st["city"]["half_m"] / O
        out.append(dict(name=st["name"], pos=(wx, wy), trect=(wx - ts, wy - ts, 2 * ts), crect=(wx - cs, wy - cs, 2 * cs),
                        tsize=2 * ts, csize=2 * cs))
    return out


def slug(p):
    return re.sub(r"[^a-z0-9]+", "_", p["name"].lower()).strip("_") or "place"


def cache_tag(path):
    """Cache key that changes whenever the place file is re-saved."""
    st = os.stat(path)
    return f"place_{os.path.splitext(os.path.basename(path))[0]}_{int(st.st_mtime)}_{st.st_size}"


def elevation(p):
    e = p["terrain"]["elev"]
    n = e["n"]
    a = np.frombuffer(base64.b64decode(e["data"]), "<u2").reshape(n, n).astype(np.float32) / 65535
    return a * (e["max"] - e["min"]) + e["min"]


def _pts(flat, n):
    return [(flat[i] * n, flat[i + 1] * n) for i in range(0, len(flat) - 1, 2)]


def _shade(gx, gy):
    L = np.array([-0.55, -0.65, 0.52], np.float32)
    L /= np.linalg.norm(L)
    return np.clip((-gx * L[0] - gy * L[1] + L[2]) / np.sqrt(gx * gx + gy * gy + 1), 0, 1)


def _nice_interval(relief):
    for step in (1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500):
        if relief / step <= 55:
            return step
    return 1000


TERRAIN_ROADS = {  # class: (width px @2560, brightness)
    "motorway": (4.0, 235), "trunk": (3.6, 220), "primary": (3.0, 205), "secondary": (2.4, 175),
    "tertiary": (2.0, 145), "motorway_link": (1.8, 170), "trunk_link": (1.6, 160), "primary_link": (1.5, 150),
    "secondary_link": (1.4, 140), "tertiary_link": (1.2, 120),
}


def build_terrain(src, n=2560, part=None):
    p = load(src, part)
    E = elevation(p)
    half = p["terrain"]["half_m"]
    Eu = np.asarray(Image.fromarray(E).resize((n, n), Image.BICUBIC), np.float32)
    del E
    mpp = 2 * half / n
    gy, gx = np.gradient(Eu, mpp)
    slope = np.hypot(gx, gy)
    ex = float(np.clip(0.3 / (np.median(slope) + 1e-4), 1.0, 40.0))  # flat places get more exaggeration
    det = fbm(n, 70, 4, 5) - .5
    dy, dx = np.gradient(det)
    shade = _shade(gx * ex + dx * 9, gy * ex + dy * 9)
    del det, dx, dy
    lo, hi = np.percentile(Eu, (1, 99))
    h = np.clip((Eu - lo) / (hi - lo + 1e-6), 0, 1)
    lum = 0.02 + 1.0 * shade ** 1.6 * (0.28 + 0.72 * h ** 1.1)
    del shade, h
    step = _nice_interval(hi - lo)
    lv = Eu / step
    fr = lv % 1
    gm = slope * mpp / step
    con = np.clip(1.25 - np.minimum(fr, 1 - fr) / np.maximum(gm, 1e-5), 0, 1)
    con *= 0.5 + 0.5 * (np.floor(lv) % 5 == 0)
    del lv, fr, gm, slope, gx, gy
    s = n / 2560
    # water
    wm = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(wm)
    for kind, closed, flat in p["terrain"].get("water", []):
        pts = _pts(flat, n)
        if len(pts) < 2:
            continue
        if closed and len(pts) >= 3:
            d.polygon(pts, fill=255)
        else:
            d.line(pts, fill=255, width=max(2, int(4 * s)), joint="curve")
    water = np.asarray(wm, np.float32) / 255
    edge = np.clip(np.asarray(wm.filter(ImageFilter.MaxFilter(3)), np.float32) / 255 - water, 0, 1)
    lum = lum * (1 - .85 * water) + .02 * water + edge * .28
    # roads
    rm = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(rm)
    roads = sorted(p["terrain"].get("roads", []), key=lambda r: TERRAIN_ROADS.get(r[0], (0, 0))[1])
    for cls, flat in roads:
        w, v = TERRAIN_ROADS.get(cls, (1.2, 110))
        pts = _pts(flat, n)
        if len(pts) >= 2:
            d.line(pts, fill=v, width=max(1, int(round(w * s))), joint="curve")
    road = np.asarray(rm.filter(ImageFilter.GaussianBlur(.6 * s)), np.float32) / 255
    dens = np.asarray(rm.resize((n // 16, n // 16), Image.BOX).filter(ImageFilter.GaussianBlur(2))
                      .resize((n, n), Image.BILINEAR), np.float32) / 255
    dens = np.clip(dens / (np.percentile(dens, 99.5) + 1e-6), 0, 1)
    lights = np.clip((fbm(n, 110, 3, 9) - .55) * 3, 0, 1) * dens ** 1.5
    lum += road * .32 + lights * .22
    return {"map": _to_img(lum), "contours": _to_img(con)}


CITY_ROADS = {  # class: (width metres, brightness)
    "motorway": (20, 150), "trunk": (16, 145), "primary": (14, 140), "secondary": (12, 132), "tertiary": (10, 124),
    "motorway_link": (9, 130), "trunk_link": (8, 128), "primary_link": (8, 125), "secondary_link": (7, 120),
    "tertiary_link": (7, 118), "residential": (7, 108), "unclassified": (7, 105), "living_street": (6, 100),
    "road": (6, 100), "service": (4, 88), "pedestrian": (5, 95), "track": (3, 70),
    "footway": (1.5, 72), "path": (1.5, 66), "cycleway": (1.5, 70), "steps": (1.5, 66), "bridleway": (1.5, 60),
}


HOUSE_ROADS = {"residential": 1, "unclassified": 1, "living_street": 1, "tertiary": 1, "service": .5, "road": 1}


def _fake_houses(c, half, n, img):
    """Stand-in houses along real residential streets, for places OSM has no footprints for.
    Deterministic, so the same place always gets the same houses."""
    rng = np.random.default_rng(1234)
    ppm = n / (2 * half)
    road = np.asarray(img, np.uint8) > 80          # road pixels drawn so far
    taken = np.zeros((n // 4 + 1, n // 4 + 1), bool)  # coarse occupancy grid
    out = []
    for cls, flat in c.get("roads", []):
        keep = HOUSE_ROADS.get(cls)
        if not keep:
            continue
        rw = CITY_ROADS.get(cls, (7, 0))[0]
        P = np.array(flat, np.float64).reshape(-1, 2) * 2 * half  # metres
        for p0, p1 in zip(P, P[1:]):
            seg = np.hypot(*(p1 - p0))
            if seg < 8:
                continue
            u = (p1 - p0) / seg
            nrm = np.array([-u[1], u[0]])
            s = rng.uniform(4, 14)
            while s < seg - 4:
                for side in (-1, 1):
                    if rng.random() > .82 * keep:
                        continue
                    w, dpt = rng.uniform(11, 17), rng.uniform(8, 13)
                    off = rw / 2 + rng.uniform(9, 16) + dpt / 2
                    cen = p0 + u * s + nrm * side * off
                    px, py = cen * ppm
                    if not (4 <= px < n - 4 and 4 <= py < n - 4):
                        continue
                    gx, gy = int(px) // 4, int(py) // 4
                    rr = max(1, int(7 * ppm / 4))
                    if taken[max(0, gy - rr):gy + rr + 1, max(0, gx - rr):gx + rr + 1].any() or road[int(py), int(px)]:
                        continue
                    taken[gy, gx] = True
                    a = math.atan2(u[1], u[0]) + rng.normal(0, .05)
                    ca, sa = math.cos(a), math.sin(a)
                    pts = []
                    for qx, qy in ((-w / 2, -dpt / 2), (w / 2, -dpt / 2), (w / 2, dpt / 2), (-w / 2, dpt / 2)):
                        mx, my = cen[0] + qx * ca - qy * sa, cen[1] + qx * sa + qy * ca
                        pts += [mx / (2 * half), my / (2 * half)]
                    out.append(pts)
                s += rng.uniform(22, 34)
    return out


def _relief(p, c, n):
    """Real ground relief under the close-up, cut from the terrain elevation grid."""
    E = elevation(p)
    half = c["half_m"]
    k = half / p["terrain"]["half_m"]
    m = E.shape[0]
    box = (m * (.5 - k / 2), m * (.5 - k / 2), m * (.5 + k / 2), m * (.5 + k / 2))
    Ec = np.asarray(Image.fromarray(E).resize((n, n), Image.BICUBIC, box=box), np.float32)
    gy, gx = np.gradient(Ec, 2 * half / n)
    ex = float(np.clip(0.25 / (np.median(np.hypot(gx, gy)) + 1e-4), 1.0, 30.0))
    return _shade(gx * ex, gy * ex)


def _city_from_imagery(p, c, n):
    """Close-up from the real satellite view: graded to the ORIS look, real streets traced on top."""
    half = c["half_m"]
    ppm = n / (2 * half)
    sat = Image.open(io.BytesIO(base64.b64decode(c["imagery"]["data"]))).convert("L")
    sat = sat.resize((n, n), Image.LANCZOS)
    sat = ImageOps.autocontrast(sat, cutoff=1)
    sat = sat.filter(ImageFilter.UnsharpMask(radius=2, percent=70, threshold=2))
    a = (np.asarray(sat, np.float32) / 255) ** 1.3 * 0.82
    lines = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(lines)
    for cls, flat in sorted(c.get("roads", []), key=lambda r: CITY_ROADS.get(r[0], (0, 0))[1]):
        w, v = CITY_ROADS.get(cls, (4, 85))
        pts = _pts(flat, n)
        if len(pts) >= 2:
            d.line(pts, fill=v, width=max(1, int(round(w * ppm * .45))), joint="curve")
    for flat in c.get("buildings", []):  # real mapped footprints, outlined
        pts = _pts(flat, n)
        if len(pts) >= 3:
            d.polygon(pts, outline=150)
    r = np.asarray(lines.filter(ImageFilter.GaussianBlur(.6)), np.float32) / 255
    a = a * (1 - .35 * r) + r * .5
    a *= 0.85 + 0.25 * _relief(p, c, n)
    return {"map": _to_img(np.clip(a, 0, 1))}


def build_city(src, n=2048, part=None):
    p = load(src, part)
    c = p["city"]
    if c.get("imagery"):
        return _city_from_imagery(p, c, n)
    half = c["half_m"]
    ppm = n / (2 * half)
    rng = np.random.default_rng(3)
    img = _to_img(0.08 + 0.09 * fbm(n, 6, 7, 31))
    d = ImageDraw.Draw(img)
    for flat in c.get("green", []):
        pts = _pts(flat, n)
        if len(pts) >= 3:
            d.polygon(pts, fill=30)
    for kind, closed, flat in c.get("water", []):
        pts = _pts(flat, n)
        if closed and len(pts) >= 3:
            d.polygon(pts, fill=10, outline=80)
        elif len(pts) >= 2:
            d.line(pts, fill=12, width=max(2, int(10 * ppm)), joint="curve")
    roads = sorted(c.get("roads", []), key=lambda r: CITY_ROADS.get(r[0], (0, 0))[1])
    for cls, flat in roads:
        w, v = CITY_ROADS.get(cls, (4, 85))
        pts = _pts(flat, n)
        if len(pts) >= 2:
            d.line(pts, fill=v, width=max(1, int(round(w * ppm))), joint="curve")
    houses = c.get("buildings", [])
    road_len_m = sum(sum(np.hypot(np.diff(f[0::2]), np.diff(f[1::2]))) for _, f in c.get("roads", [])) * 2 * half
    sparse = len(houses) < road_len_m / 120  # OSM has few or no footprints here (suburbs, woods)
    if sparse and p.get("options", {}).get("fill_houses", False):
        houses = houses + _fake_houses(c, half, n, img)  # only when asked for
    if sparse:
        trees = fbm(n, 90, 4, 77)
    sh = max(1.0, 2.5 * ppm)
    for flat in houses:
        pts = _pts(flat, n)
        if len(pts) < 3:
            continue
        d.polygon([(x + sh, y + sh) for x, y in pts], fill=12)
    for flat in houses:
        pts = _pts(flat, n)
        if len(pts) >= 3:
            d.polygon(pts, fill=int(rng.uniform(70, 150)))
    a = np.asarray(img, np.float32) / 255
    if sparse:  # tree canopy on open ground (not on roads or roofs)
        open_ground = a < 0.2
        canopy = np.clip((trees - .42) * 3, 0, 1) * open_ground
        a = a * (1 - .55 * canopy) + canopy * (0.05 + 0.1 * fbm(n, 300, 2, 78))
    a *= 0.8 + 0.45 * _relief(p, c, n)
    a *= 0.85 + 0.3 * fbm(n, 120, 3, 6)
    return {"map": _to_img(np.clip(a, 0, 1))}


def landmarks(p, k=7, near=(0.035, 0.2)):
    """Real reference points around the target, from the place file itself:
    hilltops (with real height), lakes/ponds, and road junctions. World coords of the terrain square.
    Returns [(x, y, label)], nearest first, spread out so labels don't pile up."""
    half = p["terrain"]["half_m"]
    E = elevation(p)
    S = 160
    Es = np.asarray(Image.fromarray(E).resize((S, S), Image.BILINEAR), np.float32)
    cands = []
    # hilltops: local maxima over a ~700 m window that stand out from their surroundings
    r = max(2, int(S * 350 / (2 * half)))
    pad = np.pad(Es, r, mode="edge")
    mx = np.full_like(Es, -1e9)
    mn = np.full_like(Es, 1e9)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            sh = pad[r + dy:r + dy + S, r + dx:r + dx + S]
            mx = np.maximum(mx, sh)
            mn = np.minimum(mn, sh)
    for j, i in zip(*np.nonzero((Es >= mx) & (Es - mn > 8))):
        cands.append(("hill", (i + .5) / S, (j + .5) / S, f"HILL {Es[j, i]:.0f}M", float(Es[j, i] - mn[j, i])))
    # lakes and ponds (closed water outlines), biggest first
    for kind, closed, flat in p["terrain"].get("water", []):
        if not closed or len(flat) < 6:
            continue
        x, y = np.array(flat[0::2]), np.array(flat[1::2])
        area = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))) * (2 * half) ** 2
        if area > 6000:  # > ~0.6 ha
            cands.append(("water", float(x.mean()), float(y.mean()), "WATER", area / 1e4))
    # road junctions: OSM ways that share a node
    seen = {}
    for idx, (cls, flat) in enumerate(p["terrain"].get("roads", [])):
        for q in range(0, len(flat) - 1, 2):
            seen.setdefault((flat[q], flat[q + 1]), set()).add(idx)
    for (x, y), ways in seen.items():
        if len(ways) >= 2:
            cands.append(("jct", x, y, "JCT", float(len(ways))))
    # keep the ones in view of the target, nearest first, spread out, a mix of kinds
    out, per = [], {"hill": 0, "water": 0, "jct": 0}
    cap = {"hill": 3, "water": 2, "jct": 3}
    for kind, x, y, label, _ in sorted(cands, key=lambda c: math.hypot(c[1] - .5, c[2] - .5)):
        d = math.hypot(x - .5, y - .5)
        if not (near[0] <= d <= near[1]) or per[kind] >= cap[kind]:
            continue
        if any(math.hypot(x - ox, y - oy) < .045 for ox, oy, _ in out):
            continue
        out.append((x, y, f"{label} · {d * 2 * half / 1000:.1f}KM"))
        per[kind] += 1
        if len(out) >= k:
            break
    return out
