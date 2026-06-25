$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretFile = Join-Path $Root "data\local-secrets-qwen.clixml"
$StartupFolder = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupFolder "KOL Assistant.lnk"
$HiddenScript = Join-Path $Root "run-assistant-hidden.ps1"

if (-not (Test-Path -LiteralPath $SecretFile)) {
  Write-Host "Please run reconfigure-assistant.cmd first, then run this installer again." -ForegroundColor Yellow
  exit 2
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$HiddenScript`""
$Shortcut.WorkingDirectory = $Root
$Shortcut.Description = "Start KOL Assistant in the background"
$Shortcut.Save()

& (Join-Path $Root "stop-assistant.ps1")
Start-Sleep -Milliseconds 800
& $HiddenScript
if ($LASTEXITCODE -ne 0) {
  try {
    $Health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3210/health" -TimeoutSec 2
    if ($Health.StatusCode -ne 200) {
      throw "Health check failed."
    }
  } catch {
    throw "Background service could not start. Check data\assistant-error.log."
  }
}

Write-Host "Installed successfully." -ForegroundColor Green
Write-Host "KOL Assistant will start silently when you sign in to Windows." -ForegroundColor Green
Write-Host "You can close this window." -ForegroundColor DarkGray
