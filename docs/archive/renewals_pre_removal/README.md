# Renewals feature — archived snapshot (pre-removal)

The **dashboard Renewals (ARR) block**, **Go-To-Market → Renewals** page, and related APIs were removed from the live app so renewals can be rebuilt.

## How to restore the old implementation

1. **Git branch** (same commit as the snapshot before removal):

   ```bash
   git branch -a | findstr renewals
   git log --oneline -5 --grep="renewals"
   ```

   Look for commit **`archive: snapshot before renewals removal`** (or the branch `archive/renewals-baseline-before-removal` if it was created).

2. **Restore files** from that commit into your working tree:

   ```bash
   git checkout <that-commit> -- backend/main.py backend/schemas.py frontend/src/views/Dashboard.tsx frontend/src/views/Renewals.tsx frontend/src/api.ts frontend/src/App.tsx frontend/src/Layout.tsx
   ```

   Adjust paths if your tree differs. Re-add `Renewals.tsx` if it was deleted.

3. **Re-run the frontend build** (`npm run build`) and restart the backend.

## What was kept on purpose

- **Salesforce sync** still loads renewal opportunities and fields (`renewal_date`, `original_acv`, `opportunity_arr`, etc.) for future use.
- **Bookings (ARR)** still includes **expansion upon renewal** via `_closed_won_renewal_expansion_arr_in_range`.
- **ARR schedule / Products purchased** still treat **Renewal** record types as today (core product logic).

## Suggested direction for the rebuild (summary)

See **[`docs/renewals_rebuild_notes.md`](../renewals_rebuild_notes.md)** — materialized cohorts / rollups, narrow SQL filters, read models fed by sync or nightly jobs, and avoiding per-request full-table scans plus heavy schedule replay.
