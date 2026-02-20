# Google Sheets access — step-by-step (one-time)

Do these in order. Pause after each step and confirm it worked before continuing.

---

## Step 1 — Open Google Cloud Console

1. In your browser, go to: **https://console.cloud.google.com/**
2. Sign in with the **same Google account** that owns (or can edit) your financial model Google Sheet.

**Check:** You see the Google Cloud Console (dashboard with “Google Cloud” at the top).

---

## Step 2 — Create a project (or pick an existing one)

1. At the top of the page, click the **project dropdown** (it may say “Select a project” or show a current project name).
2. Click **“New Project”**.
3. **Project name:** type e.g. `Dazos CFO Copilot` (or any name you like).
4. Leave “Organization” as is (or leave default).
5. Click **“Create”**.
6. Wait a few seconds; then use the project dropdown again and **select the project you just created**.

**Check:** The top bar shows your new project name.

---

## Step 3 — Enable the Google Sheets API

1. In the left sidebar, click **“APIs & Services”** → **“Library”** (or go to https://console.cloud.google.com/apis/library).
2. In the search box, type **“Google Sheets API”**.
3. Click **“Google Sheets API”** in the results.
4. Click the blue **“Enable”** button.
5. Wait until it says the API is enabled.

**Check:** On the same page you see “API enabled” or “Manage”.

---

## Step 4 — Create a service account

1. In the left sidebar, go to **“APIs & Services”** → **“Credentials”** (or https://console.cloud.google.com/apis/credentials).
2. Click **“+ Create Credentials”** at the top.
3. Choose **“Service account”**.
4. **Service account name:** e.g. `cfo-copilot-sheets`.
5. **Service account ID** will fill in automatically (e.g. `cfo-copilot-sheets`). You can leave it.
6. Click **“Create and Continue”**.
7. (Optional) “Grant access” step: you can skip — click **“Continue”**.
8. (Optional) “Grant users access” step: skip — click **“Done”**.

**Check:** Under “Credentials”, in the “Service accounts” section, you see your new service account (e.g. `cfo-copilot-sheets@...`).

---

## Step 5 — Create and download the JSON key

1. On the **Credentials** page, in the **“Service accounts”** list, click the **email** of the service account you just created (e.g. `cfo-copilot-sheets@your-project.iam.gserviceaccount.com`).
2. Open the **“Keys”** tab.
3. Click **“Add key”** → **“Create new key”**.
4. Leave **“JSON”** selected. Click **“Create”**.
5. A JSON file will **download** to your computer (e.g. `your-project-abc123.json`). Remember where it went (usually your **Downloads** folder).

**Check:** You have one JSON file downloaded. **Do not share this file** — it’s like a password.

**Important:** Copy the **service account email** (e.g. `cfo-copilot-sheets@your-project.iam.gserviceaccount.com`) from the Keys tab or from inside the JSON file — you’ll need it in Step 6. You can open the JSON in Notepad and find the line `"client_email": "..."` to copy that email.

---

## Step 6 — Put the key file in the project and note the path

1. On your computer, go to: `c:\Users\marce\dazos-cfo-copilot\backend\`
2. Create a folder named **`credentials`** (if it doesn’t exist).
3. **Move** the downloaded JSON file from your Downloads folder into `c:\Users\marce\dazos-cfo-copilot\backend\credentials\`.
4. **Rename** the file to something simple, e.g. **`google-service-account.json`** (so the path is `backend\credentials\google-service-account.json`).

**Check:** This file exists: `c:\Users\marce\dazos-cfo-copilot\backend\credentials\google-service-account.json`

---

## Step 7 — Share your Google Sheet with the service account

1. Open your **financial model / plan Google Sheet** in the browser (the one you want the Copilot to read).
2. Click the green **“Share”** button (top right).
3. In “Add people and groups”, **paste the service account email** (the `client_email` from Step 5, e.g. `cfo-copilot-sheets@your-project.iam.gserviceaccount.com`).
4. Set the role to **“Viewer”** (read-only is enough).
5. **Uncheck** “Notify people” (the service account doesn’t read email).
6. Click **“Share”** or **“Send”**.

**Check:** The sheet is shared with that email as Viewer. You can close the Share dialog.

---

## Step 8 — Get the Sheet ID from the URL

1. With the **same Google Sheet** open, look at the **address bar** in your browser.
2. The URL looks like:  
   `https://docs.google.com/spreadsheets/d/ **1abc...long string...xyz** /edit`
3. The **Sheet ID** is the long string between `/d/` and `/edit`. Copy that whole string (e.g. `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms` — yours will be different).

**Check:** You have the Sheet ID copied (no spaces, no `/edit`).

---

## Step 9 — Create or edit `backend/.env`

1. Go to the folder: `c:\Users\marce\dazos-cfo-copilot\backend\`
2. If there is **no** file named **`.env`**:  
   - Copy the file **`.env.example`** and paste it in the same folder.  
   - Rename the copy to **`.env`** (exactly, with the dot at the start).
3. Open **`.env`** in Notepad (or Cursor).
4. Add or edit these two lines (use your real values):

   ```env
   GOOGLE_SHEET_ID=paste_the_sheet_id_you_copied_here
   GOOGLE_APPLICATION_CREDENTIALS=./credentials/google-service-account.json
   ```

   - Replace `paste_the_sheet_id_you_copied_here` with the Sheet ID from Step 8.  
   - If you put the JSON key in a different place, use that path instead (e.g. `C:\Users\marce\dazos-cfo-copilot\backend\credentials\google-service-account.json`).

5. Save the file.

**Check:** `.env` contains `GOOGLE_SHEET_ID=` and `GOOGLE_APPLICATION_CREDENTIALS=` with no typos.

---

## Step 10 — Test the connection

1. Start the backend (from `backend` folder, with venv activated):
   ```powershell
   cd c:\Users\marce\dazos-cfo-copilot\backend
   .venv\Scripts\Activate.ps1
   uvicorn main:app --reload --port 8000
   ```
2. Open in your browser: **http://localhost:8000/docs**
3. Find **POST /api/sync/google-sheets**. Click “Try it out”.
4. In **range_name**, enter a range that exists in your sheet, e.g. **`Sheet1!A1:D10`** (change `Sheet1` to your tab name if different; keep the `!` and the range).
5. Click **“Execute”**.
6. If it works, you’ll see **200** and a response like `"ok": true` and `"rows": 10`. If you get an error, check: Sheet ID in `.env`, file path to the JSON key, and that the sheet is shared with the service account email.

**Check:** The sync returns success and you can call **GET /api/sheet-snapshots/latest** with the same `range_name` and see your sheet data.

---

You’re done. The Copilot can now read from your Google Sheet using the sync endpoint.
