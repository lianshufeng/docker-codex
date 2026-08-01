@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to open Codex Reset Forecast.
  pause
  exit /b 1
)
node codex-local-server.mjs
if errorlevel 1 pause
