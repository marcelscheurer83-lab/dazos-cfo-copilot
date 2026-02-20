# Dazos CFO Copilot — Roadmap

This roadmap turns the [vision in CONTEXT.md](CONTEXT.md) into a phased build. Each phase delivers something you can use, and sets up the next.

**Data source priorities:** Start with **Google Sheets + Salesforce** (ARR and key GTM metrics). Then **QuickBooks** (financials). Salesforce = ARR source of truth; Chargebee = billing engine only (Intuit = payments). Crew Accounting sends monthly statements → uploaded to Google Sheets; automate later, not a priority.

---

## Progress (updated as we go)

| Milestone | Status | Notes |
|-----------|--------|--------|
| **1a** Connectors layer + Google Sheets | ✅ Done | Connectors layer + full model sync; plan data kept in background for summaries/analyses; dashboard shows KPI cards + “Refresh from sheet” only. |
| **1b** Salesforce connector (ARR + GTM) | ✅ Done | Connector + Opportunity sync; POST /api/sync/salesforce, GET /api/opportunities. |
| **1c** QuickBooks connector (financials) | ✅ Done | OAuth + Reports API; POST /api/sync/quickbooks, GET /api/quickbooks/reports/{pl,balance_sheet,cash_flow}. **Sandbox only for now** — production OAuth/keys later. |
| **2** Live exec dashboard | 🔲 Not started | KPIs from Sheets + Salesforce + QuickBooks. |
| **3** ARR schedule (Salesforce) | 🔲 Not started | ARR schedule maintained from Salesforce; view in app. |
| **4** Monthly & quarterly reports | 🔲 Not started | Draft reports from app data. |
| **5** Full data + analyst Copilot | 🔲 Not started | Justworks if needed; LLM; proactive analyst. |

---

## Current status / Where we left off (Feb 2026)

- **Backend & frontend** — Run with `uvicorn main:app --reload --port 8000` (backend) and `npm run dev` (frontend). App at http://localhost:5173, API at http://localhost:8000.
- **Google Sheets (Phase 1a)** — Done. Service account set up; full financial model syncs via “Refresh from sheet” on the dashboard (all tabs in `frontend/src/api.ts` → `MODEL_SHEET_RANGES`). Plan data is stored in the backend (table `sheet_snapshots`) and used in the background for future summaries/analyses; dashboard shows only KPI cards + “Plan data available… Last synced: …” and the Refresh button.
- **Dashboard** — Shows seed-data KPIs (cash, burn, runway, revenue, etc.). No raw sheet table; plan data is background-only.
- **Salesforce (Phase 1b)** — Done. Set SALESFORCE_USERNAME, SALESFORCE_PASSWORD, SALESFORCE_SECURITY_TOKEN in `.env`; run `POST /api/sync/salesforce` to sync opportunities; `GET /api/opportunities` to read them.
- **QuickBooks (Phase 1c)** — Done. Set QB_* in `.env` and **QB_SANDBOX=true** (sandbox only for now; production later). POST /api/sync/quickbooks; GET /api/quickbooks/reports/pl (or balance_sheet, cash_flow).
- **Next step** — **Phase 2: Live exec dashboard** (wire KPIs from Sheets + Salesforce + QuickBooks), then **Phase 3: ARR schedule**.

---

## Where we are today

- **App runs** — Backend (FastAPI) and frontend (React). Dashboard, P&L, cash flow, budget vs actuals, Copilot tab.
- **Data** — **Google Sheets** connected; full model syncs and is stored for summaries/analyses. **KPI / P&L / cash / budget** still from seed data until Salesforce and QuickBooks are connected.
- **Copilot** — Rule-based answers from seed KPI data; no LLM yet.

Goal: add Salesforce (ARR/GTM) and QuickBooks (financials), then live dashboard, ARR schedule, reports, and analyst Copilot.

---

## Phase 1 — Data layer foundation (weeks 1–4)

**Objective:** Connect **Google Sheets** and **Salesforce** first (ARR and key GTM metrics). Then connect **QuickBooks** for financials. Proves the connector pattern and gives the app real data for dashboard and ARR.

**Scope:**

| Item | What we do | Why |
|------|------------|-----|
| **Backend structure** | Add a “connectors” layer: one module per system (`connectors/google_sheets.py`, `connectors/salesforce.py`, `connectors/quickbooks.py`). Each connector fetches data and writes into app tables (existing or new). | So we can add more systems later without rewriting the app. |
| **1a — Google Sheets** | Connect the **comprehensive Google Sheet** (financial model/plan). Read ranges that hold plan, KPIs, or summary data the dashboard and reports need. | Plan and model are the source of truth; needed for variance and reporting. |
| **1b — Salesforce** | Connect **Salesforce** (ARR source of truth + key GTM metrics). Sync opportunities, closed-won, ARR/MRR-relevant objects (or reports) into the app. | ARR and GTM reporting start here. |
| **1c — QuickBooks** | Connect **QuickBooks Online** for P&L, balance sheet, cash. Sync into app so financials in the dashboard and reports are live. | Financials; Crew Accounting feeds QB; you upload their statements to sheets—automate later, not priority. |
| **Sync approach** | Scheduled sync (e.g. every 15–60 min via script or backend job). Document how to run syncs and what each connector needs (API keys, OAuth, sheet IDs). | Near live is enough for exec dashboard and reports. |
| **Secrets** | Store API keys / OAuth in `backend/.env`. Document in README what’s needed per system. | Safe and repeatable. |

**Done when:** You can run a sync and see Google Sheet plan data and Salesforce ARR/GTM data in the app; then QuickBooks financials. Dashboard (Phase 2) can consume this.

**You’ll need:** Google Sheets API (service account or OAuth), Salesforce API access, QuickBooks Online API access.

---

## Phase 2 — Live exec dashboard (weeks 3–5)

**Objective:** The **main company performance KPIs** are visible on a single dashboard you can pull up in exec conversations, using data from Google Sheets, Salesforce, and (once connected) QuickBooks.

**Scope:**

| Item | What we do |
|------|------------|
| **KPI list** | Lock the list of “main” KPIs (e.g. ARR, MRR, cash, burn, runway, pipeline, key GTM metrics, top-line vs plan). Align with your Google Sheet plan so labels and definitions match. **→ [docs/DASHBOARD_KPIS.md](docs/DASHBOARD_KPIS.md)** |
| **Dashboard UI** | Refine the existing Dashboard view: these KPIs front and centre, clear labels, and “as of” / last sync time so you know how fresh the data is. |
| **Data mapping** | Map each KPI to a source: **Salesforce** (ARR, GTM), **Google Sheets** (plan, variance), **QuickBooks** (financials). Implement for sources connected in Phase 1; placeholders for Justworks, etc. |

**Done when:** You can open the app, go to the dashboard, and see the agreed exec KPIs from synced Google Sheets + Salesforce (and QuickBooks once Phase 1c is done), with a clear “last updated” indicator.

---

## Phase 3 — ARR schedule (weeks 5–7)

**Objective:** The Copilot **prepares and maintains** the ARR schedule from **Salesforce** (source of truth for ARR): recurring revenue view, cohorts, churn, expansion, and key GTM metrics.

**Scope:**

| Item | What we do |
|------|------------|
| **ARR data model** | Define tables/structures for: ARR/MRR by cohort or segment, churn, expansion, and splits you care about (e.g. product, segment), aligned with what Salesforce provides. |
| **Salesforce → ARR** | Sync the relevant Salesforce objects/reports into that model; compute or surface ARR, MRR, and basic cohort/churn metrics. |
| **ARR view in the app** | New “ARR” or “Revenue” view: schedule table and, if useful, simple charts (e.g. MRR trend, cohort retention). Include key GTM metrics that live in Salesforce. |
| **Maintain** | Sync (e.g. scheduled or “Refresh ARR” in the app) keeps it updated from Salesforce. Document how “maintain” works. |

**Done when:** The ARR schedule is visible in the app and updates when Salesforce data is synced; you can use it for internal and board discussions.

---

## Phase 4 — Monthly and quarterly reports (weeks 6–9)

**Objective:** The Copilot **prepares** monthly reports (internal + board) and **quarterly board performance reports**, so you have drafts to edit and share instead of starting from zero.

**Scope:**

| Item | What we do |
|------|------------|
| **Report templates** | Define structure and sections for: (1) monthly internal, (2) monthly board, (3) quarterly board. E.g. summary, KPIs, P&L/cash highlights, ARR, pipeline, risks/opportunities. |
| **Data → report** | Backend (or scheduled job) fills the templates with data from the app’s DB (dashboard KPIs, P&L, cash flow, ARR, budget vs actual). Output = document (e.g. PDF or Google Doc) or structured blob (e.g. JSON/Markdown) you can paste into a doc. |
| **Where it lives** | Either the app has a “Reports” area with “Generate monthly” / “Generate quarterly” and a download, or a script you run (e.g. `python scripts/generate_monthly_report.py`) that produces a file. |

**Done when:** You can generate a monthly and a quarterly report draft from one click or one command, with numbers pulled from the same data that powers the dashboard and ARR schedule.

---

## Phase 5 — Full data layer and analyst Copilot (weeks 9–12+)

**Objective:** Remaining systems connected as needed; Copilot can do **ad hoc analyses** and **proactive** ideas (FP&A/RevOps analyst in the app).

**Scope:**

| Item | What we do |
|------|------------|
| **Remaining connectors** | Justworks (headcount, payroll-related). Chargebee only if needed for billing reconciliation (ARR stays from Salesforce). Later: Outreach, HubSpot. **Crew Accounting:** automate ingestion of their statements into sheets/app is possible later—**not a priority**; today you upload their statements into the Google Sheets model. |
| **Single “sync” story** | One place (script or app button) that runs all syncs (Sheets, Salesforce, QuickBooks, Justworks, etc.) in a sensible order so the app has a consistent snapshot. |
| **Copilot + LLM** | Plug an LLM (e.g. OpenAI) into the Copilot tab; give it CONTEXT.md + access to KPIs, P&L, ARR, pipeline, and plan. So you can ask in plain English and get answers that reference your data. |
| **Proactive analyst** | Optional: scheduled “digests” (e.g. weekly email or in-app summary) with highlights, variances, and suggested talking points. Starts simple (e.g. “top 3 variances vs plan”) and can get smarter with the LLM. |

**Done when:** All priority systems feed the app; you can ask the Copilot ad hoc questions and get analyst-style answers; optionally you get a short proactive summary on a schedule.

---

## Summary: order of work

| Phase | Focus | Outcome for you |
|-------|--------|------------------|
| **1** | Data layer: Google Sheets + Salesforce (ARR/GTM), then QuickBooks (financials) | Real plan, ARR, GTM, and financial data in the app. |
| **2** | Live exec dashboard | One screen with main KPIs for exec conversations. |
| **3** | ARR schedule (Salesforce) | ARR schedule maintained from Salesforce; view in app. |
| **4** | Monthly & quarterly reports | Draft reports generated from app data. |
| **5** | Full data + analyst Copilot | Justworks etc.; LLM; ad hoc + proactive analyst. |

---

## How to use this roadmap

- **Progress:** The **Progress** table at the top is updated as we complete milestones (e.g. “Phase 1a done”, “Phase 1 in progress”).
- **Scope per phase:** Phase 1 is split into 1a (Google Sheets), 1b (Salesforce), 1c (QuickBooks). We can tick those off in the Progress section as we go.
- **Ownership:** Document who runs syncs, who has API keys, and where the Google Sheet lives so the Copilot stays maintainable.
