# Dashboard KPIs — Phase 2

This document locks the **main exec dashboard KPIs** and maps each to its **source of truth**. Use it when wiring the live dashboard (Phase 2) and when aligning the Google Sheet plan labels.

**Principles:** FP&A + RevOps lens; board/investor-ready; ARR from Salesforce, financials from QuickBooks, plan/variance from Google Sheets.

**Current scope:** The **KPI Summary** (dashboard cards / API) uses **Salesforce only** for now. QuickBooks and Google Sheets KPIs will be added later.

---

## KPI Summary — Salesforce only (current)

These are the only KPIs we surface in the KPI Summary until we wire QuickBooks and Sheets.

| # | KPI | Definition | How we get it |
|---|-----|------------|----------------|
| 1 | **ARR** | Annual recurring revenue from **all open renewals**. | For each opportunity where **Record Type = Renewal** and stage is **open** (not Closed Won / Closed Lost), **Sales Price × Quantity** per product line = **MRR** (monthly). **ARR = MRR × 12.** Total ARR = sum of (line MRR × 12) across all open renewals. In Salesforce: `OpportunityLineItem.TotalPrice` (or UnitPrice × Quantity) = MRR; we multiply by 12. |
| 2 | **Pipeline** | Total value of open opportunities (not closed). | Sum of `Amount` where `StageName` is **not** Closed Won or Closed Lost. |

**Example (from Salesforce):** For "Heartfelt Recovery Centers - Renewal - 2028-03-15" (Record Type **Renewal**, Stage **Internal Discovery**), ARR is the sum over its products: e.g. (Additional CRM Seats $100 × 2) + (Marketing Reports $300 × 1) + (iVerify Credits $0.35 × 200) + (Kipu API $150 × 1) + (Additional EINs $100 × 1) + (Dazos CRM $830 × 1) = total for that opportunity. New Business + Closed Won opportunities are excluded.

**As of / last sync:** Show "Salesforce synced at &lt;timestamp&gt;" (from last `POST /api/sync/salesforce` or from latest opportunity `synced_at`).

**Implementation note:** Sync or query **OpportunityLineItem** (OpportunityId, UnitPrice, Quantity, TotalPrice) for opportunities that are Record Type = Renewal and open; sum TotalPrice (or UnitPrice × Quantity) per opportunity, then sum across renewals for total ARR.

**ARR product scope (Dazos Products price book):** ARR uses the **11 recurring (monthly)** products from the Dazos Products price book. **iVerify Monthly Credits** and **Kipu API** are excluded from ARR (not counted in totals or columns). The **6 one-time ProServ products** (e.g. CRM/IQ/iCampaign Implementation, Data Migration, Kipu API Set Up, Customer Integration Development) are out of scope for ARR and do not appear as columns or in totals. The full product and list price list is stored in [`data/dazos-products-pricebook.json`](../data/dazos-products-pricebook.json) for analysis; see [DAZOS_PRODUCTS_PRICEBOOK.md](DAZOS_PRODUCTS_PRICEBOOK.md).

---

## Later: full KPI list (QuickBooks + Sheets + derived)

When we add QuickBooks and Sheets to the KPI Summary, we’ll use the full mapping below.

| # | KPI | Source | How we get it |
|---|-----|--------|----------------|
| 1 | Cash balance | QuickBooks | Balance Sheet → Current Assets → Bank Accounts total. |
| 2 | Monthly burn | QuickBooks (or Sheets) | Cash Flow → Operating activities net; or from plan in Sheets. |
| 3 | Runway | Derived | Cash ÷ monthly burn (months). |
| 4 | ARR | **Salesforce** | Sum of (Sales Price × Quantity) per product line on each open renewal opportunity (see summary above). |
| 5 | Revenue YTD | QuickBooks | P&L → Total Income / Revenue, YTD. |
| 6 | Revenue growth % (YTD) | QuickBooks | (Revenue YTD − Prior YTD) ÷ Prior YTD. |
| 7 | Gross margin % | QuickBooks | P&L → (Gross Profit ÷ Total Income) × 100. |
| 8 | EBITDA YTD | QuickBooks | P&L → Operating Income (or equivalent). |
| 9 | Pipeline | **Salesforce** | *(Already in summary above.)* |
| 10 | AR days | QuickBooks | From Balance Sheet + P&L. |
| 11 | AP days | QuickBooks | From Balance Sheet + P&L. |

---

## Plan vs actual (variance) — later

When we wire Sheets: plan from **Google Sheets**, actual from **QuickBooks** or **Salesforce**. Sheet ranges and cell mapping TBD.

---

## Out of scope for initial Phase 2

- **MRR:** ARR ÷ 12 if needed.
- **Cohorts, churn, expansion:** Phase 3 (ARR schedule).
- **CAC, LTV, headcount:** Later.

---

## Next steps (Salesforce-only)

1. **Confirm** closed-won (and closed-lost) stage names for your Salesforce org.
2. **Implement** KPI Summary from Salesforce only: compute ARR and Pipeline from synced opportunities; expose via **GET /api/kpi** (or a dedicated response shape) with `as_of` / last sync from Salesforce.
3. **Dashboard UI:** Show ARR and Pipeline cards with "Salesforce synced at …" and a Refresh from Salesforce action.
4. **Later:** Add QuickBooks and Sheets to the same summary and "as of" per source.
