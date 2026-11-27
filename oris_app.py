"""
ORIS app — double-click ORIS.exe and ORIS Studio opens in its own window. Close the window and ORIS quits.

Where things live (nothing is put next to the exe):
  places + map cache : %LOCALAPPDATA%\\ORIS
  finished videos    : Videos\\ORIS

Under the hood the Studio page talks to this program over localhost: map servers refuse pages opened
from a file, and a page can't save files or start renders by itself. You never see any of that.
Also runs as `python oris_app.py`.
"""
import glob
import json
import multiprocessing
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

FROZEN = getattr(sys, "frozen", False)
ROOT = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
RES = getattr(sys, "_MEIPASS", ROOT)          # files bundled inside ORIS.exe
PORT = 8765
URL = f"http://localhost:{PORT}/pick.html"
NAME_OK = re.compile(r"^[A-Za-z0-9_\-]{1,80}\.json$")
VIDEO_OK = re.compile(r"^[A-Za-z0-9_\-]{1,120}\.mp4$")
WIN = os.name == "nt"

if WIN:
    DATA = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ORIS")
    RENDERS = os.path.join(os.path.expanduser("~"), "Videos", "ORIS")
else:
    DATA = os.path.join(os.path.expanduser("~"), ".oris")
    RENDERS = os.path.join(os.path.expanduser("~"), "Videos", "ORIS")
PLACES = os.path.join(DATA, "places")
os.environ["ORIS_CACHE"] = os.path.join(DATA, "cache")   # the renderer reads these
os.environ["ORIS_RENDERS"] = RENDERS

job = {"proc": None, "out": ""}
lock = threading.Lock()
last_ping = [time.time()]


def res(name):
    p = os.path.join(ROOT, name)
    return p if os.path.exists(p) else os.path.join(RES, name)


def tail(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4000))
            lines = [l for l in f.read().decode("utf-8", "replace").replace("\r", "\n").split("\n") if l.strip()]
        return lines[-1] if lines else ""
    except OSError:
        return ""


_META = {}   # file name -> ((mtime, size), summary): saved place files are big, read each once


def place_meta(name):
    """What ORIS Studio needs to reopen a saved place or route: stops, area, effects, words, picture (no map data)."""
    path = os.path.join(PLACES, name)
    st = os.stat(path)
    key = (st.st_mtime, st.st_size)
    hit = _META.get(name)
    if hit and hit[0] == key:
        return hit[1]
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    route = p.get("oris_route") == 1
    if not route and p.get("oris_place") != 1:
        raise ValueError("not an ORIS place file")
    parts = p["stops"] if route else [dict(p, name=p["name"])]
    first = parts[0]
    m = {
        "file": name, "kind": "route" if route else "place", "name": p.get("name", name[:-5]),
        "created": p.get("created", ""), "mtime": st.st_mtime, "size": st.st_size, "center": p.get("center"),
        "stops": [{"lat": s["center"][0], "lng": s["center"][1], "name": s.get("name", "") if route else ""} for s in parts],
        "tr": first["terrain"]["half_m"] / 1000, "cr": first["city"]["half_m"], "res": first["terrain"]["elev"]["n"],
        "sat": any("imagery" in s.get("city", {}) for s in parts),
        "options": p.get("options", {}), "text": p.get("text", {}), "subject": p.get("subject", {}).get("image"),
    }
    _META[name] = (key, m)
    return m


def saved_places():
    out = []
    for f in sorted(glob.glob(os.path.join(PLACES, "*.json"))):
        try:
            out.append(place_meta(os.path.basename(f)))
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            continue   # not a place file, or half-written
    out.sort(key=lambda m: m["mtime"], reverse=True)
    return out


def rendering():
    with lock:
        return job["proc"] is not None and job["proc"].poll() is None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, ctype, data, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def text(self, code, s):
        self.send(code, "text/plain; charset=utf-8", s.encode())

    def json(self, obj):
        self.send(200, "application/json", json.dumps(obj).encode())

    def do_GET(self):
        u = urlparse(self.path)
        last_ping[0] = time.time()
        if u.path in ("/", "/pick.html"):
            with open(res("pick.html"), "rb") as f:
                return self.send(200, "text/html; charset=utf-8", f.read())
        if u.path == "/oris_icon.png":
            with open(res("oris_icon.png"), "rb") as f:
                return self.send(200, "image/png", f.read())
        if u.path == "/ping":
            return self.text(200, "ok")
        if u.path == "/places":
            return self.json(saved_places())
        if u.path == "/status":
            return self.json({"render": True, "why": "", "app": True})
        if u.path == "/progress":
            with lock:
                p = job["proc"]
                running = p is not None and p.poll() is None
                out = job["out"]
                ok = p is not None and not running and p.returncode == 0 and os.path.exists(os.path.join(RENDERS, out))
            line = tail(os.path.join(DATA, "render_log.txt"))
            if p is not None and not running and not ok:
                line = tail(os.path.join(DATA, "render_err.txt")) or line
            return self.json({"running": running, "ok": ok, "line": line, "out": out})
        if u.path.startswith("/renders/"):
            name = unquote(u.path[len("/renders/"):])
            f = os.path.join(RENDERS, name)
            if not VIDEO_OK.match(name) or not os.path.exists(f):
                return self.text(404, "not found")
            return self.video(f)
        return self.text(404, "not found")

    def video(self, path):
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else 0
            end = min(int(b), size - 1) if b else size - 1
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read(end - start + 1)
        if rng:
            self.send(206, "video/mp4", data, {"Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes"})
        else:
            self.send(200, "video/mp4", data, {"Accept-Ranges": "bytes"})

    def do_POST(self):
        u = urlparse(self.path)
        last_ping[0] = time.time()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if u.path == "/save":
            name = q.get("name", "")
            if not NAME_OK.match(name):
                return self.text(400, "bad file name")
            os.makedirs(PLACES, exist_ok=True)
            with open(os.path.join(PLACES, name), "wb") as f:
                f.write(body)
            return self.text(200, f"saved {name}")
        if u.path == "/options":   # effects, words and picture of a saved place, without re-sending its map data
            name = q.get("name", "")
            path = os.path.join(PLACES, name)
            if not NAME_OK.match(name) or not os.path.exists(path):
                return self.text(404, "place file not found")
            try:
                new = json.loads(body)
                with open(path, encoding="utf-8") as f:
                    p = json.load(f)
            except ValueError:
                return self.text(400, "bad data")
            p["options"], p["text"] = new.get("options", {}), new.get("text", {})
            if new.get("subject"):
                p["subject"] = {"image": new["subject"]}
            else:
                p.pop("subject", None)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(p, f, separators=(",", ":"))
            os.replace(tmp, path)
            return self.text(200, f"saved {name}")
        if u.path == "/remove":    # off the Saved list; the file is kept in places\removed
            name = q.get("name", "")
            path = os.path.join(PLACES, name)
            if not NAME_OK.match(name) or not os.path.exists(path):
                return self.text(404, "place file not found")
            if rendering():
                return self.text(409, "wait for the render to finish")
            dest = os.path.join(PLACES, "removed")
            os.makedirs(dest, exist_ok=True)
            os.replace(path, os.path.join(dest, name))
            _META.pop(name, None)
            return self.text(200, f"removed {name}")
        if u.path == "/render":
            return self.start_render(q.get("file", ""), q.get("mode", "full"))
        if u.path == "/open":
            os.makedirs(RENDERS, exist_ok=True)
            if WIN:
                os.startfile(RENDERS)
            return self.text(200, "ok")
        return self.text(404, "not found")

    def start_render(self, file, mode):
        if not NAME_OK.match(file) or not os.path.exists(os.path.join(PLACES, file)):
            return self.text(404, "place file not found")
        with lock:
            if job["proc"] is not None and job["proc"].poll() is None:
                return self.text(409, "a render is already running")
            stem = file[:-5]
            stem = stem[6:] if stem.startswith("place_") else stem
            out = f"oris_{stem}{'_preview' if mode == 'preview' else ''}.mp4"
            os.makedirs(RENDERS, exist_ok=True)
            args = ["--place", os.path.join(PLACES, file), "--out", os.path.join(RENDERS, out)]
            if mode == "preview":
                args.append("--preview")
            cmd = [sys.executable, "--render"] + args if FROZEN else [sys.executable, "-u", os.path.join(ROOT, "scene_demo.py")] + args
            log = open(os.path.join(DATA, "render_log.txt"), "w", encoding="utf-8")
            err = open(os.path.join(DATA, "render_err.txt"), "w", encoding="utf-8")
            env = dict(os.environ, PYTHONUNBUFFERED="1")
            job["proc"] = subprocess.Popen(cmd, cwd=DATA, stdout=log, stderr=err, env=env,
                                           creationflags=0x08000000 if WIN else 0)  # no console window
            job["out"] = out
        return self.text(200, "started")


def find_app_browser():
    """Edge (always on Windows 10/11) or Chrome, to open the Studio as an app window."""
    cands = [shutil.which("msedge"), shutil.which("chrome"), shutil.which("google-chrome"), shutil.which("chromium")]
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                      os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    return next((c for c in cands if c and os.path.exists(c)), None)


def open_window():
    exe = find_app_browser()
    if exe:
        profile = os.path.join(DATA, "window")   # its own profile: a separate window we can watch close
        try:
            return subprocess.Popen([exe, f"--app={URL}", f"--user-data-dir={profile}", "--window-size=1600,940",
                                     "--no-first-run", "--no-default-browser-check"])
        except OSError:
            pass
    webbrowser.open(URL)
    return None


def migrate():
    """Bring over place files from the old ORIS folder (next to the exe / source) the first time."""
    os.makedirs(PLACES, exist_ok=True)
    for f in glob.glob(os.path.join(ROOT, "places", "*.json")):
        dst = os.path.join(PLACES, os.path.basename(f))
        if not os.path.exists(dst):
            shutil.copy2(f, dst)


def render_main():
    """ORIS.exe --render …  → run a render (same flags as scene_demo.py)."""
    sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a != "--render"]
    import oris
    import scene_demo
    oris.main(scene_demo.Demo, scene_demo.__file__)


def app_main():
    os.makedirs(DATA, exist_ok=True)
    migrate()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:  # already running: just bring up another window
        open_window()
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    win = open_window()
    started = time.time()
    while True:  # quit once the window is closed (the page pings every 5 s while open) and no render is running
        time.sleep(1)
        if rendering() or time.time() - started < 30:
            continue
        quiet = time.time() - last_ping[0]
        if quiet > 20 or (win is not None and win.poll() is not None and quiet > 6):
            break
    srv.shutdown()


if __name__ == "__main__":
    multiprocessing.freeze_support()          # lets ORIS.exe use all CPU cores while rendering
    if "--render" in sys.argv:
        render_main()
    else:
        app_main()
