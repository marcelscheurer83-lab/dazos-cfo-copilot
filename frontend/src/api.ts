/** API base URL: use VITE_API_URL when building for production (e.g. https://api.example.com/api). Must include /api so routes work. */
const RAW_API = import.meta.env.VITE_API_URL ?? '/api'
const API = RAW_API.endsWith('/api') ? RAW_API : `${RAW_API.replace(/\/$/, '')}/api`

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
  /** Booking ARR from closed won expansions (no plan/delta) */
  expansion_mid_term?: number | null
  /** Booking ARR from renewals (no plan/delta) */
  expansion_upon_renewal?: number | null
  /** Total open pipeline ARR / shortfall to plan (MTD/QTD only) */
  pipe_coverage_total?: number | null
  /** Open pipeline NB ARR / shortfall to plan (MTD/QTD only) */
  pipe_coverage_new_business?: number | null
  /** Open pipeline expansion ARR / shortfall to plan (MTD/QTD only) */
  pipe_coverage_expansion?: number | null
}

export type BookingsMTDResponse = {
  previous_month: BookingsPeriod
  current_mtd: BookingsPeriod
  qtd: BookingsPeriod
  plan_source: string | null
  plan_message: string | null
}

export async function getDashboardBookingsMTD(): Promise<BookingsMTDResponse> {
  const BOOKINGS_ERR = 'Bookings — server returned invalid data. Check that the backend is running and try again.'
  let text: string
  try {
    const r = await apiFetch('/dashboard/bookings-mtd')
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

export type RenewalsMTDPeriod = {
  period_label?: string
  total: BookingsMTDRow
  renewed: BookingsMTDRow
  open: BookingsMTDRow
  churn: BookingsMTDRow
  contraction: BookingsMTDRow
  renewal_rate: BookingsMTDRow
}

export type RenewalsMTDResponse = {
  previous_month: RenewalsMTDPeriod
  current_mtd: RenewalsMTDPeriod
  qtd: RenewalsMTDPeriod
  plan_source: string | null
  plan_message: string | null
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
  previous_month: CashPeriod
  current_mtd: CashPeriod
  qtd: CashPeriod
  plan_source: string | null
  plan_message: string | null
  chargebee_message?: string | null
}

export async function getDashboardRenewalsMTD(): Promise<RenewalsMTDResponse> {
  const RENEWALS_ERR = 'Renewals — server returned invalid data. Check that the backend is running and try again.'
  let text: string
  try {
    const r = await apiFetch('/dashboard/renewals-mtd')
    text = await r.text()
    if (!r.ok) {
      try {
        const j = JSON.parse(text)
        throw new Error(j.detail || j.error || `Failed to fetch renewals MTD (${r.status})`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/Unexpected token|not valid JSON|SyntaxError|Internal S/i.test(msg)) throw new Error(RENEWALS_ERR)
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

const CASH_ERR = 'Cash — server returned invalid data. Check that the backend is running and try again.'

export async function getDashboardCashMTD(): Promise<CashMTDResponse> {
  let text: string
  try {
    const r = await apiFetch('/dashboard/cash-mtd')
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
  segment: string | null
  active_arr: number
  /** ARR from anchor (renewal/NB) only; used for ARR history over time. */
  anchor_arr?: number
  /** Expansions after anchor: close_date + arr; used for by-month ARR. */
  expansions?: Array<{ close_date: string; arr: number }>
  by_product: Record<string, number>
  /** CRM seats (Additional CRM Seats quantity + 5 per Dazos CRM Platform (Includes 5 Seats) once per opp). Same opportunity set as active ARR. */
  crm_seats?: number
  /** ARR from CRM SKUs only: Additional CRM Seats, Dazos CRM Platform (Includes 5 Seats), Dazos CRM Platform (Legacy). Same opportunity set as active ARR. */
  crm_arr?: number
  subscription_start_date: string | null
  subscription_end_date: string | null
  /** e.g. "ren only" when only open renewal, no closed renewal/NB */
  note: string | null
  no_new_business: boolean
}

export type ActiveARRResponse = {
  rows: ActiveARRRow[]
  grand_total: number
  salesforce_base_url?: string
}

export async function getARRScheduleActiveArr(): Promise<ActiveARRResponse> {
  const r = await apiFetch('/arr-schedule/active-arr')
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

/** Pipeline overview: open opportunities (not Closed Won/Lost). One row per opportunity. */
export type PipelineOverviewRow = {
  account_id: string | null
  account_name: string
  segment: string
  opportunity_sf_id: string
  opportunity_name: string
  stage_name: string
  record_type_name: string
  close_date: string | null
  /** Renewals overview only: effective renewal date (SF Renewal Date or close date). */
  renewal_date?: string | null
  arr: number
}

export type PipelineOverviewResponse = {
  rows: PipelineOverviewRow[]
  grand_total: number
  segments: string[]
  stages: string[]
  record_types: string[]
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

/** Renewals overview: same as closed but with UFR ARR (up for renewal) and renewal change. */
export type RenewalsOverviewRow = ClosedOverviewRow & {
  ufr_arr: number | null
  renewal_change_arr: number
}

export type RenewalsOverviewResponse = Omit<ClosedOverviewResponse, 'rows'> & {
  rows: RenewalsOverviewRow[]
  /** When false, no opp has renewal_date set so months are based on close date. Set SALESFORCE_RENEWAL_DATE_FIELD and sync for correct bucketing. */
  renewal_date_used?: boolean
}

export async function getRenewalsOverview(filters?: ClosedOverviewFilters): Promise<RenewalsOverviewResponse> {
  const params = new URLSearchParams()
  if (filters?.segment?.length) filters.segment.forEach((s) => params.append('segment', s))
  if (filters?.stage?.length) filters.stage.forEach((s) => params.append('stage', s))
  if (filters?.record_type?.length) filters.record_type.forEach((r) => params.append('record_type', r))
  if (filters?.months?.length) filters.months.forEach((m) => params.append('months', m))
  const qs = params.toString()
  const r = await apiFetch(`/renewals-overview${qs ? `?${qs}` : ''}`)
  if (!r.ok) throw new Error('Failed to fetch renewals overview')
  return r.json()
}

export async function syncSalesforce(): Promise<{
  ok: boolean
  error?: string
  synced_opportunities?: number
  synced_line_items?: number
  renewal_opportunities_count?: number
  message?: string
  renewal_date_field_used?: boolean
  renewal_date_field_configured?: boolean
}> {
  const r = await apiFetch('/sync/salesforce', { method: 'POST' })
  let data: { ok?: boolean; error?: string; detail?: unknown; renewal_date_field_used?: boolean; renewal_date_field_configured?: boolean }
  try {
    const text = await r.text()
    data = text ? JSON.parse(text) : {}
  } catch {
    return { ok: false, error: r.ok ? 'Invalid response from server.' : 'Sync failed. Restart the backend and try again.' }
  }
  if (!r.ok) return { ok: false, error: data.error || (Array.isArray(data.detail) ? data.detail.map((d: { msg?: string }) => d.msg).join(' ') : String(data.detail ?? 'Sync failed')) }
  return data as { ok: boolean; error?: string; synced_opportunities?: number; synced_line_items?: number; renewal_opportunities_count?: number; message?: string; renewal_date_field_used?: boolean; renewal_date_field_configured?: boolean }
}

export async function getEodSnapshots(): Promise<{
  count: number
  snapshots: Array<{ snapshot_date: string; snapshot_utc: string | null }>
  message?: string
}> {
  const r = await apiFetch('/salesforce/eod-snapshots')
  if (!r.ok) throw new Error('Failed to fetch EOD snapshots')
  return r.json()
}

export async function takeEodSnapshotNow(): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await apiFetch('/salesforce/eod-snapshots/take', { method: 'POST' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: data.detail ?? data.error ?? 'Failed to take snapshot' }
  return { ok: true, message: data.message }
}

export async function getEodSnapshotContents(
  snapshotDate: string,
  full = false
): Promise<{
  snapshot_date: string
  snapshot_utc: string | null
  counts: { accounts: number; opportunities: number; opportunity_line_items: number }
  carr_summary: { grand_total: number; accounts_with_arr: number }
  payload?: unknown
}> {
  const path = `/salesforce/eod-snapshots/${encodeURIComponent(snapshotDate)}${full ? '?full=1' : ''}`
  const r = await apiFetch(path)
  if (!r.ok) throw new Error(r.status === 404 ? 'No snapshot for that date' : 'Failed to fetch snapshot')
  return r.json()
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
