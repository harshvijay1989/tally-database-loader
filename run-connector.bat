@echo off
title Tally to Salesforce Connector
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;C:\Program Files\sf\client\bin;%PATH%"
echo Starting the Tally to Salesforce Connector...
echo Your browser will open at http://localhost:3000
echo Keep this window open while you use the connector. Close it to stop.
echo.
node dist\uiServer.mjs
echo.
echo Connector stopped. Press any key to close.
pause >nul
