@echo off
rem ---------------------------------------------------------------------------
rem  Tally -> Salesforce Connector launcher (installed as start-connector.bat)
rem  Uses the Node.js runtime bundled inside this install folder, so the machine
rem  does not need Node.js installed. Working directory is the app folder, which
rem  lives under the user's LocalAppData and is writable (mappings, csv, logs).
rem ---------------------------------------------------------------------------
title Tally to Salesforce Connector
cd /d "%~dp0"

rem Use the bundled Node runtime (no Node install required on this machine).
set "PATH=%~dp0node;%PATH%"

echo ===========================================================
echo   Tally to Salesforce Connector
echo ===========================================================
echo.
echo   Starting the connector...
echo   Your browser will open at http://localhost:3000
echo.
echo   Keep this window open while you use the connector.
echo   Close it (or press Ctrl+C) to stop.
echo.

"%~dp0node\node.exe" "%~dp0dist\uiServer.mjs"

echo.
echo   Connector stopped. Press any key to close this window.
pause >nul
