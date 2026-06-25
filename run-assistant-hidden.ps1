$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretFile = Join-Path $Root "data\local-secrets-qwen.clixml"
$PidFile = Join-Path $Root "data\assistant.pid"
$StatusLog = Join-Path $Root "data\assistant-status.log"
$Node = "C:\Users\xy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$HostScript = Join-Path $Root "assistant-host.ps1"

function Test-AssistantHealth {
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3210/health" -TimeoutSec 2
    return $Response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-AssistantHealth) {
  exit 0
}

if (-not (Test-Path -LiteralPath $SecretFile)) {
  Add-Content -LiteralPath $StatusLog -Value "$(Get-Date -Format o) Missing API key configuration." -ErrorAction SilentlyContinue
  exit 2
}

if (-not (Test-Path -LiteralPath $Node)) {
  Add-Content -LiteralPath $StatusLog -Value "$(Get-Date -Format o) Node.js not found: $Node" -ErrorAction SilentlyContinue
  exit 3
}

$Process = Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$HostScript`"" `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $Process.Id

for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
  Start-Sleep -Milliseconds 500
  if (Test-AssistantHealth) {
    Add-Content -LiteralPath $StatusLog -Value "$(Get-Date -Format o) Assistant started in background." -ErrorAction SilentlyContinue
    exit 0
  }
}

Add-Content -LiteralPath $StatusLog -Value "$(Get-Date -Format o) Assistant failed to become healthy." -ErrorAction SilentlyContinue
exit 5
