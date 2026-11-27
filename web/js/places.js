// ORIS web — turn a place file from the Studio into ORIS map textures (port of places.py).
// A place file holds real data for one spot:
//   terrain : elevation grid + major roads + water for the big square
//   city    : every street, building, water body and green area for the close-up square
// Coordinates in the file are already normalized to 0..1 inside each square, north up.
import {
  GrayDraw, autocontrast, b64bytes, blur, clamp, decodeGray, fbm, gimg, gradient, max3, percentile, resize, rng, toU8,
} from "./util.js";

/** One part of a place or route file: part = 'overview' or 'stop0', 'stop1', … (null = the file itself). */
export function part(p, which = null) {
  if (p.oris_route === 1) {
    if (which === null) return p;
    if (which === "overview") return { name: p.name, center: p.center, terrain: p.overview, options: p.options || {} };
    return { ...p.stops[+which.slice(4)], options: p.options || {} };
  }
  if (p.oris_place !== 1) throw new Error("not an ORIS place or route file");
  return p;
}
export const isRoute = p => p.oris_route === 1;

const M_LAT = 110540, M_LON = 111320;

/** Where each stop sits in the overview's world square (0..1), and the size of its terrain and close-up squares. */
export function routeLayout(r) {
  const [lat0, lon0] = r.center, O = r.overview.half_m;
  return r.stops.map(st => {
    const [lat, lon] = st.center;
    const x = (lon - lon0) * M_LON * Math.cos((lat0 * Math.PI) / 180), y = (lat0 - lat) * M_LAT;
    const wx = (x + O) / (2 * O), wy = (y + O) / (2 * O);
    const ts = st.terrain.half_m / O, cs = st.city.half_m / O;
    return { name: st.name, pos: [wx, wy], trect: [wx - ts, wy - ts, 2 * ts], crect: [wx - cs, wy - cs, 2 * cs], tsize: 2 * ts, csize: 2 * cs };
  });
}

export function elevation(p) {
  const e = p.terrain.elev, n = e.n;
  const bytes = b64bytes(e.data), dv = new DataView(bytes.buffer);
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) out[i] = (dv.getUint16(i * 2, true) / 65535) * (e.max - e.min) + e.min;
  return { w: n, h: n, d: out };
}

const pts = (flat, n) => { const o = []; for (let i = 0; i + 1 < flat.length; i += 2) o.push([flat[i] * n, flat[i + 1] * n]); return o; };

function shade(gx, gy) {
  let L = [-0.55, -0.65, 0.52];
  const ln = Math.hypot(...L);
  L = L.map(v => v / ln);
  const out = new Float32Array(gx.length);
  for (let i = 0; i < gx.length; i++) out[i] = clamp((-gx[i] * L[0] - gy[i] * L[1] + L[2]) / Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i] + 1));
  return out;
}
function niceInterval(relief) {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) if (relief / step <= 55) return step;
  return 1000;
}
const median = a => percentile(a, [50], Math.max(1, Math.floor(a.length / 200000)))[0];

const TERRAIN_ROADS = {   // class: [width px @2560, brightness]
  motorway: [4.0, 235], trunk: [3.6, 220], primary: [3.0, 205], secondary: [2.4, 175], tertiary: [2.0, 145],
  motorway_link: [1.8, 170], trunk_link: [1.6, 160], primary_link: [1.5, 150], secondary_link: [1.4, 140], tertiary_link: [1.2, 120],
};

/** Terrain map + contour layer (8-bit), as places.build_terrain. */
export function buildTerrain(p, n = 2560) {
  const E = elevation(p), half = p.terrain.half_m;
  const Eu = resize(E, n, n, "bicubic");
  const mpp = (2 * half) / n;
  const [gy, gx] = gradient(Eu, mpp);
  const N = n * n, slope = new Float32Array(N);
  for (let i = 0; i < N; i++) slope[i] = Math.hypot(gx[i], gy[i]);
  const ex = clamp(0.3 / (median(slope) + 1e-4), 1, 40);   // flat places get more exaggeration
  const det = fbm(n, 70, 4, 5);
  for (let i = 0; i < N; i++) det.d[i] -= 0.5;
  const [dy, dx] = gradient(det);
  for (let i = 0; i < N; i++) { dx[i] = gx[i] * ex + dx[i] * 9; dy[i] = gy[i] * ex + dy[i] * 9; }
  const sh = shade(dx, dy);
  const [lo, hi] = percentile(Eu.d, [1, 99], Math.max(1, Math.floor(N / 400000)));
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const h = clamp((Eu.d[i] - lo) / (hi - lo + 1e-6));
    lum[i] = 0.02 + 1.0 * sh[i] ** 1.6 * (0.28 + 0.72 * h ** 1.1);
  }
  const step = niceInterval(hi - lo), con = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const lv = Eu.d[i] / step, fr = lv - Math.floor(lv), gm = (slope[i] * mpp) / step;
    let c = clamp(1.25 - Math.min(fr, 1 - fr) / Math.max(gm, 1e-5));
    c *= 0.5 + 0.5 * (((Math.floor(lv) % 5) + 5) % 5 === 0 ? 1 : 0);
    con[i] = c;
  }
  const s = n / 2560;
  // water
  const wm = new GrayDraw(n);
  for (const [, closed, flat] of p.terrain.water || []) {
    const P = pts(flat, n);
    if (P.length < 2) continue;
    if (closed && P.length >= 3) wm.polygon(P, 255);
    else wm.line(P, 255, Math.max(2, Math.trunc(4 * s)));
  }
  const water = wm.read();
  wm.free();
  const grown = max3(water);
  for (let i = 0; i < N; i++) {
    const w = water.d[i], edge = clamp(grown.d[i] - w);
    lum[i] = lum[i] * (1 - 0.85 * w) + 0.02 * w + edge * 0.28;
  }
  // roads
  const rm = new GrayDraw(n);
  const roads = (p.terrain.roads || []).slice().sort((a, b) => (TERRAIN_ROADS[a[0]] || [0, 0])[1] - (TERRAIN_ROADS[b[0]] || [0, 0])[1]);
  for (const [cls, flat] of roads) {
    const [w, v] = TERRAIN_ROADS[cls] || [1.2, 110];
    const P = pts(flat, n);
    if (P.length >= 2) rm.line(P, v, Math.max(1, Math.round(w * s)));
  }
  const raw = rm.read();
  rm.free();
  const road = blur(raw, 0.6 * s);
  const small = resize(raw, Math.floor(n / 16), Math.floor(n / 16), "box");
  const dens = resize(blur(small, 2), n, n, "bilinear");
  const p995 = percentile(dens.d, [99.5], Math.max(1, Math.floor(N / 400000)))[0];
  const lightsN = fbm(n, 110, 3, 9);
  for (let i = 0; i < N; i++) {
    const dn = clamp(dens.d[i] / (p995 + 1e-6));
    const lights = clamp((lightsN.d[i] - 0.55) * 3) * dn ** 1.5;
    lum[i] += road.d[i] * 0.32 + lights * 0.22;
  }
  return { map: toU8({ w: n, h: n, d: lum }), contours: toU8({ w: n, h: n, d: con }) };
}

const CITY_ROADS = {   // class: [width metres, brightness]
  motorway: [20, 150], trunk: [16, 145], primary: [14, 140], secondary: [12, 132], tertiary: [10, 124],
  motorway_link: [9, 130], trunk_link: [8, 128], primary_link: [8, 125], secondary_link: [7, 120],
  tertiary_link: [7, 118], residential: [7, 108], unclassified: [7, 105], living_street: [6, 100],
  road: [6, 100], service: [4, 88], pedestrian: [5, 95], track: [3, 70],
  footway: [1.5, 72], path: [1.5, 66], cycleway: [1.5, 70], steps: [1.5, 66], bridleway: [1.5, 60],
};
const HOUSE_ROADS = { residential: 1, unclassified: 1, living_street: 1, tertiary: 1, service: 0.5, road: 1 };
const byBright = (a, b) => (CITY_ROADS[a[0]] || [0, 0])[1] - (CITY_ROADS[b[0]] || [0, 0])[1];

/** Stand-in houses along real residential streets, for places OSM has no footprints for (deterministic). */
function fakeHouses(c, half, n, roadPx) {
  const r = rng(1234), ppm = n / (2 * half);
  const G = Math.floor(n / 4) + 1, taken = new Uint8Array(G * G), out = [];
  for (const [cls, flat] of c.roads || []) {
    const keep = HOUSE_ROADS[cls];
    if (!keep) continue;
    const rw = (CITY_ROADS[cls] || [7, 0])[0];
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const p0 = [flat[i] * 2 * half, flat[i + 1] * 2 * half], p1 = [flat[i + 2] * 2 * half, flat[i + 3] * 2 * half];
      const seg = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (seg < 8) continue;
      const u = [(p1[0] - p0[0]) / seg, (p1[1] - p0[1]) / seg], nrm = [-u[1], u[0]];
      let s = r.uniform(4, 14);
      while (s < seg - 4) {
        for (const side of [-1, 1]) {
          if (r.random() > 0.82 * keep) continue;
          const w = r.uniform(11, 17), dpt = r.uniform(8, 13), off = rw / 2 + r.uniform(9, 16) + dpt / 2;
          const cen = [p0[0] + u[0] * s + nrm[0] * side * off, p0[1] + u[1] * s + nrm[1] * side * off];
          const px = cen[0] * ppm, py = cen[1] * ppm;
          if (!(px >= 4 && px < n - 4 && py >= 4 && py < n - 4)) continue;
          const gx = Math.floor(px) >> 2, gy = Math.floor(py) >> 2, rr = Math.max(1, Math.trunc((7 * ppm) / 4));
          let hit = roadPx[Math.floor(py) * n + Math.floor(px)];
          for (let yy = Math.max(0, gy - rr); !hit && yy <= Math.min(G - 1, gy + rr); yy++)
            for (let xx = Math.max(0, gx - rr); xx <= Math.min(G - 1, gx + rr); xx++) if (taken[yy * G + xx]) { hit = 1; break; }
          if (hit) continue;
          taken[gy * G + gx] = 1;
          const a = Math.atan2(u[1], u[0]) + r.normal(0, 0.05), ca = Math.cos(a), sa = Math.sin(a), q = [];
          for (const [qx, qy] of [[-w / 2, -dpt / 2], [w / 2, -dpt / 2], [w / 2, dpt / 2], [-w / 2, dpt / 2]])
            q.push((cen[0] + qx * ca - qy * sa) / (2 * half), (cen[1] + qx * sa + qy * ca) / (2 * half));
          out.push(q);
        }
        s += r.uniform(22, 34);
      }
    }
  }
  return out;
}

/** Real ground relief under the close-up, cut from the terrain elevation grid. */
function relief(p, c, n) {
  const E = elevation(p), half = c.half_m, k = half / p.terrain.half_m, m = E.w;
  const Ec = resize(E, n, n, "bicubic", [m * (0.5 - k / 2), m * (0.5 - k / 2), m * (0.5 + k / 2), m * (0.5 + k / 2)]);
  const [gy, gx] = gradient(Ec, (2 * half) / n);
  const sl = new Float32Array(gx.length);
  for (let i = 0; i < sl.length; i++) sl[i] = Math.hypot(gx[i], gy[i]);
  const ex = clamp(0.25 / (median(sl) + 1e-4), 1, 30);
  for (let i = 0; i < gx.length; i++) { gx[i] *= ex; gy[i] *= ex; }
  return shade(gx, gy);
}

/** Close-up from the real satellite view: graded to the ORIS look, real streets traced on top. */
async function cityFromImagery(p, c, n) {
  const half = c.half_m, ppm = n / (2 * half), N = n * n;
  const sat = await decodeGray(c.imagery.data, n, n);
  for (let i = 0; i < N; i++) sat.d[i] = Math.floor(sat.d[i] * 255);
  sat.d = autocontrast(sat.d, 1);
  // UnsharpMask(radius=2, percent=70, threshold=2)
  const bl = blur(sat, 2);
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = sat.d[i];
    const diff = v - bl.d[i];
    if (Math.abs(diff) >= 2) v = clamp(v + diff * 0.7, 0, 255);
    a[i] = (Math.round(v) / 255) ** 1.3 * 0.82;
  }
  const lines = new GrayDraw(n);
  for (const [cls, flat] of (c.roads || []).slice().sort(byBright)) {
    const [w, v] = CITY_ROADS[cls] || [4, 85];
    const P = pts(flat, n);
    if (P.length >= 2) lines.line(P, v, Math.max(1, Math.round(w * ppm * 0.45)));
  }
  for (const flat of c.buildings || []) {
    const P = pts(flat, n);
    if (P.length >= 3) lines.polygon(P, null, 150);
  }
  const r = blur(lines.read(), 0.6);
  lines.free();
  const rel = relief(p, c, n);
  for (let i = 0; i < N; i++) a[i] = clamp((a[i] * (1 - 0.35 * r.d[i]) + r.d[i] * 0.5) * (0.85 + 0.25 * rel[i]));
  return { map: toU8({ w: n, h: n, d: a }) };
}

/** Close-up map (8-bit), as places.build_city. */
export async function buildCity(p, n = 2048) {
  const c = p.city;
  if (c.imagery) {
    try { return await cityFromImagery(p, c, n); } catch (e) { console.warn("satellite image unreadable, using map data", e); }
  }
  const half = c.half_m, ppm = n / (2 * half), N = n * n;
  const r = rng(3);
  const base = fbm(n, 6, 7, 31);
  for (let i = 0; i < N; i++) base.d[i] = 0.08 + 0.09 * base.d[i];
  const d = new GrayDraw(n);
  d.putFloat(base);
  for (const flat of c.green || []) { const P = pts(flat, n); if (P.length >= 3) d.polygon(P, 30); }
  for (const [, closed, flat] of c.water || []) {
    const P = pts(flat, n);
    if (closed && P.length >= 3) d.polygon(P, 10, 80);
    else if (P.length >= 2) d.line(P, 12, Math.max(2, Math.trunc(10 * ppm)));
  }
  for (const [cls, flat] of (c.roads || []).slice().sort(byBright)) {
    const [w, v] = CITY_ROADS[cls] || [4, 85];
    const P = pts(flat, n);
    if (P.length >= 2) d.line(P, v, Math.max(1, Math.round(w * ppm)));
  }
  let houses = c.buildings || [];
  let roadLen = 0;
  for (const [, f] of c.roads || []) for (let i = 0; i + 3 < f.length; i += 2) roadLen += Math.hypot(f[i + 2] - f[i], f[i + 3] - f[i + 1]);
  roadLen *= 2 * half;
  const sparse = houses.length < roadLen / 120;   // OSM has few or no footprints here (suburbs, woods)
  if (sparse && (p.options || {}).fill_houses) {
    const cur = d.read(), roadPx = new Uint8Array(N);
    for (let i = 0; i < N; i++) roadPx[i] = cur.d[i] * 255 > 80 ? 1 : 0;
    houses = houses.concat(fakeHouses(c, half, n, roadPx));
  }
  const sh = Math.max(1, 2.5 * ppm);
  for (const flat of houses) { const P = pts(flat, n); if (P.length >= 3) d.polygon(P.map(([x, y]) => [x + sh, y + sh]), 12); }
  for (const flat of houses) { const P = pts(flat, n); if (P.length >= 3) d.polygon(P, Math.trunc(r.uniform(70, 150))); }
  const a = d.read();
  d.free();
  if (sparse) {   // tree canopy on open ground (not on roads or roofs)
    const trees = fbm(n, 90, 4, 77), fine = fbm(n, 300, 2, 78);
    for (let i = 0; i < N; i++) {
      if (!(a.d[i] < 0.2)) continue;
      const canopy = clamp((trees.d[i] - 0.42) * 3);
      a.d[i] = a.d[i] * (1 - 0.55 * canopy) + canopy * (0.05 + 0.1 * fine.d[i]);
    }
  }
  const rel = relief(p, c, n), grain = fbm(n, 120, 3, 6);
  for (let i = 0; i < N; i++) a.d[i] = clamp(a.d[i] * (0.8 + 0.45 * rel[i]) * (0.85 + 0.3 * grain.d[i]));
  return { map: toU8(a) };
}

/** Cloud noise texture (oris.build_clouds). */
export function buildClouds(n = 1024) {
  return toU8(fbm(n, 4, 8, 21, 0.55));
}

/** Real reference points around the target: hilltops (with real height), lakes/ponds and road junctions.
 *  World coords of the terrain square. Returns [[x, y, label]], nearest first, spread out. */
export function landmarks(p, k = 7, near = [0.035, 0.2]) {
  const half = p.terrain.half_m, E = elevation(p), S = 160;
  const Es = resize(E, S, S, "bilinear");
  const cands = [];
  const r = Math.max(2, Math.trunc((S * 350) / (2 * half)));
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      let mx = -1e9, mn = 1e9;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(S - 1, Math.max(0, j + dy));
        for (let dx = -r; dx <= r; dx++) {
          const v = Es.d[yy * S + Math.min(S - 1, Math.max(0, i + dx))];
          if (v > mx) mx = v;
          if (v < mn) mn = v;
        }
      }
      const v = Es.d[j * S + i];
      if (v >= mx && v - mn > 8) cands.push(["hill", (i + 0.5) / S, (j + 0.5) / S, `HILL ${Math.round(v)}M`, v - mn]);
    }
  for (const [, closed, flat] of p.terrain.water || []) {
    if (!closed || flat.length < 6) continue;
    const n = flat.length / 2;
    let a = 0, cx = 0, cy = 0;
    for (let q = 0; q < n; q++) {
      const x = flat[2 * q], y = flat[2 * q + 1], xp = flat[2 * ((q + n - 1) % n)], yp = flat[2 * ((q + n - 1) % n) + 1];
      a += x * yp - y * xp;
      cx += x; cy += y;
    }
    const area = 0.5 * Math.abs(a) * (2 * half) ** 2;
    if (area > 6000) cands.push(["water", cx / n, cy / n, "WATER", area / 1e4]);
  }
  const seen = new Map();
  (p.terrain.roads || []).forEach(([, flat], idx) => {
    for (let q = 0; q + 1 < flat.length; q += 2) {
      const kk = flat[q] + "," + flat[q + 1];
      if (!seen.has(kk)) seen.set(kk, new Set());
      seen.get(kk).add(idx);
    }
  });
  for (const [kk, ways] of seen) if (ways.size >= 2) { const [x, y] = kk.split(",").map(Number); cands.push(["jct", x, y, "JCT", ways.size]); }
  const out = [], per = { hill: 0, water: 0, jct: 0 }, cap = { hill: 3, water: 2, jct: 3 };
  cands.sort((a, b) => Math.hypot(a[1] - 0.5, a[2] - 0.5) - Math.hypot(b[1] - 0.5, b[2] - 0.5));
  for (const [kind, x, y, label] of cands) {
    const d = Math.hypot(x - 0.5, y - 0.5);
    if (!(near[0] <= d && d <= near[1]) || per[kind] >= cap[kind]) continue;
    if (out.some(([ox, oy]) => Math.hypot(x - ox, y - oy) < 0.045)) continue;
    out.push([x, y, `${label} · ${((d * 2 * half) / 1000).toFixed(1)}KM`]);
    per[kind]++;
    if (out.length >= k) break;
  }
  return out;
}

/** Last mip level of a texture (what the GRID FIX minimap shows), as floats 0..1. */
export function miniOf(tex8) {
  let w = tex8.w;
  while (w > 600) w = Math.floor(w / 2);
  const f = gimg(tex8.w, tex8.h);
  for (let i = 0; i < f.d.length; i++) f.d[i] = tex8.d[i] / 255;
  return resize(f, w, w, "lanczos");
}
