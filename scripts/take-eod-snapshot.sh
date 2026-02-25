#!/usr/bin/env bash
# Call the EOD snapshot endpoint (backup when in-app scheduler misses 23:59 EST).
# Usage: BACKEND_URL=https://your-app.up.railway.app [APP_PASSWORD=xxx] ./scripts/take-eod-snapshot.sh

set -e
if [ -z "$BACKEND_URL" ]; then
  echo "Set BACKEND_URL (e.g. https://your-backend.up.railway.app)" >&2
  exit 1
fi
url="${BACKEND_URL%/}/api/salesforce/eod-snapshots/take"
headers=(-H "Content-Type: application/json")
if [ -n "$APP_PASSWORD" ]; then
  headers+=(-H "X-App-Password: $APP_PASSWORD")
fi
echo "POST $url"
resp=$(curl -s -w "\n%{http_code}" -X POST "${headers[@]}" "$url")
body=$(echo "$resp" | head -n -1)
code=$(echo "$resp" | tail -n 1)
if [ "$code" = "200" ]; then
  echo "$body" | head -c 200
  echo ""
  echo "Snapshot taken (HTTP 200)."
else
  echo "Failed: HTTP $code" >&2
  echo "$body" >&2
  exit 1
fi
