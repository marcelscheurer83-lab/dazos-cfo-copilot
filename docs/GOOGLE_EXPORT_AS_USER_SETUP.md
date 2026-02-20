# Create new ARR export sheets in your Google Workspace Drive

If you set **GOOGLE_EXPORT_AS_USER=marcel@dazos.com** (or your email) in `backend/.env`, each "Export to Google Sheet" creates a **new** Google Sheet in **your** Drive. No overwriting, and the file uses your quota.

This requires **domain-wide delegation** in Google Workspace Admin (one-time). Only a Workspace admin can do that step.

---

## If you don’t have Workspace Admin access

Send the following to your Google Workspace admin (e.g. IT or whoever manages admin.google.com):

---

**Subject:** One-time API delegation for Dazos CFO Copilot (Google Sheets export)

We need domain-wide delegation set up once so our internal app can create new Google Sheets in a user’s Drive (marcel@dazos.com) when they click “Export to Google Sheet.” The app uses a service account; this allows it to act as that user only for creating/writing the sheet.

**Steps (in Google Workspace Admin):**

1. Go to [admin.google.com](https://admin.google.com) → **Security** → **Access and data control** → **API Controls**.
2. Click **Manage Domain Wide Delegation**.
3. Click **Add new**.
4. **Client ID:** `117504845541326734116`
5. **OAuth Scopes (paste exactly):**
   ```
   https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets
   ```
6. Click **Authorize**.

After this is done, I’ll set `GOOGLE_EXPORT_AS_USER=marcel@dazos.com` in our app and restart it. No further admin action needed.

---

## After the admin has added delegation

1. In `backend/.env` add (or update):
   ```
   GOOGLE_EXPORT_AS_USER=marcel@dazos.com
   ```
2. Restart the backend.
3. Use “Export to Google Sheet” — each run will create a new sheet in marcel@dazos.com’s Drive.

---

## If you are the Workspace admin

1. **Client ID** (for this project): `117504845541326734116`
2. In [Admin](https://admin.google.com) → **Security** → **API Controls** → **Manage Domain Wide Delegation** → **Add new**.
3. **Client ID:** `117504845541326734116`
4. **OAuth Scopes:** `https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets`
5. Click **Authorize**.
6. Tell the user to set `GOOGLE_EXPORT_AS_USER=marcel@dazos.com` in `backend/.env` and restart the app.
