# Project ORIS

Tactical-HUD videos of real places: terrain scans, landmark lock-ons, a dive into the satellite close-up, sound, and the ⊙ℝ⥍§ outro. One place or a route of several.

## Use it
**iPhone / browser:** open https://remnantactual.github.io/PROJECT-ORIS/ in Safari, then Share → Add to Home Screen.
**Windows:** run `ORIS.exe` (from Releases).

1. Pick a spot. **+ Add stop** for a route.
2. Choose the area and effects.
3. **Get map data.**
4. **Preview** or **Full HD**. On iPhone, keep the app open while it renders, then **Save / Share** → Save Video.

Saved places reopen without downloading again. On iPhone, ⇩ exports a place file and **Import** loads one (PC files work too).

## Files
| | |
|---|---|
| `web/` | The browser version (published by `.github/workflows/pages.yml`). |
| `oris_app.py`, `pick.html` | The Windows app and its Studio page. |
| `oris.py`, `oris_gpu.py`, `shaders/` | Renderer. |
| `scene_demo.py`, `route.py`, `hud.py` | The sequence, routes, HUD. |
| `places.py`, `sound.py` | Map textures, sound. |
| `Build ORIS.exe.bat` | Builds `ORIS.exe`. |

`web/js/` mirrors the Python files; change both to change the look.

## Credits
Map data © OpenStreetMap contributors (ODbL) via OpenFreeMap and Overpass; elevation: Terrain Tiles on AWS (Mapzen); imagery © Esri, Maxar, Earthstar Geographics; search: Nominatim / Photon. Fonts: DejaVu, FreeFont. Libraries: Leaflet, mp4-muxer (MIT).
