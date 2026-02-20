# QuickBooks Online — one-time setup (Phase 1c)

To sync P&L, Balance Sheet, and Cash Flow into the Copilot you need a **refresh token** from Intuit’s OAuth. Do this once, then put the values in `backend/.env`.

**Note:** We use **Sandbox/Development** only for now. Production (real company) will be set up later with Production keys and a new OAuth flow.

---

## Step 1 — Create an Intuit developer app

1. Go to **https://developer.intuit.com** and sign in (or create an Intuit developer account).
2. **Create an app** (or open an existing one): **Apps** → **Create an app** → **QuickBooks Online**.
3. Under **Keys & credentials**, note:
   - **Client ID**
   - **Client Secret**
4. Under **Keys & credentials** → **Redirect URIs**, add: **`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`** (so you can use the OAuth 2.0 Playground in the next step). Save.

---

## Step 2 — Get refresh token and Realm ID (OAuth Playground)

1. Open **https://developer.intuit.com/app/developer/playground** (OAuth 2.0 Playground).
2. **Step 1 – Get authorization code:**
   - Select **QuickBooks Online** (or **Accounting**).
   - Click **Get authorization code**.
   - Sign in with the Intuit/QuickBooks account that has access to the company you want to sync.
   - Choose the **company** (if you have more than one).
   - After redirect, you’ll see an **Authorization code** in the Playground. Copy it.
3. **Step 2 – Get tokens:**
   - Paste the authorization code.
   - Click **Get tokens**.
   - Copy the **Refresh token** and the **Realm ID** (company id). You’ll need both in `.env`.

---

## Step 3 — Configure the backend

1. Open **`backend/.env`** (create from `.env.example` if needed).
2. Add (use your real values):

   ```env
   QB_CLIENT_ID=your_client_id_from_step_1
   QB_CLIENT_SECRET=your_client_secret_from_step_1
   QB_REALM_ID=the_realm_id_from_playground
   QB_REFRESH_TOKEN=the_refresh_token_from_playground
   QB_SANDBOX=true
   ```

   **Important:** If you're using a **Sandbox/Development** company (OAuth Playground in Sandbox mode), set **`QB_SANDBOX=true`**. Otherwise the Reports API returns 403 Forbidden because Sandbox companies must use the sandbox API endpoint.

3. Restart the backend so it loads the new variables.

---

## Step 4 — Sync and read reports

1. **Sync:** In the API docs (**http://localhost:8000/docs**), run **POST /api/sync/quickbooks**.
2. **Read:** Use **GET /api/quickbooks/reports/pl**, **GET /api/quickbooks/reports/balance_sheet**, or **GET /api/quickbooks/reports/cash_flow** to get the latest P&L, Balance Sheet, or Cash Flow snapshot.

Refresh tokens can expire if unused for a long time or if the app’s credentials change. If sync starts failing with an auth error, repeat Step 2 to get a new refresh token and update `QB_REFRESH_TOKEN` in `.env`.
