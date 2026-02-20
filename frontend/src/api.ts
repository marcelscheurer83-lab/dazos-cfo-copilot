/** API base URL: use VITE_API_URL when building for production (e.g. https://api.example.com) so the app can be published and accessed online. */
const API = import.meta.env.VITE_API_URL ?? '/api'

const AUTH_HEADER = 'X-App-Password'

function getStoredPassword(): string | null {
  return sessionStorage.getItem('app_password')
}

/** Fetch with app password header. On 401, clears storage and reloads (except when checking login with passwordOverride). */
export async function apiFetch(
  path: string,
  options?: RequestInit,
  passwordOverride?: string | null
): Promise<Response> {
  const url = path.startsWith('/') ? `${API}${path}` : `${API}/${path}`
  const password = passwordOverride ?? getStoredPassword()
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) }
  if (password) headers[AUTH_HEADER] = password
  const r = await fetch(url, { ...options, headers })
  if (r.status === 401 && passwordOverride === undefined) {
    sessionStorage.removeItem('app_password')
    window.location.reload()
    throw new Error('Unauthorized')
  }
  return r
}

/** Call from login screen: verify password and return true if valid. */
export async function checkAppPassword(password: string): Promise<boolean> {
  const r = await apiFetch('/dashboard-kpi', {}, password)
  return r.ok
}

/** Dashboard KPI from Salesforce (Phase 2): ARR and Pipeline only. */
export type DashboardKPI = {
  arr: number
  pipeline: number
  salesforce_synced_at: string | null
}

export type KPISummary = {
  as_of_date: string
  cash_balance: number
  monthly_burn: number
  runway_months: number | null
  revenue_ytd: number
  revenue_prior_ytd: number
  revenue_growth_pct: number | null
  gross_margin_pct: number
  ebitda_ytd: number
  ar_days: number
  ap_days: number
}

export type PnLLine = {
  period_end: string
  line_type: string
  category: string
  amount: number
  is_subtotal: boolean
}

export type CashFlowLine = {
  period_end: string
  section: string
  category: string
  amount: number
}

export type BudgetVsActual = {
  period_end: string
  category: string
  budget_amount: number
  actual_amount: number
  variance: number
  variance_pct: number | null
}

export type CopilotResponse = { answer: string; sources?: string[] }

/** Latest snapshot of a Google Sheet range (Phase 1a). */
export type SheetSnapshotResponse = {
  range_name: string
  as_of: string | null
  data: string[][] | null
  message?: string
}

/** Range shown on the dashboard (first/primary range). */
export const DEFAULT_SHEET_RANGE = 'OVERVIEW!A1:D10'

/**
 * All ranges to sync when you click "Refresh from sheet" (import full model).
 * Use A1 notation with row numbers: SheetName!A1:ZZ1000 (not A:ZZ).
 * Sheet names with spaces or "&" may need quotes: 'Sheet Name'!A1:ZZ1000
 */
export const MODEL_SHEET_RANGES: string[] = [
  'OVERVIEW!A1:ZZ1000',
  'P&L!A1:ZZ1000',
  'BS!A1:ZZ1000',
  'CF!A1:ZZ1000',
  'ARR_Calculations!A1:ZZ1000',
  'ARR_Actuals!A1:ZZ1000',
  'ARR_Schedule!A1:ZZ1000',
  'OVERVIEW_2026P!A1:ZZ1000',
  'P&L_2026P!A1:ZZ1000',
  'BS_2026P!A1:ZZ1000',
  'CF_2026P!A1:ZZ1000',
  'ARR_Calculations_2026P!A1:ZZ1000',
  'CoGS!A1:ZZ1000',
  'Sales & Marketing!A1:ZZ1000',
  'Product & Engineering!A1:ZZ1000',
  'General & Administrative!A1:ZZ1000',
  'Headcount!A1:ZZ1000',
  'CoGS_2026P!A1:ZZ1000',
  'Sales & Marketing_2026P!A1:ZZ1000',
  'Product & Engineering_2026P!A1:ZZ1000',
  'General & Administrative_2026P!A1:ZZ1000',
  'Headcount_2026P!A1:ZZ1000',
]

export type SyncSheetResult = { ok: boolean; range_name: string; rows?: number; error?: string }

export async function syncGoogleSheet(rangeName: string): Promise<SyncSheetResult> {
  const r = await apiFetch(`/sync/google-sheets?range_name=${encodeURIComponent(rangeName)}`, { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, range_name: rangeName, error: data.detail?.toString() || data.error || 'Sync failed' }
  return { ok: data.ok === true, range_name: rangeName, rows: data.rows, error: data.error }
}

export async function getSheetSnapshot(rangeName: string): Promise<SheetSnapshotResponse> {
  const r = await apiFetch(`/sheet-snapshots/latest?range_name=${encodeURIComponent(rangeName)}`)
  if (!r.ok) throw new Error('Failed to fetch sheet snapshot')
  return r.json()
}

export async function getCompany(): Promise<{ name: string; fiscal_year_end_month: number }> {
  const r = await apiFetch('/company')
  if (!r.ok) throw new Error('Failed to fetch company')
  return r.json()
}

export type ARRExample = {
  name: string | null
  stage_name: string | null
  line_item_total: number
  sf_id: string
}

export type ARRExamplesResponse = {
  open_renewal_arr: number
  closed_won_renewal_arr: number
  total_renewal_arr: number
  open_examples: ARRExample[]
  closed_won_examples: ARRExample[]
  note: string
}

export async function getDashboardKPI(): Promise<DashboardKPI> {
  const r = await apiFetch('/dashboard-kpi')
  if (!r.ok) {
    const msg = r.status === 401 ? 'Unauthorized — sign in again.' : `Dashboard error ${r.status}. Check backend is up.`
    throw new Error(msg)
  }
  return r.json()
}

export async function getARRExamples(limit = 10): Promise<ARRExamplesResponse> {
  const r = await apiFetch(`/dashboard-kpi/arr-examples?limit=${limit}`)
  if (!r.ok) throw new Error('Failed to fetch ARR examples')
  return r.json()
}

export type ARRByAccountRow = {
  account_id: string | null
  account_name: string
  open_renewal_count: number
  arr: number
}

export type ARRByAccountResponse = {
  accounts: ARRByAccountRow[]
  total_arr: number
}

export async function getARRByAccount(): Promise<ARRByAccountResponse> {
  const r = await apiFetch('/dashboard-kpi/arr-by-account')
  if (!r.ok) throw new Error('Failed to fetch ARR by account')
  return r.json()
}

/** CARR by account with product columns (open renewals; contracted ARR). */
export type ARRByAccountProductResponse = {
  products: string[]
  rows: { account_id: string | null; account_name: string; segment?: string | null; subscription_end_date?: string | null; by_product: Record<string, number>; total_arr: number }[]
  total_by_product: Record<string, number>
  grand_total: number
  /** When set, account names in Customer overview link to Salesforce (url + "/" + account_id). */
  salesforce_base_url?: string
}

export async function getARRByAccountProduct(): Promise<ARRByAccountProductResponse> {
  const r = await apiFetch('/arr-by-account-product')
  if (!r.ok) throw new Error('Failed to fetch ARR by account and product')
  return r.json()
}

/** Export the current ARR-by-account-product table to a new Google Sheet (created each time). */
export async function exportARRToGoogleSheet(): Promise<{ ok: boolean; error?: string; spreadsheet_url?: string; rows_written?: number }> {
  const r = await apiFetch('/export/arr-to-google-sheet', { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, error: data.error || data.detail?.toString() || 'Export failed' }
  return data
}

export async function syncSalesforce(): Promise<{
  ok: boolean
  error?: string
  synced_opportunities?: number
  synced_line_items?: number
  renewal_opportunities_count?: number
}> {
  const r = await apiFetch('/sync/salesforce', { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, error: data.error || data.detail?.toString() || 'Sync failed' }
  return data
}

export async function getKPI(asOf?: string): Promise<KPISummary> {
  const path = asOf ? `/kpi?as_of=${asOf}` : '/kpi'
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch KPI')
  return r.json()
}

export async function getPnL(periodEnd?: string, months = 3): Promise<PnLLine[]> {
  let path = `/pnl?months=${months}`
  if (periodEnd) path += `&period_end=${periodEnd}`
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch P&L')
  return r.json()
}

export async function getCashFlow(periodEnd?: string, months = 3): Promise<CashFlowLine[]> {
  let path = `/cashflow?months=${months}`
  if (periodEnd) path += `&period_end=${periodEnd}`
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch cash flow')
  return r.json()
}

export async function getBudgetVsActual(periodEnd?: string): Promise<BudgetVsActual[]> {
  const path = periodEnd ? `/budget-vs-actual?period_end=${periodEnd}` : '/budget-vs-actual'
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch budget vs actual')
  return r.json()
}

export async function askCopilot(question: string): Promise<CopilotResponse> {
  const r = await apiFetch('/copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  if (!r.ok) throw new Error('Copilot request failed')
  return r.json()
}
