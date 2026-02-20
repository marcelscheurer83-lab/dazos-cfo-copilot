# Dazos CFO Copilot

A complete CFO Copilot for **Dazos** — financial dashboard, KPIs, statements, budget vs actuals, and an AI-assisted Copilot for natural-language questions.

**Company & role context:** See [CONTEXT.md](CONTEXT.md) for Dazos background and the FP&A/RevOps analyst lens used when building this Copilot.  
**Build plan:** See [ROADMAP.md](ROADMAP.md) for the phased roadmap (data layer → live dashboard → ARR schedule → reports → full analyst Copilot).

## Features

- **Executive dashboard** — Cash position, revenue, burn, runway, key metrics at a glance
- **P&L view** — Income statement with period comparison
- **Cash flow** — Operating, investing, financing summary
- **Budget vs actuals** — Variance analysis by category
- **Copilot** — Ask questions in plain English (“What’s our runway?”, “How did marketing spend compare to plan?”)

## Tech stack

- **Backend:** Python 3.11 or 3.12 recommended (3.14 not yet supported by some deps), FastAPI, SQLite (upgradable to Postgres)
- **Frontend:** React 18, TypeScript, Vite
- **Future:** Connect to Dazos ERP/GL via API or file feeds

## Quick start

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. API runs at **http://localhost:8000**.

### Publishing the front-end (making it accessible online)

1. **Build the frontend** with the API base URL set to your deployed backend:
   ```bash
   cd frontend
   # Set your backend API URL (e.g. https://api.yourcompany.com)
   # On Windows PowerShell: $env:VITE_API_URL="https://api.yourcompany.com"; npm run build
   # On Linux/macOS: VITE_API_URL=https://api.yourcompany.com npm run build
   npm run build
   ```
   Output is in `frontend/dist`. Host that folder on any static host (Vercel, Netlify, S3 + CloudFront, etc.).

2. **Backend CORS:** In `backend/.env` set `CORS_ORIGINS` to your frontend URL(s), e.g.:
   ```
   CORS_ORIGINS=https://your-app.vercel.app,http://localhost:5173
   ```
   Then deploy the backend (e.g. Railway, Render, Fly.io) so it is reachable at the URL you used for `VITE_API_URL`.

3. **Summary:** Set `VITE_API_URL` at frontend build time to your backend URL; set `CORS_ORIGINS` on the backend to your frontend origin(s). All scheduled times (Salesforce sync, EOD snapshot) use **America/New_York (EST/EDT)**.

### Running the backend 24/7 (scheduled sync & snapshot)

The **hourly Salesforce sync** (:59:59 EST) and **daily EOD snapshot** (23:59:59 EST) run only while the backend process is running. If your machine is off or you stop the server, they won’t run.

To have them run constantly (including when your computer is off):

1. **Deploy the backend** to a host that runs 24/7. Examples:
   - **[Railway](https://railway.app)** — Deploy from GitHub; add env vars in the dashboard; offers a small Postgres DB you can use instead of SQLite.
   - **[Render](https://render.com)** — Web Service from a repo; set env vars; optional Postgres add-on.
   - **[Fly.io](https://fly.io)** — Run a container; you can mount a volume for SQLite or use an external DB.
   - **Google Cloud Run / AWS / Azure** — Same idea: run the FastAPI app as a long-running or always-on service.

2. **Database:** On most cloud hosts the filesystem is **ephemeral** (resets on restart). So either:
   - Use a **hosted database** (e.g. Postgres on Railway or Render) and set `DATABASE_URL` in the app, or  
   - Use a **persistent volume** for the SQLite file if the host supports it (e.g. Fly.io volumes).

3. **Secrets:** Put all `backend/.env` values (Salesforce credentials, Google credentials, etc.) into the host’s **environment variables** or secrets (no `.env` file in the repo).

4. **No code changes needed** — the scheduler is already in the app; once the backend is running 24/7 on a host, sync and EOD snapshot will run on schedule in EST.

If you prefer to trigger sync/snapshot from **outside** (e.g. a cron service hitting your API), you can call `POST /api/sync/salesforce` every hour; the EOD snapshot is only triggered by the in-app scheduler, so for true 24/7 you need the backend deployed.

## Project structure

```
dazos-cfo-copilot/
├── backend/          # FastAPI app, DB, APIs
├── frontend/         # React + Vite app
├── CONTEXT.md        # Company, user, and Copilot vision
├── ROADMAP.md        # Phased build plan
└── README.md
```

## Environment

- Copy `backend/.env.example` to `backend/.env` and set any API keys (e.g. for future AI provider).
- Defaults work with SQLite and seed data.

### Google Sheets connector (Phase 1a)

To pull data from your financial model/plan Google Sheet:

1. **Create a Google Cloud project** and enable the **Google Sheets API** ([Google Cloud Console](https://console.cloud.google.com/)).
2. **Create a service account** (APIs & Services → Credentials → Create credentials → Service account). Create a key (JSON) and download the file. Keep it private (e.g. `backend/credentials/google-service-account.json` — add `credentials/` to `.gitignore`).
3. **Share your Google Sheet** with the service account email (the `client_email` in the JSON file). Give it “Viewer” access so it can read the sheet.
4. In `backend/.env` set:
   - `GOOGLE_SHEET_ID` — from the sheet URL: `https://docs.google.com/spreadsheets/d/<this part>/edit`
   - `GOOGLE_APPLICATION_CREDENTIALS` — path to the JSON key file (e.g. `./credentials/google-service-account.json`).
5. **Sync a range:** `POST http://localhost:8000/api/sync/google-sheets?range_name=Plan!A1:Z50` (use your sheet’s tab name and range). Then `GET http://localhost:8000/api/sheet-snapshots/latest?range_name=Plan!A1:Z50` to see the stored data.

Ranges use A1 notation (e.g. `Summary!A1:D20`). You can sync multiple ranges; each is stored as a snapshot with a “last updated” time.

### Salesforce connector (Phase 1b)

To sync opportunities (ARR and pipeline) from Salesforce:

1. In **Salesforce**: Get your **security token** (Profile → Settings → Reset My Security Token; it’s emailed to you). You need your login email, password, and this token.
2. In `backend/.env` set:
   - `SALESFORCE_USERNAME` — your Salesforce login email
   - `SALESFORCE_PASSWORD` — your Salesforce password
   - `SALESFORCE_SECURITY_TOKEN` — the token from step 1
   - `SALESFORCE_DOMAIN=login` (or `test` for sandbox)
3. **Sync:** `POST http://localhost:8000/api/sync/salesforce` (e.g. from the API docs at http://localhost:8000/docs). Opportunities are stored in the app for ARR schedule and pipeline views.

**Scheduled sync (EST):** With the backend running, Salesforce data is synced automatically every hour at **:59:59** (America/New_York). An **end-of-day snapshot** of all Salesforce data (accounts, opportunities, opportunity line items) is stored daily at **23:59:59 EST** in the `salesforce_eod_snapshots` table for future analysis.

### QuickBooks Online connector (Phase 1c)

To sync P&L, Balance Sheet, and Cash Flow from QuickBooks:

1. **Create an app** at [developer.intuit.com](https://developer.intuit.com): create a QuickBooks Online app, note **Client ID** and **Client Secret**.
2. **Complete OAuth once** to get a **refresh token**: use the Intuit OAuth 2.0 flow (authorize with your QB company, get an authorization code, exchange it for `access_token` and `refresh_token`). Store the **refresh_token**; the app uses it to get new access tokens. The **Realm ID** (company id) is in the redirect URL or from the API after connecting.
3. In `backend/.env` set:
   - `QB_CLIENT_ID` — from the Intuit app
   - `QB_CLIENT_SECRET` — from the Intuit app
   - `QB_REALM_ID` — your QuickBooks company (realm) id
   - `QB_REFRESH_TOKEN` — from the OAuth exchange (step 2)
4. **Sync:** `POST http://localhost:8000/api/sync/quickbooks`. Then `GET http://localhost:8000/api/quickbooks/reports/pl` (or `balance_sheet`, `cash_flow`) to read the latest report snapshot.

## Extending the Copilot

- The **Copilot** tab uses rule-based answers from your KPI and P&L data. You can plug in OpenAI or another LLM by reading `COPILOT_API_KEY` in `backend/main.py` and sending the user question plus a context summary (e.g. latest KPI, recent P&L) to the API.
- To connect **real Dazos data**, add ETL or API clients in `backend/` that write into the same tables (e.g. `KPI`, `PnLLine`, `CashFlowLine`, `BudgetLine`), or replace the seed with a sync from your GL/ERP.
