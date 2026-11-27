// HUD pieces (port of hud.py). Coordinates are 1920x1080 design px.
import { ACC, DARK, GLYPH_SCRAMBLE, INK, MARK, PALE, RED, clamp, hsh, mixc, ramp, rng, typed } from "./util.js";

const col_ = alert => mixc(INK, RED, alert);
const pad = (n, w) => String(n).padStart(w, "0");

// ─────────────────────────── screen chrome ───────────────────────────
export function chrome(ov, t, f, cfg, alert = 0, lowFps = false) {
  const clock = (cfg.clock ?? 21 * 3600 + 6 * 60) + Math.trunc(t);
  const hh = Math.floor(clock / 3600) % 24, mm = Math.floor(clock / 60) % 60, ss = clock % 60;
  const fps = lowFps ? String(Math.trunc(5 + 4 * hsh(Math.floor(f / 4)))) : "30";
  ov.text([8, 6], "FPS:", INK, 0.85, 13);
  ov.text([50, 6], fps, lowFps ? RED : INK, 0.95, 13);
  ov.text([80, 6], `PING: ${41 + Math.trunc(4 * hsh(Math.floor(f / 20)))} MS   PACKET LOSS: 0 %   ` +
    `CORE: ${70 + Math.trunc(5 * hsh(Math.floor(f / 45), 2))}°   ${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}`, INK, 0.85, 13);
  ov.line([[40, 40], [1880, 40]], INK, 0.16, 3);
  ov.line([[40, 40], [440, 40]], INK, 0.45, 3);
  ov.text([44, 48], cfg.header ?? "TACTICAL SURVEILLANCE", INK, 0.6, 12, "mono", "la", 1.2);
  const title = cfg.title ?? MARK;
  ov.text([44, 66], title, INK, 0.16, 48, title === MARK ? "glyph" : "bold");
  (cfg.title_lines || []).forEach((l, i) => ov.text([46, 124 + i * 15], l, INK, 0.13, 11));
  const [x0, y0, x1, y1] = [40, 60, 1880, 1044];
  ov.rect(x0, y0, x1 - x0, y1 - y0, INK, 0.07);
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]])
    ov.line([[cx + 26 * sx, cy], [cx, cy], [cx, cy + 26 * sy]], INK, 0.45, 2);
  ov.line([[1800, 118], [1840, 118], [1840, 760]], INK, 0.1, 1);
  (cfg.left_ticks || ["0700", "0800", "0900", "1000"]).forEach((lab, i) => {
    const y = 380 + i * 45;
    ov.line([[66, y], [86, y]], INK, 0.3);
    ov.text([92, y - 7], lab, INK, 0.25, 10);
  });
  (cfg.sys_left || []).forEach((l, i) => ov.text([130, 806 + i * 15], l, INK, 0.38, 10));
  (cfg.sys_right || []).forEach((l, i) => ov.text([1782, 184 + i * 15], l, INK, 0.55, 10, "mono", "ra"));
  ov.text([1782, 300], `LATENCY: ${8 + Math.trunc(3 * hsh(Math.floor(f / 15), 5))}ms`, INK, 0.75, 11, "mono", "ra");
  for (let i = 0; i < 11; i++) {
    const x = 720 + i * 78, a = 0.16 + 0.5 * (hsh(i, Math.floor(f / 8)) > 0.62 ? 1 : 0);
    ov.text([x, 1013], `AOI-${2031 + (i % 3)}`, INK, a, 9);
    ov.text([x, 1027], `LAT-${1184 + ((i * 7) % 5)}`, INK, a * 0.8, 9);
  }
  (cfg.footer_left || []).forEach((l, i) => ov.text([70 + i * 205, 1020], l, INK, 0.32, 9));
  let digits = "";
  for (let i = 0; i < 22; i++) digits += Math.trunc(hsh(f, i) * 10);
  ov.text([8, 1061], digits, INK, 0.55, 12);
  brand(ov, 1650, 1018, cfg);
}

export function brand(ov, x, y, cfg) {
  ov.poly([[x, y], [x + 22, y - 12], [x + 44, y], [x + 22, y + 12], [x + 22, y + 4], [x + 32, y], [x + 22, y - 4], [x + 12, y]], INK, 0.3);
  ov.text([x + 54, y - 13], cfg.brand ?? "ORIS", INK, 0.38, 14, "bold");
  ov.text([x + 54, y + 4], cfg.brand_sub ?? "SURVEILLANCE SYSTEMS", INK, 0.3, 9, "mono", "la", 1);
}

/** The ⊙ℝ⥍§ glyph mark (corner logo) — glitches now and then. */
export function mark(ov, cx, cy, size, t, f, col = ACC, a = 1) {
  const glitching = hsh(Math.floor(f / 2), 9) > 0.8;
  const dx = glitching ? (hsh(f, 1) - 0.5) * 16 : 0;
  if (glitching) {
    ov.text([cx + dx + 6, cy], MARK, RED, 0.55 * a, size, "glyph", "mm");
    ov.text([cx + dx - 4, cy], MARK, PALE, 0.3 * a, size, "glyph", "mm");
  }
  ov.text([cx + dx, cy], MARK, col, a, size, "glyph", "mm");
}

/** The glyph mark appearing glyph by glyph: each one scrambles through symbols, then locks. */
export function markResolve(ov, cx, cy, size, t, t0, step = 0.12, scramble = 0.12, col = ACC, a = 1, spacing = 0) {
  const w = ov.text_w(MARK, size, "glyph", spacing);
  let x = cx - w / 2;
  [...MARK].forEach((ch, i) => {
    const ts = t0 + i * step, cw = ov.text_w(ch, size, "glyph");
    if (t >= ts) {
      if (t < ts + scramble) {
        const g = GLYPH_SCRAMBLE[Math.floor(hsh(t * 40, i) * GLYPH_SCRAMBLE.length)];
        ov.text([x + cw / 2, cy], g, PALE, a * 0.7, size, "glyph", "mm");
      } else {
        const pop = 1 + 0.25 * (1 - ramp(t, ts + scramble, ts + scramble + 0.12, "out"));
        ov.text([x + cw / 2, cy], ch, col, a, size * pop, "glyph", "mm");
      }
    }
    x += cw + spacing;
  });
  return t0 + (MARK.length - 1) * step + scramble;
}

// ─────────────────────────── panels ───────────────────────────
function signalLost(ov, x, y, w, h) {
  ov.rect(x, y, w, h, RED, 0.06, true);
  ov.line([[x, y + h], [x + w, y]], RED, 0.45, 1.5);
  ov.text([x + w - 12, y + h - 20], "SIGNAL_LOST", RED, 0.8, 10, "mono", "ra");
}

/** Turn a grayscale subject picture into a HUD feed: scanlines, moving scan band, flicker, glitch tears. */
export function subjectPicture(gray, t, f, glitch = 0) {
  const { w: W, h: H } = gray, g = new Float32Array(gray.d);
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x++) g[y * W + x] *= 0.45;
  const band = ((t * 0.45) % 1) * H, fl = 0.9 + 0.1 * hsh(f, 21);
  for (let y = 0; y < H; y++) {
    const k = (1 + 0.6 * Math.exp(-(((y - band) / (H * 0.04)) ** 2))) * fl;
    for (let x = 0; x < W; x++) g[y * W + x] *= k;
  }
  if (glitch > 0 || hsh(Math.floor(f / 3), 23) > 0.93) {
    const r = rng(f);
    for (let i = 0; i < 3; i++) {
      const y0 = r.integers(0, H - 4), hh = r.integers(2, Math.max(3, Math.floor(H / 12)));
      const sh = Math.trunc(r.normal(0, W * 0.08));
      for (let y = y0; y < Math.min(H, y0 + hh); y++) {
        const row = g.slice(y * W, y * W + W);
        for (let x = 0; x < W; x++) g[y * W + x] = row[(((x - sh) % W) + W) % W];
      }
    }
  }
  return { w: W, h: H, d: g };
}

export function subjectPanel(ov, x, y, w, h, t, f, cfg, alert = 0, picture = null) {
  const c = col_(alert);
  ov.rect(x, y, w, h, c, 0.4);
  ov.line([[x, y], [x + 40, y]], c, 0.9, 3);
  ov.text([x + 10, y + 10], cfg.subject_head ?? "SUBJECT", c, 0.85, 12, "monob");
  const tag = cfg.subject_tag ?? "RD-1";
  const tw = ov.text_w(tag, 12, "monob") + 12;
  ov.rect(x + w - tw - 6, y + 7, tw, 19, c, 0.8, true);
  ov.text([x + w - 12, y + 9], tag, DARK, 1, 12, "monob", "ra");
  if (alert > 0.5) { signalLost(ov, x, y, w, h); return; }
  (cfg.subject_lines || []).forEach(([l, r], i) => {
    ov.text([x + 10, y + 36 + i * 13], l, INK, 0.45, 9);
    ov.text([x + w - 10, y + 36 + i * 13], r, INK, 0.45, 9, "mono", "ra");
  });
  const bars = () => { for (let i = 0; i < 6; i++) ov.rect(x + w - 16, y + h - 80 + i * 10, 6, 4 + 4 * hsh(i, Math.floor(f / 10)), INK, 0.45, true); };
  if (picture) {
    ov.image(subjectPicture(picture, t, f), x + 8, y + 80, w - 30, h - 88, INK, 0.85);
    bars();
    return;
  }
  const cx = x + w * 0.5, cy = y + h * 0.64;
  for (let k = 0; k < 5; k++) {
    const r = 16 + k * 15, rot = t * 0.35 * (k % 2 ? 1 : -1) + k * 0.4, pts = [];
    for (let i = 0; i < 7; i++) pts.push([cx + r * Math.cos(rot + (i * Math.PI) / 3), cy + r * Math.sin(rot + (i * Math.PI) / 3)]);
    ov.line(pts, INK, 0.1 + 0.06 * k, 1);
  }
  ov.circle([cx, cy], 4, ACC, 0.5 + 0.5 * (Math.sin(t * 6) > 0 ? 1 : 0), 1, true);
  const sy = y + 80 + ((t * 0.45) % 1) * (h - 100);
  ov.line([[x + 8, sy], [x + w - 8, sy]], PALE, 0.35, 1);
  bars();
}

/** GRID FIX as a live minimap. mini = {img, map: fn(world) -> [u, v] in 0..1, foot, route, stops, target, hdg, fov_m, tgt_m}. */
export function gridFix(ov, x, y, w, h, t, f, cfg, alert = 0, mini = null) {
  if (!mini) return radarPanel(ov, x, y, w, h, t, f, cfg, alert);
  const c = col_(alert);
  ov.rect(x, y, w, h, c, 0.35);
  ov.line([[x, y], [x + 34, y]], c, 0.9, 3);
  ov.text([x + 10, y + 10], cfg.radar_head ?? "GRID FIX", c, 0.85, 11, "monob");
  if (alert > 0.5) { signalLost(ov, x, y, w, h); return; }
  const dist = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} KM` : `${Math.round(m)} M`);
  ov.text([x + w - 10, y + 11], `HDG ${pad(Math.round(mini.hdg) % 360, 3)}°`, ACC, 0.85, 9, "mono", "ra");
  ov.text([x + 10, y + 30], `FOV ${dist(mini.fov_m)}`, INK, 0.55, 8);
  ov.text([x + w - 10, y + 30], `TGT ${dist(mini.tgt_m)}`, INK, 0.55, 8, "mono", "ra");
  const ms = Math.min(w - 20, h - 56), mx = x + (w - ms) / 2, my = y + 46;
  ov.image(mini.img, mx, my, ms, ms, INK, 0.5, true);
  ov.rect(mx, my, ms, ms, INK, 0.35);
  const P = pt => { const [u, v] = mini.map(pt); return [mx + Math.min(Math.max(u, -0.02), 1.02) * ms, my + Math.min(Math.max(v, -0.02), 1.02) * ms]; };
  if (mini.route) ov.dashed(mini.route.map(P), ACC, 0.6, 1, 3, 3, t * 12);
  for (const [q, lab, done] of mini.stops || []) {
    const p = P(q);
    ov.circle(p, 3, done ? INK : ACC, 0.95, 1, true);
    ov.text([p[0] + 5, p[1] - 11], lab, done ? INK : ACC, 0.8, 8);
  }
  if (mini.target) ov.circle(P(mini.target), 4 + 2 * (Math.sin(t * 6) > 0 ? 1 : 0), PALE, 0.9, 1);
  const foot = mini.foot.map(P);
  ov.line(foot.concat([foot[0]]), PALE, 0.95, 1.4);
  const fx = foot.reduce((s, p) => s + p[0], 0) / 4, fy = foot.reduce((s, p) => s + p[1], 0) / 4;
  ov.line([[fx - 4, fy], [fx + 4, fy]], PALE, 0.8, 1);
  ov.line([[fx, fy - 4], [fx, fy + 4]], PALE, 0.8, 1);
  const sweep = (t * 1.3) % 1;
  ov.line([[mx, my + sweep * ms], [mx + ms, my + sweep * ms]], ACC, 0.18, 1);
}

export function radarPanel(ov, x, y, w, h, t, f, cfg, alert = 0) {
  const c = col_(alert);
  ov.rect(x, y, w, h, c, 0.35);
  ov.text([x + 10, y + 10], cfg.radar_head ?? "GRID FIX", c, 0.85, 11, "monob");
  (cfg.radar_lines || []).forEach((l, i) => ov.text([x + 10, y + 30 + i * 12], l, INK, 0.35, 8));
  if (alert > 0.5) { signalLost(ov, x, y, w, h); return; }
  const cx = x + w / 2, cy = y + h * 0.68, R = w * 0.38, arc = [];
  for (let a = 205; a < 336; a += 3) arc.push([cx + R * Math.cos((a * Math.PI) / 180), cy + R * Math.sin((a * Math.PI) / 180)]);
  ov.line(arc, INK, 0.55, 1.5);
  ov.line([[x + 14, cy], [x + w - 14, cy]], INK, 0.4, 1);
  ov.dashed([[cx, cy - R - 10], [cx, y + h - 14]], INK, 0.3, 1, 4, 4);
  const sweep = 205 + ((t * 45) % 130);
  for (let k = 0; k < 5; k++) {
    const a = ((sweep - k * 4) * Math.PI) / 180;
    ov.line([[cx, cy], [cx + R * Math.cos(a), cy + R * Math.sin(a)]], ACC, 0.7 - k * 0.13, 1);
  }
  const a = (250 * Math.PI) / 180;
  ov.line([[cx, cy], [cx + R * 1.25 * Math.cos(a), cy + R * 1.25 * Math.sin(a)]], INK, 0.35, 1);
  ov.line([[x + 14, cy + 20], [x + w - 14, cy - 18]], ACC, 0.25, 1);
  ov.circle([cx + 14, cy - 8], 3, ACC, 0.4 + 0.6 * ((t * 2) % 1 > 0.5 ? 1 : 0), 1, true);
  const foot = cfg.radar_foot ?? "28-10-31-64-35";
  ov.text([x + 12, y + h - 16], foot, INK, 0.3, 8);
  ov.text([x + w - 12, y + h - 16], foot, INK, 0.3, 8, "mono", "ra");
}

// ─────────────────────────── map graphics ───────────────────────────
/** World-space circle (draws as an ellipse under tilt). reveal 0..1 sweeps it on. */
export function ring(fr, c, r, col = INK, a = 0.6, w = 1.2, reveal = 1, start = 0, dash = null, phase = 0, n = 220) {
  if (reveal <= 0 || a <= 0) return;
  const m = Math.max(8, Math.trunc(n * reveal)), world = [];
  for (let i = 0; i < m; i++) {
    const ang = start + (2 * Math.PI * reveal * i) / (m - 1);
    world.push([c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]);
  }
  const pts = fr.cam.proj(world);
  if (dash) fr.ov.dashed(pts, col, a, w, dash[0], dash[1], phase);
  else fr.ov.line(pts, col, a, w);
}

export function ticks(fr, c, r, col = INK, a = 0.5, every = 10, length = 0.008, rot = 0, w = 1) {
  for (let d = 0; d < 360; d += every) {
    const q = (d * Math.PI) / 180 + rot, l = length * (d % 90 === 0 ? 2 : 1);
    const p = fr.cam.proj([[c[0] + r * Math.cos(q), c[1] + r * Math.sin(q)], [c[0] + (r - l) * Math.cos(q), c[1] + (r - l) * Math.sin(q)]]);
    fr.ov.line(p, col, a, w);
  }
}

/** Light beam from p0 (screen) to p1 (screen), brighter at the target, with travelling arrowheads. */
export function beam(ov, p0, p1, t, col = PALE, a = 1, reveal = 1, w = 1.6, arrows = 2, speed = 0.45, seed = 0) {
  if (reveal <= 0 || a <= 0) return;
  const end = [p0[0] + (p1[0] - p0[0]) * reveal, p0[1] + (p1[1] - p0[1]) * reveal], n = 14;
  for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n;
    ov.line([[p0[0] + (end[0] - p0[0]) * u0, p0[1] + (end[1] - p0[1]) * u0], [p0[0] + (end[0] - p0[0]) * u1, p0[1] + (end[1] - p0[1]) * u1]],
      col, a * (0.08 + 0.92 * u1 ** 1.6), w);
  }
  const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  for (let k = 0; k < arrows; k++) {
    const u = ((t * speed + k / arrows + seed * 0.37) % 1) ** 0.8 * reveal;
    arrow(ov, [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u], ang, 9, col, a * clamp(u * 3) * 0.95);
  }
}

export function arrow(ov, p, ang, s, col, a) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  ov.poly([[s, 0], [-s * 0.7, s * 0.55], [-s * 0.35, 0], [-s * 0.7, -s * 0.55]].map(([x, y]) => [p[0] + x * ca - y * sa, p[1] + x * sa + y * ca]), col, a);
}

/** Generic top-down craft marker (an original chevron, not any real vehicle). */
export function craft(ov, p, ang, col = ACC, a = 1, s = 16) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  ov.poly([[s * 1.2, 0], [-s * 0.3, s * 0.25], [-s * 0.9, s * 0.95], [-s * 0.55, 0], [-s * 0.9, -s * 0.95], [-s * 0.3, -s * 0.25]]
    .map(([x, y]) => [p[0] + x * ca - y * sa, p[1] + x * sa + y * ca]), col, a);
  ov.circle(p, s * 2.1, col, a * 0.25, 1);
}

export function target(ov, p, t, col = PALE, a = 1) {
  const pulse = (t * 1.1) % 1;
  ov.circle(p, 6, col, a, 1, true);
  ov.circle(p, 10 + 40 * pulse, col, a * (1 - pulse) * 0.7, 1.5);
  for (let k = 0; k < 4; k++) {
    const q = (k * Math.PI) / 2 + t * 0.6;
    ov.line([[p[0] + 16 * Math.cos(q), p[1] + 16 * Math.sin(q)], [p[0] + 24 * Math.cos(q), p[1] + 24 * Math.sin(q)]], col, a * 0.8, 1.5);
  }
}

/** Corner brackets that snap in onto a point, then hold with a small pulse. */
export function lockon(ov, p, t, t0, col = PALE, a = 1) {
  if (a <= 0 || t < t0) return;
  const u = ramp(t, t0, t0 + 0.22, "out");
  const s = 34 - 22 * u + 1.5 * Math.sin((t - t0) * 9) * (u >= 1 ? 1 : 0), L = 6;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = p[0] + sx * s, cy = p[1] + sy * s;
    ov.line([[cx - sx * L, cy], [cx, cy], [cx, cy - sy * L]], col, a * (0.4 + 0.6 * u), 1.5);
  }
  ov.circle(p, 2.5, col, a, 1, true);
}

/** Survey marker: ringed diamond. */
export function node(ov, p, s, col = ACC, a = 1) {
  if (a <= 0) return;
  ov.poly([[p[0], p[1] - s], [p[0] + s, p[1]], [p[0], p[1] + s], [p[0] - s, p[1]]], col, a * 0.9);
  ov.circle(p, s * 1.9, col, a * 0.6, 1.5);
}

export function xmark(ov, p, s, col = RED, a = 1) {
  ov.line([[p[0] - s, p[1] - s], [p[0] + s, p[1] + s]], col, a, 2);
  ov.line([[p[0] - s, p[1] + s], [p[0] + s, p[1] - s]], col, a, 2);
}

export function tri(ov, p, s, col = RED, a = 1) {
  ov.poly([[p[0], p[1] - s], [p[0] + s * 0.9, p[1] + s * 0.6], [p[0] - s * 0.9, p[1] + s * 0.6]], col, a);
}

/** Big ID + boxed caption + status line, typed on from t0, with a leader line to the anchor. */
export function tag(ov, anchor, t, t0, big, line1, line2 = "", { col2 = ACC, alert = 0, alertText = ["HAZARD ALERT", ""], offset = [90, -36] } = {}) {
  const a = ramp(t, t0, t0 + 0.25);
  if (a <= 0) return;
  let x = anchor[0] + offset[0];
  const y = anchor[1] + offset[1];
  const wide = Math.max(ov.text_w(big, 50, "thin"), ov.text_w(line1, 13, "mono", 0.6) + 16, ov.text_w(line2, 12, "mono", 0.8));
  if (x + wide > 1590) {   // would run into the right-hand panels: put the label on the left of the target
    x = anchor[0] - offset[0] - wide;
    ov.line([anchor, [x + wide + 14, y + 18], [x + wide + 4, y + 18]], INK, 0.55 * a, 1);
  } else ov.line([anchor, [x - 14, y + 18], [x - 4, y + 18]], INK, 0.55 * a, 1);
  ov.text([x, y + 18], typed(big, t, t0, 16), INK, 0.95 * a, 50, "thin", "ls");
  const y1 = y + 30, s1 = typed(line1, t, t0 + 0.3, 30);
  if (s1) {
    const w1 = ov.text_w(line1, 13, "mono", 0.6) + 16;
    ov.rect(x, y1, w1 * ramp(t, t0 + 0.3, t0 + 0.5), 20, INK, 0.7 * a, true);
    ov.text([x + 8, y1 + 3], s1, DARK, a, 13, "mono", "la", 0.6);
  }
  const y2 = y1 + 28;
  if (alert > 0) {
    const aw = ov.text_w(alertText[0], 14, "monob", 0.8) + 20;
    ov.rect(x, y2 - 2, aw, 22, RED, 0.85 * alert, true);
    ov.text([x + 10, y2 + 1], alertText[0], INK, alert, 14, "monob", "la", 0.8);
    if (alertText[1]) ov.text([x, y2 + 30], alertText[1], INK, 0.8 * alert, 12, "mono", "la", 0.8);
    return;
  }
  const s2 = typed(line2, t, t0 + 0.7, 28), cur = (t * 3) % 1 > 0.5 ? "_" : " ";
  ov.text([x, y2], s2 + (s2 === line2 ? cur : ""), col2, 0.9 * a, 12, "mono", "la", 0.8);
}
