# Renewals rebuild — data and performance notes

This complements [`docs/archive/renewals_pre_removal/README.md`](archive/renewals_pre_removal/README.md) (restore point). Use it when designing the next renewals experience.

## Goals

- **Fast dashboards**: sub-second reads for MTD/QTD/cohort views without replaying full ARR schedule logic per HTTP request.
- **Correct source of truth**: Salesforce remains authoritative; the app stores synced rows and derived summaries.

## Source data (keep syncing)

- **`opportunities`** (and line items): `record_type_name`, `renewal_date`, `close_date`, `stage_name`, `original_acv`, `opportunity_arr` / `ARR__c`, contract dates, account linkage.
- **Env**: `SALESFORCE_RENEWAL_DATE_FIELD` when the org uses a custom renewal date field.

Indexes that usually help (SQLite/Postgres): `(record_type_name)`, `(renewal_date)`, `(close_date)`, `(stage_name)`, `(account_id)` — tune to your heaviest filters.

## Avoid on the hot path

- Loading **all** opportunities and filtering in Python for every dashboard refresh.
- Recomputing **EOD snapshot replay** or full **products-purchased schedule** just to answer “renewals this month.”

## Recommended patterns

### 1. Narrow queries first

For renewal-specific APIs, query with **`record_type_name` LIKE renewal** (or your canonical list) **and** a **date window** (`renewal_date` or `close_date` between …). Return only columns you need.

### 2. Materialized renewal metrics (nightly or on sync)

After each Salesforce sync (or a scheduled job), upsert rows into something like:

| Concept | Example columns |
|--------|-------------------|
| **Renewal cohort by month** | `cohort_month`, `account_id`, `ufr_baseline_arr`, `renewed_arr`, `status`, `sf_opp_id` |
| **Rollups** | `period` (month/quarter), `sum_ufr`, `sum_renewed`, `count_won`, `renewal_rate_pct` |

Dashboards read **only** these tables. Rebuild rules live in one place (the job), not scattered across request handlers.

### 3. Read models vs. live schedule

- **Read model**: pre-aggregated renewal KPIs for GTM dashboards.
- **Live schedule** (`_compute_active_arr_rows` and related): keep for **deep-dive** admin / ARR schedule tools, not for every renewals widget.

### 4. Idempotent sync → idempotent aggregates

Make aggregate jobs **idempotent** (delete-and-insert or upsert by natural key) so retries after partial failure do not double-count.

### 5. API shape

Prefer **small JSON payloads**: one row per period for summary cards; optional `?detail=1` or separate endpoint for drill-down lists.

## What stayed in the codebase after removal

Bookings MTD still uses **`expansion_upon_renewal`** via `_closed_won_renewal_expansion_arr_in_range`. Copilot still answers “CARR up for renewal in (month/year)” using open renewal opportunities. Those paths are unrelated to the removed Renewals page/APIs but reuse the same Salesforce fields.
