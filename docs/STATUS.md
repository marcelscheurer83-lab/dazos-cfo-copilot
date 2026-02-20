# Project status (save point)

**Date:** Feb 19, 2025  
**Next session:** Continue from here.

---

## Done today

- **ARR exclusions:** Kipu API and iVerify Monthly Credits (and “Verify Monthly Credits”) are fully excluded from ARR using normalized product names and substring matching. Lenape (and others) should show $0 in Other for those products.
- **Price book alignment:** Documented that ARR uses the 11 recurring products from Dazos Products price book; 6 one-time ProServ products are out of scope. Added “Verify Monthly Credits” and “Additional IQMR EINs” alias in backend.
- **Product/price data:** Full Dazos Products price book stored in `data/dazos-products-pricebook.json`; see `docs/DAZOS_PRODUCTS_PRICEBOOK.md`.
- **ARR export to Google Sheet:** “Export to Google Sheet” on the ARR page writes the current ARR-by-account-product table to the configured sheet. Backend: `POST /api/export/arr-to-google-sheet`; connector has write scope and `update_range()`. Env: `GOOGLE_SHEET_ARR_EXPORT_RANGE` (default `ARR!A1:Z200`). User must have an “ARR” tab (or custom range) and share the sheet with the service account.

---

## App overview

- **Stack:** React + Vite frontend, FastAPI backend, SQLite. Data from Google Sheets, Salesforce, QuickBooks (sandbox only).
- **Routes:** Dashboard (ARR + Pipeline from Salesforce), ARR page (table by account/product + Export to Google Sheet), P&L, Cash flow, Budget vs actual, Copilot.
- **Key env (backend/.env):** `GOOGLE_SHEET_ID`, `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SHEETS_CREDENTIALS_JSON`, `GOOGLE_SHEET_ARR_EXPORT_RANGE` (optional), Salesforce credentials, optional QuickBooks + `QB_SANDBOX=true`.
- **Run:** Backend `uvicorn main:app --reload --port 8000` (from `backend/`), frontend `npm run dev` (from `frontend/`). App at http://localhost:5173.

---

## Possible next steps (when you return)

- Confirm Lenape (and any other account) shows $0 in Other for Kipu/iVerify after a Salesforce refresh.
- If sharing the app with others: deployment, CORS, and auth (see earlier conversation).
- Any further ARR or export tweaks (e.g. different sheet/range, formatting).

---

*Update this file as you progress.*
