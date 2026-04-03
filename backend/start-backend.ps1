# Stop any process listening on the backend port, then start one backend (Python 3.12).
# Run from repo root: .\backend\start-backend.ps1
# Or from backend: .\start-backend.ps1
#
# Default port is 8008 (not 8000): on some Windows setups multiple listeners on 8000 can yield a
# stale/incomplete app (fewer routes in OpenAPI). Override: $env:BACKEND_PORT = 8000

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$port = 8008
if ($env:BACKEND_PORT -match '^\d+$') { $port = [int]$env:BACKEND_PORT }
elseif ($env:PORT -match '^\d+$') { $port = [int]$env:PORT }

function Get-PidsListeningOnPort {
  param([int]$Port)
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return @($conns | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -gt 0 })
}

for ($round = 0; $round -lt 4; $round++) {
  $pids = Get-PidsListeningOnPort -Port $port
  if ($pids.Count -eq 0) { break }
  foreach ($procId in $pids) {
    Write-Host "Stopping process $procId (was using port $port)..."
    # /T = child workers (uvicorn --reload uses a parent + server process)
    # cmd so a stale PID does not abort the script ($ErrorActionPreference = Stop)
    cmd /c "taskkill /F /T /PID $procId 2>nul" | Out-Null
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}
if ((Get-PidsListeningOnPort -Port $port).Count -gt 0) {
  Write-Host "WARNING: port $port may still be in use. Close other terminals using Uvicorn or run as Administrator."
}
Start-Sleep -Seconds 1

# Second pass: kill any Python still running uvicorn on this port (duplicate consoles / mixed interpreters).
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match 'uvicorn' -and ($_.CommandLine -like "*--port $port*" -or $_.CommandLine -like "*-port $port*")
} | ForEach-Object {
  Write-Host "Stopping uvicorn PID $($_.ProcessId)..."
  cmd /c "taskkill /F /T /PID $($_.ProcessId) 2>nul" | Out-Null
}
Start-Sleep -Seconds 2

$python = Join-Path $PSScriptRoot ".venv312\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "Python 3.12 venv not found. Create it with:"
  Write-Host "  py -3.12 -m venv .venv312"
  Write-Host "  .\.venv312\Scripts\pip install -r requirements.txt"
  exit 1
}

$mainPy = Join-Path $PSScriptRoot "main.py"
if (-not (Select-String -Path $mainPy -Pattern "post_arr_schedule_arr_breakdown" -Quiet)) {
  Write-Host "WARNING: $mainPy does not define Admin ARR breakdown (post_arr_schedule_arr_breakdown). Pull latest code."
} else {
  Write-Host "Verified: main.py includes Admin ARR breakdown endpoint."
}

# Ensure Python loads main.py from this repo (avoids wrong copy when started from another cwd)
$env:PYTHONPATH = $PSScriptRoot
Set-Location $PSScriptRoot

# Force uvicorn to load main from this directory (--app-dir) so we always get this repo's code
$appDir = $PSScriptRoot
Write-Host "Starting backend on http://127.0.0.1:$port (app from $appDir)"
& $python -m uvicorn main:app --reload --port $port --host 0.0.0.0 --app-dir $appDir
