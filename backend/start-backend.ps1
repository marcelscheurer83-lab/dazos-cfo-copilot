# Stop any process listening on port 8000, then start one backend (Python 3.12).
# Run from repo root: .\backend\start-backend.ps1
# Or from backend: .\start-backend.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$port = 8000
$pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($pids) {
  foreach ($procId in $pids) {
    Write-Host "Stopping process $procId (was using port $port)..."
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$python = Join-Path $PSScriptRoot ".venv312\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "Python 3.12 venv not found. Create it with:"
  Write-Host "  py -3.12 -m venv .venv312"
  Write-Host "  .\.venv312\Scripts\pip install -r requirements.txt"
  exit 1
}

# Ensure Python loads main.py from this repo (avoids wrong copy when started from another cwd)
$env:PYTHONPATH = $PSScriptRoot
Set-Location $PSScriptRoot

# Force uvicorn to load main from this directory (--app-dir) so we always get this repo's code
$appDir = $PSScriptRoot
Write-Host "Starting backend on http://127.0.0.1:$port (app from $appDir)"
& $python -m uvicorn main:app --reload --port $port --host 0.0.0.0 --app-dir $appDir
