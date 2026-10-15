@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the official Node.js LTS and retry.
  pause
  exit /b 1
)
echo Local Wiki: http://127.0.0.1:8765/
echo Keep this window open. Press Ctrl+C to stop.
node server.mjs
if errorlevel 1 pause
