/**
 * API base URL for production / preview builds: use VITE_API_URL (e.g. https://api.example.com/api).
 * Ensures exactly one `/api` suffix so we never produce `/api/api/...` (404 on all routes).
 * Handles: `https://host`, `https://host/`, `https://host/api`, `https://host/api/`
 *
 * While running `npm run dev` (Vite dev server), we **always** use same-origin `/api` so the dev
 * proxy hits **local** :8008 (see `vite.config.ts`). Otherwise a stray `VITE_API_URL` (e.g. pointing at Railway) makes
 * new endpoints 404. To call a remote API from the dev server, set:
 *   VITE_USE_REMOTE_API_IN_DEV=true
 */
function apiBaseUrl(): string {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_REMOTE_API_IN_DEV !== 'true') {
    return '/api'
  }
  const raw = (import.meta.env.VITE_API_URL as string | undefined)?.trim() ?? ''
  if (!raw) return '/api'
  const noTrail = raw.replace(/\/+$/, '')
  if (noTrail.endsWith('/api')) return noTrail
  return `${noTrail}/api`
}

const API = apiBaseUrl()

const AUTH_HEADER = 'X-App-Password'

function getStoredPassword(): string | null {
  return sessionStorage.getItem('app_password')
}

/**
 * Admin ARR breakdown only: in `npm run dev` on localhost, call FastAPI directly on :8008.
 * Some setups see the Vite proxy strip POST bodies or query strings, so active-arr?breakdown_q=
 * hits the server without the param and looks like an "old" backend. CORS already allows :5173 → :8008.
 * Set `VITE_BREAKDOWN_USE_PROXY=true` to keep using `/api` through Vite. Optional `VITE_DEV_BACKEND_URL`
 * if the API is not on 127.0.0.1:8008.
 */
function arrBreakdownApiUrl(pathWithLeadingSlash: string): string {
  const p = pathWithLeadingSlash.startsWith('/') ? pathWithLeadingSlash : `/${pathWithLeadingSlash}`
  const forceProxy =
    import.meta.env.VITE_BREAKDOWN_USE_PROXY === 'true' || import.meta.env.VITE_BREAKDOWN_USE_PROXY === '1'
  if (
    !forceProxy &&
    import.meta.env.DEV &&
    typeof window !== 'undefined'
  ) {
    const h = window.location.hostname
    if (h === 'localhost' || h === '127.0.0.1') {
      const base =
        (import.meta.env.VITE_DEV_BACKEND_URL as string | undefined)?.trim().replace(/\/+$/, '') ||
        'http://127.0.0.1:8008'
      return `${base}/api${p}`
    }
  }
  return p.startsWith('/') ? `${API}${p}` : `${API}/${p}`
}

async function arrBreakdownFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = arrBreakdownApiUrl(path)
  const password = getStoredPassword()
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) }
  if (password) headers[AUTH_HEADER] = password
  const r = await fetch(url, { ...options, headers })
  if (r.status === 401) {
    sessionStorage.removeItem('app_password')
    window.location.reload()
    throw new Error('Unauthorized')
  }
  return r
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
  const t0 =
    import.meta.env.DEV && typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_API_TIMING') === '1'
      ? performance.now()
      : 0
  const r = await fetch(url, { ...options, headers })
  if (t0 && import.meta.env.DEV) {
    const ms = Math.round(performance.now() - t0)
    console.debug(`[api timing] ${path} ${ms}ms`)
  }
  if (r.status === 401 && passwordOverride === undefined) {
    sessionStorage.removeItem('app_password')
    window.location.reload()
    throw new Error('Unauthorized')
  }
  return r
}

/** Call from login screen: verify password and return true if valid. */
export async function checkAppPassword(password: string): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    const r = await apiFetch('/auth/check', { signal: controller.signal }, password)
    return r.ok
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Check if backend is reachable (no auth). Use before login to show a clear "server unreachable" vs "invalid password". */
export async function checkBackendHealth(): Promise<boolean> {
  const result = await checkBackendHealthDetailed()
  return result.ok
}

/** Same as checkBackendHealth but returns a reason when unreachable (for debugging). */
export async function checkBackendHealthDetailed(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = `${API}/health`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)
  try {
    const r = await fetch(url, { method: 'GET', signal: controller.signal })
    if (r.ok) return { ok: true }
    return { ok: false, reason: `HTTP ${r.status}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('abort') || msg.includes('Abort')) return { ok: false, reason: 'Timeout (backend not responding)' }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return { ok: false, reason: 'Network error — is the backend running? Open app from http://localhost:5173' }
    return { ok: false, reason: msg.slice(0, 80) }
  } finally {
    clearTimeout(timeoutId)
  }
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
  plan_amount: number | null
  is_subtotal: boolean
  is_plan_only: boolean
  sort_order: number
}

export type CashFlowLine = {
  period_end: string
  section: string
  category: string
  amount: number
  plan_amount: number | null
  is_subtotal: boolean
  sort_order: number
}

export type BalanceSheetLine = {
  period_end: string
  section: string
  category: string
  amount: number
  plan_amount: number | null
  is_subtotal: boolean
  sort_order: number
}

export type FinancialAnalysis = {
  id: number
  period_end: string
  generated_at: string | null
  pnl_analysis: string | null
  cashflow_analysis: string | null
  balance_sheet_analysis: string | null
  executive_summary: string | null
  status: string
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
export type FPAChatMessage = { role: 'user' | 'assistant'; content: string }
export type FPAChatResponse = { answer: string }

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
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 90_000)
  try {
    const r = await apiFetch('/dashboard-kpi', { signal: controller.signal })
    const text = await r.text()
    if (!r.ok) {
      const msg = r.status === 401 ? 'Unauthorized — sign in again.' : `Dashboard error ${r.status}. Check backend is up.`
      try {
        const j = JSON.parse(text)
        throw new Error(j.detail || j.error || msg)
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(msg)
        throw e
      }
    }
    try {
      return JSON.parse(text) as DashboardKPI
    } catch {
      throw new Error('Invalid response from server')
    }
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === 'AbortError' || /aborted|AbortError/i.test(String(e.message)))
    ) {
      throw new Error(
        'Dashboard timed out waiting for the server (90s). The backend may be busy — try again in a moment.',
      )
    }
    throw e
  } finally {
    clearTimeout(timeoutId)
  }
}

export type BookingsMTDRow = {
  mtd: number
  plan: number | null
  achievement_pct: number | null
  delta_k: number | null
}

export type BookingsPeriod = {
  period_label: string
  total: BookingsMTDRow
  new_business: BookingsMTDRow
  expansion: BookingsMTDRow
  /** Closed Won expansion — Expansion_ARR__c (no plan/delta) */
  expansion_mid_term?: number | null
  /** Closed Won renewals — Expansion_ARR__c (no plan/delta) */
  expansion_upon_renewal?: number | null
  /** Total open pipeline ARR / shortfall to plan (MTD/QTD only) */
  pipe_coverage_total?: number | null
  /** Open pipeline NB ARR / shortfall to plan (MTD/QTD only) */
  pipe_coverage_new_business?: number | null
  /** Open pipeline expansion ARR / shortfall to plan (MTD/QTD only) */
  pipe_coverage_expansion?: number | null
}

export type BookingsMTDResponse = {
  two_months_ago: BookingsPeriod
  previous_month: BookingsPeriod
  current_mtd: BookingsPeriod
  qtd: BookingsPeriod
  plan_source: string | null
  plan_message: string | null
}

export type RenewalsMTDRow = {
  mtd: number
  plan: number | null
  achievement_pct: number | null
  delta_k: number | null
  is_rate?: boolean
}

export type RenewalsPeriod = {
  period_label: string
  up_for_renewal: RenewalsMTDRow
  renewed: RenewalsMTDRow
  open: RenewalsMTDRow
  churn: RenewalsMTDRow
  contraction: RenewalsMTDRow
  renewal_rate: RenewalsMTDRow
  cancelled: RenewalsMTDRow
}

export type RenewalsMTDResponse = {
  two_months_ago: RenewalsPeriod
  previous_month: RenewalsPeriod
  current_mtd: RenewalsPeriod
  qtd: RenewalsPeriod
  plan_source: string | null
  plan_message: string | null
}

/** When set, MTD columns use fixed labels (Q1 2026 → Jan–Mar + Q1 26; Q2 2026 → Apr–Jun + Q2 26). */
export type DashboardFixedPeriods = 'q1_2026' | 'q2_2026'

function dashboardMtdQuery(fixedPeriods?: DashboardFixedPeriods): string {
  if (fixedPeriods === 'q1_2026') return '?fixed_periods=q1_2026'
  if (fixedPeriods === 'q2_2026') return '?fixed_periods=q2_2026'
  return ''
}

export async function getDashboardBookingsMTD(options?: {
  fixedPeriods?: DashboardFixedPeriods
}): Promise<BookingsMTDResponse> {
  const BOOKINGS_ERR = 'Bookings — server returned invalid data. Check that the backend is running and try again.'
  let text: string
  try {
    const r = await apiFetch(`/dashboard/bookings-mtd${dashboardMtdQuery(options?.fixedPeriods)}`)
    text = await r.text()
    if (!r.ok) {
      try {
        const j = JSON.parse(text)
        throw new Error(j.detail || j.error || `Failed to fetch bookings MTD (${r.status})`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/Unexpected token|not valid JSON|SyntaxError|Internal S/i.test(msg)) throw new Error(BOOKINGS_ERR)
        if (e instanceof Error && /detail|error|Failed to fetch/.test(msg)) throw e
        throw new Error(text?.slice(0, 80) || `Bookings endpoint error (${r.status})`)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/Unexpected token|not valid JSON|JSON\.parse|SyntaxError|Internal S/i.test(msg)) throw new Error(BOOKINGS_ERR)
    throw e
  }
  try {
    return JSON.parse(text) as BookingsMTDResponse
  } catch {
    throw new Error(BOOKINGS_ERR)
  }
}

const RENEWALS_ERR =
  'Renewals — server returned invalid data. Check that the backend is running and try again.'

export async function getDashboardRenewalsMTD(options?: {
  fixedPeriods?: DashboardFixedPeriods
}): Promise<RenewalsMTDResponse> {
  let text: string
  try {
    const r = await apiFetch(`/dashboard/renewals-mtd${dashboardMtdQuery(options?.fixedPeriods)}`)
    text = await r.text()
    if (!r.ok) {
      try {
        const j = JSON.parse(text)
        throw new Error(j.detail || j.error || `Failed to fetch renewals MTD (${r.status})`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/Unexpected token|not valid JSON|SyntaxError/i.test(msg)) throw new Error(RENEWALS_ERR)
        if (e instanceof Error && /detail|error|Failed to fetch/.test(msg)) throw e
        throw new Error(text?.slice(0, 80) || `Renewals endpoint error (${r.status})`)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/Unexpected token|not valid JSON|JSON\.parse|SyntaxError|Internal S/i.test(msg)) throw new Error(RENEWALS_ERR)
    throw e
  }
  try {
    return JSON.parse(text) as RenewalsMTDResponse
  } catch {
    throw new Error(RENEWALS_ERR)
  }
}

export type CashPeriod = {
  period_label: string
  billings_plan: number | null
  collections_plan: number | null
  billings_actual: number | null
  collections_actual: number | null
  billings_achievement_pct: number | null
  billings_delta_k: number | null
  collections_achievement_pct: number | null
  collections_delta_k: number | null
}

export type CashMTDResponse = {
  two_months_ago: CashPeriod
  previous_month: CashPeriod
  current_mtd: CashPeriod
  qtd: CashPeriod
  plan_source: string | null
  plan_message: string | null
  chargebee_message?: string | null
}

const CASH_ERR = 'Cash — server returned invalid data. Check that the backend is running and try again.'

export async function getDashboardCashMTD(options?: {
  fixedPeriods?: DashboardFixedPeriods
}): Promise<CashMTDResponse> {
  let text: string
  try {
    const r = await apiFetch(`/dashboard/cash-mtd${dashboardMtdQuery(options?.fixedPeriods)}`)
    text = await r.text()
    if (!r.ok) {
      try {
        const j = JSON.parse(text)
        throw new Error(j.detail || j.error || `Failed to fetch cash MTD (${r.status})`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/Unexpected token|not valid JSON|SyntaxError/i.test(msg))
          throw new Error(CASH_ERR)
        if (e instanceof Error && /detail|error|Failed to fetch/.test(msg)) throw e
        throw new Error(text?.slice(0, 80) || `Cash endpoint error (${r.status})`)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/Unexpected token|not valid JSON|JSON\.parse|SyntaxError|Internal S/i.test(msg))
      throw new Error(CASH_ERR)
    throw e
  }
  try {
    return JSON.parse(text) as CashMTDResponse
  } catch {
    throw new Error(CASH_ERR)
  }
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

/** CARR by account with product columns (open renewals). contracted_arr = Live ARR (schedule) + Closed Won NB/Expansion with service start after today (EST). */
export type ARRByAccountProductResponse = {
  products: string[]
  rows: {
    account_id: string | null
    account_name: string
    segment?: string | null
    csm?: string | null
    subscription_end_date?: string | null
    active_arr?: number
    /** Same schedule engine as Active ARR, but uses soonest future period ARR when subscription has not started yet. */
    contracted_arr?: number
    by_product: Record<string, number>
    total_arr: number
  }[]
  total_by_product: Record<string, number>
  grand_total: number
  /** When set, account names on Products purchased link to Salesforce (url + "/" + account_id). */
  salesforce_base_url?: string
}

export async function getARRByAccountProduct(): Promise<ARRByAccountProductResponse> {
  const r = await apiFetch('/arr-by-account-product', { cache: 'no-store' })
  if (!r.ok) throw new Error('Failed to fetch ARR by account and product')
  return r.json()
}

export async function getSalesforceUserNamesByIds(ids: string[]): Promise<Record<string, string>> {
  const r = await apiFetch('/salesforce/users/by-ids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data?.ok === false) return {}
  return (data?.users ?? {}) as Record<string, string>
}

/** Export the current ARR-by-account-product table to a new Google Sheet (created each time). */
export async function exportARRToGoogleSheet(): Promise<{ ok: boolean; error?: string; spreadsheet_url?: string; rows_written?: number }> {
  const r = await apiFetch('/export/arr-to-google-sheet', { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, error: data.error || data.detail?.toString() || 'Export failed' }
  return data
}

/** Analytics: Active ARR by product group as of a specific date (default = last day of previous month). */
export type ActiveARRAnalyticsGroup = {
  label: string
  arr: number
  arr_smb_mm?: number
  arr_enterprise?: number
}

export type ActiveARRAnalyticsOtherItem = {
  product: string
  arr: number
}

export type ActiveARRAnalyticsResponse = {
  as_of: string
  groups: ActiveARRAnalyticsGroup[]
  by_segment?: ActiveARRAnalyticsGroup[]
  grand_total: number
  other_breakdown?: ActiveARRAnalyticsOtherItem[]
  unmapped_accounts?: { account_id: string | null; account_name: string; arr: number }[]
  other_accounts?: { account_id: string | null; account_name: string; product: string; arr: number }[]
  salesforce_base_url?: string
}

export async function getActiveARRAnalytics(asOf?: string): Promise<ActiveARRAnalyticsResponse> {
  const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : ''
  const r = await apiFetch(`/analytics/active-arr-by-product${qs}`)
  if (!r.ok) throw new Error('Failed to fetch Active ARR analytics')
  return r.json()
}

/** Active ARR by account from all Closed Won opportunities. Subscription dates from New Business opp when present. */
export type ActiveARRRow = {
  account_id: string | null
  account_name: string
  /** Account Status from Salesforce (e.g. Account_Status__c). */
  status: string | null
  /** Salesforce Account Type picklist (e.g. Customer, Prospect). */
  type?: string | null
  /** Salesforce Account owner (user name) from the anchor opportunity. */
  owner_name?: string | null
  segment: string | null
  active_arr: number
  /** CRM seats from CRM SKUs only (Additional CRM Seats quantity + 5 per CRM Platform (Includes 5 Seats)), for the period active today. */
  crm_seats?: number | null
  /** ARR from CRM SKUs only (Additional CRM Seats, CRM Platform (Includes 5 Seats), CRM Platform (Legacy)), same period as active_arr. */
  crm_arr?: number | null
  /** ARR from anchor (renewal/NB) only; used for ARR history over time. */
  anchor_arr?: number
  /** Expansions after anchor: close_date + arr; used for by-month ARR. */
  expansions?: Array<{ close_date: string; arr: number }>
  by_product: Record<string, number>
  subscription_start_date: string | null
  subscription_end_date: string | null
  /** e.g. "ren only" when only open renewal, no closed renewal/NB */
  note: string | null
  no_new_business: boolean
}

export type ActiveARRResponse = {
  rows: ActiveARRRow[]
  grand_total: number
  /** Sum of crm_seats on schedule rows (Live). */
  crm_seats_live_total?: number
  /** Live CRM seats + CRM seats on Closed Won NB/Expansion with service start after today (same cohort as Contracted ARR). */
  contracted_crm_seats_total?: number
  salesforce_base_url?: string
}

export async function getARRScheduleActiveArr(): Promise<ActiveARRResponse> {
  const r = await apiFetch('/arr-schedule/active-arr', { cache: 'no-store' })
  if (!r.ok) throw new Error('Failed to fetch Active ARR')
  return r.json()
}

/** Contracted ARR as of each month-end (Dec 2024–Dec 2026). Row has by_month[YYYY-MM] = ARR when subscription is active that month. */
export type ActiveARRByMonthRow = ActiveARRRow & { by_month: Record<string, number> }

export type ActiveARRByMonthResponse = {
  months: string[]
  totals_by_month: Record<string, number>
  rows: ActiveARRByMonthRow[]
  salesforce_base_url?: string
}

export async function getARRScheduleActiveARRByMonth(): Promise<ActiveARRByMonthResponse> {
  const r = await apiFetch('/arr-schedule/active-arr-by-month')
  if (!r.ok) throw new Error('Failed to fetch ARR by month')
  return r.json()
}

export type NewScheduleAccountRow = {
  account_id: string
  account_name: string
  /** Salesforce Account.Type — same as Schedule. */
  type?: string | null
  /** Salesforce Account status — same as Schedule. */
  status?: string | null
  /** Contract Start Date on the earliest closed-won NB opportunity (by close date), ISO YYYY-MM-DD. */
  subscription_start_date?: string | null
  /** See NEW SCHEDULE backend: CW NB+Renewal max contract end, overridden by Closed Lost Renewal + midterm cancel close date. */
  subscription_end_date?: string | null
  /** Sum of ARR__c on CW NB/Renewal/Expansion opps active today; 0 if CL Renewal + midterm cancel and today > that opp’s contract end. */
  live_arr: number
  /** Live ARR + sum of ARR__c on all Closed Won opps whose contract start is after today. */
  contracted_arr: number
  /** Same Live ARR rules as live_arr, evaluated on each month-end (YYYY-MM keys from month_columns). */
  arr_by_month?: Record<string, number>
}

export type NewScheduleAccountsResponse = {
  rows: NewScheduleAccountRow[]
  /** Dec '25 … Dec '26 month keys for ``arr_by_month``. */
  month_columns?: string[]
  salesforce_base_url?: string
}

export type ExportNewScheduleResult = {
  ok: boolean
  spreadsheet_url?: string
  spreadsheet_id?: string
  sheet_gid?: number | null
  rows_written?: number
  account_count?: number
  range_used?: string
  message?: string
  error?: string
}

export async function exportNewScheduleToSheet(): Promise<ExportNewScheduleResult> {
  const r = await apiFetch('/export/new-schedule-to-google-sheet', { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, error: data.error ?? data.detail ?? 'Export failed' }
  return {
    ok: data.ok ?? true,
    spreadsheet_url: data.spreadsheet_url,
    spreadsheet_id: data.spreadsheet_id,
    sheet_gid: data.sheet_gid,
    rows_written: data.rows_written,
    account_count: data.account_count,
    range_used: data.range_used,
    message: data.message,
    error: data.error,
  }
}

/** Accounts with ≥1 Closed Won New Business opportunity (NEW SCHEDULE; no bookings owner exclusion). */
export async function getNewScheduleAccounts(): Promise<NewScheduleAccountsResponse> {
  const r = await apiFetch('/arr-schedule/new-schedule-accounts', { cache: 'no-store' })
  if (!r.ok) throw new Error('Failed to fetch NEW SCHEDULE accounts')
  return r.json()
}

export type ExportCopilotARRScheduleResult = {
  ok: boolean
  spreadsheet_url?: string
  spreadsheet_id?: string
  rows_written?: number
  account_count?: number
  /** First 2 rows × 7 columns read back from sheet after write to verify. */
  read_back?: string[][]
  /** Exact A1 range written (for debugging). */
  range_used?: string
  message?: string
  error?: string
}

export async function exportCopilotARRScheduleToSheet(): Promise<ExportCopilotARRScheduleResult> {
  const r = await apiFetch('/export/copilot-arr-schedule-to-google-sheet', { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, error: data.error ?? data.detail ?? 'Export failed' }
  return {
    ok: true,
    spreadsheet_url: data.spreadsheet_url,
    spreadsheet_id: data.spreadsheet_id,
    rows_written: data.rows_written,
    account_count: data.account_count,
    read_back: data.read_back,
    range_used: data.range_used,
    message: data.message,
    error: data.error,
  }
}

export type ExportCohortRetentionResult = {
  ok: boolean
  spreadsheet_url?: string
  spreadsheet_id?: string
  rows_written?: number
  cohort_count?: number
  range_used?: string
  message?: string
  error?: string
}

export async function exportCohortRetentionToSheet(): Promise<ExportCohortRetentionResult> {
  const r = await apiFetch('/export/cohort-retention-to-google-sheet', { method: 'POST' })
  const data = await r.json()
  if (!r.ok) return { ok: false, error: data.error ?? data.detail ?? 'Export failed' }
  return {
    ok: true,
    spreadsheet_url: data.spreadsheet_url,
    spreadsheet_id: data.spreadsheet_id,
    rows_written: data.rows_written,
    cohort_count: data.cohort_count,
    range_used: data.range_used,
    message: data.message,
    error: data.error,
  }
}

/** Pipeline overview: open opportunities (not Closed Won/Lost). One row per opportunity. */
export type PipelineOverviewRow = {
  account_id: string | null
  account_name: string
  segment: string
  opportunity_sf_id: string
  opportunity_name: string
  stage_name: string
  forecast_category: string | null
  deal_tier: string | null
  record_type_name: string
  close_date: string | null
  arr: number
  ai_probability: number | null
  ai_reasoning: string | null
}

export type PipelineOverviewResponse = {
  rows: PipelineOverviewRow[]
  grand_total: number
  segments: string[]
  stages: string[]
  record_types: string[]
  deal_tiers: string[]
  salesforce_base_url?: string
}

export type PipelineOverviewFilters = {
  segment?: string[]
  stage?: string[]
  record_type?: string[]
}

export async function getPipelineOverview(filters?: PipelineOverviewFilters): Promise<PipelineOverviewResponse> {
  const params = new URLSearchParams()
  if (filters?.segment?.length) filters.segment.forEach((s) => params.append('segment', s))
  if (filters?.stage?.length) filters.stage.forEach((s) => params.append('stage', s))
  if (filters?.record_type?.length) filters.record_type.forEach((r) => params.append('record_type', r))
  const qs = params.toString()
  const r = await apiFetch(`/pipeline-overview${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error('Failed to fetch pipeline overview')
  return r.json()
}

/** Closed overview: Closed Won + Closed Lost. Same row shape as pipeline. */
export type ClosedOverviewRow = PipelineOverviewRow

export type ClosedOverviewResponse = {
  rows: ClosedOverviewRow[]
  grand_total: number
  available_months: string[]
  segments: string[]
  stages: string[]
  record_types: string[]
  salesforce_base_url?: string
}

export type ClosedOverviewFilters = {
  segment?: string[]
  stage?: string[]
  record_type?: string[]
  months?: string[]
}

export async function getClosedOverview(filters?: ClosedOverviewFilters): Promise<ClosedOverviewResponse> {
  const params = new URLSearchParams()
  if (filters?.segment?.length) filters.segment.forEach((s) => params.append('segment', s))
  if (filters?.stage?.length) filters.stage.forEach((s) => params.append('stage', s))
  if (filters?.record_type?.length) filters.record_type.forEach((r) => params.append('record_type', r))
  if (filters?.months?.length) filters.months.forEach((m) => params.append('months', m))
  const qs = params.toString()
  const r = await apiFetch(`/closed-overview${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error('Failed to fetch closed overview')
  return r.json()
}

export type RenewalsOverviewRow = {
  account_id: string | null
  account_name: string
  opportunity_sf_id: string
  opportunity_name: string
  stage_name: string
  forecast_category: string | null
  renewal_date: string | null
  /** "Yes" when Midterm_Cancellation__c is true; null when false. */
  midterm_cancellation_after_stage: string | null
  up_for_renewal_arr: number | null
  renewed_arr: number | null
  delta: number | null
}

export type RenewalsChartMonth = {
  month: string
  arr_open: number
  arr_renewed: number
  arr_churned: number
  count_open: number
  count_renewed: number
  count_lost: number
  arr_renewal_rate: number | null
  /** closed won / (closed won + closed lost) among closed outcomes */
  opp_renewal_rate: number | null
  /** Up-for-renewal ARR sum for mid-term cancellation = Yes (separate from stacked bar) */
  arr_midterm_cancellation?: number
  count_midterm_cancellation?: number
}

export type RenewalsOverviewResponse = {
  rows: RenewalsOverviewRow[]
  grand_up_for_renewal_arr: number
  grand_renewed_arr: number
  grand_delta: number
  stages: string[]
  available_months: string[]
  renewals_chart: RenewalsChartMonth[]
  salesforce_base_url?: string
}

export type RenewalsOverviewFilters = {
  stage?: string[]
  months?: string[]
  /** `yes` | `no` — matches backend midterm filter */
  midterm?: string[]
}

export async function getRenewalsOverview(filters?: RenewalsOverviewFilters): Promise<RenewalsOverviewResponse> {
  const params = new URLSearchParams()
  if (filters?.stage?.length) filters.stage.forEach((s) => params.append('stage', s))
  if (filters?.months?.length) filters.months.forEach((m) => params.append('months', m))
  if (filters?.midterm?.length) filters.midterm.forEach((m) => params.append('midterm', m))
  const qs = params.toString()
  const r = await apiFetch(`/renewals-overview${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error('Failed to fetch renewals overview')
  return r.json()
}

export type DatasetStatus = {
  /** UTC instant (ISO with Z). */
  updated_at: string | null
  /** Preformatted UTC string from the server (preferred for display). */
  updated_at_utc: string | null
  last_refresh_ok: boolean | null
  last_error: string | null
  steps: unknown[]
  message?: string
}

export async function getDatasetStatus(): Promise<DatasetStatus> {
  const r = await apiFetch('/dataset/status')
  if (!r.ok) throw new Error('Failed to fetch dataset status')
  return r.json()
}

export type OverviewTargets = {
  net_new_carr_ytd_target: number | null
  message: string | null
}

export async function getOverviewTargets(): Promise<OverviewTargets> {
  const r = await apiFetch('/dashboard/overview-targets')
  if (!r.ok) throw new Error('Failed to fetch overview targets')
  return r.json()
}

/** Unified refresh: Salesforce, Google Sheets (DATASET_SHEET_RANGES), Chargebee when configured. QuickBooks is separate (POST /api/sync/quickbooks). Can take many minutes. */
/** Consistent "last updated" label used on every Refresh app data button. */
export function formatLastUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export async function refreshAppDataset(): Promise<{
  ok: boolean
  job_id?: string
  status?: string
  message?: string
  error?: string
}> {
  const r = await apiFetch('/dataset/refresh', { method: 'POST' })
  let data: { ok?: boolean; job_id?: string; status?: string; message?: string; error?: string }
  try {
    const text = await r.text()
    data = text ? JSON.parse(text) : {}
  } catch {
    return { ok: false, error: 'Invalid response from server.' }
  }
  if (!r.ok) return { ok: false, error: data.error ?? 'Refresh failed' }
  return data as { ok: boolean; job_id?: string; status?: string; message?: string; error?: string }
}

/** @deprecated Prefer refreshAppDataset() from the Dashboard. */
export async function syncSalesforce(signal?: AbortSignal): Promise<{
  ok: boolean
  error?: string
  synced_opportunities?: number
  synced_line_items?: number
  renewal_opportunities_count?: number
  message?: string
  renewal_date_field_used?: boolean
  renewal_date_field_configured?: boolean
}> {
  const r = await apiFetch('/sync/salesforce', { method: 'POST', signal })
  let data: { ok?: boolean; error?: string; detail?: unknown; renewal_date_field_used?: boolean; renewal_date_field_configured?: boolean }
  try {
    const text = await r.text()
    data = text ? JSON.parse(text) : {}
  } catch {
    return { ok: false, error: r.ok ? 'Invalid response from server.' : 'Sync failed. Restart the backend and try again.' }
  }
  if (!r.ok) return { ok: false, error: data.error || (Array.isArray(data.detail) ? data.detail.map((d: { msg?: string }) => d.msg).join(' ') : String(data.detail ?? 'Sync failed')) }
  return data as {
    ok: boolean
    error?: string
    synced_opportunities?: number
    synced_line_items?: number
    renewal_opportunities_count?: number
    message?: string
    renewal_date_field_used?: boolean
    renewal_date_field_configured?: boolean
  }
}

/** Admin: Active vs Contracted ARR calculation steps (same engine as Products purchased schedule). */
export type ArrScheduleBreakdownMatch = {
  as_of_date_est: string
  timezone: string
  apply_alleva_retained_arr_adjustment: boolean
  account_id: string | null
  account_name: string
  account_type: string | null
  status: string | null
  is_churned: boolean
  schedule_note: string | null
  in_open_renewal_override_list: boolean
  open_renewal_line_arr: number
  anchor_opportunity_arr: number
  expansions_closed_won: Array<{ close_date: string; arr: number }>
  expansion_arr_sum_close_on_or_before_today: number
  subscription_window: { start: string | null; end: string | null }
  closed_won_periods_with_arr: Array<{ start: string; end: string; arr: number }>
  period_containing_today: { start: string; end: string; arr: number } | null
  active_arr_explanation: Record<string, unknown>
  contracted_arr_explanation: Record<string, unknown>
  products_purchased_note: string
}

export async function getArrScheduleBreakdown(q = '12 south'): Promise<{
  query: string
  match_count: number
  matches: ArrScheduleBreakdownMatch[]
  message?: string
}> {
  const rawQ = (q.trim() || '12 south').slice(0, 500)
  const needleEnc = encodeURIComponent(rawQ)

  // 1) POST first — distinct route; old backends 404 here and we fall back to GET.
  const postUrl = arrBreakdownApiUrl('/arr-schedule/arr-breakdown')
  const pr = await arrBreakdownFetch('/arr-schedule/arr-breakdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: rawQ }),
    cache: 'no-store',
  })
  if (pr.ok) {
    const data = (await pr.json()) as { matches?: ArrScheduleBreakdownMatch[]; match_count?: number; query?: string; message?: string }
    if (Array.isArray(data.matches)) {
      return {
        query: data.query ?? rawQ,
        match_count: data.match_count ?? data.matches.length,
        matches: data.matches,
        message: data.message,
      }
    }
  }

  // 2) GET fallbacks
  const paths = [
    `/arr-schedule/active-arr?breakdown_q=${needleEnc}`,
    `/arr-schedule/schedule-breakdown?q=${needleEnc}`,
    `/admin/arr-schedule-breakdown?q=${needleEnc}`,
  ]
  let lastStatus = 0
  let lastDetail = ''
  let sawFullActiveArrWithoutBreakdown = false

  for (const path of paths) {
    const r = await arrBreakdownFetch(path, { cache: 'no-store' })
    if (r.ok) {
      const data = (await r.json()) as {
        matches?: ArrScheduleBreakdownMatch[]
        match_count?: number
        query?: string
        message?: string
        rows?: unknown[]
        grand_total?: number
        breakdown_only?: boolean
      }
      if (Array.isArray(data.matches)) {
        return {
          query: data.query ?? q,
          match_count: data.match_count ?? data.matches.length,
          matches: data.matches,
          message: data.message,
        }
      }
      // Old backend ignores `breakdown_q` and returns the normal Schedule payload — do not chase 404 fallbacks.
      if (Array.isArray(data.rows) && data.grand_total !== undefined) {
        sawFullActiveArrWithoutBreakdown = true
        break
      }
      continue
    }
    lastStatus = r.status
    const text = await r.text().catch(() => '')
    try {
      const parsed = JSON.parse(text) as { detail?: unknown }
      lastDetail =
        typeof parsed?.detail === 'string'
          ? parsed.detail
          : parsed?.detail != null
            ? JSON.stringify(parsed.detail)
            : text
    } catch {
      lastDetail = text
    }
    if (r.status !== 404) break
  }

  if (sawFullActiveArrWithoutBreakdown) {
    throw new Error(
      `The API still returned the full Schedule without breakdown (missing breakdown_q / POST route). ` +
        `In dev, breakdown calls http://127.0.0.1:8008 directly — if that is not your API, set VITE_DEV_BACKEND_URL. ` +
        `Otherwise run .\\backend\\start-backend.ps1 from this repo. Try POST ${postUrl} with {"q":"12 south"}.`
    )
  }

  throw new Error(
    `ARR schedule breakdown failed (${lastStatus}${lastDetail ? `: ${lastDetail.slice(0, 200)}` : ''}). ` +
      `POST tried: ${postUrl}. ` +
      `Confirm the process on port 8008 is this project (see start-backend.ps1 “Verified: main.py includes…” line).`
  )
}

export async function getKPI(asOf?: string): Promise<KPISummary> {
  const path = asOf ? `/kpi?as_of=${asOf}` : '/kpi'
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch KPI')
  return r.json()
}

export async function getPnLPeriods(): Promise<string[]> {
  const r = await apiFetch('/pnl/periods')
  if (!r.ok) throw new Error('Failed to fetch P&L periods')
  const data = await r.json()
  return data.periods as string[]
}

export async function getPnL(periodEnd?: string, months = 3): Promise<PnLLine[]> {
  let path = `/pnl?months=${months}`
  if (periodEnd) path += `&period_end=${periodEnd}`
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch P&L')
  return r.json()
}

export async function getPnLObservations(periodEnd: string): Promise<{ observations: string | null; period_end: string }> {
  const r = await apiFetch(`/pnl/observations?period_end=${periodEnd}`)
  if (!r.ok) throw new Error('Failed to fetch P&L observations')
  return r.json()
}

export async function getCFObservations(periodEnd: string): Promise<{ observations: string | null; period_end: string }> {
  const r = await apiFetch(`/cf/observations?period_end=${periodEnd}`)
  if (!r.ok) throw new Error('Failed to fetch Cash Flow observations')
  return r.json()
}

export async function getBSObservations(periodEnd: string): Promise<{ observations: string | null; period_end: string }> {
  const r = await apiFetch(`/bs/observations?period_end=${periodEnd}`)
  if (!r.ok) throw new Error('Failed to fetch Balance Sheet observations')
  return r.json()
}

export async function getOverviewObservations(periodEnd: string): Promise<{ observations: string | null; period_end: string }> {
  const r = await apiFetch(`/overview/observations?period_end=${periodEnd}`)
  if (!r.ok) throw new Error('Failed to fetch overview observations')
  return r.json()
}

export type DeptDetailLine = {
  period_end: string
  dept: string
  category: string
  amount: number
  plan_amount: number | null
  is_subtotal: boolean
  is_plan_only: boolean
  sort_order: number
}

export async function getDeptDetail(periodEnd?: string, months = 3): Promise<DeptDetailLine[]> {
  let path = `/dept-detail?months=${months}`
  if (periodEnd) path += `&period_end=${periodEnd}`
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch department detail')
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

// --- Simple Accounts listing for type analysis ---
export type AccountRow = {
  sf_id: string
  name: string | null
  type: string | null
  status: string | null
  industry: string | null
  segment: string | null
}

export async function getAccounts(limit = 5000): Promise<AccountRow[]> {
  const r = await apiFetch(`/accounts?limit=${limit}`)
  if (!r.ok) throw new Error('Failed to fetch accounts')
  return r.json()
}

// ── ARR History ──────────────────────────────────────────────────────────────
export type ArrHistoryRow = {
  account_name: string
  arr_by_month: Record<string, number>
}

export type ArrHistoryResponse = {
  month_columns: string[]
  rows: ArrHistoryRow[]
  totals_by_month: Record<string, number>
  sheet_snapshot_as_of: string | null
  message: string | null
}

export async function getArrHistory(): Promise<ArrHistoryResponse> {
  const r = await apiFetch('/arr-history')
  if (!r.ok) throw new Error(`ARR History fetch failed: HTTP ${r.status}`)
  return r.json()
}

// ── ARR Bridge ───────────────────────────────────────────────────────────────
export type ArrBridgeMonth = {
  month: string              // YYYY-MM
  beginning_arr: number
  new_business: number
  expansion: number
  contraction: number
  churn: number
  net_change: number
  ending_arr: number
}

export type ArrRetentionMonth = {
  month: string
  nrr_trailing_12m: number | null
  grr_trailing_12m: number | null
  cohort_arr: number | null
  cohort_size: number
}

export type ArrYoyMonth = {
  month: string        // YYYY-MM
  ending_arr: number
  net_new_arr: number
  yoy_pct: number | null
}

export type ArrBridgeResponse = {
  bridge: ArrBridgeMonth[]
  retention: ArrRetentionMonth[]
  yoy: ArrYoyMonth[]
  display_months: string[]
  message: string | null
}

export async function getArrBridge(): Promise<ArrBridgeResponse> {
  const r = await apiFetch('/arr-bridge')
  if (!r.ok) throw new Error(`ARR Bridge fetch failed: HTTP ${r.status}`)
  return r.json()
}

export type BridgeAccountRow = {
  account_name: string
  arr: number
  arr_change: number
  sf_account_id: string | null
}

export type BridgeAccountsResponse = {
  accounts: BridgeAccountRow[]
  month: string
  component: string
  salesforce_base_url: string | null
}

export async function getBridgeAccounts(month: string, component: string): Promise<BridgeAccountsResponse> {
  const r = await apiFetch(`/arr-bridge/accounts?month=${encodeURIComponent(month)}&component=${encodeURIComponent(component)}`)
  if (!r.ok) throw new Error(`Bridge accounts fetch failed: HTTP ${r.status}`)
  return r.json()
}

// ── ARR Cohort Churn ─────────────────────────────────────────────────────────
export type CohortMonth = {
  offset: number
  arr: number
  pct: number | null   // % of Month-0 ARR; null if starting_arr = 0
  calendar_month: string
}

export type CohortRow = {
  cohort_month: string        // YYYY-MM
  starting_arr: number
  account_count: number
  months: CohortMonth[]
}

export type ArrCohortChurnResponse = {
  cohorts: CohortRow[]
  max_offset: number
  sheet_snapshot_as_of: string | null
  message: string | null
}

export async function getArrCohortChurn(): Promise<ArrCohortChurnResponse> {
  const r = await apiFetch('/arr-cohort-churn')
  if (!r.ok) throw new Error(`ARR Cohort Churn fetch failed: HTTP ${r.status}`)
  return r.json()
}

// ── Forecast ──────────────────────────────────────────────────────────────────
export type ForecastMonthNB = {
  month: string
  actuals: number
  pipeline_weighted: number
  pipeline_ai_weighted: number
  pipeline_tier_weighted: number
  pipeline_raw: number
  forecast: number
  forecast_ai: number
  forecast_tier: number
  in_quarter_est: number
  adjusted_forecast: number
  target: number | null
  has_ai_scores: boolean
}

export type ForecastMonthExp = {
  month: string
  actuals: number
  pipeline_weighted: number
  pipeline_ai_weighted: number
  pipeline_tier_weighted: number
  pipeline_raw: number
  forecast: number
  forecast_ai: number
  forecast_tier: number
  in_quarter_est: number
  adjusted_forecast: number
  target: number | null
  has_ai_scores: boolean
}

export type ForecastMonthRenewal = {
  month: string
  due_arr: number
  won_arr: number
  pipeline_weighted: number
  pipeline_raw: number
  forecast_arr: number
  rate_actual: number | null
  rate_forecast: number | null
  rate_target: number | null
}

export type ForecastQuarterTotals = {
  nb_actuals: number
  nb_forecast: number
  nb_forecast_ai: number
  nb_forecast_tier: number
  nb_in_quarter_est: number
  nb_adjusted_forecast: number
  nb_target: number | null
  exp_actuals: number
  exp_forecast: number
  exp_forecast_ai: number
  exp_forecast_tier: number
  exp_in_quarter_est: number
  exp_adjusted_forecast: number
  exp_target: number | null
  total_actuals: number
  total_forecast: number
  total_forecast_ai: number
  total_forecast_tier: number
  total_in_quarter_est: number
  total_adjusted_forecast: number
  has_ai_scores: boolean
  renewal_due: number
  renewal_won: number
  renewal_forecast: number
  rate_actual: number | null
  rate_forecast: number | null
  rate_target: number | null
}

/** Earliest-snapshot AI month forecast vs final closed won (backtest) */
export type AIForecastBacktestRow = {
  month: string
  predicted: number
  actual: number
  error_pct: number
  earliest_snapshot: string
}

export type AIForecastBacktestSummary = {
  n: number
  mean_signed_error_pct: number | null
  mean_abs_error_pct: number | null
  rows: AIForecastBacktestRow[]
}

export type ForecastResponse = {
  quarter: string
  months: string[]
  new_business: ForecastMonthNB[]
  expansion: ForecastMonthExp[]
  renewals: ForecastMonthRenewal[]
  /** Snapshot vs actual closed bookings — sharpens AI scoring; absent on older backends */
  ai_backtest?: AIForecastBacktestSummary | null
  quarter_totals: ForecastQuarterTotals
  in_quarter_quarters_used: number
  salesforce_base_url: string | null
}

export type ForecastAccuracyRow = {
  month: string
  is_complete: boolean
  nb_actual: number
  exp_actual: number
  total_actual: number
  snapshots?: { snapshot_date: string; total_forecast: number | null; total_adjusted_forecast: number | null; total_ai_adjusted_forecast?: number | null }[]
  earliest_snapshot_date: string | null
  weighted_forecast_at_snap: number | null
  adjusted_forecast_at_snap: number | null
  /** Earliest-snapshot *Forecast (AI) adjusted* (NB+Exp+IQ), for apples-to-apples vs `accuracy_ai_pct` */
  ai_adjusted_forecast_at_snap: number | null
  accuracy_weighted_pct: number | null
  accuracy_adjusted_pct: number | null
  accuracy_ai_pct: number | null
}

export type ForecastAccuracyResponse = {
  rows: ForecastAccuracyRow[]
  snapshot_count: number
  message: string
}

export async function getForecastAccuracy(): Promise<ForecastAccuracyResponse> {
  const r = await apiFetch('/forecast/accuracy')
  if (!r.ok) throw new Error(`Forecast accuracy fetch failed: HTTP ${r.status}`)
  return r.json()
}

export async function triggerForecastSnapshot(): Promise<{ ok: boolean; months_saved: number; snapshot_date: string }> {
  const r = await apiFetch('/forecast/snapshot', { method: 'POST' })
  if (!r.ok) throw new Error(`Snapshot failed: HTTP ${r.status}`)
  return r.json()
}

export async function getForecastCurrentQuarter(): Promise<ForecastResponse> {
  const r = await apiFetch('/forecast/current-quarter')
  if (!r.ok) throw new Error(`Forecast fetch failed: HTTP ${r.status}`)
  return r.json()
}

export type AIDealScore = {
  sf_opp_id: string
  account_name: string | null
  opportunity_name: string | null
  arr: number
  probability: number | null
  ai_contribution: number
  reasoning: string | null
  stage: string | null
  forecast_category: string | null
}

export type AIForecastMonth = {
  month: string
  ai_forecast: number
  deal_count: number
  scored_deal_count: number
  top_deals: AIDealScore[]
}

export type AIForecastResponse = {
  quarter: string
  months: string[]
  month_data: AIForecastMonth[]
  total_ai_forecast: number
  last_scored_at: string | null
  total_scored_deals: number
  salesforce_base_url: string | null
  observations: string[]
}

export async function getAIForecastCurrentQuarter(): Promise<AIForecastResponse> {
  const r = await apiFetch('/forecast/ai-current-quarter')
  if (!r.ok) throw new Error(`AI forecast fetch failed: HTTP ${r.status}`)
  return r.json()
}

export type AIObservationsResponse = {
  observations: string[]
  scored_at: string | null
  quarter_label: string | null
  obs_type?: string
  last_ai_run_at: string | null
}

export async function getAIObservations(type: 'forecast' | 'pipeline' | 'renewals' = 'forecast'): Promise<AIObservationsResponse> {
  const r = await apiFetch(`/forecast/observations?type=${type}`)
  if (!r.ok) throw new Error(`Observations fetch failed: HTTP ${r.status}`)
  return r.json()
}

export async function triggerAIRescore(): Promise<{ ok: boolean; job_id?: string; status?: string; message?: string; scored?: number; error?: string }> {
  const r = await apiFetch('/forecast/ai-rescore', { method: 'POST' })
  if (!r.ok) throw new Error(`AI rescore failed: HTTP ${r.status}`)
  return r.json()
}

export interface ActiveJob {
  id: string
  type: string
  label: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  result: string | null
}

export async function getActiveJobs(): Promise<{ jobs: ActiveJob[] }> {
  const r = await apiFetch('/jobs/active')
  if (!r.ok) return { jobs: [] }
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

export async function getBalanceSheet(periodEnd?: string, months = 3): Promise<BalanceSheetLine[]> {
  let path = `/financials/balance-sheet?months=${months}`
  if (periodEnd) path += `&period_end=${periodEnd}`
  const r = await apiFetch(path)
  if (!r.ok) throw new Error('Failed to fetch balance sheet')
  return r.json()
}

export async function getFinancialAnalyses(): Promise<FinancialAnalysis[]> {
  const r = await apiFetch('/financials/analyses')
  if (!r.ok) throw new Error('Failed to fetch analyses')
  return r.json()
}

export async function triggerMonthlyClose(periodEnd: string): Promise<{ ok: boolean }> {
  const r = await apiFetch('/financials/monthly-close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period_end: periodEnd }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

export async function fpaChat(messages: FPAChatMessage[]): Promise<FPAChatResponse> {
  const r = await apiFetch('/financials/fpa-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

export type SyncStatementResult = { ok: boolean; rows_synced?: number; periods_synced?: number; error?: string }
export type SyncStatus = {
  synced_at: string | null
  rows_synced?: number
  periods_synced?: number
  actuals_tab?: string
  plan_tab?: string
} | null

export async function getSyncStatus(): Promise<Record<'pnl' | 'bs' | 'cf', SyncStatus>> {
  const r = await apiFetch('/financials/sync-status')
  if (!r.ok) throw new Error('Failed to fetch sync status')
  return r.json()
}

export async function syncFromSheet(statement: 'pnl' | 'bs' | 'cf' | 'all'): Promise<{ results: Record<string, SyncStatementResult> }> {
  const r = await apiFetch(`/financials/sync-from-sheet?statement=${statement}`, { method: 'POST' })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

// ── Churn Analysis ────────────────────────────────────────────────────────
export type ChurnRecord = {
  id: number
  account_name: string
  sf_account_id: string | null
  churn_month: string
  churn_arr: number
  tenure_months: number | null
  first_arr_month: string | null
  industry: string | null
  segment: string | null
  region: string | null
  account_type: string | null
  churn_reason: string | null
  health_score: number | null
  synced_at: string | null
  sf_attributes: Record<string, string | number | null>
}

export type ChurnBucket = { count: number; arr: number }
export type ChurnSummary = {
  total: number
  total_arr: number
  synced_at: string | null
  by_industry: Record<string, ChurnBucket>
  by_segment: Record<string, ChurnBucket>
  by_tenure_bucket: Record<string, ChurnBucket>
  by_arr_bucket: Record<string, ChurnBucket>
  by_month: Record<string, ChurnBucket>
}

export type ChurnObservations = {
  observations: string[]
  summary: string | null
  patterns: Record<string, Record<string, number>>
  total_churned: number
  total_churn_arr: number
  generated_at: string | null
}

export async function getChurnRecords(): Promise<ChurnRecord[]> {
  const r = await apiFetch('/churn/records')
  if (!r.ok) throw new Error('Failed to fetch churn records')
  return r.json()
}

export async function getChurnSummary(): Promise<ChurnSummary> {
  const r = await apiFetch('/churn/summary')
  if (!r.ok) throw new Error('Failed to fetch churn summary')
  return r.json()
}

export async function getChurnObservations(): Promise<ChurnObservations> {
  const r = await apiFetch('/churn/observations')
  if (!r.ok) throw new Error('Failed to fetch churn observations')
  return r.json()
}

export async function syncChurnData(): Promise<{ ok: boolean; churned_found: number; sf_rows: number; message: string }> {
  const r = await apiFetch('/churn/sync', { method: 'POST' })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

export async function runChurnAIAnalysis(): Promise<{ ok: boolean; observations: number }> {
  const r = await apiFetch('/churn/ai-analyze', { method: 'POST' })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

export type TabSnapshot = { title: string; synced_at: string | null; non_empty_rows: number; priority: number }

export async function getTabSnapshots(): Promise<TabSnapshot[]> {
  const r = await apiFetch('/financials/tab-snapshots')
  if (!r.ok) throw new Error('Failed to fetch tab snapshots')
  return r.json()
}

export type ModelTabStatus = {
  tab: string
  synced: boolean
  synced_at: string | null
  rows: number | null
}

export async function getModelTabsStatus(): Promise<{ tabs: ModelTabStatus[] }> {
  const r = await apiFetch('/financials/model-tabs-status')
  if (!r.ok) throw new Error('Failed to fetch model tabs status')
  return r.json()
}

/** Model tab sync can take several minutes (many Google Sheet reads). */
export async function syncModelTabs(
  signal?: AbortSignal
): Promise<{ synced: number; failed: number; details: { tab: string; ok: boolean; rows?: number; error?: string }[] }> {
  const r = await apiFetch('/financials/sync-model-tabs', { method: 'POST', signal })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    const detail = (err as { detail?: string | unknown }).detail
    const msg =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? (detail as { msg?: string }[]).map((d) => d.msg).filter(Boolean).join(' ')
          : `HTTP ${r.status}`
    throw new Error(msg || 'Failed to sync model tabs')
  }
  return r.json()
}

export type ModelMap = { map: { text: string; tabs: string[] } | null; as_of: string | null; message?: string }

export async function getModelMap(): Promise<ModelMap> {
  const r = await apiFetch('/financials/model-map')
  if (!r.ok) throw new Error('Failed to fetch model map')
  return r.json()
}

export async function scanFinancialModel(): Promise<{ ok: boolean; tabs_scanned: number; map_preview: string }> {
  const r = await apiFetch('/financials/scan-model', { method: 'POST' })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

// ── Weekly Briefing ───────────────────────────────────────────────────────────

export interface WeeklyBriefingData {
  week_of: string | null
  generated_at: string | null
  briefing_text: string | null
  model_used: string | null
  error: string | null
}

export async function getWeeklyBriefing(): Promise<WeeklyBriefingData> {
  const r = await apiFetch('/briefing/weekly')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function generateWeeklyBriefing(): Promise<{ ok: boolean; week_of?: string; generated_at?: string; error?: string }> {
  const r = await apiFetch('/briefing/generate', { method: 'POST' })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}

// ── Agent Chat ────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function postAgentChat(
  message: string,
  history: ChatMessage[],
  sessionId: string,
): Promise<{ answer: string; memory_used?: boolean }> {
  const r = await apiFetch('/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, session_id: sessionId }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail || `HTTP ${r.status}`)
  }
  return r.json()
}
