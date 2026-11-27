// ORIS web — the sequence: one place (scene_demo.py) or a route of several stops (route.py).
//   one place:  BOOT · TERRAIN 0–7.2 s · CITY 7.2–13 s · WIDE 13–17.6 s · OUTRO 17.6–19.5 s
//   route:      overview of all stops → zoom to A → zoom out → shift to B → … → back to the overview → outro
import * as H from "./hud.js";
import * as places from "./places.js";
import { Cam, CamPath } from "./engine.js";
import {
  ACC, DIM, EASE, INK, MARK, PALE, PINK, RED, autocontrast, clamp, decodeGray, dist, hexc, hsh, key, mixc, ramp, resize, typed, win,
} from "./util.js";

// ─────────────── words on screen (the Studio can change most of them) ───────────────
export const TEXT = {
  header: "TACTICAL SURVEILLANCE",
  title: MARK,
  title_lines: ["OBSERVATION / RECON", "INTEGRATED SYSTEM"],
  sys_left: ["SYS // ORIS_NET", "NODE: RD-01", "LINK: SECURE", "SECURITY: AES-256", "UPLINK: STABLE"],
  sys_right: ["SYS // ORIS_NET", "NODE: RD-01", "LINK: SECURE", "STATUS: ONLINE"],
  footer_left: ["> COMMAND VISUALIZATION // OVC", "SCAN MODE: SPATIAL LIDAR", "MATERIAL MAP: INCONSISTENT"],
  subject_head: "SUBJECT", subject_tag: "RD-1",
  subject_lines: [["PROFILE: GROUND", "ACTIVE"], ["SENSOR: HOLD", "TRACKED"], ["POSITION: HOLD", "NAV SYNC"]],
  radar_head: "GRID FIX", radar_lines: ["VECTOR  028", "HEADING 311", "DRIFT   0.4"],
  brand: "ORIS", brand_sub: "SURVEILLANCE SYSTEMS",
  a_id: "OR-07", a_l1: "SURFACE SCAN", a_l2: "ACQUIRING SIGNAL",
  b_id: "B-02", b_l1: "ENVIRONMENTAL SCAN", b_l2: "ANALYZING PARTICLE DENSITY",
  b_alert: ["HAZARD ALERT", "PARTICLE FIELD DETECTED"],
  b_alert_quiet: ["SIGNAL INTERFERENCE", "UPLINK DEGRADED"],
  c_id: "ID-12", c_l1: "CONTAINMENT RADIUS", c_l2: "NAV-LOCK STAT",
  c_l1_quiet: "AREA SURVEY",
};

const T_CITY = [0.5, 0.5];
const GLITCHES = [[2.9, 3.0, 0.35], [5.6, 5.7, 0.5], [10.0, 10.3, 1.0], [12.85, 13.12, 1.0], [15.2, 15.27, 0.4]];
const SWEEP = [13.4, 16.6, -Math.PI / 2];   // shot 3 sweep: start, end, start angle
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SAFE = [170, 190, 1250, 900];          // open screen area (design px): left of the panels, below the title
const CITY_TINT = hexc("#c4ccc8");

// built textures (8-bit) survive between renders of the same place (preview, then full HD)
const BUILT = new Map();
async function built(key, fn) {
  if (!BUILT.has(key)) {
    if (BUILT.size > 12) BUILT.delete(BUILT.keys().next().value);
    BUILT.set(key, await fn());
  }
  return BUILT.get(key);
}
export function forgetTextures() { BUILT.clear(); }

export class Scene {
  constructor(place, fileKey) {
    this.place = place;
    this.key = fileKey;
    this.fps = 30;
    this.duration = 19.5;
  }

  /** Build every texture and the timeline. progress(fraction, words) reports along the way. */
  async setup(e, progress = () => {}) {
    this.e = e;
    this.text = JSON.parse(JSON.stringify(TEXT));
    this.opt = { hazards: true, zone: true, sound: true, alert: true };
    this.picture = null;
    this.place_name = "ORIS";
    this.is_route = false;
    const tick = () => new Promise(r => setTimeout(r, 0));
    progress(0, "cloud layer");
    await tick();
    e.cloud = e.mapTex(await built("clouds", () => places.buildClouds(1024)));
    this.noise = e.cloud;
    const p = this.place;
    await this.applyMeta(p);
    if (places.isRoute(p)) { await this.setupRoute(e, p, progress, tick); return; }
    progress(0.1, "terrain");
    await tick();
    const t = await built(this.key + "|terrain", () => places.buildTerrain(p));
    progress(0.55, "close-up");
    await tick();
    const city = await built(this.key + "|city", () => places.buildCity(p));
    progress(0.9, "landmarks");
    await tick();
    const T = [0.5, 0.5];
    this.marks = (await built(this.key + "|marks", () => places.landmarks(p, 12)))
      .filter(m => !(0.012 < m[0] - T[0] && m[0] - T[0] < 0.135 && -0.035 < m[1] - T[1] && m[1] - T[1] < 0.04)).slice(0, 7);
    this.T = T;
    this.mpw = [2 * p.terrain.half_m, 2 * p.city.half_m];   // metres per world unit: terrain, close-up
    this.terrain = e.mapTex(t.map);
    this.contours = e.mapTex(t.contours);
    this.city = e.mapTex(city.map);
    this.mini_img = await built(this.key + "|mini", () => places.miniOf(t.map));
    progress(1, "ready");
  }

  /** Options, words, subject picture and HUD lines from a place or route file. */
  async applyMeta(p) {
    Object.assign(this.opt, p.options || {});
    const words = p.text || {};
    for (const [k, v] of Object.entries(words)) if (k in TEXT) this.text[k] = v;
    if (words.c_l1) this.text.c_l1_quiet = words.c_l1;
    const lines = this.text.subject_lines.map(l => l.slice());
    for (let k = 0; k < 3; k++) {
      const v = words[`subj_${k + 1}`];
      if (v) { const i = v.indexOf("/"); lines[k] = i < 0 ? [v.trim(), ""] : [v.slice(0, i).trim(), v.slice(i + 1).trim()]; }
    }
    this.text.subject_lines = lines;
    const pic = p.subject && p.subject.image;
    if (pic) {
      try {
        const g = await decodeGray(pic);
        for (let i = 0; i < g.d.length; i++) g.d[i] = Math.floor(g.d[i] * 255);
        g.d = autocontrast(g.d, 1);
        for (let i = 0; i < g.d.length; i++) g.d[i] /= 255;
        this.picture = resize(g, 216, 218, "bicubic");
      } catch (err) { console.warn("subject picture unreadable", err); }
    }
    if (words.alert_title || words.alert_detail)
      for (const k of ["b_alert", "b_alert_quiet"]) { const d = this.text[k]; this.text[k] = [words.alert_title || d[0], words.alert_detail || d[1]]; }
    const [lat, lon] = p.center;
    let ll, extra;
    if (this.opt.coords) {   // real position on screen
      ll = `${Math.abs(lat).toFixed(4)}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}${lon >= 0 ? "E" : "W"}`;
      extra = [`LAT ${lat.toFixed(4)}`, `LON ${lon.toFixed(4)}`];
    } else {                 // default: a made-up grid code, so videos don't give the spot away
      const code = Math.trunc(hsh(lat * 7.1, lon * 3.3) * 1e8);
      ll = `GRID ${String(Math.floor(code / 10000)).padStart(4, "0")}-${String(code % 10000).padStart(4, "0")}`;
      extra = [`GRID REF: ${String(code % 100000).padStart(5, "0")}`];
    }
    this.text.title_lines = [p.name.toUpperCase().slice(0, 28), ll];
    this.place_name = p.name.toUpperCase().slice(0, 24);
    this.code_line = ll;
    this.text.sys_right = TEXT.sys_right.concat(extra);
  }

  get frames() { return Math.round(this.duration * this.fps); }

  frame(fr) {
    const t = fr.t;
    if (this.is_route) { this.routeFrame(fr, t); return; }
    if (t >= 17.6) { this.outro(fr, t); return; }
    if (t < 7.2) this.shotTerrain(fr, t);
    else if (t < 13.0) this.shotCity(fr, t);
    else this.shotWide(fr, t);
    this.boot(fr, t);
    const on = this.opt.alert !== false;
    const alert = on ? win(t, 10.0, 13.0, 0.08) : 0;
    this.hudCommon(fr, t, alert, this.placeMini(fr, t), on && t >= 13.0 && t < 14.5);
    for (const [t0, t1, amt] of this.glitches()) if (t0 <= t && t < t1) fr.glitch = amt;
    if (t > 17.0) this.powerDown(fr, t, 17.0);
  }

  hudCommon(fr, t, alert, mini = null, lowFps = false) {
    H.chrome(fr.hud, t, fr.f, this.text, alert, lowFps);
    H.subjectPanel(fr.hud, 1617, 438, 246, 306, t, fr.f, this.text, alert, this.picture);
    H.gridFix(fr.hud, 1350, 752, 245, 250, t, fr.f, this.text, alert, mini);
    H.mark(fr.hud, 1790, 952, 34, t, fr.f);
  }

  /** HUD flickers off, scan line wipes the map away upward (0.6 s from t0). */
  powerDown(fr, t, t0) {
    const off = ramp(t, t0, t0 + 0.4);
    fr.hud_alpha = off >= 1 ? 0 : (1 - off) * (hsh(fr.f, 41) > 0.35 ? 1 : 0.15);
    const y = 1 - ramp(t, t0 + 0.15, t0 + 0.58, "in");
    fr.reveal_y = y;
    if (t0 + 0.15 <= t && t < t0 + 0.58) fr.scan_y = y;
  }

  /** Live GRID FIX data for a single place: the terrain square, camera footprint, real heading/FOV/distance. */
  placeMini(fr, t) {
    if (!fr.cam) return null;
    const city = 7.2 <= t && t < 13.0, k = this.mpw[1] / this.mpw[0];
    const conv = city ? q => [0.5 + (q[0] - 0.5) * k, 0.5 + (q[1] - 0.5) * k] : q => q;
    const mpw = city ? this.mpw[1] : this.mpw[0];
    const foot = fr.footprint(), tgt = city ? T_CITY : this.T;
    return {
      img: this.mini_img, map: conv, foot, route: null,
      stops: city ? [] : this.marks.slice(0, 4).map(m => [m.slice(0, 2), "", false]),
      target: tgt, hdg: (((-fr.cam.rot * 180) / Math.PI) % 360 + 360) % 360,
      fov_m: dist(foot[2], foot[3]) * mpw, tgt_m: dist(fr.cam.center, tgt) * mpw,
    };
  }

  // ─────────────── boot-up (first 1.4 s) ───────────────
  boot(fr, t) {
    if (t > 1.5) return;
    const on = ramp(t, 0.1, 0.8);
    fr.hud_alpha = on >= 1 ? 1 : hsh(fr.f, 77) > 0.3 ? on : on * 0.2;
    const y = key(t, [[0.25, 0], [1.3, 1, "inout"]]);
    fr.reveal_y = t < 1.3 ? y : 1;
    if (0.25 <= t && t < 1.3) fr.scan_y = y;
    const a = win(t, 0.2, 1.35, 0.15);
    if (a) {
      fr.hud.text([960, 520], typed("ORIS // UPLINK", t, 0.2, 30), INK, a, 26, "monob", "mm", 6);
      fr.hud.text([960, 562], typed("LINK ESTABLISHED", t, 0.55, 34), ACC, a, 13, "mono", "mm", 4);
    }
  }

  // ─────────────── outro title card ───────────────
  outro(fr, t) {
    const T = this.T, end = 1 - ramp(t, 19.15, 19.45);
    fr.set_cam(new Cam(T, key(t, [[17.6, 0.62], [19.5, 0.74]]), key(t, [[17.6, -0.06], [19.5, 0.02]]), 0.18));
    const bg = ramp(t, 17.6, 18.2);
    fr.map(this.terrain, undefined, 0.16 * bg);
    fr.reveal(this.contours, T, 2.0, PALE, 0.22 * bg);
    fr.edgeFade();   // pool of light behind the card
    fr.hud_alpha = 1;
    const cx = 960, cy = 452;
    H.markResolve(fr.hud, cx, cy, 130, t, 17.72, 0.12, 0.12, ACC, end, 14);   // last glyph locks at 18.2
    const pr = (t - 18.2) / 0.9;
    if (pr > 0 && pr < 1) fr.hud.circle([cx, cy], 150 + 300 * pr, ACC, 0.55 * (1 - pr) * end, 2);
    if (t > 18.2 && t < 18.35) fr.addColor(PALE, 0.22 * (1 - ramp(t, 18.2, 18.35)));   // flash (under the HUD)
    const sp = key(t, [[18.3, 22.0], [18.95, 8.0, "out"]]);
    fr.hud.text([cx, 646], typed(this.place_name, t, 18.3, 20), INK, end, 40, "thin", "mm", sp);
    const w = 230 * ramp(t, 18.5, 18.85, "out");
    fr.hud.line([[cx - w / 2, 676], [cx + w / 2, 676]], ACC, end, 1.5);
    const sub = "TRANSMISSION END" + (this.code_line ? `  //  ${this.code_line}` : "");
    fr.hud.text([cx, 698], typed(sub, t, 18.75, 36), DIM, 0.9 * end, 12, "mono", "mm", 3);
    if (t >= 19.1 && t < 19.35) fr.glitch = 0.9;
    fr.fade = end;
  }

  /** Glitch moments; the connection-error one only when that effect is on. */
  glitches() { return GLITCHES.filter(g => this.opt.alert !== false || g[0] !== 10.0); }

  pingTimes() {
    const [t0, t1, a0] = SWEEP, T = this.T;
    return this.marks.map(([mx, my]) => {
      const ang = (((Math.atan2(my - T[1], mx - T[0]) - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return t0 + ((t1 - t0) * ang) / (2 * Math.PI);
    });
  }

  // ─────────────── shot 1: terrain ───────────────
  shotTerrain(fr, t) {
    const T = this.T;
    fr.set_cam(new Cam(key(t, [[0, [T[0] - 0.015, T[1] - 0.02]], [5.8, T]]),
      key(t, [[0, 0.95], [5.8, 0.62, "out"], [7.2, 0.3, "in"]]),
      key(t, [[0, -0.12], [7.2, -0.03]]),
      key(t, [[0, 0.35], [5.8, 0.38], [7.2, 0.55, "in"]])));
    fr.map(this.terrain, undefined, 1.25);
    fr.light(T, key(t, [[0, 0.05], [1.6, 0.16, "out"]]), 0.45, 1.35);
    const sw = win(t, 2.0, 6.0, 0.4);
    if (sw) {
      const ang = (t - 2.0) * 1.7;
      fr.wedge(T, 0.21, ang, 0.55, PALE, 0.22 * sw);
      fr.ov.line([fr.P(T), fr.P([T[0] + 0.21 * Math.cos(ang), T[1] + 0.21 * Math.sin(ang)])], PALE, 0.5 * sw, 1.2);
    }
    fr.clouds(0.8);
    fr.zone(T, key(t, [[0, 0.12], [1.4, 0.34, "out"]]), PALE, 0.35 * (1 - ramp(t, 0.2, 1.6)));
    fr.reveal(this.contours, T, key(t, [[0.3, 0], [2.4, 0.15, "out"]]), PALE, 0.42, 0.04);
    const a = ramp(t, 0.4, 1.0);
    H.ring(fr, T, 0.17, INK, 0.55 * a, 1.2, ramp(t, 0.4, 1.4, "out"), -1.2);
    H.ring(fr, T, 0.27, INK, 0.35 * a, 1.0, ramp(t, 0.6, 1.8, "out"), 0.6);
    H.ticks(fr, T, 0.27, INK, 0.3 * a, 6, 0.008, t * 0.05);
    H.ring(fr, T, 0.31, INK, 0.22 * a, 1.0, ramp(t, 0.8, 2.0), 0, [14, 10], t * 20);
    const p = fr.P(T), rv = ramp(t, 0.8, 1.7, "out");
    [[-80, 1180], [330, 1180], [-120, 790]].forEach((s, i) => H.beam(fr.ov, s, p, t, PALE, 0.9, rv, 1.6, 2, 0.45, i));
    fr.ov.dashed([[560, 1180], p], PALE, 0.4 * rv, 1, 6, 8, t * 30);
    H.target(fr.ov, p, t, PALE, ramp(t, 1.2, 1.5));
    this.marks.slice(0, 4).forEach(([qx, qy, lab], i) => {
      const tl = 2.5 + i * 0.55, a2 = win(t, tl, 6.4, 0.12);
      if (!a2) return;
      const pp = fr.P([qx, qy]);
      H.lockon(fr.ov, pp, t, tl, PALE, a2);
      fr.ov.dashed([p, pp], PALE, 0.35 * a2 * ramp(t, tl, tl + 0.2), 1, 3, 5, t * 20);
      fr.ov.text([pp[0] + 16, pp[1] - 22], typed(lab, t, tl + 0.1, 40), INK, a2 * 0.8, 10);
    });
    H.tag(fr.ov, p, t, 1.8, this.text.a_id, this.text.a_l1, this.text.a_l2);
    fr.fog(ramp(t, 6.0, 7.2, "in"), key(t, [[6.0, 1.0], [7.2, 1.6, "in"]]));
  }

  // ─────────────── shot 2: city ───────────────
  shotCity(fr, t) {
    const T = T_CITY;
    fr.set_cam(new Cam(key(t, [[7.2, [0.5, 0.5]], [13, [0.505, 0.5]]]),
      key(t, [[7.2, 0.46], [8.6, 0.66, "out"], [13, 0.6]]), key(t, [[7.2, 0.25], [13, 0.17]]), 0.22));
    fr.map(this.city, CITY_TINT, 1.0, 0.15);
    fr.light(T, 0.3, 0.32, 1.0);
    fr.clouds(1.0, undefined, 1.15);
    const haz = [{ p: [0.3, 0.36], t: 10.2, r: 0.17 }, { p: [0.4, 0.66], t: 10.6, r: 0.18 }, { p: [0.7, 0.58], t: 11.0, r: 0.19 },
                 { p: [0.6, 0.33], t: 11.3, r: 0.15 }, { p: [0.27, 0.52], t: 11.7, r: 0.15 }];
    if (this.opt.hazards !== false) {
      fr.tint(ACC, 0.18 * ramp(t, 10.5, 12.8));
      fr.hazards(this.noise, haz, ACC);
    }
    const a = ramp(t, 8.0, 8.6);
    const alert = this.opt.alert !== false ? win(t, 10.0, 13.5, 0.08) : 0;
    const ringCol = mixc(INK, RED, alert * 0.5);
    H.ring(fr, T, 0.165, ringCol, 0.75 * a, 1.6, ramp(t, 8.0, 8.9, "out"), 2.4);
    H.ring(fr, T, 0.23, INK, 0.25 * a, 1.0, ramp(t, 8.2, 9.2), 0, [4, 7], t * 15);
    H.ticks(fr, T, 0.165, INK, 0.4 * a, 15, 0.008, -t * 0.08);
    const b1 = [T[0] - 0.155, T[1] - 0.02];
    H.ring(fr, b1, 0.035, INK, 0.6 * ramp(t, 8.6, 9.0), 1.2, ramp(t, 8.6, 9.0));
    const pb = fr.P(b1);
    fr.ov.circle(pb, 3, INK, ramp(t, 8.6, 9.0), 1, true);
    fr.ov.text([pb[0] - 10, pb[1] - 30], "B1", INK, 0.8 * ramp(t, 8.8, 9.0), 11);
    const ang = (-28 * Math.PI) / 180;
    const ps = fr.cam.proj([[T[0] - 0.6 * Math.cos(ang), T[1] - 0.6 * Math.sin(ang)], [T[0] + 0.6 * Math.cos(ang), T[1] + 0.6 * Math.sin(ang)]]);
    const rv = ramp(t, 8.2, 9.2, "out"), mid = [(ps[0][0] + ps[1][0]) / 2, (ps[0][1] + ps[1][1]) / 2];
    fr.ov.dashed([[mid[0] + (ps[0][0] - mid[0]) * rv, mid[1] + (ps[0][1] - mid[1]) * rv], [mid[0] + (ps[1][0] - mid[0]) * rv, mid[1] + (ps[1][1] - mid[1]) * rv]],
      mixc(ACC, RED, alert), 0.8, 1.5, 5, 6, t * 40);
    const pa = fr.P([T[0] + 0.165 * Math.cos(ang), T[1] + 0.165 * Math.sin(ang)]);
    const sang = Math.atan2(ps[1][1] - ps[0][1], ps[1][0] - ps[0][0]);
    H.arrow(fr.ov, pa, sang, 9, INK, rv);
    fr.ov.text([pa[0] + 4, pa[1] - 26], "A2", INK, 0.85 * rv, 11);
    const u = key(t, [[7.2, -0.05], [13, 0.05, "linear"]]);
    const cp = fr.P([T[0] + u * Math.cos(ang), T[1] + u * Math.sin(ang)]);
    H.craft(fr.ov, cp, sang, mixc(ACC, PINK, alert), ramp(t, 7.8, 8.4));
    H.tag(fr.ov, cp, t, 8.7, this.text.b_id, this.text.b_l1, this.text.b_l2, {
      alert: ramp(t, 10.0, 10.15) * (this.opt.alert !== false ? 1 : 0),
      alertText: this.opt.hazards !== false ? this.text.b_alert : this.text.b_alert_quiet, offset: [110, -20],
    });
    fr.fog(1 - ramp(t, 7.2, 8.4, "out"), key(t, [[7.2, 1.6], [8.4, 2.6, "out"]]), [0.05, -0.03]);
  }

  // ─────────────── shot 3: wide / containment ───────────────
  shotWide(fr, t) {
    const T = this.T;
    fr.set_cam(new Cam(key(t, [[13, [T[0] + 0.015, T[1] + 0.01]], [18, T]]), key(t, [[13, 0.82], [18, 0.7]]), -0.06, 0.36));
    fr.map(this.terrain, undefined, 1.15);
    fr.light(T, 0.22, 0.42, 1.25);
    const [s0, s1, a0] = SWEEP;
    if (t > s0) {
      const swept = Math.min(2 * Math.PI, ((t - s0) / (s1 - s0)) * 2 * Math.PI);
      fr.reveal_swept(this.contours, T, 0.3, a0, swept, PALE, 0.45);
      const sa = win(t, s0, s1 + 0.3, 0.3);
      if (sa) {
        const ang = a0 + swept;
        fr.wedge(T, 0.3, ang, 0.5, PALE, 0.25 * sa);
        fr.ov.line([fr.P(T), fr.P([T[0] + 0.3 * Math.cos(ang), T[1] + 0.3 * Math.sin(ang)])], PALE, 0.6 * sa, 1.4);
      }
      H.ring(fr, T, 0.3, INK, 0.3 * ramp(t, s0, s0 + 0.4), 1.0);
    }
    fr.clouds(0.7);
    const R = key(t, [[13.3, 0], [14.1, 0.17, "expo"]]);
    const fill = key(t, [[13.3, 0.7], [14.3, 0.62], [16.6, 0.2], [18, 0.16]]);
    const zone = this.opt.zone !== false;
    if (zone) {
      fr.zone(T, R, RED, fill);
      for (let k = 0; k < 3; k++) {
        const ph = ((((t - 13.6) / 1.4 + k / 3) % 1) + 1) % 1;
        if (t > 13.6) H.ring(fr, T, 0.17 + 0.16 * ph, RED, 0.6 * (1 - ph), 1.4);
      }
      H.ring(fr, T, 0.17, RED, 0.7 * ramp(t, 13.4, 14.0), 1.5);
    }
    H.ring(fr, T, 0.27, ACC, 0.3 * ramp(t, 13.4, 14.2), 1.0, ramp(t, 13.4, 14.4), 0, [3, 6], t * 10);
    const p = fr.P(T);
    H.craft(fr.ov, p, (-150 * Math.PI) / 180, PINK, ramp(t, 13.2, 13.6), 18);
    const pings = this.pingTimes();
    this.marks.forEach(([qx, qy, lab], i) => {
      const tp = pings[i];
      if (t < tp) return;
      const ta = ramp(t, tp, tp + 0.25, "out"), pp = fr.P([qx, qy]), pr = (t - tp) / 1.2;
      if (pr < 1) fr.ov.circle(pp, 8 + 60 * pr, ACC, 0.8 * (1 - pr), 1.5);
      H.node(fr.ov, pp, 9 * (0.5 + 0.5 * ta), ACC, ta);
      fr.ov.text([pp[0] + 14, pp[1] - 18], typed(lab, t, tp + 0.05, 40), INK, ta * 0.8, 10);
    });
    for (let i = 0; i < (zone ? 26 : 0); i++) {
      const q = [0.49 + (hsh(i, 1) - 0.5) * 0.12, 0.565 + (hsh(i, 2) - 0.5) * 0.07];
      const ta = ramp(t, 14.4 + i * 0.04, 14.6 + i * 0.04), pp = fr.P(q), kind = Math.trunc(hsh(i, 3) * 3);
      if (kind === 0) H.xmark(fr.ov, pp, 4, RED, ta * 0.9);
      else if (kind === 1) H.tri(fr.ov, pp, 5, RED, ta * 0.9);
      else fr.ov.circle(pp, 3, RED, ta, 1, true);
    }
    H.tag(fr.ov, p, t, 14.2, this.text.c_id, zone ? this.text.c_l1 : this.text.c_l1_quiet, this.text.c_l2, { col2: INK, offset: [100, -30] });
  }

  // ─────────────── sound design ───────────────
  sounds(m, S) {
    if (this.is_route) { this.routeSounds(m, S); return; }
    const hz = this.opt.hazards !== false, zone = this.opt.zone !== false;
    m.add(0, S.drone(this.duration), 1.0, 0, 0);
    m.add(0.0, S.powerOn(), 0.9, 0, 0.2);
    m.typeOn("ORIS // UPLINK", 0.2, 30, 0.22);
    m.add(0.6, S.blip(1760), 0.5, 0, 0.5);
    m.add(1.5, S.lock(), 0.8, 0, 0.25);
    tagSounds(m, 1.8, this.text.a_id, this.text.a_l1, this.text.a_l2);
    for (let i = 0; i < Math.min(4, this.marks.length); i++) m.add(2.5 + i * 0.55, S.lock(), 0.45, [-0.55, 0.55][i % 2], 0.25);
    m.add(5.2, S.riser(2.0), 1.0, 0, 0.25);
    m.add(6.6, S.whoosh(1.4), 0.9, 0, 0.4);
    m.add(7.2 - 0.8, S.reverseSwell(0.8), 0.6, 0, 0.2);
    m.add(7.2, S.impact(3, 0.8), 0.55, 0, 0.5);
    m.add(8.0, S.ping(), 0.7, 0, 0.45);
    tagSounds(m, 8.7, this.text.b_id, this.text.b_l1, this.text.b_l2);
    if (this.opt.alert !== false) m.add(10.0, S.alarm(2.6), 1.0, 0, 0.3);
    if (hz) m.add(10.4, S.riser(2.4, 8), 0.55, 0, 0.3);
    m.add(13.05 - 0.8, S.reverseSwell(0.8, 9), 0.7, 0, 0.2);
    m.add(13.05, S.impact(), 1.0, 0, 0.6);
    if (zone) m.add(13.3, S.impact(7, 1.4), 0.6, 0, 0.7);
    this.pingTimes().forEach((tt, i) => m.add(tt, S.ping(0.13, [880, 988, 1175][i % 3]), 0.5, (((i * 5) % 7) - 3) / 4, 0.3));
    tagSounds(m, 14.2, this.text.c_id, this.text.c_l1, this.text.c_l2);
    for (const [t0, t1, amt] of this.glitches()) m.add(t0, S.glitch(t1 - t0 + 0.06, Math.trunc(t0 * 10)), 0.5 + 0.5 * amt, 0, 0.1);
    this.outroSounds(m, S, 0);
  }

  /** Power-down + outro sounds; off shifts them (routes end later than 17.6 s). */
  outroSounds(m, S, off) {
    m.add(17.0 + off, S.powerOn().slice().reverse(), 0.7, 0, 0.3);
    m.add(17.7 + off, S.whoosh(0.9, 12), 0.5, 0, 0.5);
    for (let i = 0; i < 4; i++) m.add(17.84 + off + i * 0.12, i === 3 ? S.lock() : S.blip(1200 + 260 * i, i), 0.45, (i - 1.5) / 3, 0.45);
    m.add(18.2 + off - 0.8, S.reverseSwell(0.8, 13), 0.8, 0, 0.3);
    m.add(18.2 + off, S.impact(11, 1.3), 1.0, 0, 0.8);
    m.add(18.2 + off, S.shimmer(1.3), 0.8, 0, 0.9);
    m.typeOn(this.place_name, 18.3 + off, 20, 0.3);
    m.typeOn("TRANSMISSION END", 18.75 + off, 36, 0.18, 2);
    m.add(19.1 + off, S.glitch(0.28, 19), 0.8, 0, 0.2);
  }

  // ═════════════════════════════ routes ═════════════════════════════
  async setupRoute(e, r, progress, tick) {
    this.is_route = true;
    this.route = r;
    this.layout = places.routeLayout(r);
    const out = this.layout.filter(L => !(L.pos[0] >= 0 && L.pos[0] <= 1 && L.pos[1] >= 0 && L.pos[1] <= 1)).map(L => L.name);
    if (out.length) throw new Error(`Stops ${out.join(", ")} fall outside this route's overview map. Press GET MAP DATA again.`);
    const steps = 1 + 2 * this.layout.length;
    let done = 0;
    const step = async what => { progress(done++ / steps, what); await tick(); };
    await step("overview terrain");
    const ov = await built(this.key + "|overview", () => places.buildTerrain(places.part(r, "overview")));
    this.ov_map = e.mapTex(ov.map);
    this.ov_con = e.mapTex(ov.contours);
    this.O_m = r.overview.half_m;
    this.stops = [];
    for (let i = 0; i < this.layout.length; i++) {
      const L = this.layout[i], sp = places.part(r, `stop${i}`), letter = LETTERS[i % 26];
      await step(`stop ${letter} terrain`);
      const t = await built(`${this.key}|stop${i}`, () => places.buildTerrain(sp));
      await step(`stop ${letter} close-up`);
      const city = await built(`${this.key}|stop${i}|city`, () => places.buildCity(sp));
      const [x0, y0, sz] = L.trect, marks = [];
      for (const [mx, my, lab] of await built(`${this.key}|stop${i}|marks`, () => places.landmarks(sp, 10))) {
        if (0.012 < mx - 0.5 && mx - 0.5 < 0.135 && -0.035 < my - 0.5 && my - 0.5 < 0.04) continue;   // keep clear of the label
        marks.push([x0 + mx * sz, y0 + my * sz, lab]);
      }
      this.stops.push({ ...L, i, letter, map: e.mapTex(t.map), con: e.mapTex(t.contours), city: e.mapTex(city.map),
                        marks: marks.slice(0, 3), label: (L.name || `WAYPOINT ${letter}`).toUpperCase().slice(0, 20) });
    }
    this.mini_img = await built(this.key + "|ovmini", () => places.miniOf(ov.map));
    const P = this.stops.map(s => s.pos), xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    this.oc = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    this.V = Math.min(0.95, Math.max(ext * 1.35, Math.max(...this.stops.map(s => s.tsize)) * 1.8));
    let tot = 0;
    for (let k = 0; k + 1 < P.length; k++) tot += dist(P[k], P[k + 1]);
    this.total_m = tot * 2 * this.O_m;
    this.T = this.oc;
    this.marks = [];
    this.buildTimeline();
    progress(1, "ready");
  }

  buildTimeline() {
    const cam = new CamPath(), oc = this.oc, V = this.V;
    // wide shots: turn the map so the route runs bottom-left → top-right (the frame's longest open direction)
    const a = this.stops[0].pos, b = this.stops[this.stops.length - 1].pos;
    let ro;
    if (this.stops.length > 1 && dist(a, b) > 1e-6) {
      ro = -0.42 - Math.atan2(b[1] - a[1], b[0] - a[0]);
      while (ro > Math.PI / 2) ro -= Math.PI;
      while (ro < -Math.PI / 2) ro += Math.PI;
    } else ro = -0.04;
    const wt = 0.2;   // flatter tilt for the widest views
    const fit = (c, span) => {   // keep the view inside the overview map
      span = Math.min(span, 0.95);
      const m = span * 0.62;
      return [[m < 0.5 ? Math.min(Math.max(c[0], m), 1 - m) : 0.5, m < 0.7 ? Math.min(Math.max(c[1], m * 0.7), 1 - m * 0.7) : 0.5], span];
    };
    const add = (t, c, span, rot, tilt, ease = "inout", frame = null) => {
      if (frame) [c, span] = framePoints(frame, rot, tilt, c, span);
      [c, span] = fit(c, span);
      cam.add(t, c, span, rot, tilt, ease);
    };
    const allp = this.stops.map(s => s.pos);
    add(0, oc, V * 1.12, ro - 0.05, wt, "inout", allp);
    add(4.0, oc, V, ro, wt, "inout", allp);
    let t = 4.0;
    const n = this.stops.length;
    for (const s of this.stops) {
      const T = s.pos, ts = s.tsize, cs = s.csize;
      if (s.i > 0) {
        const prev = this.stops[s.i - 1].pos, d = dist(T, prev);
        add(t + 1.1, [(prev[0] + T[0]) / 2, (prev[1] + T[1]) / 2], Math.max(d * 1.6, ts * 2.4), ro, 0.26, "inout", [prev, T]);
        s.travel = [t, t + 2.4]; t += 2.4;
      } else { s.travel = [t, t + 1.8]; t += 1.8; }
      add(t, T, ts * 1.5, -0.06, 0.34);
      s.approach = [t, t + 2.4]; t += 2.4;
      add(t, T, ts * 0.62, -0.03, 0.38, "out");
      s.scan = [t, t + 1.4]; t += 1.4;
      add(t, T, ts * 0.56, -0.02, 0.4);
      s.push = [t, t + 1.5]; t += 1.5;
      add(t, T, cs * 0.62, 0.18, 0.22, "in");
      s.close = [t, t + 3.0]; t += 3.0;
      add(t, T, cs * 0.56, 0.22, 0.22);
      s.pull = [t, t + 1.6]; t += 1.6;
      add(t, T, ts * 1.4, 0.0, 0.32);
      s.last = s.i === n - 1;
    }
    this.t_final = [t, t + 3.6];
    add(t + 2.2, oc, V, ro, wt, "inout", allp);
    add(t + 3.6, oc, V * 1.08, ro + 0.03, wt, "linear", allp);
    t += 3.6;
    this.t_out = t + 0.6;            // power-down ends, outro starts
    this.duration = this.t_out + 1.9;
    this.path = cam;
    const a0 = -Math.PI / 2, f0 = this.t_final[0] + 0.6, f1 = this.t_final[0] + 3.2;
    this.final_pings = this.stops.map(s => {
      const ang = (((Math.atan2(s.pos[1] - oc[1], s.pos[0] - oc[0]) - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return f0 + ((f1 - f0) * ang) / (2 * Math.PI);
    });
    this.final_sweep = [f0, f1, a0];
  }

  activeStop(t) { return this.stops.find(s => s.travel[0] <= t && t < s.pull[1]) || null; }

  routeFrame(fr, t) {
    if (t >= this.t_out) {
      this.T = this.oc;
      this.terrain = this.ov_map;
      this.contours = this.ov_con;
      this.outro(fr, t - this.t_out + 17.6);
      return;
    }
    const cam = this.path.at(t);
    fr.set_cam(cam);
    const S = this.activeStop(t);
    // map layers: overview, then each stop's terrain, then the active stop's satellite close-up
    const layers = [{ tex: this.ov_map, gain: 1.2 }];
    for (const s of this.stops) layers.push({ tex: s.map, rect: s.trect, a: clamp((s.tsize * 3.4 - cam.span) / (s.tsize * 1.8)), gain: 1.25 });
    let sat = 0;
    if (S) {
      sat = ramp(t, S.push[0] + 0.6, S.push[1] - 0.1) * (1 - ramp(t, S.pull[0] + 0.3, S.pull[0] + 1.1));
      layers.push({ tex: S.city, rect: S.crect, a: sat, gain: 1.0, tint: CITY_TINT, feather: 0.04 });
    }
    fr.map_layers(layers, 0.16);
    fr.light(S ? S.pos : this.oc, cam.span * 0.42, 0.45 - 0.1 * sat, 1.25 - 0.6 * sat);   // gentler over satellite imagery
    fr.clouds(0.65 * (1 - sat) + 0.9 * sat, undefined, 1.0 + 0.15 * sat);
    if (t < 4.4) this.routeOverview(fr, t);
    if (S) this.routeStop(fr, t, S);
    this.routeMarkers(fr, t, cam);
    if (t >= this.t_final[0]) this.routeFinal(fr, t);
    let alert = 0;
    if (S && S.last && this.opt.alert !== false) {
      alert = win(t, S.close[0] + 1.2, S.pull[0] + 0.3, 0.08);
      const g0 = S.close[0] + 1.2;
      if (g0 <= t && t < g0 + 0.3) fr.glitch = 1.0;
    }
    this.boot(fr, t);
    this.hudCommon(fr, t, alert, this.routeMini(fr, cam, S));
    if (t > this.t_out - 0.6) this.powerDown(fr, t, this.t_out - 0.6);
  }

  routeOverview(fr, t) {
    const P = this.stops.map(s => s.pos), draw = ramp(t, 1.0, 2.6);
    if (draw > 0 && P.length > 1) {
      const pts = P.map(p => fr.P(p));
      let total = 0;
      for (let k = 0; k + 1 < pts.length; k++) total += dist(pts[k], pts[k + 1]);
      fr.ov.dashed(partial(pts, total * draw), ACC, 0.8, 1.6, 9, 6, t * 25);
    }
    const sw = win(t, 1.0, 4.2, 0.4);
    if (sw) fr.wedge(this.oc, this.V * 0.48, -Math.PI / 2 + (t - 1.0) * 2.0, 0.6, PALE, 0.2 * sw);
    const a = win(t, 1.2, 4.4, 0.3);
    if (a) {
      fr.hud.text([960, 118], typed(`ROUTE // ${this.route.name.toUpperCase().slice(0, 26)}`, t, 1.2, 30), INK, a, 22, "thin", "mm", 6);
      fr.hud.text([960, 150], typed(`WAYPOINTS ${this.stops.length}  ·  TOTAL ${(this.total_m / 1000).toFixed(1)} KM`, t, 1.6, 40), ACC, a * 0.9, 11, "mono", "mm", 3);
    }
  }

  /** Every stop's marker and the route line, visible whenever the camera is zoomed out enough. */
  routeMarkers(fr, t, cam) {
    const P = this.stops.map(s => s.pos);
    this.stops.forEach((s, k) => {
      const vis = clamp((cam.span - s.tsize * 0.9) / (s.tsize * 1.4)), a = vis * ramp(t, 1.4 + k * 0.3, 1.7 + k * 0.3, "out");
      if (a <= 0) return;
      const p = fr.P(s.pos), done = t > s.pull[1], col = done ? INK : ACC;
      H.node(fr.ov, p, 8, col, a);
      const pr = (t - 1.4 - k * 0.3) / 1.2;
      if (pr > 0 && pr < 1) fr.ov.circle(p, 10 + 50 * pr, ACC, 0.7 * (1 - pr) * vis, 1.5);
      fr.ov.text([p[0] + 16, p[1] - 22], `${s.letter} · ${s.label}`, col, a * 0.95, 12, "monob");
      if (done) fr.ov.text([p[0] + 16, p[1] - 6], "CLEARED", INK, a * 0.6, 9, "mono", "la", 1);
    });
    if (P.length > 1 && t > 2.6) {
      for (let k = 0; k + 1 < P.length; k++) {
        const ts = this.stops[k].tsize, a = clamp((cam.span - ts * 1.2) / (ts * 1.4));
        if (a <= 0) continue;
        const p0 = fr.P(P[k]), p1 = fr.P(P[k + 1]);
        fr.ov.dashed([p0, p1], ACC, 0.55 * a, 1.2, 9, 6, t * 25);
        if (t < 4.4) {
          const d = dist(P[k], P[k + 1]) * 2 * this.O_m, mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
          fr.ov.text([mid[0] + 8, mid[1] + 6], typed(`${(d / 1000).toFixed(1)} KM`, t, 2.6 + k * 0.2, 30), INK, a * 0.75 * win(t, 2.6, 4.4, 0.3), 10);
        }
      }
    }
  }

  routeStop(fr, t, S) {
    const T = S.pos, ts = S.tsize, cs = S.csize, [a0] = S.approach, p = fr.P(T);
    if (S.i > 0 && S.travel[0] <= t && t < S.travel[1]) {   // travel: craft runs along the route line
      const prev = this.stops[S.i - 1].pos, u = EASE.inout(ramp(t, S.travel[0], S.travel[1], "linear"));
      const pq = fr.P(prev), pt = fr.P(T);
      H.craft(fr.ov, fr.P([prev[0] + (T[0] - prev[0]) * u, prev[1] + (T[1] - prev[1]) * u]), Math.atan2(pt[1] - pq[1], pt[0] - pq[0]), ACC, 1);
    }
    const vis = win(t, a0, S.push[0] + 0.5, 0.4);
    if (vis) {
      fr.reveal(S.con, T, ts * 0.3 * ramp(t, a0 + 0.2, a0 + 2.0, "out"), PALE, 0.42 * vis, 0.015, S.trect);
      const rv = ramp(t, a0 + 0.3, a0 + 1.1, "out");
      [[-80, 1180], [330, 1180], [-120, 790]].forEach((sp, k) => H.beam(fr.ov, sp, p, t, PALE, 0.85 * vis, rv, 1.6, 2, 0.45, k));
      H.target(fr.ov, p, t, PALE, vis * ramp(t, a0 + 0.9, a0 + 1.2));
      H.ring(fr, T, ts * 0.17, INK, 0.5 * vis, 1.2, ramp(t, a0 + 0.2, a0 + 1.2, "out"), -1.2);
      H.ring(fr, T, ts * 0.27, INK, 0.3 * vis, 1.0, ramp(t, a0 + 0.4, a0 + 1.6, "out"), 0.6);
      S.marks.forEach(([mx, my, lab], k) => {
        const tl = a0 + 1.0 + k * 0.45, am = win(t, tl, S.push[0] + 0.3, 0.12);
        if (!am) return;
        const pp = fr.P([mx, my]);
        H.lockon(fr.ov, pp, t, tl, PALE, am);
        fr.ov.dashed([p, pp], PALE, 0.35 * am * ramp(t, tl, tl + 0.2), 1, 3, 5, t * 20);
        fr.ov.text([pp[0] + 16, pp[1] - 22], typed(lab, t, tl + 0.1, 40), INK, am * 0.8, 10);
      });
      H.tag(fr.ov, p, t, a0 + 0.5, S.label, this.text.a_l1, this.text.a_l2);
    }
    const [sc0] = S.scan, sw = win(t, sc0 - 0.4, S.push[0] + 0.4, 0.3);
    if (sw) fr.wedge(T, ts * 0.21, (t - sc0 + 0.4) * 2.2, 0.55, PALE, 0.22 * sw);
    const [p0, p1] = S.push;   // push in through cloud
    if (p0 - 0.1 <= t && t < p1 + 0.6) {
      const u = (t - p0 + 0.1) / (p1 - p0 + 0.7);
      fr.fog(0.92 * Math.sin(Math.PI * Math.min(Math.max(u, 0), 1)) ** 1.4, 1 + 1.4 * u);
    }
    const [c0, c1] = S.close, ca = win(t, c0 - 0.2, S.pull[0] + 0.4, 0.3);   // close-up
    if (ca) {
      const alert = S.last && this.opt.alert !== false ? win(t, c0 + 1.2, S.pull[0] + 0.3, 0.08) : 0;
      if (S.last && this.opt.hazards !== false) {
        const haz = [[-0.2, -0.14], [-0.1, 0.24], [0.2, 0.06], [0.1, -0.2]].map(([dx, dy], k) =>
          ({ p: [T[0] + dx * cs, T[1] + dy * cs], t: c0 + 1.4 + k * 0.3, r: cs * 0.2, grow: 1.6 }));
        fr.tint(ACC, 0.16 * ramp(t, c0 + 1.6, c1));
        fr.hazards(this.noise, haz, ACC);
      }
      H.ring(fr, T, cs * 0.33, mixc(INK, RED, alert * 0.5), 0.75 * ca, 1.6, ramp(t, c0 - 0.1, c0 + 0.8, "out"), 2.4);
      H.ring(fr, T, cs * 0.46, INK, 0.25 * ca, 1.0, ramp(t, c0, c0 + 1.0), 0, [4, 7], t * 15);
      H.ticks(fr, T, cs * 0.33, INK, 0.4 * ca, 15, cs * 0.03, -t * 0.08);
      const pc = fr.P(T);
      H.target(fr.ov, pc, t, mixc(ACC, PINK, alert), ca);
      H.tag(fr.ov, pc, t, c0 + 0.2, `${S.letter}-${String(S.i + 1).padStart(2, "0")}`, this.text.b_l1, this.text.b_l2, {
        alert: alert ? ramp(t, c0 + 1.2, c0 + 1.35) : 0,
        alertText: this.opt.hazards === false ? this.text.b_alert_quiet : this.text.b_alert, offset: [110, -20],
      });
    }
  }

  routeFinal(fr, t) {
    const [f0, f1, a0] = this.final_sweep;
    if (t > f0) {
      const swept = Math.min(2 * Math.PI, ((t - f0) / (f1 - f0)) * 2 * Math.PI), R = this.V * 0.5;
      fr.reveal_swept(this.ov_con, this.oc, R, a0, swept, PALE, 0.35);
      const sa = win(t, f0, f1 + 0.3, 0.3);
      if (sa) {
        const ang = a0 + swept;
        fr.wedge(this.oc, R, ang, 0.4, PALE, 0.11 * sa);
        fr.ov.line([fr.P(this.oc), fr.P([this.oc[0] + R * Math.cos(ang), this.oc[1] + R * Math.sin(ang)])], PALE, 0.55 * sa, 1.3);
      }
    }
    if (this.opt.zone !== false) {
      const last = this.stops[this.stops.length - 1];
      const Rz = key(t, [[this.t_final[0] + 0.8, 0], [this.t_final[0] + 1.5, last.tsize * 0.16, "expo"]]);
      fr.zone(last.pos, Rz, RED, key(t, [[this.t_final[0] + 0.8, 0.65], [this.t_final[1], 0.22]]));
      if (Rz > 0) H.ring(fr, last.pos, Rz, RED, 0.7, 1.4);
    }
    this.stops.forEach((s, k) => {
      const pr = (t - this.final_pings[k]) / 1.2;
      if (pr > 0 && pr < 1) fr.ov.circle(fr.P(s.pos), 10 + 70 * pr, ACC, 0.8 * (1 - pr), 1.5);
    });
  }

  routeMini(fr, cam, S) {
    const mpw = 2 * this.O_m, foot = fr.footprint(), tgt = S ? S.pos : this.oc;
    return {
      img: this.mini_img, map: q => q, foot, route: this.stops.map(s => s.pos),
      stops: this.stops.map(s => [s.pos, s.letter, fr.t > s.pull[1]]), target: tgt,
      hdg: (((-cam.rot * 180) / Math.PI) % 360 + 360) % 360, fov_m: dist(foot[2], foot[3]) * mpw, tgt_m: dist(cam.center, tgt) * mpw,
    };
  }

  routeSounds(m, S) {
    m.add(0, S.drone(this.duration), 1.0, 0, 0);
    m.add(0.0, S.powerOn(), 0.9, 0, 0.2);
    m.typeOn("ORIS // UPLINK", 0.2, 30, 0.22);
    m.add(0.6, S.blip(1760), 0.5, 0, 0.5);
    m.typeOn("ROUTE // " + this.route.name.toUpperCase().slice(0, 26), 1.2, 30, 0.2, 2);
    m.add(1.0, S.riser(1.6, 21), 0.4, 0, 0.25);
    this.stops.forEach((_, k) => m.add(1.4 + k * 0.3, S.ping(0.13, [880, 988, 1175][k % 3]), 0.55, (k - 1) / 3, 0.3));
    for (const s of this.stops) {
      const a0 = s.approach[0];
      if (s.i > 0) m.add(s.travel[0], S.whoosh(2.0, 30 + s.i), 0.7, 0, 0.4);
      m.add(a0 + 1.0, S.lock(), 0.7, 0, 0.25);
      tagSounds(m, a0 + 0.5, s.label, this.text.a_l1, this.text.a_l2);
      s.marks.forEach((_, k) => m.add(a0 + 1.0 + k * 0.45, S.lock(), 0.4, [-0.55, 0.55][k % 2], 0.25));
      const [p0, p1] = s.push;
      m.add(p0 - 0.6, S.riser(1.8, 40 + s.i), 0.9, 0, 0.25);
      m.add(p0 + 0.4, S.whoosh(1.4, 50 + s.i), 0.8, 0, 0.4);
      m.add(p1 - 0.8, S.reverseSwell(0.8, 60 + s.i), 0.5, 0, 0.2);
      m.add(p1, S.impact(70 + s.i, 0.8), 0.5, 0, 0.5);
      const c0 = s.close[0];
      m.add(c0, S.ping(), 0.6, 0, 0.45);
      tagSounds(m, c0 + 0.2, `${s.letter}-${String(s.i + 1).padStart(2, "0")}`, this.text.b_l1, this.text.b_l2);
      if (s.last && this.opt.alert !== false) { m.add(c0 + 1.2, S.alarm(2.6), 1.0, 0, 0.3); m.add(c0 + 1.2, S.glitch(0.3, 77), 0.9, 0, 0.1); }
      if (s.last && this.opt.hazards !== false) m.add(c0 + 1.4, S.riser(2.0, 80), 0.5, 0, 0.3);
      m.add(s.pull[0], S.whoosh(1.6, 90 + s.i), 0.7, 0, 0.4);
    }
    const f0 = this.t_final[0];
    if (this.opt.zone !== false) m.add(f0 + 0.8, S.impact(7, 1.4), 0.6, 0, 0.7);
    this.final_pings.forEach((tp, k) => m.add(tp, S.ping(0.13, [880, 988, 1175][k % 3]), 0.5, (((k * 5) % 7) - 3) / 4, 0.3));
    this.outroSounds(m, S, this.t_out - 17.6);
  }
}

function tagSounds(m, t0, big, l1, l2) {   // data ticks matching hud.tag's type-on speeds
  m.typeOn(big, t0, 16, 0.35);
  m.typeOn(l1, t0 + 0.3, 30, 0.18, 2);
  m.typeOn(l2, t0 + 0.7, 28, 0.18, 2);
}

/** Find a camera center/span that shows all `pts` inside SAFE (never zooming in past `span`). */
function framePoints(pts, rot, tilt, c, span) {
  const [x0, y0, x1, y1] = SAFE;
  for (let it = 0; it < 40; it++) {
    const cam = new Cam(c, span, rot, tilt), q = cam.proj(pts);
    const bx0 = Math.min(...q.map(p => p[0])), by0 = Math.min(...q.map(p => p[1]));
    const bx1 = Math.max(...q.map(p => p[0])), by1 = Math.max(...q.map(p => p[1]));
    const fits = bx0 >= x0 && bx1 <= x1 && by0 >= y0 && by1 <= y1;
    if (bx1 - bx0 > (x1 - x0) * 0.92 || by1 - by0 > (y1 - y0) * 0.92) { span *= 1.08; continue; }
    const dx = (x0 + x1) / 2 - (bx0 + bx1) / 2, dy = (y0 + y1) / 2 - (by0 + by1) / 2;
    if (fits && Math.abs(dx) < 20 && Math.abs(dy) < 20) break;
    const Hc = cam.H(), Hi = invert(Hc);
    const a = applyH(Hi, 960, 540), b = applyH(Hi, 960 - dx, 540 - dy);
    c = [c[0] + (b[0] - a[0]) * 0.8, c[1] + (b[1] - a[1]) * 0.8];
  }
  return [c, span];
}
function invert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const applyH = (Hm, x, y) => { const w = Hm[2][0] * x + Hm[2][1] * y + Hm[2][2]; return [(Hm[0][0] * x + Hm[0][1] * y + Hm[0][2]) / w, (Hm[1][0] * x + Hm[1][1] * y + Hm[1][2]) / w]; };

/** The first `length` px of a polyline. */
function partial(pts, length) {
  const out = [pts[0]];
  let left = length;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], d = dist(a, b);
    if (d >= left) { const u = d ? left / d : 0; out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); return out; }
    out.push(b);
    left -= d;
  }
  return out;
}
