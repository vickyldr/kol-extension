param(
  [switch]$Configure
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretFile = Join-Path $Root "data\local-secrets-qwen.clixml"
$Node = "C:\Users\xy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if ($Configure -or -not (Test-Path -LiteralPath $SecretFile)) {
  Write-Host "Configure KOL Assistant (Alibaba Cloud Model Studio)" -ForegroundColor Cyan
  Write-Host "The API key will be encrypted for your current Windows account." -ForegroundColor DarkGray
  Write-Host "Paste the key when prompted. Nothing will appear while typing or pasting. Press Enter when done." -ForegroundColor Yellow

  $DashScopeKey = Read-Host "DashScope API Key" -AsSecureString
  New-Item -ItemType Directory -Force (Split-Path $SecretFile) | Out-Null
  [pscustomobject]@{
    DashScopeKey = $DashScopeKey
  } | Export-Clixml -LiteralPath $SecretFile
}

$Secrets = Import-Clixml -LiteralPath $SecretFile
$env:DASHSCOPE_API_KEY = [System.Net.NetworkCredential]::new("", $Secrets.DashScopeKey).Password
$env:DASHSCOPE_MODEL = if ($env:DASHSCOPE_MODEL) { $env:DASHSCOPE_MODEL } else { "qwen-flash" }

if (-not $env:DASHSCOPE_API_KEY) {
  throw "The saved DashScope API key is empty. Run reconfigure-assistant.cmd again."
}

if (-not (Test-Path -LiteralPath $Node)) {
  throw "Bundled Node.js was not found at: $Node"
}

Write-Host "KOL Assistant is running. Keep this window open." -ForegroundColor Green
Write-Host "Closing this window will stop the AI service." -ForegroundColor DarkGray
& $Node (Join-Path $Root "server.js")
