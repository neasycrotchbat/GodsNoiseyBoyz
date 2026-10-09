@echo off
title God's Noisey BoyZ - public link
cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared isn't installed yet. Open PowerShell and run:
  echo.
  echo     winget install --id Cloudflare.cloudflared
  echo.
  echo Then close this window and double-click share.bat again.
  pause
  exit /b 1
)

echo Opening a public link to your room...
echo Once it's up, press "Invite friends" in the room to copy a link that lets
echo friends straight in. Keep this window open; closing it ends the link.
echo The address changes each time you run this. See the README for a permanent one.
echo.
rem The room reads the public address from this log to build invite links.
if not exist data mkdir data
if exist data\tunnel.log del data\tunnel.log
cloudflared tunnel --logfile data\tunnel.log --url http://localhost:3000
pause
