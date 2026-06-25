@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-assistant.ps1"
echo KOL Assistant has been stopped.
pause
