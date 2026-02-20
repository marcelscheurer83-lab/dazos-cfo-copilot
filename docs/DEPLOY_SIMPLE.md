# Deploy Dazos CFO Copilot (simplest path)

This guide gets the app running 24/7 on the internet so you can use it from any device and the **hourly Salesforce sync** and **daily EOD snapshot** keep running when your computer is off.

We’ll use:
- **Railway** for the backend (one app, always on, free tier available)
- **Vercel** for the frontend (static site, free tier)
- **SQLite on a Railway volume** so data persists (no separate database sign-up)

---

## Part 0: Get ready (GitHub + env values)

Do this first if you don’t yet have the code on GitHub or a list of env values.

### 0.1 GitHub account and repo

1. **Create a GitHub account** (if you don’t have one): go to [github.com](https://github.com) and sign up. You can use your personal email or a work one (e.g. marcel@dazos.com); both work. Use whichever account you want to own the repo.
2. **Install Git** on your computer (if needed): [git-scm.com/downloads](https://git-scm.com/downloads). Use the default options. After install, open a new terminal.
3. **Create a new repo on GitHub:**
   - On GitHub, click the **+** (top right) → **New repository**.
   - Name it e.g. `dazos-cfo-copilot`.
   - Leave it **empty** (no README, no .gitignore).
   - Click **Create repository**. Copy the repo URL (e.g. `https://github.com/YourUsername/dazos-cfo-copilot.git`).
4. **Push your local project to GitHub** (run these in a terminal, from the folder that contains `backend` and `frontend`):

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YourUsername/dazos-cfo-copilot.git
   git push -u origin main
   ```

   Replace `YourUsername/dazos-cfo-copilot` with your actual repo URL. If GitHub asks you to sign in, use your username and a **Personal Access Token** as the password (GitHub → Settings → Developer settings → Personal access tokens → Generate new token, with `repo` scope).

   You now have the code in a GitHub repo.

### 0.2 Gather your env values (for Railway)

You’ll paste these into Railway in Part 1. Get them from your **existing** `backend/.env` if the app already runs on your machine, or set them up as below.

**Required for sync + export:**

| Variable | Where to get it |
|----------|------------------|
| `SALESFORCE_USERNAME` | Your Salesforce login email. |
| `SALESFORCE_PASSWORD` | Your Salesforce password. |
| `SALESFORCE_SECURITY_TOKEN` | Salesforce: your Profile → Settings → **Reset My Security Token** (they email you the token). |
| `SALESFORCE_DOMAIN` | Use `login` (or `test` for sandbox). |

**For Google Sheets export (optional but recommended):**

| Variable | Where to get it |
|----------|------------------|
| `GOOGLE_SHEETS_CREDENTIALS_JSON` | Open your **service account JSON key file** (the one you use for Google Sheets). Copy the **entire** file contents (one line is fine) and paste as the value. This is the easiest option on Railway (no file upload). |
| Or `GOOGLE_APPLICATION_CREDENTIALS` | Only if you don’t use the JSON paste: path to the key file (Railway may support file upload; otherwise use the JSON above). |
| `GOOGLE_SHEET_ID` | If you use “write to one existing sheet”: from the sheet URL `https://docs.google.com/spreadsheets/d/XXXXX/edit`, the ID is `XXXXX`. |
| `GOOGLE_EXPORT_AS_USER` | If your admin set up domain-wide delegation: your email, e.g. `marcel@dazos.com`. |

**Database (set only on Railway):**

- `DATABASE_URL` = `sqlite+aiosqlite:////data/cfo.db`  
  (You only set this in Railway; no sign-up. The `/data` path is where the volume is mounted.)

**CORS (set in Railway after you have the Vercel URL):**

- `CORS_ORIGINS` = your Vercel app URL, e.g. `https://dazos-cfo-copilot-xxx.vercel.app`

**Tip:** If you already have a working `backend/.env`, open it and copy each line (skip comments and empty lines). In Railway you’ll add each as a **Variable** name and value. Don’t upload the `.env` file itself; only the variable names and values.

### 0.3 SQLite / database

You don’t sign up for anything. In Part 1 we’ll add a **Railway volume** and set `DATABASE_URL` so the app stores data on that volume. No separate database service needed.

---

## Part 1: Backend on Railway

### 1.1 Create the project

1. Go to [railway.app](https://railway.app) and sign in (e.g. with GitHub).
2. Click **“New Project”**.
3. Choose **“Deploy from GitHub repo”** and select your **dazos-cfo-copilot** repo (or the repo that contains this project).
4. When asked what to deploy, choose **“Add a service”** and pick the same repo again (we’ll point it at the backend folder next).

### 1.2 Point Railway at the backend

1. Click the new service (the one you just added).
2. Open **Settings** (or the **Settings** tab).
3. Under **“Build”** or **“Source”**, set **Root Directory** to: `backend`.
4. Set **Start Command** to: `uvicorn main:app --host 0.0.0.0 --port $PORT`  
   (If Railway picks this up from the Procfile, you can leave Start Command empty.)
5. Under **“Deploy”** or **“Networking”**, ensure the service gets a **public URL** (e.g. “Generate domain”). Note the URL (e.g. `https://something.up.railway.app`). You’ll need it for the frontend and CORS.

### 1.3 Add a volume (so SQLite data is kept)

1. In the same service, go to **Settings** (or the **Volumes** tab if you see it).
2. Click **“Add Volume”** (or **“New Volume”**).
3. Mount path: `/data`.
4. Save. This keeps everything under `/data` (including the SQLite file) across restarts.

### 1.4 Set environment variables

1. In the service, open **Variables** (or **Environment**).
2. Add every variable you have in `backend/.env`. At minimum you’ll need something like:

   - `DATABASE_URL` = `sqlite+aiosqlite:////data/cfo.db`  
     (four slashes: `sqlite+aiosqlite:///` + `/data/cfo.db`)
   - `SALESFORCE_USERNAME`
   - `SALESFORCE_PASSWORD`
   - `SALESFORCE_SECURITY_TOKEN`
   - `SALESFORCE_DOMAIN` = `login` (or `test` for sandbox)
   - `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SHEETS_CREDENTIALS_JSON` (and optionally `GOOGLE_SHEET_ID`, `GOOGLE_EXPORT_AS_USER` if you use Sheets)

   For Google credentials from a file: either paste the JSON into `GOOGLE_SHEETS_CREDENTIALS_JSON` or upload the key and set `GOOGLE_APPLICATION_CREDENTIALS` to the path Railway gives (if supported). Easiest is pasting the whole JSON into `GOOGLE_SHEETS_CREDENTIALS_JSON`.

3. Add CORS (we’ll set the exact value after the frontend is deployed):
   - `CORS_ORIGINS` = `https://your-app.vercel.app`  
     (replace with your real Vercel URL in the next part; you can add `http://localhost:5173` too for local dev.)

4. Save. Railway will redeploy when you change variables.

### 1.5 Deploy and get the backend URL

1. Trigger a deploy if it didn’t start automatically (e.g. **Deploy** or push a commit).
2. Wait until the deploy is **live** and the service shows a **public URL** (e.g. `https://dazos-cfo-copilot-production-xxxx.up.railway.app`).
3. Copy that URL; this is your **backend URL**. You’ll use it as `VITE_API_URL` and in `CORS_ORIGINS`.

---

## Part 2: Frontend on Vercel

### 2.1 Import the repo

1. Go to [vercel.com](https://vercel.com) and sign in (e.g. with GitHub).
2. Click **“Add New…”** → **“Project”**.
3. Import the same **dazos-cfo-copilot** repo (or the repo you use).
4. Leave **Framework Preset** as Vite (or set it to Vite if asked).

### 2.2 Configure build

1. **Root Directory:** click **Edit** and set to `frontend`.
2. **Build Command:** `npm run build` (often auto-filled).
3. **Output Directory:** `dist` (often auto-filled).
4. **Environment variables:** add one:
   - Name: `VITE_API_URL`  
   - Value: your **backend URL from Part 1** plus `/api`, e.g. `https://dazos-cfo-copilot-production-xxxx.up.railway.app/api`
5. Click **Deploy**. Wait until the deployment finishes.

### 2.3 Get the frontend URL

1. When the deploy is done, Vercel shows the site URL (e.g. `https://dazos-cfo-copilot-xxx.vercel.app`).
2. Copy that URL.

---

## Part 3: Connect backend and frontend

1. In **Railway**, open your backend service → **Variables**.
2. Set **CORS_ORIGINS** to your Vercel URL (and optionally localhost for dev), e.g.:  
   `https://dazos-cfo-copilot-xxx.vercel.app,http://localhost:5173`
3. Save. Railway will redeploy with the new CORS setting.

---

## Part 4: Check that it works

1. Open your **Vercel URL** in the browser. You should see the app (Dashboard, Customer overview, etc.).
2. Try **Sync from Salesforce** on Customer overview and **Export to Google Sheet** (if configured).
3. Backend runs 24/7, so the **hourly sync** (:59 EST) and **daily EOD snapshot** (23:59 EST) will run automatically.

---

## Quick reference

| What            | Where                         |
|-----------------|-------------------------------|
| Backend 24/7    | Railway (root: `backend`)     |
| Database        | SQLite on Railway volume `/data` → `DATABASE_URL=sqlite+aiosqlite:////data/cfo.db` |
| Frontend        | Vercel (root: `frontend`, `VITE_API_URL` = backend URL) |
| CORS            | Railway env: `CORS_ORIGINS` = your Vercel URL |
| Sync / snapshot | Run automatically by the backend (EST)      |

If something doesn’t work, check: Railway logs (backend errors), Vercel function/build logs (frontend build), and that `VITE_API_URL` and `CORS_ORIGINS` match your real URLs (no trailing slash).
