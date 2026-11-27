"""
ORIS demo — an 18 s tactical-surveillance sequence in three shots.

  0.0 –  1.4  BOOT      HUD powers on, scan line reveals the map
  0.0 –  7.2  TERRAIN   scan disk opens, contours reveal, beams lock the target, push in through cloud
  7.2 – 13.0  CITY      fog clears, flight path + rings, environmental scan, HAZARD ALERT, yellow clouds bloom
 13.0 – 17.6  WIDE      glitch cut back out, lidar sweep pings real landmarks (+ red zone if on)
 17.6 – 19.5  OUTRO     ⊙ℝ⥍§ resolves glyph by glyph, place name, TRANSMISSION END
 Sound is synthesized and added automatically (--no-audio to skip).

Render:
  python scene_demo.py --preview          quick 960x540 check
  python scene_demo.py                    full 1080p  -> renders/oris_demo.mp4
  python scene_demo.py --still 9.5        one PNG frame at 9.5 s
  python scene_demo.py --from 7 --to 13   just one section

  python scene_demo.py --place places/place_x.json   render a real location picked in pick.html
  add --coords to show its real lat/lon in the HUD (hidden by default)

Change the words in TEXT, the timings in the shot functions.
"""
import math
import os

import numpy as np

import oris as O
from oris import Cam, key, ramp, win, INK, ACC, RED, PINK, PALE, DIM, hexc
import hud as H
import places
from route import RouteMixin

# ─────────────── words on screen (edit freely) ───────────────
TEXT = dict(
    header="TACTICAL SURVEILLANCE",
    title=O.MARK,
    title_lines=["OBSERVATION / RECON", "INTEGRATED SYSTEM"],
    sys_left=["SYS // ORIS_NET", "NODE: RD-01", "LINK: SECURE", "SECURITY: AES-256", "UPLINK: STABLE"],
    sys_right=["SYS // ORIS_NET", "NODE: RD-01", "LINK: SECURE", "STATUS: ONLINE"],
    footer_left=["> COMMAND VISUALIZATION // OVC", "SCAN MODE: SPATIAL LIDAR", "MATERIAL MAP: INCONSISTENT"],
    subject_head="SUBJECT", subject_tag="RD-1",
    subject_lines=[("PROFILE: GROUND", "ACTIVE"), ("SENSOR: HOLD", "TRACKED"), ("POSITION: HOLD", "NAV SYNC")],
    radar_head="GRID FIX", radar_lines=["VECTOR  028", "HEADING 311", "DRIFT   0.4"],
    brand="ORIS", brand_sub="SURVEILLANCE SYSTEMS",
    a_id="OR-07", a_l1="SURFACE SCAN", a_l2="ACQUIRING SIGNAL",
    b_id="B-02", b_l1="ENVIRONMENTAL SCAN", b_l2="ANALYZING PARTICLE DENSITY",
    b_alert=("HAZARD ALERT", "PARTICLE FIELD DETECTED"),
    b_alert_quiet=("SIGNAL INTERFERENCE", "UPLINK DEGRADED"),   # used when hazard clouds are off
    c_id="ID-12", c_l1="CONTAINMENT RADIUS", c_l2="NAV-LOCK STAT",
    c_l1_quiet="AREA SURVEY",                                    # used when the containment zone is off
)

T_CITY = (0.5, 0.5)         # target on the city map
GLITCHES = ((2.9, 3.0, .35), (5.6, 5.7, .5), (10.0, 10.3, 1.0), (12.85, 13.12, 1.0), (15.2, 15.27, .4))


def tag_sounds(m, t0, big, l1, l2):
    """Data ticks matching hud.tag's type-on speeds."""
    m.type_on(big, t0, 16, .35)
    m.type_on(l1, t0 + .3, 30, .18, every=2)
    m.type_on(l2, t0 + .7, 28, .18, every=2)


class Demo(O.Scene, RouteMixin):
    name = "oris_demo"
    duration = 19.5
    fps = 30

    def setup(self, e):
        self.text = dict(TEXT)
        self.opt = dict(hazards=True, zone=True, sound=True, alert=True)   # effect switches (a place file can override them)
        self.picture = None                        # subject panel picture (grayscale array) from the Studio
        self.place_name = "ORIS"
        self.is_route = False
        self.noise = e.cloud
        self.marks = [(0.44, 0.43, "R-03"), (0.6, 0.55, "R-05"), (0.47, 0.6, "R-09"), (0.58, 0.41, "R-11"),
                      (0.47, 0.42, "S-01"), (0.43, 0.51, "S-02"), (0.56, 0.39, "S-03")]  # stand-ins for the demo map
        src = O.place_path()
        if src and places.is_route(src):           # several stops: overview → A → B → … (route.py)
            self.apply_meta(places.load(src))
            self.setup_route(e, src)
            return
        if src:  # a real location from pick.html
            tag = places.cache_tag(src)
            t = e.textures("terrain", places.build_terrain, tag=tag, src=src)
            self.city = e.textures("city", places.build_city, tag=tag, src=src)["map"]
            p = places.load(src)
            self.apply_meta(p)
            T = (0.5, 0.5)
            self.marks = [m for m in places.landmarks(p, k=12)  # real hilltops, water, junctions around the target
                          if not (0.012 < m[0] - T[0] < 0.135 and -0.035 < m[1] - T[1] < 0.04)][:7]  # keep clear of the label
            self.T = (0.5, 0.5)
            self.mpw = (2 * p["terrain"]["half_m"], 2 * p["city"]["half_m"])   # metres per world unit: terrain, close-up
        else:    # procedural stand-in maps
            t = e.textures("terrain", O.build_terrain, n=2560, seed=7)
            self.city = e.textures("city", O.build_city, n=2048, seed=11)["map"]
            self.T = (0.515, 0.49)
            self.mpw = (12000.0, 1400.0)
        self.terrain, self.contours = t["map"], t["contours"]
        self.mini_img = np.asarray(self.terrain.levels[-1], np.float32) / 255

    def apply_meta(self, p):
        """Options, words, subject picture and HUD lines from a place or route file."""
        self.opt.update(p.get("options", {}))
        words = p.get("text", {})                   # words typed in the Studio
        self.text.update({k: v for k, v in words.items() if k in TEXT})
        if words.get("c_l1"):
            self.text["c_l1_quiet"] = words["c_l1"]
        lines = list(self.text["subject_lines"])
        for k in range(3):                          # subject panel lines: "LEFT / RIGHT"
            v = words.get(f"subj_{k + 1}")
            if v:
                l, _, r = v.partition("/")
                lines[k] = (l.strip(), r.strip())
        self.text["subject_lines"] = lines
        pic = p.get("subject", {}).get("image")
        if pic:
            import base64, io
            from PIL import Image, ImageOps
            im = ImageOps.autocontrast(Image.open(io.BytesIO(base64.b64decode(pic))).convert("L"), cutoff=1)
            self.picture = np.asarray(im.resize((216, 218)), np.float32) / 255
        if words.get("alert_title") or words.get("alert_detail"):
            for k in ("b_alert", "b_alert_quiet"):
                d = self.text[k]
                self.text[k] = (words.get("alert_title") or d[0], words.get("alert_detail") or d[1])
        lat, lon = p["center"]
        if os.environ.get("ORIS_COORDS") or self.opt.get("coords"):  # real position on screen
            ll = f"{abs(lat):.4f}{'N' if lat >= 0 else 'S'} {abs(lon):.4f}{'E' if lon >= 0 else 'W'}"
            extra = [f"LAT {lat:.4f}", f"LON {lon:.4f}"]
        else:                              # default: a made-up grid code, so videos don't give the spot away
            code = int(O.hsh(lat * 7.1, lon * 3.3) * 1e8)
            ll = f"GRID {code // 10000:04d}-{code % 10000:04d}"
            extra = [f"GRID REF: {code % 100000:05d}"]
        self.text["title_lines"] = [p["name"].upper()[:28], ll]
        self.place_name = p["name"].upper()[:24]
        self.code_line = ll
        self.text["sys_right"] = TEXT["sys_right"] + extra

    def frame(self, fr):
        t = fr.t
        if self.is_route:
            self.route_frame(fr, t)
            return
        if t >= 17.6:
            self.outro(fr, t)
            return
        if t < 7.2:
            self.shot_terrain(fr, t)
        elif t < 13.0:
            self.shot_city(fr, t)
        else:
            self.shot_wide(fr, t)
        self.boot(fr, t)
        on = self.opt.get("alert", True)
        alert = win(t, 10.0, 13.0, .08) if on else 0.0
        self.hud_common(fr, t, alert, self.place_mini(fr, t), low_fps=on and 13.0 <= t < 14.5)
        for t0, t1, amt in self.glitches():
            if t0 <= t < t1:
                fr.glitch = amt
        if t > 17.0:
            self.power_down(fr, t, 17.0)

    def hud_common(self, fr, t, alert, mini=None, low_fps=False):
        H.chrome(fr.hud, t, fr.f, self.text, alert, low_fps=low_fps)
        H.subject_panel(fr.hud, 1617, 438, 246, 306, t, fr.f, self.text, alert, self.picture)
        H.grid_fix(fr.hud, 1350, 752, 245, 250, t, fr.f, self.text, alert, mini)
        H.mark(fr.hud, 1790, 952, 34, t, fr.f)

    def power_down(self, fr, t, t0):
        """HUD flickers off, scan line wipes the map away upward (0.6 s from t0)."""
        off = ramp(t, t0, t0 + .4)
        fr.hud_alpha = 0.0 if off >= 1 else (1 - off) * (1.0 if O.hsh(fr.f, 41) > .35 else .15)
        y = 1 - ramp(t, t0 + .15, t0 + .58, "in")
        fr.reveal_y = y
        if t0 + .15 <= t < t0 + .58:
            fr.scan_y = y

    def place_mini(self, fr, t):
        """Live GRID FIX data for a single place: the terrain square, camera footprint, real heading/FOV/distance."""
        if fr.cam is None:
            return None
        city = 7.2 <= t < 13.0
        k = self.mpw[1] / self.mpw[0]                  # close-up square as a fraction of the terrain square
        conv = (lambda q: (.5 + (q[0] - .5) * k, .5 + (q[1] - .5) * k)) if city else (lambda q: q)
        mpw = self.mpw[1] if city else self.mpw[0]
        foot = fr.footprint()
        tgt = T_CITY if city else self.T
        return dict(img=self.mini_img, map=conv, foot=foot, route=None,
                    stops=[(m[:2], "", False) for m in self.marks[:4]] if not city else [],
                    target=tgt, hdg=(-math.degrees(fr.cam.rot)) % 360,
                    fov_m=math.dist(foot[2], foot[3]) * mpw, tgt_m=math.dist(fr.cam.center, tgt) * mpw)

    # ─────────────── boot-up (first 1.4 s) ───────────────
    def boot(self, fr, t):
        if t > 1.5:
            return
        on = ramp(t, .1, .8)
        flick = 1.0 if on >= 1 else (on if O.hsh(fr.f, 77) > .3 else on * .2)
        fr.hud_alpha = flick
        y = key(t, [(.25, 0.0), (1.3, 1.0, "inout")])
        fr.reveal_y = y if t < 1.3 else 1.0
        if .25 <= t < 1.3:
            fr.scan_y = y
        a = win(t, .2, 1.35, .15)
        if a:
            fr.hud.text((960, 520), O.typed("ORIS // UPLINK", t, .2, 30), INK, a, 26, kind="monob", anchor="mm", spacing=6)
            fr.hud.text((960, 562), O.typed("LINK ESTABLISHED", t, .55, 34), ACC, a, 13, anchor="mm", spacing=4)

    # ─────────────── outro title card ───────────────
    def outro(self, fr, t):
        T = self.T
        end = 1 - ramp(t, 19.15, 19.45)
        # in-world backdrop: the place's own contours, drifting, very dim
        fr.set_cam(Cam(center=T, span=key(t, [(17.6, .62), (19.5, .74)]), rot=key(t, [(17.6, -.06), (19.5, .02)]), tilt=.18))
        bg = ramp(t, 17.6, 18.2)
        fr.map(self.terrain, gain=.16 * bg)
        fr.reveal(self.contours, T, 2.0, PALE, .22 * bg)
        fr.img *= np.clip(1.35 - fr.e.edge * 1.1, 0, 1)[..., None]  # pool of light behind the card
        fr.hud_alpha = 1.0
        cx, cy, s = 960, 452, 120
        H.mark_resolve(fr.hud, cx, cy, 130, t, 17.72, step=.12, scramble=.12, a=end, spacing=14)  # last glyph locks at 18.2
        pr = (t - 18.2) / .9
        if 0 < pr < 1:  # pulse ring when the dot lands
            fr.hud.circle((cx, cy), 150 + 300 * pr, ACC, .55 * (1 - pr) * end, w=2)
        if 18.2 < t < 18.35:
            fr.img += PALE * .22 * (1 - ramp(t, 18.2, 18.35))  # flash (added under the HUD, so the sigil stays)
        sp = key(t, [(18.3, 22.0), (18.95, 8.0, "out")])
        fr.hud.text((cx, 646), O.typed(self.place_name, t, 18.3, 20), INK, end, 40, kind="thin", anchor="mm", spacing=sp)
        w = 230 * ramp(t, 18.5, 18.85, "out")
        fr.hud.line([(cx - w / 2, 676), (cx + w / 2, 676)], ACC, end, 1.5)
        sub = "TRANSMISSION END" + (f"  //  {self.code_line}" if hasattr(self, "code_line") else "")
        fr.hud.text((cx, 698), O.typed(sub, t, 18.75, 36), DIM, .9 * end, 12, anchor="mm", spacing=3)
        if 19.1 <= t < 19.35:
            fr.glitch = .9
        fr.fade = end

    # ─────────────── sound design ───────────────
    def sounds(self, m):
        if self.is_route:
            self.route_sounds(m)
            return
        import sound as S
        hz, zone = self.opt.get("hazards", True), self.opt.get("zone", True)
        m.add(0, S.drone(self.duration), 1.0, verb=0)
        # boot
        m.add(0.0, S.power_on(), .9, verb=.2)
        m.type_on("ORIS // UPLINK", .2, 30, .22)
        m.add(.6, S.blip(1760), .5, verb=.5)
        # shot 1
        m.add(1.5, S.lock(), .8, verb=.25)
        tag_sounds(m, 1.8, self.text["a_id"], self.text["a_l1"], self.text["a_l2"])
        for i in range(min(4, len(self.marks))):
            m.add(2.5 + i * .55, S.lock(), .45, pan=(-.55, .55)[i % 2], verb=.25)
        m.add(5.2, S.riser(2.0), 1.0, verb=.25)
        m.add(6.6, S.whoosh(1.4), .9, verb=.4)
        m.add(7.2 - .8, S.reverse_swell(.8), .6, verb=.2)
        m.add(7.2, S.impact(size=.8), .55, verb=.5)
        # shot 2
        m.add(8.0, S.ping(), .7, verb=.45)
        tag_sounds(m, 8.7, self.text["b_id"], self.text["b_l1"], self.text["b_l2"])
        if self.opt.get("alert", True):
            m.add(10.0, S.alarm(2.6), 1.0, verb=.3)
        if hz:
            m.add(10.4, S.riser(2.4, seed=8), .55, verb=.3)
        m.add(13.05 - .8, S.reverse_swell(.8, 9), .7, verb=.2)
        m.add(13.05, S.impact(), 1.0, verb=.6)
        # shot 3
        if zone:
            m.add(13.3, S.impact(7, size=1.4), .6, verb=.7)
        for i, tt in enumerate(self.ping_times()):
            m.add(tt, S.ping(.13, (880, 988, 1175)[i % 3]), .5, pan=((i * 5) % 7 - 3) / 4, verb=.3)
        tag_sounds(m, 14.2, self.text["c_id"], self.text["c_l1"], self.text["c_l2"])
        for t0, t1, amt in self.glitches():
            m.add(t0, S.glitch(t1 - t0 + .06, int(t0 * 10)), .5 + .5 * amt, verb=.1)
        self.outro_sounds(m, 0.0)

    def outro_sounds(self, m, off):
        """Power-down + outro sounds; off shifts them (routes end later than 17.6 s)."""
        import sound as S
        m.add(17.0 + off, S.power_on()[::-1], .7, verb=.3)
        m.add(17.7 + off, S.whoosh(.9, 12), .5, verb=.5)
        for i in range(4):  # each glyph locks
            m.add(17.84 + off + i * .12, S.lock() if i == 3 else S.blip(1200 + 260 * i, i), .45, pan=(i - 1.5) / 3, verb=.45)
        m.add(18.2 + off - .8, S.reverse_swell(.8, 13), .8, verb=.3)
        m.add(18.2 + off, S.impact(11, size=1.3), 1.0, verb=.8)
        m.add(18.2 + off, S.shimmer(1.3), .8, verb=.9)
        m.type_on(self.place_name, 18.3 + off, 20, .3)
        m.type_on("TRANSMISSION END", 18.75 + off, 36, .18, every=2)
        m.add(19.1 + off, S.glitch(.28, 19), .8, verb=.2)

    def glitches(self):
        """Glitch moments; the connection-error one only when that effect is on."""
        return [g for g in GLITCHES if self.opt.get("alert", True) or g[0] != 10.0]

    # sweep in shot 3: when it passes each landmark
    SWEEP = (13.4, 16.6, -math.pi / 2)  # start, end, start angle

    def ping_times(self):
        t0, t1, a0 = self.SWEEP
        T = self.T
        out = []
        for mx, my, _ in self.marks:
            ang = (math.atan2(my - T[1], mx - T[0]) - a0) % (2 * math.pi)
            out.append(t0 + (t1 - t0) * ang / (2 * math.pi))
        return out

    # ─────────────── shot 1: terrain ───────────────
    def shot_terrain(self, fr, t):
        T = self.T
        fr.set_cam(Cam(center=key(t, [(0, (T[0] - .015, T[1] - .02)), (5.8, T)]),
                       span=key(t, [(0, 0.95), (5.8, 0.62, "out"), (7.2, 0.30, "in")]),
                       rot=key(t, [(0, -0.12), (7.2, -0.03)]),
                       tilt=key(t, [(0, 0.35), (5.8, 0.38), (7.2, 0.55, "in")])))
        fr.map(self.terrain, gain=1.25)
        fr.light(T, key(t, [(0, .05), (1.6, .16, "out")]), amb=.45, gain=1.35)
        sw = win(t, 2.0, 6.0, .4)
        if sw:
            ang = (t - 2.0) * 1.7
            fr.wedge(T, .21, ang, .55, PALE, .22 * sw)
            tip = fr.P((T[0] + .21 * math.cos(ang), T[1] + .21 * math.sin(ang)))
            fr.ov.line([fr.P(T), tip], PALE, .5 * sw, 1.2)
        fr.clouds(.8)
        fr.zone(T, key(t, [(0, .12), (1.4, .34, "out")]), PALE, fill=.35 * (1 - ramp(t, .2, 1.6)))
        fr.reveal(self.contours, T, key(t, [(.3, 0), (2.4, .15, "out")]), PALE, .42, soft=.04)
        a = ramp(t, .4, 1.0)
        H.ring(fr, T, .17, INK, .55 * a, 1.2, reveal=ramp(t, .4, 1.4, "out"), start=-1.2)
        H.ring(fr, T, .27, INK, .35 * a, 1.0, reveal=ramp(t, .6, 1.8, "out"), start=.6)
        H.ticks(fr, T, .27, INK, .3 * a, every=6, rot=t * .05)
        H.ring(fr, T, .31, INK, .22 * a, 1.0, reveal=ramp(t, .8, 2.0), dash=(14, 10), phase=t * 20)
        p = fr.P(T)
        rv = ramp(t, .8, 1.7, "out")
        for i, s in enumerate([(-80, 1180), (330, 1180), (-120, 790)]):
            H.beam(fr.ov, s, p, t, PALE, .9, reveal=rv, seed=i)
        fr.ov.dashed([(560, 1180), p], PALE, .4 * rv, 1, 6, 8, t * 30)
        H.target(fr.ov, p, t, PALE, ramp(t, 1.2, 1.5))
        for i, (qx, qy, lab) in enumerate(self.marks[:4]):
            tl = 2.5 + i * .55
            a2 = win(t, tl, 6.4, .12)
            if a2:
                pp = fr.P((qx, qy))
                H.lockon(fr.ov, pp, t, tl, PALE, a2)
                fr.ov.dashed([p, pp], PALE, .35 * a2 * ramp(t, tl, tl + .2), 1, 3, 5, t * 20)
                fr.ov.text((pp[0] + 16, pp[1] - 22), O.typed(lab, t, tl + .1, 40), INK, a2 * .8, 10)
        H.tag(fr.ov, p, t, 1.8, self.text["a_id"], self.text["a_l1"], self.text["a_l2"])
        fr.fog(ramp(t, 6.0, 7.2, "in"), zoom=key(t, [(6.0, 1.0), (7.2, 1.6, "in")]))

    # ─────────────── shot 2: city ───────────────
    def shot_city(self, fr, t):
        T = T_CITY
        fr.set_cam(Cam(center=key(t, [(7.2, (0.5, 0.5)), (13, (0.505, 0.5))]),
                       span=key(t, [(7.2, 0.46), (8.6, 0.66, "out"), (13, 0.6)]),
                       rot=key(t, [(7.2, 0.25), (13, 0.17)]), tilt=0.22))
        fr.map(self.city, tint=hexc("#c4ccc8"), gain=1.0, dots=.15)
        fr.light(T, .3, amb=.32, gain=1.0)
        fr.clouds(1.0, reach=1.15)
        haz = [dict(p=(0.30, 0.36), t=10.2, r=.17), dict(p=(0.40, 0.66), t=10.6, r=.18),
               dict(p=(0.70, 0.58), t=11.0, r=.19), dict(p=(0.60, 0.33), t=11.3, r=.15),
               dict(p=(0.27, 0.52), t=11.7, r=.15)]
        if self.opt.get("hazards", True):
            fr.tint(ACC, .18 * ramp(t, 10.5, 12.8))
            fr.hazards(self.noise, haz, ACC)
        a = ramp(t, 8.0, 8.6)
        alert = win(t, 10.0, 13.5, .08) if self.opt.get("alert", True) else 0.0
        ring_col = INK * (1 - alert * .5) + RED * alert * .5
        H.ring(fr, T, .165, ring_col, .75 * a, 1.6, reveal=ramp(t, 8.0, 8.9, "out"), start=2.4)
        H.ring(fr, T, .23, INK, .25 * a, 1.0, reveal=ramp(t, 8.2, 9.2), dash=(4, 7), phase=t * 15)
        H.ticks(fr, T, .165, INK, .4 * a, every=15, rot=-t * .08)
        b1 = (T[0] - .155, T[1] - .02)
        H.ring(fr, b1, .035, INK, .6 * ramp(t, 8.6, 9.0), 1.2, reveal=ramp(t, 8.6, 9.0))
        pb = fr.P(b1)
        fr.ov.circle(pb, 3, INK, ramp(t, 8.6, 9.0), fill=True)
        fr.ov.text((pb[0] - 10, pb[1] - 30), "B1", INK, .8 * ramp(t, 8.8, 9.0), 11)
        ang = math.radians(-28)
        far = [(T[0] - .6 * math.cos(ang), T[1] - .6 * math.sin(ang)), (T[0] + .6 * math.cos(ang), T[1] + .6 * math.sin(ang))]
        ps = fr.cam.proj(far)
        rv = ramp(t, 8.2, 9.2, "out")
        mid = ((ps[0][0] + ps[1][0]) / 2, (ps[0][1] + ps[1][1]) / 2)
        path_col = ACC * (1 - alert) + RED * alert
        fr.ov.dashed([(mid[0] + (ps[0][0] - mid[0]) * rv, mid[1] + (ps[0][1] - mid[1]) * rv),
                      (mid[0] + (ps[1][0] - mid[0]) * rv, mid[1] + (ps[1][1] - mid[1]) * rv)],
                     path_col, .8, 1.5, 5, 6, t * 40)
        a2 = (T[0] + .165 * math.cos(ang), T[1] + .165 * math.sin(ang))
        pa = fr.P(a2)
        sang = math.atan2(ps[1][1] - ps[0][1], ps[1][0] - ps[0][0])
        H.arrow(fr.ov, pa, sang, 9, INK, rv)
        fr.ov.text((pa[0] + 4, pa[1] - 26), "A2", INK, .85 * rv, 11)
        u = key(t, [(7.2, -.05), (13, .05, "linear")])
        cp = fr.P((T[0] + u * math.cos(ang), T[1] + u * math.sin(ang)))
        H.craft(fr.ov, cp, sang, ACC * (1 - alert) + PINK * alert, ramp(t, 7.8, 8.4))
        H.tag(fr.ov, cp, t, 8.7, self.text["b_id"], self.text["b_l1"], self.text["b_l2"],
              alert=ramp(t, 10.0, 10.15) * (1 if self.opt.get("alert", True) else 0),
              alert_text=self.text["b_alert"] if self.opt.get("hazards", True) else self.text["b_alert_quiet"], offset=(110, -20))
        fr.fog(1 - ramp(t, 7.2, 8.4, "out"), zoom=key(t, [(7.2, 1.6), (8.4, 2.6, "out")]), drift=(.05, -.03))

    # ─────────────── shot 3: wide / containment ───────────────
    def shot_wide(self, fr, t):
        T = self.T
        fr.set_cam(Cam(center=key(t, [(13, (T[0] + .015, T[1] + .01)), (18, T)]),
                       span=key(t, [(13, 0.82), (18, 0.70)]), rot=-0.06, tilt=0.36))
        fr.map(self.terrain, gain=1.15)
        fr.light(T, .22, amb=.42, gain=1.25)
        s0, s1, a0 = self.SWEEP
        if t > s0:
            swept = min(2 * math.pi, (t - s0) / (s1 - s0) * 2 * math.pi)
            fr.reveal_swept(self.contours, T, .3, a0, swept, PALE, .45)
            sa = win(t, s0, s1 + .3, .3)
            if sa:
                ang = a0 + swept
                fr.wedge(T, .3, ang, .5, PALE, .25 * sa)
                tip = fr.P((T[0] + .3 * math.cos(ang), T[1] + .3 * math.sin(ang)))
                fr.ov.line([fr.P(T), tip], PALE, .6 * sa, 1.4)
            H.ring(fr, T, .3, INK, .3 * ramp(t, s0, s0 + .4), 1.0)
        fr.clouds(.7)
        R = key(t, [(13.3, 0), (14.1, .17, "expo")])
        fill = key(t, [(13.3, .7), (14.3, .62), (16.6, .2), (18, .16)])
        zone = self.opt.get("zone", True)
        if zone:
            fr.zone(T, R, RED, fill)
            for k in range(3):
                ph = ((t - 13.6) / 1.4 + k / 3) % 1
                if t > 13.6:
                    H.ring(fr, T, .17 + .16 * ph, RED, .6 * (1 - ph), 1.4)
            H.ring(fr, T, .17, RED, .7 * ramp(t, 13.4, 14.0), 1.5)
        H.ring(fr, T, .27, ACC, .3 * ramp(t, 13.4, 14.2), 1.0, reveal=ramp(t, 13.4, 14.4), dash=(3, 6), phase=t * 10)
        p = fr.P(T)
        H.craft(fr.ov, p, math.radians(-150), PINK, ramp(t, 13.2, 13.6), s=18)
        for (qx, qy, lab), tp in zip(self.marks, self.ping_times()):
            if t < tp:
                continue
            ta = ramp(t, tp, tp + .25, "out")
            pp = fr.P((qx, qy))
            pr = (t - tp) / 1.2
            if pr < 1:
                fr.ov.circle(pp, 8 + 60 * pr, ACC, .8 * (1 - pr), w=1.5)
            H.node(fr.ov, pp, 9 * (.5 + .5 * ta), ACC, ta)
            fr.ov.text((pp[0] + 14, pp[1] - 18), O.typed(lab, t, tp + .05, 40), INK, ta * .8, 10)
        for i in range(26 if zone else 0):
            q = (0.49 + (O.hsh(i, 1) - .5) * .12, 0.565 + (O.hsh(i, 2) - .5) * .07)
            ta = ramp(t, 14.4 + i * .04, 14.6 + i * .04)
            pp = fr.P(q)
            kind = int(O.hsh(i, 3) * 3)
            if kind == 0:
                H.xmark(fr.ov, pp, 4, RED, ta * .9)
            elif kind == 1:
                H.tri(fr.ov, pp, 5, RED, ta * .9)
            else:
                fr.ov.circle(pp, 3, RED, ta, fill=True)
        H.tag(fr.ov, p, t, 14.2, self.text["c_id"], self.text["c_l1"] if zone else self.text["c_l1_quiet"], self.text["c_l2"],
              col2=INK, offset=(100, -30))


if __name__ == "__main__":
    O.main(Demo, __file__)
