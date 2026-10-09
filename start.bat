@echo off
title God's Noisey BoyZ - server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed yet.
  echo Download the LTS version from https://nodejs.org, install it, then double-click start.bat again.
  pause
  exit /b 1
)

if not exist config.json (
  copy config.example.json config.json >nul
  echo Created config.json. Set your room password in the window that opens, save it, then run start.bat again.
  notepad config.json
  pause
  exit /b 0
)

if not exist node_modules (
  echo Installing for the first time. This takes a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

node server.js
pause
