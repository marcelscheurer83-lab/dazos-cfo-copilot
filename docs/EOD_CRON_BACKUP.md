# EOD snapshot backup cron (Railway)

The app takes an **EOD snapshot** automatically at **23:59 EST** when the backend is running. If the Railway service is asleep or restarting at that time, the snapshot can be missed.

Use an **external cron** to call the snapshot endpoint once per day at 23:59 EST as a backup. No extra Railway service is required.

---

## Option A: cron-job.org (or similar)

1. **Create an account** at [cron-job.org](https://cron-job.org) (free tier is enough).

2. **Create a new cron job:**
   - **URL:** `https://YOUR-BACKEND.up.railway.app/api/salesforce/eod-snapshots/take`
   - **Method:** `POST`
   - **Schedule:** Daily at **23:59** in timezone **America/New_York**.
   - **Request headers** (if you set `APP_PASSWORD` on Railway):
     - Name: `X-App-Password`
     - Value: your `APP_PASSWORD` value

3. **Save.** The service will POST to your backend every day at 23:59 EST. The backend will store the snapshot; the Admin “Recent snapshots” list will show it like any other snapshot.

**Other services:** You can use any HTTP cron (e.g. EasyCron, GitHub Actions scheduled workflow) the same way: POST to the URL above at 23:59 EST, with `X-App-Password` if required.

---

## Option B: Script + system cron / Task Scheduler

Use the provided script so a server or your machine can call the endpoint on a schedule.

1. **Set your backend URL and optional password:**

   ```bash
   export BACKEND_URL="https://YOUR-BACKEND.up.railway.app"
   export APP_PASSWORD="your-app-password"   # optional, only if set on Railway
   ```

2. **Run once to test:**

   ```bash
   ./scripts/take-eod-snapshot.sh
   ```

3. **Schedule daily at 23:59 EST:**
   - **Linux/macOS (cron):**  
     `59 23 * * * BACKEND_URL="https://..." APP_PASSWORD="..." /path/to/dazos-cfo-copilot/scripts/take-eod-snapshot.sh`
   - **Windows (Task Scheduler):** Create a daily task at 11:59 PM, action “Start a program” → program `powershell.exe`, arguments:  
     `-File "C:\path\to\dazos-cfo-copilot\scripts\take-eod-snapshot.ps1"`  
     and set env vars in the task or in the script.

---

## Verify

- **Admin → Recent snapshots:** after the cron runs, a new row should appear with a timestamp around **04:59 UTC** the next day (23:59 EST).
- If you use cron-job.org, check its execution log to confirm the POST succeeded (HTTP 200).
