@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-print-station.ps1" -AddPrinter
if errorlevel 1 pause
