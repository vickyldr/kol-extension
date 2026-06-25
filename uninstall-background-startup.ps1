$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupFolder = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupFolder "KOL Assistant.lnk"

& (Join-Path $Root "stop-assistant.ps1")
Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue

Write-Host "Background startup has been removed." -ForegroundColor Green
Write-Host "The encrypted API key was kept. Run reconfigure-assistant.cmd to replace it." -ForegroundColor DarkGray
