$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretFile = Join-Path $Root "data\local-secrets-qwen.clixml"
$StdoutLog = Join-Path $Root "data\assistant-output.log"
$StderrLog = Join-Path $Root "data\assistant-error.log"
$Node = "C:\Users\xy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

$Secrets = Import-Clixml -LiteralPath $SecretFile
$env:DASHSCOPE_API_KEY = [System.Net.NetworkCredential]::new("", $Secrets.DashScopeKey).Password
$env:DASHSCOPE_MODEL = "qwen-flash"

Set-Location -LiteralPath $Root
& $Node (Join-Path $Root "server.js") 1>> $StdoutLog 2>> $StderrLog
