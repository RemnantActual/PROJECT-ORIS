---
aliases: [Project ORIS, ORIS, ORIS Workspace]
tags: [build, tool]
---
# Project ORIS

Tactical-surveillance HUD animations of real places, rendered from code: terrain scans, lock-ons on real landmarks, a cloud dive into the satellite close-up, a live GRID FIX minimap, synthesized sound, and the ⊙ℝ⥍§ outro. One place, or a route of several (overview → A → B → … → overview). Back to [[What I Make]].

## Using it
1. Double-click **`ORIS.exe`**. ORIS Studio opens in its own window.
2. **Pick a spot** (search or click the map). For a route, **+ ADD STOP** for B, C, …
3. **How much area** (Neighborhood / Town / Region) and **Effects** (satellite detail, connection error, hazard clouds, containment zone, sound, real coordinates). Optional: subject panel (text + picture) and words on screen.
4. **Get map data**. Everything downloads at once, usually in a few seconds: streets, buildings, water and green areas come as OpenStreetMap vector tiles (OpenFreeMap), like the elevation and satellite tiles. If those can't be had, it falls back to the public Overpass servers (one query per stop, slow when they're busy). If a server flakes, press it again and only the missing part is fetched.
5. **Preview** or **Full HD**. The video plays in the window when done and is saved to **Videos\ORIS**.

**Saved** (top of step 1) lists every place and route you've fetched before, newest first. Click one to reopen it with its stops, area, effects, words and picture, ready to render with no download. ✕ takes it off the list (the file moves to `places\removed`, so it can be brought back). Changing an effect or the words of a reopened place saves into its file; changing a stop or the area means GET MAP DATA again.

Close the window to quit (a running render finishes first). Places and map cache live in `%LOCALAPPDATA%\ORIS`.

Coordinates are hidden by default (a made-up grid code shows instead), but satellite close-ups still show the real place.

## What's here
| | |
|---|---|
| `ORIS.exe` | The app. Rebuild it with `Build ORIS.exe.bat` after any change to the files below (replaces this one). |
| `Build ORIS.exe.bat` | Builds `ORIS.exe` (needs Python; 2–5 min). Also copies `places\` into the app's data folder. |
| `oris_app.py` | The app shell: Studio window, saving and listing saved places, starting renders, quitting. |
| `pick.html` | ORIS Studio (the page in the window). |
| `oris.py` | Render engine: timeline, camera, map layers, effects, video + sound output. |
| `oris_gpu.py`, `shaders\` | GPU path: the per-pixel work (map warps, light, clouds, fog, sweeps, overlays, bloom, finish) as OpenGL shaders via moderngl, plus NVENC video encoding. Used automatically when there's a GPU (on this laptop, the RTX 3050); otherwise the numpy path in `oris.py` does the same work on the CPU, and libx264 encodes. The picture is the same either way (frames match within 2/255). Previews render 4–5× faster (FOB A 50 s → 12 s, Commute In 110 s → 21 s). Set `ORIS_GPU=0` or `ORIS_ENCODER=libx264` to force the CPU. |
| `scene_demo.py` | The single-place sequence and all on-screen words (`TEXT`). |
| `route.py` | The multi-stop route sequence. |
| `hud.py` | HUD pieces: chrome, SUBJECT panel, GRID FIX minimap, labels, markers. |
| `places.py` | Turns place/route files into map textures; finds real landmarks. |
| `sound.py` | Sound design synthesizer (no samples). |
| `fonts\` | DejaVu + FreeMono (draws ⊙ℝ⥍§), licenses included. |
| `oris.ico`, `oris_icon.png` | The ℝ app icon. |
| `places\` | Place and route files: FOB A, Commute In (RD-1). |
| `renders\` | Earlier renders: FOB A, Commute In (RD-1). New ones go to Videos\ORIS. |

## Credits
Map data © OpenStreetMap contributors (ODbL) via OpenFreeMap (OpenMapTiles schema) and the Overpass API; elevation: Terrain Tiles on AWS (Mapzen; SRTM, USGS and others); satellite imagery and picker maps © Esri, Maxar, Earthstar Geographics; search: Nominatim / Photon.

## Thumbnails
YouTube (1280×720) and Instagram Reel cover (1080×1920), made 26 Nov 2026 from the OR-07 lock-on frame of the FOB A render, on a Design canvas: https://claude.ai/artifact/Chgt1BtJFBqzFpQR5RQByu (export the PNGs from there). No satellite close-ups of FOB A or B-02 in anything public: they show the real neighborhood and commute.

## Next: GPU pass (paste into Claude Code)
Map data was fixed and given a progress bar on 26 Nov 2026 (`pick.html`); rebuild `ORIS.exe` with `Build ORIS.exe.bat` to pick it up. The GPU is NVIDIA. Prompt for the GPU pass:

```
Project ORIS lives in C:\Users\wdmbl\Desktop\SUPREME\WORKSPACE FOR PROJECT ORIS (render engine: oris.py, scene_demo.py, route.py, hud.py; app: oris_app.py; build: "Build ORIS.exe.bat" with PyInstaller). Frames are drawn on the CPU with numpy/Pillow and piped to ffmpeg. Profiling shows the time is in oris.py: finish() + bloom() (~half), clouds() (~10%), plus map() warping, light(), reveal(), wedge().

My GPU is NVIDIA. Do a GPU performance pass. This is optimization, not a quality cut: output must look the same.
1. Run nvidia-smi and tell me the card, driver and VRAM.
2. Move the heavy per-pixel work (finish, bloom, clouds, map warps, light) to the GPU with moderngl (OpenGL shaders). Use moderngl, not CuPy, so ORIS.exe stays small and doesn't need a CUDA install. Keep the current numpy path as an automatic fallback if no usable GPU is found.
3. Encode with h264_nvenc. First check that the ffmpeg bundled by imageio-ffmpeg actually has nvenc (ffmpeg -encoders); if it doesn't, bundle one that does. Fall back to libx264 automatically. Match the current quality settings.
4. Prove it: render places\place_fob_a.json --preview and places\route_commute_in_rd_1.json --preview on the old and new code, report the time for each, and compare frames at 2 s, 6 s, 10 s and 16 s side by side. Show me any visible difference and fix it before calling it done.
5. Make sure moderngl and the shaders get bundled by "Build ORIS.exe.bat", rebuild ORIS.exe, and test a render started from ORIS Studio.
6. Update README.md's "What's here" with the GPU note. No co-authored lines in commits.
```
