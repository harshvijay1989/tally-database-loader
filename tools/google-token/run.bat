@echo off
title Google Token Baker
cd /d "%~dp0"
echo ============================================================
echo   Google refresh-token baker
echo ============================================================
echo.
if not exist "%~dp0node.exe" (
  echo   PROBLEM: node.exe was not found next to this file.
  echo.
  echo   You are running this from INSIDE the zip. Windows only
  echo   unpacked run.bat, not the rest of the tool.
  echo.
  echo   Please do this instead:
  echo     1^) Close this window.
  echo     2^) Right-click the downloaded .zip and choose "Extract All".
  echo     3^) Open the extracted folder.
  echo     4^) Double-click run.bat from THERE.
  echo.
  pause
  exit /b 1
)
echo   A browser window will open. Sign in with the Google account
echo   the connector should deliver files to, and approve access.
echo.
"%~dp0node.exe" bake-google-token.mjs
echo.
echo   Done. Press any key to close.
pause >nul
