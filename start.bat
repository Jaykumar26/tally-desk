@echo off
title Tally Desk
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Install it from https://nodejs.org  ^(the "LTS" download^), then run this again.
  echo.
  pause
  exit /b 1
)

echo Starting Tally Desk...
start "" http://localhost:4000
node server.js

echo.
echo Tally Desk has stopped.
pause
