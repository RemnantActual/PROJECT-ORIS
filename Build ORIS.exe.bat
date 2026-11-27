@echo off
title ORIS // Build ORIS.exe
cd /d "%~dp0"
echo.
echo   ORIS // BUILD ORIS.exe
echo   Packs ORIS (Studio, renderer, GPU shaders, fonts, FFmpeg) into one ORIS.exe in this folder.
echo.
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY (
  echo   Python wasn't found. Install it from https://www.python.org/downloads/
  echo   ^(tick "Add python.exe to PATH"^), then run this again.
  pause
  exit /b 1
)
echo   Using: %PY%
echo   Installing build tools: PyInstaller, numpy, Pillow, imageio-ffmpeg, moderngl ...
%PY% -m pip install --user --upgrade --disable-pip-version-check pyinstaller numpy pillow imageio-ffmpeg moderngl || goto fail
echo.
echo   Building ORIS.exe (2-5 minutes) ...
if exist "%TEMP%\oris_dist" rmdir /s /q "%TEMP%\oris_dist"
if exist "%TEMP%\oris_build" rmdir /s /q "%TEMP%\oris_build"
%PY% -m PyInstaller --noconfirm --clean --onefile --noconsole --name ORIS ^
  --distpath "%TEMP%\oris_dist" --workpath "%TEMP%\oris_build" --specpath "%TEMP%\oris_build" ^
  --icon "%~dp0oris.ico" ^
  --add-data "%~dp0pick.html;." --add-data "%~dp0oris_icon.png;." --add-data "%~dp0fonts;fonts" --add-data "%~dp0shaders;shaders" ^
  --collect-all imageio_ffmpeg --hidden-import moderngl --collect-submodules glcontext ^
  --hidden-import scene_demo --hidden-import route --hidden-import hud --hidden-import places --hidden-import sound --hidden-import oris_gpu ^
  "%~dp0oris_app.py" || goto fail
copy /y "%TEMP%\oris_dist\ORIS.exe" "%~dp0ORIS.exe" >nul || goto fail
rem refresh Windows icon cache so the new logo shows
ie4uinit.exe -show >nul 2>&1
rem bring the place files saved so far into ORIS's data folder
if exist "%~dp0places\*.json" xcopy "%~dp0places\*.json" "%LOCALAPPDATA%\ORIS\places\" /D /Y /I /Q >nul
echo.
echo   DONE. ORIS.exe is in this folder - double-click it.
echo   Videos save to your Videos\ORIS folder. Close the ORIS window to quit.
echo.
pause
exit /b 0
:fail
echo.
echo   Build failed - copy the messages above and send them to Claude.
pause
exit /b 1
