# Metric and data definitions (Dazos CFO Cockpit)

Single reference for **what each term means in this app**, how it is computed, and where it is used. When product behavior changes, update this file and the linked code comments.

**Related:** [CONTEXT.md](../CONTEXT.md) (company and analyst lens), [DASHBOARD_KPIS.md](DASHBOARD_KPIS.md) (KPI summary / Salesforce mapping), [DAZOS_PRODUCTS_PRICEBOOK.md](DAZOS_PRODUCTS_PRICEBOOK.md) (product scope for ARR columns).

The **Go-To-Market → Renewals** list and **`GET /api/renewals-overview`** were removed pending a rebuild; renewal **record types**, **open renewal ARR** on the dashboard KPI, and **bookings (expansion upon renewal)** still use Salesforce as documented below.

**Time zone:** Unless stated otherwise, “today” and schedule logic use **America/New_York (EST/EDT)**.

---

## Systems of record

| System | Role in this app |
|--------|------------------|
| **Salesforce** | Source of truth for **ARR**, **pipeline**, opportunities, record types, stages, and line items used in the schedule and dashboards. |
| **Google Sheets** | Financial **plan** and model ranges (e.g. bookings plan, cash plan). Synced snapshots; not the source of ARR. |
| **Chargebee** | **Billing** data (invoices, subscriptions) for cash/billings **actuals** vs plan—not the definition of ARR. |
| **QuickBooks** | Financial statements (P&amp;L, balance sheet, cash flow) where wired. |

---

## Stages and pipeline

- **Closed stages:** Opportunities in **`Closed Won`** or **`Closed Lost`** are treated as closed (matching is case-insensitive with normalization). Closed opps are excluded from **open pipeline**.
- **Open pipeline:** Opportunities that are **not** Closed Won/Lost. **Pipeline value (KPI card):** sum of **`Amount`** on those open opps (see `/api/dashboard-kpi`).
- **Closed Won:** Used for bookings, closed-won ARR on opportunities, and building the **Active ARR** schedule (anchors, expansions).

---

## Record types (Salesforce)

Classification uses **`RecordType.Name`** (stored as `record_type_name`). Manual overrides exist in **`opportunity_record_type_overrides`** (per opportunity).

| Pattern | Typical use |
|---------|-------------|
| **Renewal** (name is `"renewal"` or contains `"renewal"`) | Open renewal ARR on the simple KPI; anchor periods; open-renewal-only product columns on Products purchased. |
| **New Business** / **New Customer** / **Internal Admin Use** | New business anchors and NB pipeline. |
| **Expansion** | Expansion pipeline and closed-won expansion bookings. |
| **Amendment** | Treated as amendment when not overridden. |

---

## Two different “ARR” figures (do not confuse them)

### 1. Dashboard KPI — “ARR” (Salesforce summary card)

**Definition:** Sum of **MRR × 12** (i.e. ARR) from **product lines** on **open** opportunities whose record type is **Renewal** (and stage not closed).

**Line math:** Prefer **`OpportunityLineItem.TotalPrice`** as MRR per line (or UnitPrice × Quantity per org settings). See [DASHBOARD_KPIS.md](DASHBOARD_KPIS.md).

**API:** `GET /api/dashboard-kpi` → `arr`, `pipeline`.

This is **not** the same number as **Live ARR** on the Schedule / Dashboard top cards.

### 2. Live ARR (schedule / “Active ARR”)

**Definition:** **Active ARR by account** from the **ARR schedule engine**: for each account, ARR **as of today** from the most recent **closed-won** renewal or new-business anchor, plus **closed-won expansions** in the subscription window; special rules for **open-only renewal** accounts and **manual overrides** (`active_arr_account_overrides`).

**Also labeled:** “Active ARR” in API/docs; **Live ARR** on the Dashboard and Products purchased context.

**API:** `GET /api/arr-schedule/active-arr` → rows with `active_arr`, `grand_total`.

**Copilot “Total CARR” (natural language):** Uses the **same cohort as Contracted ARR** (see below)—Live ARR plus future closed-won NB/Expansion with service start after today—not the simple open-renewal KPI sum.

---

## Contracted ARR (CARR) — column and Dashboard card

**Definition:** **Live ARR** (same schedule rules as the Schedule view) **plus** ARR from **Closed Won** **New Business** and **Expansion** opportunities whose **service start** (earliest included line item, else contract start) is **strictly after today** (America/New_York).

- **Products purchased** product columns for ARR still reflect **open renewal** line items where applicable; the **grand total** matches the **Contracted ARR** story (Live + future closed-won cohort).
- **Per-row `contracted_arr`:** Same schedule engine as Active ARR, evaluated for a **forward** view (e.g. soonest future period when the subscription has not started).

**Dashboard:** The **Contracted ARR** stat card shows this **grand total** (aligned with Products purchased).

---

## CRM seats (Live vs Contracted)

**Live CRM seats:** Seats derived from **CRM SKUs only** (e.g. Additional CRM Seats quantity + bundled seats on CRM Platform products) for the **period active today** on the schedule—aligned with **Live ARR** rows.

**Contracted CRM seats:** **Live CRM seats** plus seat counts from **Closed Won** NB/Expansion with **service start after today**—same **cohort** as **Contracted ARR**.

**API:** Returned on `GET /api/arr-schedule/active-arr` as `crm_seats_live_total` and `contracted_crm_seats_total` (and per-row `crm_seats` where applicable).

---

## Bookings (ARR) — dashboard block

**Purpose:** **Booking ARR** in calendar periods vs **plan** from Google Sheets.

**Stages:** **Closed Lost** contributes **0**. Only **Closed Won** opps in the close-date window are counted.

**Periods:** Typically **two months ago**, **previous month**, **current month MTD**, **quarter QTD** (labels like `Jan 26`, `Feb 26 MTD`, `Q1 26 QTD`).

**Rows per period:** **Total**, **New Business**, **Expansion**—each with actual (`mtd`), plan, achievement %, delta ($K).

- **New Business row:** Closed Won **New Business** — **`ARR__c`** on the Opportunity (`opportunity_arr` after sync).
- **Expansion row:** Actual = **mid-term + upon renewal** (both use **`Expansion_ARR__c`** on Closed Won Expansion vs Renewal opps). Plan is the sheet **expansion** column vs that combined actual (% / Δ).
- **Total row:** New Business + mid-term expansion + upon renewal (same sum as NB + **Expansion** row).

**Sub-rows (actuals, no plan):**

- **`expansion_mid_term`:** Closed Won **Expansion** record type only — **`Expansion_ARR__c`**.
- **`expansion_upon_renewal`:** Closed Won **renewal** opps — **`Expansion_ARR__c`** (stored as `expansion_arr` after sync).

**Pipe coverage (MTD/QTD):** Open **pipeline ARR** divided by **shortfall to plan** for that slice (total / NB / expansion)—see API schema `pipe_coverage_*`.

**API:** `GET /api/dashboard/bookings-mtd`.

**Bookings page (table):** `GET /api/closed-overview` uses the same opportunity-only rules: **New Business** → **`ARR__c`**, **Expansion / Renewal / Amendment** → **`Expansion_ARR__c`** (no product line rollup).

---

## Cash — dashboard block

**Purpose:** **Billings** and **collections** vs **plan** (from sheet ranges such as **BS_2026P**), with **actuals** from **Chargebee** where configured.

**Periods:** Same layout as Bookings (two months ago, previous month, MTD, QTD).

**API:** `GET /api/dashboard/cash-mtd` (`chargebee_message` when billing data is missing or slow).

---

## MRR and line items

- **MRR (monthly):** From line items (`total_price` / **TotalPrice** in Salesforce) unless env forces **UnitPrice × Quantity**.
- **ARR from lines:** **MRR × 12** (with term-weighting where `term_months` and related fields are set—see **`SALESFORCE_LINE_ITEM_TERM_FIELD`** in `.env`).
- **Product scope for ARR columns:** Recurring **Dazos** products; **iVerify Monthly Credits** and **Kipu API** excluded from ARR totals/columns; one-time **ProServ** excluded. See [DAZOS_PRODUCTS_PRICEBOOK.md](DAZOS_PRODUCTS_PRICEBOOK.md).

---

## Optional Salesforce fields (environment)

| Env / concept | Purpose |
|---------------|---------|
| **`SALESFORCE_RENEWAL_DATE_FIELD`** | Custom opportunity field for **renewal date** when not using Close Date alone. |
| **Original ACV / UFR** | Baseline ARR up for renewal (synced into `original_acv` / similar). |
| **`ARR__c` / `opportunity_arr`** | **Closed Won New Business** booking ARR on the closed overview and dashboard bookings; also used elsewhere for renewed ARR context. |
| **`Expansion_ARR__c` / `expansion_arr`** | **Closed Won** expansion, renewal, and amendment booking ARR on closed overview and dashboard bookings. |
| **`SALESFORCE_LINE_ITEM_TERM_FIELD`** | Line-item term for period-weighted ARR (keep consistent across environments). |

---

## Snapshots and materialized tables

- **EOD snapshot:** Daily **23:59:59** America/New_York — stores JSON of accounts, opportunities, and line items in **`salesforce_eod_snapshots`** for historical analysis.
- **`arr_schedule_daily`:** Materialized **ARR by account by snapshot date** from EOD processing.
- **`arr_schedule_periods`:** Editable **subscription periods** (start/end, ARR) for historical “ARR as of date” and exports.

---

## Manual overrides (admin)

- **`opportunity_record_type_overrides`:** Force a different **record type** for reporting for a given opportunity.
- **`active_arr_account_overrides`:** For listed account names, **Active ARR** uses **open renewal** line ARR instead of the default schedule rule (Contracted logic does not use this override the same way—see code).

---

## API / schema cross-reference

| Concept | Primary types / routes |
|---------|-------------------------|
| Dashboard KPI | `DashboardKPI`, `GET /api/dashboard-kpi` |
| Live + Contracted ARR totals | `ActiveARRResponse`, `GET /api/arr-schedule/active-arr` |
| Products purchased grid | `ARRByAccountProductResponse`, `GET /api/arr-by-account-product` |
| Bookings | `BookingsMTDResponse`, `GET /api/dashboard/bookings-mtd` |
| Cash | `CashMTDResponse`, `GET /api/dashboard/cash-mtd` |

Pydantic models in **`backend/schemas.py`**; TypeScript mirrors in **`frontend/src/api.ts`**.

---

## Changelog

| Date | Notes |
|------|--------|
| 2025-03 | Initial consolidated definitions doc. Renewals-specific dashboard APIs removed pending rebuild; core renewal **record type** and **bookings expansion upon renewal** remain. |
