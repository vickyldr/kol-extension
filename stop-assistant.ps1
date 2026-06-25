$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Root "data\assistant.pid"

try {
  $Connection = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 3210 -State Listen -ErrorAction Stop | Select-Object -First 1
  if ($Connection.OwningProcess) {
    Stop-Process -Id $Connection.OwningProcess -Force
  }
} catch {
  $NetstatLine = netstat -ano | Select-String "127\.0\.0\.1:3210\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
  if ($NetstatLine -and $NetstatLine.Matches.Count) {
    $ListenerPid = [int]$NetstatLine.Matches[0].Groups[1].Value
    Stop-Process -Id $ListenerPid -Force -ErrorAction SilentlyContinue
  }

  if (Test-Path -LiteralPath $PidFile) {
    $SavedPid = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
    if ($SavedPid) {
      Stop-Process -Id ([int]$SavedPid) -Force
    }
  }
}

Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
