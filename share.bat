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
echo Look below for an address ending in .trycloudflare.com and send it to your friends.
echo The address changes each time you run this. See the README for a permanent one.
echo.
cloudflared tunnel --url http://localhost:3000
pause
