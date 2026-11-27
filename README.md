# Project ORIS

Tactical-surveillance HUD animations of real places, rendered from code: terrain scans, lock-ons on real landmarks, a cloud dive into the satellite close-up, a live GRID FIX minimap, synthesized sound, and the ⊙ℝ⥍§ outro. One place, or a route of several (overview → A → B → … → overview).

## Using it
1. Double-click **`ORIS.exe`**. ORIS Studio opens in its own window.
2. **Pick a spot** (search or click the map). For a route, **+ ADD STOP** for B, C, …
3. **How much area** (Neighborhood / Town / Region) and **Effects** (satellite detail, connection error, hazard clouds, containment zone, sound, real coordinates). Optional: subject panel (text + picture) and words on screen.
4. **Get map data**. Everything downloads at once, usually in a few seconds: streets, buildings, water and green areas come as OpenStreetMap vector tiles (OpenFreeMap), like the elevation and satellite tiles. If those can't be had, it falls back to the public Overpass servers (one query per stop, slow when they're busy). If a server flakes, press it again and only the missing part is fetched.
5. **Preview** or **Full HD**. The video plays in the window when done and is saved to **Videos\ORIS**.

**Saved** (top of step 1) lists every place and route you've fetched before, newest first. Click one to reopen it with its stops, area, effects, words and picture, ready to render with no download. ✕ takes it off the list (the file moves to `places\removed`, so it can be brought back). Changing an effect or the words of a reopened place saves into its file; changing a stop or the area means GET MAP DATA again.

Close the window to quit (a running render finishes first). Places and map cache live in `%LOCALAPPDATA%\ORIS`.

Coordinates are hidden by default (a made-up grid code shows instead), but satellite close-ups still show the real place.

## On iPhone (or any browser, no PC needed)
The `web/` folder is ORIS rebuilt to run entirely in the browser: the same Studio steps, and the render happens on the phone itself (WebGL for the picture, WebCodecs for the MP4, the same synthesized sound).

1. **Publish it once:** repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push to `main` that touches `web/` republishes it to `https://remnantactual.github.io/PROJECT-ORIS/`.
2. Open that address in Safari, then **Share → Add to Home Screen** so it opens like an app.
3. Pick a spot, **Get map data**, then **Preview** or **Full HD**. Keep ORIS open and on screen while it renders (switching apps or locking the phone stops it).
4. **Save / Share video** opens the iPhone share sheet: choose **Save Video** to put it in Photos.

Notes:
- Needs iOS 16.4 or newer for video encoding. Sound is encoded into the MP4 on iOS 26 or newer; on older iOS the sound track comes as a separate `.wav`.
- Saved places live in that browser on that device (Safari and the Home Screen app each keep their own). Use **⇩** to export a place file and **Import a place file** to move it between devices, including place files from the PC app.
- The picture follows the PC renderer closely but isn't pixel-identical (cloud and grain noise are generated differently).

| `web/` | |
|---|---|
| `index.html` | ORIS Studio for phones (made from `pick.html`): saves places on the device, renders in the page. |
| `js/places.js` | Place file → map textures (port of `places.py`). |
| `js/engine.js` | Camera, overlays and the per-pixel passes as WebGL2 shaders (port of `oris.py` / `oris_gpu.py`). |
| `js/scene.js`, `js/hud.js` | The sequence and HUD (ports of `scene_demo.py` + `route.py`, `hud.py`). |
| `js/sound.js` | Sound synthesizer (port of `sound.py`). |
| `js/render.js` | Frames → H.264 + sound → MP4. |
| `js/store.js` | Saved places on the device (IndexedDB). |
| `vendor/` | Leaflet (map view) and mp4-muxer, both MIT, licenses included. |

Keep the two versions in step: a change to the look in the Python files needs the same change in `web/js/`.

## What's here
| | |
|---|---|
| `ORIS.exe` | The app (not in the repo — download it from Releases). Rebuild it with `Build ORIS.exe.bat` after any change to the files below. |
| `Build ORIS.exe.bat` | Builds `ORIS.exe` (needs Python; 2–5 min). Also copies `places\` (if present) into the app's data folder. |
| `oris_app.py` | The app shell: Studio window, saving and listing saved places, starting renders, quitting. |
| `pick.html` | ORIS Studio (the page in the window). |
| `oris.py` | Render engine: timeline, camera, map layers, effects, video + sound output. |
| `oris_gpu.py`, `shaders\` | GPU path: the per-pixel work (map warps, light, clouds, fog, sweeps, overlays, bloom, finish) as OpenGL shaders via moderngl, plus NVENC video encoding. Used automatically when there's a usable GPU; otherwise the numpy path in `oris.py` does the same work on the CPU, and libx264 encodes. The picture is the same either way (frames match within 2/255). Previews render about 4–5× faster. Set `ORIS_GPU=0` or `ORIS_ENCODER=libx264` to force the CPU. |
| `scene_demo.py` | The single-place sequence and all on-screen words (`TEXT`). |
| `route.py` | The multi-stop route sequence. |
| `hud.py` | HUD pieces: chrome, SUBJECT panel, GRID FIX minimap, labels, markers. |
| `places.py` | Turns place/route files into map textures; finds real landmarks. |
| `sound.py` | Sound design synthesizer (no samples). |
| `fonts\` | DejaVu + FreeMono (draws ⊙ℝ⥍§), licenses included. |
| `oris.ico`, `oris_icon.png` | The ℝ app icon. |
| `places\` | Your saved place and route files (not in the repo). |

## Credits
Map data © OpenStreetMap contributors (ODbL) via OpenFreeMap (OpenMapTiles schema) and the Overpass API; elevation: Terrain Tiles on AWS (Mapzen; SRTM, USGS and others); satellite imagery and picker maps © Esri, Maxar, Earthstar Geographics; search: Nominatim / Photon.
