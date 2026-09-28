@echo off
setlocal
if not exist "%LOCALAPPDATA%\InvstoPrintStation\Diagnose Print Station.ps1" (
  echo Run Install-Print-Station.cmd from this download first. Your existing pairing will be kept.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\InvstoPrintStation\Diagnose Print Station.ps1"
if errorlevel 1 pause
