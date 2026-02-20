# Dazos Products Price Book

Stored product and list price list for analysis. Source: **Dazos Products** price book (Salesforce).

**Data file:** [`../data/dazos-products-pricebook.json`](../data/dazos-products-pricebook.json)

## Contents

- **17 products total**
  - **11 recurring (monthly)** — Product Family: Dazos. Relevant for ARR (except Verify Monthly Credits and Kipu API, which are excluded from ARR).
  - **6 one-time** — Product Family: ProServ. Not used in ARR (implementation, set-up, migration, etc.).

## JSON structure

Each product has:

| Field | Description |
|-------|-------------|
| `product_id` | 18-digit Salesforce product ID |
| `product_name` | Product name |
| `subscription_frequency` | `"Monthly"` or `"One-Time"` |
| `product_family` | `"Dazos"` or `"ProServ"` |
| `recurring` | `true` / `false` |
| `list_price` | List price (number) |
| `active` | Product active flag |
| `description` | Product description (or null) |
| `internal_notes` | Internal enablement notes (or null) |

## Use for analysis

- **List price lookup** — Match by `product_name` or `product_id` to get list price.
- **ARR scope** — Filter `recurring === true` and exclude "Verify Monthly Credits" and "Kipu API" for ARR-relevant products.
- **One-time vs recurring** — Use `subscription_frequency` or `recurring` to separate recurring revenue from professional services.

Update the JSON when the Salesforce price book changes.
