@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-background-startup.ps1"
echo.
pause
