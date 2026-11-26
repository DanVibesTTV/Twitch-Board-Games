@echo off
rem Double-click to start the Twitch Board Games companion app.
title Twitch Board Games
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed, or this window can't find it yet.
  echo Install the LTS version from https://nodejs.org and then double-click this file again.
  echo If you just installed it, restart your PC once.
  echo.
  pause
  exit /b 1
)
node app\companion.mjs %*
echo.
pause
