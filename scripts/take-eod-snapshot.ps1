# Call the EOD snapshot endpoint (backup when in-app scheduler misses 23:59 EST).
# Usage: $env:BACKEND_URL = "https://your-app.up.railway.app"; [optional] $env:APP_PASSWORD = "xxx"; .\scripts\take-eod-snapshot.ps1

if (-not $env:BACKEND_URL) {
    Write-Host "Set BACKEND_URL (e.g. https://your-backend.up.railway.app)" -ForegroundColor Red
    exit 1
}
$url = "$($env:BACKEND_URL.TrimEnd('/'))/api/salesforce/eod-snapshots/take"

$headers = @{ "Content-Type" = "application/json" }
if ($env:APP_PASSWORD) { $headers["X-App-Password"] = $env:APP_PASSWORD }

Write-Host "POST $url"
try {
    $r = Invoke-RestMethod -Uri $url -Method Post -Headers $headers
    Write-Host ($r | ConvertTo-Json -Compress)
    Write-Host "Snapshot taken (HTTP 200)."
} catch {
    Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    exit 1
}
