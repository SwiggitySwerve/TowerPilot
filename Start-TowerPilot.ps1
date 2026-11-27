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
Write-Host "Starting Tower Pilot in the system tray (http://127.0.0.1:$port/)..."
$trayArgs = @('-u', '-m', 'towerpilot.tray', '--port', $port)
if ($args.Count -gt 0) {
    $trayArgs += $args
}
$escapedArgs = ($trayArgs | ForEach-Object {
    if ($_ -match '\s|"') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
}) -join ' '
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $python
$start.Arguments = $escapedArgs
$start.WorkingDirectory = $PSScriptRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.EnvironmentVariables['TOWER_PILOT_WINDOWLESS'] = '1'
$start.EnvironmentVariables['TOWER_PILOT_PORT'] = $port
$process = [System.Diagnostics.Process]::Start($start)
$process.Dispose()
