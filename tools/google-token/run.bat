@echo off
title Google Token Baker
cd /d "%~dp0"
echo ============================================================
echo   Google refresh-token baker
echo ============================================================
echo.
echo   A browser window will open. Sign in with the Google account
echo   the connector should deliver files to, and approve access.
echo.
"%~dp0node.exe" bake-google-token.mjs
echo.
echo   Done. Press any key to close.
pause >nul
