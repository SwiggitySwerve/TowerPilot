$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    Write-Host 'Creating Tower Pilot virtual environment (Python 3.12)...'
    & py -3.12 -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12, then run Start Tower Pilot again.' }
}
$requirements = Join-Path $PSScriptRoot 'requirements.txt'
$stamp = Join-Path $PSScriptRoot '.venv\requirements.sha256'
$hash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
if (-not (Test-Path -LiteralPath $stamp) -or (Get-Content -LiteralPath $stamp -Raw).Trim() -ne $hash) {
    Write-Host 'Installing dependencies...'
    & $python -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    Set-Content -LiteralPath $stamp -Value $hash
}
$port = if ($env:TOWER_PILOT_PORT) { $env:TOWER_PILOT_PORT } else { '8620' }
Write-Host "Starting Tower Pilot on http://127.0.0.1:$port/"
Start-Process "http://127.0.0.1:$port/"
& $python -u (Join-Path $PSScriptRoot 'app.py') --port $port
