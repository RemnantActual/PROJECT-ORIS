"""
ORIS routes — several real locations in one continuous flight:
overview of all stops → zoom to A → zoom out → shift to B → zoom in → … → back to the overview → outro.

Every stop's terrain and satellite close-up are layered into the overview's map, so the camera never cuts:
detail fades in as it gets close. Used by scene_demo.py when --place is a route file (route_<name>.json).
"""
import math

import numpy as np

import hud as H
import oris as O
import places
from oris import ACC, DIM, INK, PALE, PINK, RED, hexc, key, ramp, win

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _typing(m, text, t0, cps, gain, every=1):
    m.type_on(text, t0, cps, gain, every)


def _tag_sounds(m, t0, big, l1, l2):
    m.type_on(big, t0, 16, .35)
    m.type_on(l1, t0 + .3, 30, .18, every=2)
    m.type_on(l2, t0 + .7, 28, .18, every=2)


class RouteMixin:
    # ─────────────────────────── setup: textures + the whole timeline ───────────────────────────
    def setup_route(self, e, src):
        r = places.load(src)
        self.is_route = True
        self.route = r
        self.layout = places.route_layout(r)
        out = [L["name"] for L in self.layout if not (0.0 <= L["pos"][0] <= 1.0 and 0.0 <= L["pos"][1] <= 1.0)]
        if out:
            raise SystemExit(f"Stops {', '.join(out)} fall outside this route's overview map "
                             "(it was fetched with an older Studio). Reload the Studio and press GET MAP DATA again.")
        tag = places.cache_tag(src)
        ov = e.textures("terrain", places.build_terrain, tag=f"{tag}_overview", src=src, part="overview")
        self.ov_map, self.ov_con = ov["map"], ov["contours"]
        self.O_m = r["overview"]["half_m"]
        self.stops = []
        for i, L in enumerate(self.layout):
            part = f"stop{i}"
            t = e.textures("terrain", places.build_terrain, tag=f"{tag}_{part}", src=src, part=part)
            city = e.textures("city", places.build_city, tag=f"{tag}_{part}", src=src, part=part)["map"]
            sp = places.load(src, part)
            x0, y0, sz = L["trect"]
            marks = []
            for mx, my, lab in places.landmarks(sp, k=10):
                if 0.012 < mx - .5 < 0.135 and -0.035 < my - .5 < 0.04:  # keep clear of the label
                    continue
                marks.append((x0 + mx * sz, y0 + my * sz, lab))
            self.stops.append(dict(L, i=i, letter=LETTERS[i % 26], map=t["map"], con=t["contours"], city=city,
                                   marks=marks[:3], label=(L["name"] or f"WAYPOINT {LETTERS[i % 26]}").upper()[:20]))
        # minimap image + overview framing
        lvl = self.ov_map.levels[-1]
        self.mini_img = np.asarray(lvl, np.float32) / 255
        P = [s["pos"] for s in self.stops]
        xs, ys = [p[0] for p in P], [p[1] for p in P]
        self.oc = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
        ext = max(max(xs) - min(xs), max(ys) - min(ys))
        self.V = min(.95, max(ext * 1.35, max(s["tsize"] for s in self.stops) * 1.8))
        self.total_m = sum(math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) for k in range(len(P) - 1)) * 2 * self.O_m
        self.build_timeline()

    def build_timeline(self):
        cam = O.CamPath()
        oc, V = self.oc, self.V
        # wide shots: turn the map so the route runs bottom-left → top-right (the frame's longest open direction)
        a, b = self.stops[0]["pos"], self.stops[-1]["pos"]
        if len(self.stops) > 1 and math.dist(a, b) > 1e-6:
            th = math.atan2(b[1] - a[1], b[0] - a[0])
            ro = -0.42 - th
            while ro > math.pi / 2:
                ro -= math.pi
            while ro < -math.pi / 2:
                ro += math.pi
        else:
            ro = -0.04
        wt = .2  # flatter tilt for the widest views

        def fit(c, span):
            """Keep the view inside the overview map."""
            span = min(span, .95)
            m = span * .62
            return (min(max(c[0], m), 1 - m) if m < .5 else .5, min(max(c[1], m * .7), 1 - m * .7) if m < .7 else .5), span

        class _P:
            def add(_, t, c, span, rot, tilt, ease="inout", frame=None):
                if frame:  # put these world points inside the open part of the screen (clear of the HUD panels)
                    c, span = frame_points(frame, rot, tilt, c, span)
                c, span = fit(c, span)
                cam.add(t, c, span, rot, tilt, ease)
        P = _P()
        allp = [s["pos"] for s in self.stops]
        P.add(0, oc, V * 1.12, ro - .05, wt, frame=allp)
        P.add(4.0, oc, V, ro, wt, frame=allp)
        t = 4.0
        n = len(self.stops)
        for s in self.stops:
            T, ts, cs = s["pos"], s["tsize"], s["csize"]
            if s["i"] > 0:
                prev = self.stops[s["i"] - 1]["pos"]
                d = math.hypot(T[0] - prev[0], T[1] - prev[1])
                mid = ((prev[0] + T[0]) / 2, (prev[1] + T[1]) / 2)
                P.add(t + 1.1, mid, max(d * 1.6, ts * 2.4), ro, .26, frame=[prev, T])
                s["travel"] = (t, t + 2.4)
                t += 2.4
            else:
                s["travel"] = (t, t + 1.8)
                t += 1.8
            P.add(t, T, ts * 1.5, -.06, .34)
            s["approach"] = (t, t + 2.4)
            t += 2.4
            P.add(t, T, ts * .62, -.03, .38, "out")
            s["scan"] = (t, t + 1.4)
            t += 1.4
            P.add(t, T, ts * .56, -.02, .4)
            s["push"] = (t, t + 1.5)
            t += 1.5
            P.add(t, T, cs * .62, .18, .22, "in")
            s["close"] = (t, t + 3.0)
            t += 3.0
            P.add(t, T, cs * .56, .22, .22)
            s["pull"] = (t, t + 1.6)
            t += 1.6
            P.add(t, T, ts * 1.4, 0.0, .32)
            s["last"] = s["i"] == n - 1
        self.t_final = (t, t + 3.6)
        P.add(t + 2.2, oc, V, ro, wt, frame=allp)
        P.add(t + 3.6, oc, V * 1.08, ro + .03, wt, "linear", frame=allp)
        t += 3.6
        self.t_out = t + .6           # power-down ends, outro starts
        self.duration = self.t_out + 1.9
        self.path = cam
        # final lidar sweep pings each stop
        a0 = -math.pi / 2
        f0, f1 = self.t_final[0] + .6, self.t_final[0] + 3.2
        self.final_pings = []
        for s in self.stops:
            ang = (math.atan2(s["pos"][1] - oc[1], s["pos"][0] - oc[0]) - a0) % (2 * math.pi)
            self.final_pings.append(f0 + (f1 - f0) * ang / (2 * math.pi))
        self.final_sweep = (f0, f1, a0)

    # ─────────────────────────── per-frame ───────────────────────────
    def active_stop(self, t):
        for s in self.stops:
            if s["travel"][0] <= t < s["pull"][1]:
                return s
        return None

    def route_frame(self, fr, t):
        if t >= self.t_out:
            self.T = self.oc
            self.terrain, self.contours = self.ov_map, self.ov_con
            self.outro(fr, t - self.t_out + 17.6)
            return
        cam = self.path.at(t)
        fr.set_cam(cam)
        S = self.active_stop(t)
        # ── map layers: overview, then each stop's terrain, then the active stop's satellite close-up
        layers = [dict(tex=self.ov_map, gain=1.2)]
        for s in self.stops:
            vis = float(np.clip((s["tsize"] * 3.4 - cam.span) / (s["tsize"] * 1.8), 0, 1))
            layers.append(dict(tex=s["map"], rect=s["trect"], a=vis, gain=1.25))
        sat = 0.0
        if S is not None:
            sat = ramp(t, S["push"][0] + .6, S["push"][1] - .1) * (1 - ramp(t, S["pull"][0] + .3, S["pull"][0] + 1.1))
            layers.append(dict(tex=S["city"], rect=S["crect"], a=sat, gain=1.0, tint=hexc("#c4ccc8"), feather=.04))
        fr.map_layers(layers, dots=.16)
        focus = S["pos"] if S is not None else self.oc
        fr.light(focus, cam.span * .42, amb=.45 - .1 * sat, gain=1.25 - .6 * sat)  # gentler over satellite imagery
        fr.clouds(.65 * (1 - sat) + .9 * sat, reach=1.0 + .15 * sat)
        if t < 4.4:
            self.route_overview(fr, t, cam)
        if S is not None:
            self.route_stop(fr, t, cam, S, sat)
        self.route_markers(fr, t, cam, S)
        if t >= self.t_final[0]:
            self.route_final(fr, t, cam)
        # ── HUD
        alert = 0.0
        if S is not None and S["last"] and self.opt.get("alert", True):
            alert = win(t, S["close"][0] + 1.2, S["pull"][0] + .3, .08)
        if S is not None and S["last"] and self.opt.get("alert", True):
            g0 = S["close"][0] + 1.2
            if g0 <= t < g0 + .3:
                fr.glitch = 1.0
        self.boot(fr, t)
        self.hud_common(fr, t, alert, self.route_mini(fr, cam, S))
        if t > self.t_out - .6:
            self.power_down(fr, t, self.t_out - .6)

    def route_overview(self, fr, t, cam):
        P = [s["pos"] for s in self.stops]
        draw = ramp(t, 1.0, 2.6)
        if draw > 0 and len(P) > 1:
            pts = [fr.P(p) for p in P]
            total = sum(math.dist(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
            fr.ov.dashed(_partial(pts, total * draw), ACC, .8, 1.6, 9, 6, t * 25)
        sw = win(t, 1.0, 4.2, .4)
        if sw:
            ang = -math.pi / 2 + (t - 1.0) * 2.0
            fr.wedge(self.oc, self.V * .48, ang, .6, PALE, .2 * sw)
        a = win(t, 1.2, 4.4, .3)
        if a:
            name = self.route["name"].upper()[:26]
            fr.hud.text((960, 118), O.typed(f"ROUTE // {name}", t, 1.2, 30), INK, a, 22, kind="thin", anchor="mm", spacing=6)
            km = self.total_m / 1000
            fr.hud.text((960, 150), O.typed(f"WAYPOINTS {len(self.stops)}  ·  TOTAL {km:.1f} KM", t, 1.6, 40), ACC, a * .9,
                        11, anchor="mm", spacing=3)

    def route_markers(self, fr, t, cam, S):
        """Every stop's marker and the route line, visible whenever the camera is zoomed out enough."""
        P = [s["pos"] for s in self.stops]
        for k, s in enumerate(self.stops):
            vis = float(np.clip((cam.span - s["tsize"] * .9) / (s["tsize"] * 1.4), 0, 1))
            pop = ramp(t, 1.4 + k * .3, 1.7 + k * .3, "out")
            a = vis * pop
            if a <= 0:
                continue
            p = fr.P(s["pos"])
            done = t > s["pull"][1]
            col = INK if done else ACC
            H.node(fr.ov, p, 8, col, a)
            pr = (t - 1.4 - k * .3) / 1.2
            if 0 < pr < 1:
                fr.ov.circle(p, 10 + 50 * pr, ACC, .7 * (1 - pr) * vis, w=1.5)
            fr.ov.text((p[0] + 16, p[1] - 22), f"{s['letter']} · {s['label']}", col, a * .95, 12, kind="monob")
            if done:
                fr.ov.text((p[0] + 16, p[1] - 6), "CLEARED", INK, a * .6, 9, spacing=1)
        if len(P) > 1 and t > 2.6:
            for k in range(len(P) - 1):
                a = float(np.clip((cam.span - self.stops[k]["tsize"] * 1.2) / (self.stops[k]["tsize"] * 1.4), 0, 1))
                if a <= 0:
                    continue
                p0, p1 = fr.P(P[k]), fr.P(P[k + 1])
                fr.ov.dashed([p0, p1], ACC, .55 * a, 1.2, 9, 6, t * 25)
                if t < 4.4:
                    d = math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) * 2 * self.O_m
                    mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
                    fr.ov.text((mid[0] + 8, mid[1] + 6), O.typed(f"{d / 1000:.1f} KM", t, 2.6 + k * .2, 30), INK,
                               a * .75 * win(t, 2.6, 4.4, .3), 10)

    def route_stop(self, fr, t, cam, S, sat):
        T, ts, cs = S["pos"], S["tsize"], S["csize"]
        a0, a1 = S["approach"]
        p = fr.P(T)
        # travel: craft runs along the route line from the previous stop
        if S["i"] > 0 and S["travel"][0] <= t < S["travel"][1]:
            prev = self.stops[S["i"] - 1]["pos"]
            u = O.EASE["inout"](ramp(t, *S["travel"], "linear"))
            q = (prev[0] + (T[0] - prev[0]) * u, prev[1] + (T[1] - prev[1]) * u)
            pq, pt = fr.P(prev), fr.P(T)
            H.craft(fr.ov, fr.P(q), math.atan2(pt[1] - pq[1], pt[0] - pq[0]), ACC, 1.0)
        # terrain scan around the stop
        vis = win(t, a0, S["push"][0] + .5, .4)
        if vis:
            fr.reveal(S["con"], T, ts * .3 * ramp(t, a0 + .2, a0 + 2.0, "out"), PALE, .42 * vis, rect=S["trect"])
            rv = ramp(t, a0 + .3, a0 + 1.1, "out")
            for k, sp in enumerate([(-80, 1180), (330, 1180), (-120, 790)]):
                H.beam(fr.ov, sp, p, t, PALE, .85 * vis, reveal=rv, seed=k)
            H.target(fr.ov, p, t, PALE, vis * ramp(t, a0 + .9, a0 + 1.2))
            H.ring(fr, T, ts * .17, INK, .5 * vis, 1.2, reveal=ramp(t, a0 + .2, a0 + 1.2, "out"), start=-1.2)
            H.ring(fr, T, ts * .27, INK, .3 * vis, 1.0, reveal=ramp(t, a0 + .4, a0 + 1.6, "out"), start=.6)
            for k, (mx, my, lab) in enumerate(S["marks"]):
                tl = a0 + 1.0 + k * .45
                am = win(t, tl, S["push"][0] + .3, .12)
                if am:
                    pp = fr.P((mx, my))
                    H.lockon(fr.ov, pp, t, tl, PALE, am)
                    fr.ov.dashed([p, pp], PALE, .35 * am * ramp(t, tl, tl + .2), 1, 3, 5, t * 20)
                    fr.ov.text((pp[0] + 16, pp[1] - 22), O.typed(lab, t, tl + .1, 40), INK, am * .8, 10)
            H.tag(fr.ov, p, t, a0 + .5, S["label"], self.text["a_l1"], self.text["a_l2"])
        sc0, sc1 = S["scan"]
        sw = win(t, sc0 - .4, S["push"][0] + .4, .3)
        if sw:
            ang = (t - sc0 + .4) * 2.2
            fr.wedge(T, ts * .21, ang, .55, PALE, .22 * sw)
        # push in through cloud
        p0, p1 = S["push"]
        if p0 - .1 <= t < p1 + .6:
            u = (t - p0 + .1) / (p1 - p0 + .7)
            fr.fog(.92 * math.sin(math.pi * min(max(u, 0), 1)) ** 1.4, zoom=1 + 1.4 * u)
        # close-up
        c0, c1 = S["close"]
        ca = win(t, c0 - .2, S["pull"][0] + .4, .3)
        if ca:
            alert = 0.0
            if S["last"] and self.opt.get("alert", True):
                alert = win(t, c0 + 1.2, S["pull"][0] + .3, .08)
            if S["last"] and self.opt.get("hazards", True):
                haz = [dict(p=(T[0] + dx * cs, T[1] + dy * cs), t=c0 + 1.4 + k * .3, r=cs * .2, grow=1.6)
                       for k, (dx, dy) in enumerate([(-.2, -.14), (-.1, .24), (.2, .06), (.1, -.2)])]
                fr.tint(ACC, .16 * ramp(t, c0 + 1.6, c1))
                fr.hazards(self.noise, haz, ACC)
            rc = INK * (1 - alert * .5) + RED * alert * .5
            H.ring(fr, T, cs * .33, rc, .75 * ca, 1.6, reveal=ramp(t, c0 - .1, c0 + .8, "out"), start=2.4)
            H.ring(fr, T, cs * .46, INK, .25 * ca, 1.0, reveal=ramp(t, c0, c0 + 1.0), dash=(4, 7), phase=t * 15)
            H.ticks(fr, T, cs * .33, INK, .4 * ca, every=15, length=cs * .03, rot=-t * .08)
            pc = fr.P(T)
            H.target(fr.ov, pc, t, ACC * (1 - alert) + PINK * alert, ca)
            quiet = not self.opt.get("hazards", True)
            H.tag(fr.ov, pc, t, c0 + .2, f"{S['letter']}-{S['i'] + 1:02d}", self.text["b_l1"], self.text["b_l2"],
                  alert=ramp(t, c0 + 1.2, c0 + 1.35) if alert else 0,
                  alert_text=self.text["b_alert_quiet"] if quiet else self.text["b_alert"], offset=(110, -20))

    def route_final(self, fr, t, cam):
        f0, f1, a0 = self.final_sweep
        if t > f0:
            swept = min(2 * math.pi, (t - f0) / (f1 - f0) * 2 * math.pi)
            R = self.V * .5
            fr.reveal_swept(self.ov_con, self.oc, R, a0, swept, PALE, .35)
            sa = win(t, f0, f1 + .3, .3)
            if sa:
                ang = a0 + swept
                fr.wedge(self.oc, R, ang, .4, PALE, .11 * sa)
                tip = fr.P((self.oc[0] + R * math.cos(ang), self.oc[1] + R * math.sin(ang)))
                fr.ov.line([fr.P(self.oc), tip], PALE, .55 * sa, 1.3)
        if self.opt.get("zone", True):
            last = self.stops[-1]
            Rz = key(t, [(self.t_final[0] + .8, 0), (self.t_final[0] + 1.5, last["tsize"] * .16, "expo")])
            fr.zone(last["pos"], Rz, RED, key(t, [(self.t_final[0] + .8, .65), (self.t_final[1], .22)]))
            if Rz > 0:
                H.ring(fr, last["pos"], Rz, RED, .7, 1.4)
        for s, tp in zip(self.stops, self.final_pings):
            pr = (t - tp) / 1.2
            if 0 < pr < 1:
                fr.ov.circle(fr.P(s["pos"]), 10 + 70 * pr, ACC, .8 * (1 - pr), w=1.5)

    def route_mini(self, fr, cam, S):
        mpw = 2 * self.O_m
        foot = fr.footprint()
        tgt = S["pos"] if S is not None else self.oc
        return dict(img=self.mini_img, map=lambda q: q, foot=foot, route=[s["pos"] for s in self.stops],
                    stops=[(s["pos"], s["letter"], fr.t > s["pull"][1]) for s in self.stops], target=tgt,
                    hdg=(-math.degrees(cam.rot)) % 360, fov_m=math.dist(foot[2], foot[3]) * mpw,
                    tgt_m=math.dist(cam.center, tgt) * mpw)

    # ─────────────────────────── sound ───────────────────────────
    def route_sounds(self, m):
        import sound as S
        m.add(0, S.drone(self.duration), 1.0, verb=0)
        m.add(0.0, S.power_on(), .9, verb=.2)
        m.type_on("ORIS // UPLINK", .2, 30, .22)
        m.add(.6, S.blip(1760), .5, verb=.5)
        m.type_on("ROUTE // " + self.route["name"].upper()[:26], 1.2, 30, .2, every=2)
        m.add(1.0, S.riser(1.6, 21), .4, verb=.25)
        for k in range(len(self.stops)):
            m.add(1.4 + k * .3, S.ping(.13, (880, 988, 1175)[k % 3]), .55, pan=(k - 1) / 3, verb=.3)
        for s in self.stops:
            a0 = s["approach"][0]
            if s["i"] > 0:
                m.add(s["travel"][0], S.whoosh(2.0, 30 + s["i"]), .7, verb=.4)
            m.add(a0 + 1.0, S.lock(), .7, verb=.25)
            _tag_sounds(m, a0 + .5, s["label"], self.text["a_l1"], self.text["a_l2"])
            for k in range(len(s["marks"])):
                m.add(a0 + 1.0 + k * .45, S.lock(), .4, pan=(-.55, .55)[k % 2], verb=.25)
            p0, p1 = s["push"]
            m.add(p0 - .6, S.riser(1.8, 40 + s["i"]), .9, verb=.25)
            m.add(p0 + .4, S.whoosh(1.4, 50 + s["i"]), .8, verb=.4)
            m.add(p1 - .8, S.reverse_swell(.8, 60 + s["i"]), .5, verb=.2)
            m.add(p1, S.impact(70 + s["i"], size=.8), .5, verb=.5)
            c0 = s["close"][0]
            m.add(c0, S.ping(), .6, verb=.45)
            _tag_sounds(m, c0 + .2, f"{s['letter']}-{s['i'] + 1:02d}", self.text["b_l1"], self.text["b_l2"])
            if s["last"] and self.opt.get("alert", True):
                m.add(c0 + 1.2, S.alarm(2.6), 1.0, verb=.3)
                m.add(c0 + 1.2, S.glitch(.3, 77), .9, verb=.1)
            if s["last"] and self.opt.get("hazards", True):
                m.add(c0 + 1.4, S.riser(2.0, 80), .5, verb=.3)
            m.add(s["pull"][0], S.whoosh(1.6, 90 + s["i"]), .7, verb=.4)
        f0 = self.t_final[0]
        if self.opt.get("zone", True):
            m.add(f0 + .8, S.impact(7, size=1.4), .6, verb=.7)
        for k, tp in enumerate(self.final_pings):
            m.add(tp, S.ping(.13, (880, 988, 1175)[k % 3]), .5, pan=((k * 5) % 7 - 3) / 4, verb=.3)
        self.outro_sounds(m, self.t_out - 17.6)


SAFE = (170, 190, 1250, 900)  # open screen area (design px): left of the panels, below the title


def frame_points(pts, rot, tilt, c, span):
    """Find a camera center/span that shows all `pts` inside SAFE (never zooming in past `span`)."""
    x0, y0, x1, y1 = SAFE
    for _ in range(40):
        cam = O.Cam(c, span, rot, tilt)
        q = cam.proj(pts)
        bx0, by0, bx1, by1 = q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max()
        fits = bx0 >= x0 and bx1 <= x1 and by0 >= y0 and by1 <= y1
        if (bx1 - bx0) > (x1 - x0) * .92 or (by1 - by0) > (y1 - y0) * .92:
            span *= 1.08
            continue
        # move the camera so the points' box centre sits at the safe box centre
        dx, dy = (x0 + x1) / 2 - (bx0 + bx1) / 2, (y0 + y1) / 2 - (by0 + by1) / 2
        if fits and abs(dx) < 20 and abs(dy) < 20:
            break
        Hi = np.linalg.inv(cam.H())
        a = Hi @ np.array([960.0, 540.0, 1.0])
        b = Hi @ np.array([960.0 - dx, 540.0 - dy, 1.0])
        a, b = a[:2] / a[2], b[:2] / b[2]
        c = (c[0] + (b[0] - a[0]) * .8, c[1] + (b[1] - a[1]) * .8)
    return c, span


def _partial(pts, length):
    """The first `length` px of a polyline."""
    out = [pts[0]]
    left = length
    for a, b in zip(pts, pts[1:]):
        d = math.dist(a, b)
        if d >= left:
            u = left / d if d else 0
            out.append((a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u))
            return out
        out.append(b)
        left -= d
    return out
