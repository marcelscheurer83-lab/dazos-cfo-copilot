# Contracted ARR: accounts with delta (local vs online)

**Totals:** Local **$6,792,142** | Online **$6,716,393** → **Δ $75,749** (local higher)

Accounts where Contracted ARR differs between local and online:

| Account | Local | Online | Delta (local − online) |
|--------|-------|--------|------------------------|
| Ascension Recovery Services | $46,467 | $39,885 | +$6,582 |
| Terra Behavioral Health | $35,446 | $19,200 | +$16,246 |
| Alter Behavioral Health | $34,650 | $23,100 | +$11,550 |
| Eosis Recovery | $33,055 | $18,840 | +$14,215 |
| The Well | $19,152 | $11,491 | +$7,661 |
| The Blanchard Institute | $18,926 | $11,040 | +$7,886 |
| Shoreline Treatment Center | $14,625 | $11,700 | +$2,925 |
| Vital Health | $14,625 | $11,700 | +$2,925 |
| Southern California Sunrise Recovery Center | $11,813 | $10,125 | +$1,688 |
| Footprints Beachside Recovery Center | $9,771 | $5,700 | +$4,071 |
| **Total delta** | | | **$75,749** |

These differences are almost certainly from **different line-item or term data** on the server (e.g. online missing or different `term_months`, or different product/price rows after sync). To align online with local:

1. Ensure **SALESFORCE_LINE_ITEM_TERM_FIELD** is set on Railway to the same value as in your local `backend/.env`.
2. In the **online** app, run **Sync from Salesforce** so production has the same opportunities and line items (with term) as local.
3. Reload Contracted ARR and re-check these accounts.
