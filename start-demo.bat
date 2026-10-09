@echo off
rem Runs Tally Desk against fake data, so the screens can be shown to someone
rem without TallyPrime being open. Nothing here touches real books.
title Tally Desk (demo data)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org
  pause
  exit /b 1
)

node scripts/demo.js
pause
