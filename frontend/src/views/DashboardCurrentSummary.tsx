import { useCallback, useEffect, useState } from 'react'
import {
  getDashboardKPI,
  getDashboardBookingsMTD,
  getDashboardRenewalsMTD,
  getDashboardCashMTD,
  getNewScheduleAccounts,
  getOverviewTargets,
  getDatasetStatus,
  refreshAppDataset,
  getArrBridge,
  type DashboardKPI,
  type BookingsMTDResponse,
  type BookingsMTDRow,
  type BookingsPeriod,
  type RenewalsMTDResponse,
  type RenewalsMTDRow,
  type RenewalsPeriod,
  type CashMTDResponse,
  type DatasetStatus,
  type DashboardFixedPeriods,
  type OverviewTargets,
} from '../api'

const DATASET_REFRESH_TIMEOUT_MS = 15 * 60 * 1000

/** Fixed quarter dashboard pages: no live ARR block; MTD APIs use fixed_periods. */
function dashboardFixedPeriodsForTitle(title: string): DashboardFixedPeriods | undefined {
  if (title === 'Q1 2026') return 'q1_2026'
  if (title === 'Q2 2026') return 'q2_2026'
  return undefined
}

function isFixedQuarterDashboard(title: string): boolean {
  return dashboardFixedPeriodsForTitle(title) != null
}

/** Format as $XK (thousands) for dashboard; use comma when >= 1000 (e.g. $1,235K). */
function fmtK(n: number): string {
  const k = Math.round(n / 1000)
  const str = k >= 1000 ? k.toLocaleString('en-US') : String(k)
  return `$${str}K`
}

function fmtDeltaK(deltaK: number | null | undefined): string {
  if (deltaK == null) return '—'
  const sign = deltaK >= 0 ? '+' : ''
  const k = Math.round(deltaK)
  const str = Math.abs(k) >= 1000 ? k.toLocaleString('en-US') : String(k)
  return `${sign}$${str}K`
}

function fmtPct(pct: number | null | undefined, decimals: number = 0): string {
  if (pct == null) return '—'
  return `${pct.toFixed(decimals)}%`
}

/** Delta for renewal rate row: backend sends percentage points (actual − plan) × 100. */
function fmtDeltaRatePpt(deltaK: number | null | undefined): string {
  if (deltaK == null) return '—'
  const sign = deltaK >= 0 ? '+' : ''
  return `${sign}${deltaK.toFixed(1)} ppt`
}

/** Never show raw JSON parse or server errors. Replace with a friendly message. */
function normalizeFetchError(message: string, context: string): string {
  const s = String(message)
  if (/Unexpected token|not valid JSON|JSON\.parse|SyntaxError|Internal S|"Internal S/i.test(s)) return `${context} — server returned invalid data. Check that the backend is running and try again.`
  if (/token.*JSON|JSON.*token/i.test(s)) return `${context} — server returned invalid data. Check that the backend is running and try again.`
  return s
}

/** Use for any user-facing message that might be a raw parse/server error (e.g. plan_message). */
function sanitizePlanMessage(msg: string | null | undefined): string | null {
  if (msg == null || msg === '') return null
  const s = String(msg)
  if (/Unexpected token|not valid JSON|Internal S|token.*JSON/i.test(s)) return 'Server returned invalid data. Check that the backend is running and try again.'
  return s
}

/** Alias for Cash block (plan_message + chargebee_message). */
function sanitizeCashMessage(msg: string | null | undefined): string | null {
  return sanitizePlanMessage(msg)
}

/** Legacy unified refresh used to persist QuickBooks failures; hide those from UI. */
function isLegacyQuickBooksBanner(msg: string | null | undefined): boolean {
  if (msg == null || msg === '') return false
  const s = msg.toLowerCase()
  return (
    s.includes('quickbooks') ||
    s.includes('profitandloss') ||
    s.includes('token refresh failed') ||
    s.includes('invalid refresh token')
  )
}

/** Fallback when API omits updated_at_utc: parse UTC `Z` ISO and format in UTC. */
function formatDatasetUpdatedUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d) + ' UTC'
  )
}

const blockStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '1rem 1.25rem',
}

/** Current Overview: Bookings / Renewals / Cash — slightly wider than half page, left-aligned with Live ARR row. */
const overviewMtdBlockLayout: React.CSSProperties = {
  maxWidth: '55%',
  width: '100%',
  justifySelf: 'start',
  boxSizing: 'border-box',
}

/** Top-row ARR / CRM stat cards share one fixed width (matches Live ARR). */
const dashboardArrStatCardStyle: React.CSSProperties = {
  ...blockStyle,
  flex: '0 0 220px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  minHeight: 96,
  boxSizing: 'border-box',
}

// ── ARR Bridge Summary (overview sidebar) ────────────────────────────────────

function fmtBridgeAmt(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function getQtrMonthKeys(bridge: import('../api').ArrBridgeMonth[]): string[] {
  if (!bridge.length) return []
  const latest = bridge[bridge.length - 1].month // YYYY-MM
  const [y, m] = latest.split('-').map(Number)
  const qStart = Math.floor((m - 1) / 3) * 3 + 1
  return [qStart, qStart + 1, qStart + 2]
    .filter((mo) => mo <= m)
    .map((mo) => `${y}-${String(mo).padStart(2, '0')}`)
}

function ArrBridgeSummaryBlock({ bridgeMonths }: { bridgeMonths: import('../api').ArrBridgeMonth[] }) {
  const latest = bridgeMonths[bridgeMonths.length - 1]
  const qKeys = getQtrMonthKeys(bridgeMonths)
  const qMonths = bridgeMonths.filter((b) => qKeys.includes(b.month))
  const qLabel = latest ? (() => {
    const [y, m] = latest.month.split('-').map(Number)
    const q = Math.ceil(m / 3)
    return `Q${q} '${String(y).slice(2)} QTD`
  })() : 'QTD'
  const mLabel = latest ? (() => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const [y, m] = latest.month.split('-').map(Number)
    return `${months[m - 1]} '${String(y).slice(2)}`
  })() : '—'

  const sum = (key: keyof import('../api').ArrBridgeMonth) =>
    qMonths.reduce((s, b) => s + (b[key] as number), 0)

  const qBeginning = qMonths.length ? qMonths[0].beginning_arr : 0
  const qEnding    = qMonths.length ? qMonths[qMonths.length - 1].ending_arr : 0

  const rows: { label: string; mVal: number; qVal: number; color?: string; bold?: boolean; sep?: boolean }[] = latest ? [
    { label: 'Beginning ARR',  mVal: latest.beginning_arr, qVal: qBeginning,        color: 'var(--text-muted)' },
    { label: '+ New Business', mVal: latest.new_business,  qVal: sum('new_business'), color: '#3b82f6' },
    { label: '+ Expansion',    mVal: latest.expansion,     qVal: sum('expansion'),    color: '#22c55e' },
    { label: '− Contraction',  mVal: latest.contraction,   qVal: sum('contraction'),  color: '#f97316' },
    { label: '− Churn',        mVal: latest.churn,         qVal: sum('churn'),        color: '#ef4444' },
    { label: 'Ending ARR',     mVal: latest.ending_arr,    qVal: qEnding,             bold: true, sep: true },
  ] : []

  return (
    <div style={{ ...blockStyle, flex: 1, minWidth: 0, boxSizing: 'border-box' }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
        ARR Bridge
      </div>
      {!latest ? (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>Loading…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 600 }}></th>
              <th style={{ textAlign: 'right', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 600 }}>{mLabel} MTD</th>
              <th style={{ textAlign: 'right', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 600 }}>{qLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, mVal, qVal, color, bold, sep }) => (
              <tr key={label} style={{ borderBottom: sep ? '2px solid var(--border)' : '1px solid var(--border)' }}>
                <td style={{ padding: '0.3rem 0.5rem', color: color ?? 'var(--text)', fontWeight: bold ? 700 : 400, whiteSpace: 'nowrap' }}>{label}</td>
                <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: color ?? 'var(--text)', fontWeight: bold ? 700 : 400 }}>
                  {mVal === 0 ? '—' : fmtBridgeAmt(mVal)}
                </td>
                <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: color ?? 'var(--text)', fontWeight: bold ? 700 : 400 }}>
                  {qVal === 0 ? '—' : fmtBridgeAmt(qVal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** MTD tables: avoid fixed layout + zoom collapsing row heights; keep rows readable. */
const mtTableStyle: React.CSSProperties = {
  width: '100%',
  fontSize: '1em',
  borderCollapse: 'collapse',
  lineHeight: 1.45,
}

/** Scales down on narrow viewports so four period columns fit without horizontal scroll. */
function mtPeriodGridStyle(periodCount: number): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${periodCount}, minmax(0, 1fr))`,
    gap: 'clamp(0.5rem, 1.5vw, 1.5rem)',
    minWidth: 0,
    fontSize: 'clamp(0.58rem, 0.22rem + 1.15vw, 0.8rem)',
  }
}

export default function DashboardCurrentSummary({ title = 'Current Performance' }: { title?: string }) {
  const [kpi, setKpi] = useState<DashboardKPI | null>(null)
  const [bookingsMTD, setBookingsMTD] = useState<BookingsMTDResponse | null>(null)
  const [renewalsMTD, setRenewalsMTD] = useState<RenewalsMTDResponse | null>(null)
  const [cashMTD, setCashMTD] = useState<CashMTDResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [bookingsErr, setBookingsErr] = useState<string | null>(null)
  const [renewalsErr, setRenewalsErr] = useState<string | null>(null)
  const [cashErr, setCashErr] = useState<string | null>(null)
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus | null>(null)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [liveArrTotal, setLiveArrTotal] = useState<number | null>(null)
  const [liveCarrTotal, setLiveCarrTotal] = useState<number | null>(null)
  const [netNewCarrYtd, setNetNewCarrYtd] = useState<number | null>(null)
  const [overviewTargets, setOverviewTargets] = useState<OverviewTargets | null>(null)
  const [arrErr, setArrErr] = useState<string | null>(null)
  const [yoyGrowth, setYoyGrowth] = useState<number | null>(null)
  const [nrr12m, setNrr12m] = useState<number | null>(null)
  const [grr12m, setGrr12m] = useState<number | null>(null)
  const [bridgeMonths, setBridgeMonths] = useState<import('../api').ArrBridgeMonth[]>([])

  const loadAllDashboardData = useCallback(() => {
    const fixed = dashboardFixedPeriodsForTitle(title)
    const mtdOpts = fixed ? { fixedPeriods: fixed } : undefined
    const fetchKpi = () =>
      getDashboardKPI()
        .then(setKpi)
        .catch((e) => setErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Dashboard')))
    const fetchBookings = () =>
      getDashboardBookingsMTD(mtdOpts)
        .then(setBookingsMTD)
        .catch((e) => setBookingsErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Bookings')))
    const fetchCash = () =>
      getDashboardCashMTD(mtdOpts)
        .then(setCashMTD)
        .catch((e) => setCashErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Cash')))
    const fetchRenewals = () =>
      getDashboardRenewalsMTD(mtdOpts)
        .then(setRenewalsMTD)
        .catch((e) => setRenewalsErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Renewals')))

    const fetchLiveArr = () => {
      getNewScheduleAccounts()
        .then((res) => {
          const rows = res.rows ?? []
          const liveArr = rows.reduce((s, r) => s + (r.live_arr ?? 0), 0)
          const carr = rows.reduce((s, r) => s + (r.contracted_arr ?? 0), 0)
          const dec25Arr = rows.reduce((s, r) => s + ((r.arr_by_month?.['2025-12']) ?? 0), 0)
          setLiveArrTotal(liveArr)
          setLiveCarrTotal(carr)
          setNetNewCarrYtd(carr - dec25Arr)
          setArrErr(null)
        })
        .catch((e: unknown) => setArrErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'ARR')))
      getOverviewTargets()
        .then(setOverviewTargets)
        .catch(() => setOverviewTargets(null))
      getArrBridge()
        .then((res) => {
          const latestRet = res.retention[res.retention.length - 1]
          const latestBridge = res.bridge[res.bridge.length - 1]
          const latestYoy = latestBridge ? res.yoy.find((y) => y.month === latestBridge.month) : undefined
          setNrr12m(latestRet?.nrr_trailing_12m ?? null)
          setGrr12m(latestRet?.grr_trailing_12m ?? null)
          setYoyGrowth(latestYoy?.yoy_pct ?? null)
          setBridgeMonths(res.bridge)
        })
        .catch(() => { /* non-critical — silently skip */ })
    }

    getDatasetStatus()
      .then((s) => {
        setDatasetStatus(s)
        // Drop stale QuickBooks refresh banner once server no longer reports that error (legacy scrub).
        setRefreshMessage((prev) => {
          if (!prev) return null
          if (
            !s.last_error &&
            (prev.includes('QuickBooks') || prev.includes('ProfitAndLoss'))
          ) {
            return null
          }
          return prev
        })
      })
      .catch(() => setDatasetStatus(null))
    fetchKpi()
    fetchBookings()
    fetchRenewals()
    fetchCash()
    if (!isFixedQuarterDashboard(title)) fetchLiveArr()
  }, [title])

  useEffect(() => {
    loadAllDashboardData()
  }, [loadAllDashboardData])

  const handleRefreshAppData = () => {
    setRefreshMessage(null)
    setRefreshLoading(true)
    const ac = new AbortController()
    const timeoutId = window.setTimeout(() => ac.abort(), DATASET_REFRESH_TIMEOUT_MS)
    refreshAppDataset(ac.signal)
      .then((res) => {
        window.clearTimeout(timeoutId)
        setRefreshLoading(false)
        if (res.ok) {
          setRefreshMessage(res.message ?? 'Refresh complete.')
          loadAllDashboardData()
        } else {
          const err = res.error ?? 'Refresh failed'
          setRefreshMessage(isLegacyQuickBooksBanner(err) ? null : err)
          loadAllDashboardData()
        }
      })
      .catch((e) => {
        window.clearTimeout(timeoutId)
        setRefreshLoading(false)
        if (e instanceof Error && e.name === 'AbortError') {
          setRefreshMessage('Refresh timed out or was cancelled. The server may still be working — wait and reload, or check backend logs.')
        } else {
          setRefreshMessage(e instanceof Error ? e.message : 'Refresh failed')
        }
      })
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!kpi) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  /** Current Overview: only MTD + quarter-to-date columns (not prior two months). */
  const overviewOnly = title === 'Current Performance'

  return (
    <>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '1rem',
          marginBottom: '1.25rem',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600 }}>{title}</h1>
        <button
          type="button"
          onClick={handleRefreshAppData}
          disabled={refreshLoading}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: refreshLoading ? 'wait' : 'pointer',
            background: 'var(--accent)',
            color: 'var(--accent-contrast, #fff)',
            border: 'none',
            borderRadius: 6,
          }}
        >
          {refreshLoading ? 'Refreshing…' : 'Refresh app data'}
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {datasetStatus?.updated_at
            ? `Last updated: ${datasetStatus.updated_at_utc ?? formatDatasetUpdatedUtc(datasetStatus.updated_at)}`
            : 'No refresh yet — click Refresh app data to load Salesforce, Sheets, and Chargebee (if configured).'}
          {datasetStatus?.last_refresh_ok === false &&
            datasetStatus?.last_error &&
            !isLegacyQuickBooksBanner(datasetStatus.last_error) && (
              <span style={{ color: 'var(--negative)', marginLeft: '0.5rem' }}>Last run error: {datasetStatus.last_error}</span>
            )}
        </span>
      </div>
      {refreshMessage && !isLegacyQuickBooksBanner(refreshMessage) && (
        <p style={{ fontSize: '0.9rem', color: refreshMessage.includes('failed') || refreshMessage.includes('error') ? 'var(--negative)' : 'var(--text-muted)', margin: '0 0 1rem' }}>
          {refreshMessage}
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
          gap: '1.25rem',
          minWidth: 0,
          width: '100%',
        }}
      >
        {!isFixedQuarterDashboard(title) && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '1.25rem',
              alignItems: 'stretch',
              gridColumn: '1 / -1',
              ...(overviewOnly ? { width: '100%', boxSizing: 'border-box' } : {}),
            }}
          >
            <div style={{ ...dashboardArrStatCardStyle, ...(overviewOnly ? { flex: '1 1 0', minWidth: 0 } : {}) }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center' }}>
                Live ARR
              </div>
              {arrErr && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>{arrErr}</p>
              )}
              {!arrErr && liveArrTotal != null && (
                <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(liveArrTotal)}
                </div>
              )}
              {!arrErr && liveArrTotal == null && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
              )}
            </div>

            <div style={{ ...dashboardArrStatCardStyle, ...(overviewOnly ? { flex: '1 1 0', minWidth: 0 } : {}) }}>
              <div
                style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center', lineHeight: 1.3, maxWidth: 220 }}
                title="Live ARR plus Closed Won opportunities with a contract start after today."
              >
                Contracted ARR
              </div>
              {arrErr && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>{arrErr}</p>
              )}
              {!arrErr && liveCarrTotal != null && (
                <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(liveCarrTotal)}
                </div>
              )}
              {!arrErr && liveCarrTotal == null && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
              )}
            </div>

            <div style={{ ...dashboardArrStatCardStyle, ...(overviewOnly ? { flex: '1 1 0', minWidth: 0 } : {}) }}>
              <div
                style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center', lineHeight: 1.3, maxWidth: 220 }}
                title="Contracted ARR today minus ARR active at end of Dec '25 — net new ARR added year-to-date."
              >
                Net New Contracted ARR YTD
              </div>
              {arrErr && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>{arrErr}</p>
              )}
              {!arrErr && netNewCarrYtd != null && (
                <>
                  <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(netNewCarrYtd)}
                  </div>
                  {overviewTargets?.net_new_carr_ytd_target != null && overviewTargets.net_new_carr_ytd_target !== 0 && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.2rem' }}>
                      {`(${Math.round(netNewCarrYtd / overviewTargets.net_new_carr_ytd_target * 100)}% of plan)`}
                    </div>
                  )}
                </>
              )}
              {!arrErr && netNewCarrYtd == null && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
              )}
            </div>

            {/* ── ARR Growth YoY ── */}
            <div style={{ ...dashboardArrStatCardStyle, ...(overviewOnly ? { flex: '1 1 0', minWidth: 0 } : {}) }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center' }}>
                ARR Growth YoY
              </div>
              {yoyGrowth != null ? (
                <div style={{ fontSize: '1.75rem', fontWeight: 700, textAlign: 'center', color: yoyGrowth >= 20 ? 'var(--positive, #22c55e)' : yoyGrowth >= 0 ? '#f59e0b' : 'var(--negative, #ef4444)' }}>
                  {yoyGrowth}%
                </div>
              ) : (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
              )}
            </div>

            {/* ── T12M NRR ── */}
            <div style={{ ...dashboardArrStatCardStyle, ...(overviewOnly ? { flex: '1 1 0', minWidth: 0 } : {}) }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center' }}>
                Net Revenue Retention
              </div>
              {nrr12m != null ? (
                <>
                  <div style={{ fontSize: '1.75rem', fontWeight: 700, textAlign: 'center', color: nrr12m >= 100 ? 'var(--positive, #22c55e)' : nrr12m >= 85 ? '#f59e0b' : 'var(--negative, #ef4444)' }}>
                    {nrr12m}%
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.2rem' }}>Trailing 12M</div>
                </>
              ) : (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
              )}
            </div>

            {/* ── T12M GRR ── */}
            <div style={{ ...dashboardArrStatCardStyle, ...(overviewOnly ? { flex: '1 1 0', minWidth: 0 } : {}) }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center' }}>
                Gross Revenue Retention
              </div>
              {grr12m != null ? (
                <>
                  <div style={{ fontSize: '1.75rem', fontWeight: 700, textAlign: 'center', color: grr12m >= 90 ? 'var(--positive, #22c55e)' : grr12m >= 75 ? '#f59e0b' : 'var(--negative, #ef4444)' }}>
                    {grr12m}%
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.2rem' }}>Trailing 12M</div>
                </>
              ) : (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
              )}
            </div>

          </div>
        )}

        {/* Block 1: Bookings (+ ARR Bridge table in overview mode) */}
        <div style={{
          gridColumn: '1 / -1',
          display: overviewOnly ? 'grid' : 'flex',
          gridTemplateColumns: overviewOnly ? '55fr 45fr' : undefined,
          gap: '1.25rem',
          alignItems: 'flex-start',
          minWidth: 0,
          width: '100%',
          boxSizing: 'border-box',
        }}>
          <div style={{ ...blockStyle, minWidth: 0, ...(overviewOnly ? {} : { flex: '1 1 auto' }) }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
              Bookings (ARR)
            </div>
            {bookingsErr && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{normalizeFetchError(bookingsErr, 'Bookings')}</p>
            )}
            {!bookingsErr && bookingsMTD && (
              <BookingsMTDBlock data={bookingsMTD} overviewOnly={overviewOnly} hidePipeCov={isFixedQuarterDashboard(title)} />
            )}
            {!bookingsErr && !bookingsMTD && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
            )}
          </div>

          {/* ARR Bridge summary — overview only */}
          {overviewOnly && <ArrBridgeSummaryBlock bridgeMonths={bridgeMonths} />}
        </div>

        {/* Renewals (same periods as Bookings / Cash) */}
        <div
          style={{
            ...blockStyle,
            gridColumn: '1 / -1',
            minWidth: 0,
            ...(overviewOnly ? overviewMtdBlockLayout : {}),
          }}
        >
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Renewals (ARR)
          </div>
          {renewalsErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{renewalsErr}</p>
          )}
          {!renewalsErr && renewalsMTD && <RenewalsMTDBlock data={renewalsMTD} overviewOnly={overviewOnly} />}
          {!renewalsErr && !renewalsMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

        {/* Block 2: Cash */}
        <div
          style={{
            ...blockStyle,
            gridColumn: '1 / -1',
            minWidth: 0,
            ...(overviewOnly ? overviewMtdBlockLayout : {}),
          }}
        >
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Cash
          </div>
          {cashErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{normalizeFetchError(cashErr, 'Cash')}</p>
          )}
          {!cashErr && cashMTD && (
            <CashMTDBlock data={cashMTD} overviewOnly={overviewOnly} />
          )}
          {!cashErr && !cashMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

      </div>
    </>
  )
}

/** Value column header from period label: … QTD → QTD, … MTD → MTD, else (e.g. Jan 26, Q1 26) → Actual */
function periodValueColumnLabel(periodLabel: string | undefined): string {
  if (!periodLabel) return 'Actual'
  if (periodLabel.includes('QTD')) return 'QTD'
  if (periodLabel.includes('MTD')) return 'MTD'
  return 'Actual'
}

function RenewalsMTDBlock({ data, overviewOnly }: { data: RenewalsMTDResponse; overviewOnly?: boolean }) {
  const { two_months_ago, previous_month, current_mtd, qtd, plan_message } = data
  const periods = (
    overviewOnly
      ? [current_mtd, qtd]
      : [two_months_ago, previous_month, current_mtd, qtd]
  ).filter(Boolean) as RenewalsPeriod[]
  const planNote = sanitizePlanMessage(plan_message)
  const needsGoogleConfig = planNote && /GOOGLE_SHEET_ID|not configured|credentials/i.test(planNote)
  return (
    <>
      {planNote && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          {planNote}
          {needsGoogleConfig && (
            <>
              {' '}
              — Set <strong>GOOGLE_SHEET_ID</strong> (and credentials) in the backend environment (e.g. Railway → Variables).
            </>
          )}
        </p>
      )}
      <div style={mtPeriodGridStyle(periods.length)}>
        {periods.map((period) => (
          <div key={period.period_label}>
            <div style={{ fontSize: '1.05em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {period.period_label}
            </div>
            <table style={mtTableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '0.25rem 0.5rem 0.25rem 0',
                      fontWeight: 500,
                      color: 'var(--text-muted)',
                      verticalAlign: 'bottom',
                    }}
                  />
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '0.25rem 0.5rem',
                      fontWeight: 500,
                      color: 'var(--text-muted)',
                      verticalAlign: 'bottom',
                    }}
                  >
                    {periodValueColumnLabel(period.period_label)}
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '0.25rem 0.5rem',
                      fontWeight: 500,
                      color: 'var(--text-muted)',
                      verticalAlign: 'bottom',
                    }}
                  >
                    Plan
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '0.25rem 0',
                      fontWeight: 500,
                      color: 'var(--text-muted)',
                      verticalAlign: 'bottom',
                    }}
                  >
                    %
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '0.25rem 0',
                      fontWeight: 500,
                      color: 'var(--text-muted)',
                      verticalAlign: 'bottom',
                    }}
                  >
                    Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                <RenewalsMetricRow label="Up for renewal" row={period.up_for_renewal} />
                <RenewalsMetricRow label="Renewed" row={period.renewed} />
                <RenewalsMetricRow label="Open" row={period.open} />
                <RenewalsMetricRow label="Churn" row={period.churn} />
                <RenewalsMetricRow label="Contraction" row={period.contraction} />
                <RenewalsMetricRow label="Renewal rate" row={period.renewal_rate} />
                <RenewalsMetricRow label="Cancelled" row={period.cancelled} />
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  )
}

function RenewalsMetricRow({ label, row }: { label: string; row: RenewalsMTDRow }) {
  const isRate = row.is_rate === true
  const invertDelta =
    label === 'Churn' || label === 'Contraction' || label === 'Cancelled'
  const deltaColor =
    row.delta_k == null
      ? 'var(--text-muted)'
      : invertDelta
        ? row.delta_k >= 0
          ? 'var(--negative)'
          : 'var(--positive)'
        : row.delta_k >= 0
          ? 'var(--positive)'
          : 'var(--negative)'
  const showRateActualDash = isRate && row.achievement_pct == null && row.mtd === 0
  const mtdDisplay = showRateActualDash ? '—' : isRate ? fmtPct(row.mtd * 100, 1) : fmtK(row.mtd)
  const planDisplay =
    isRate
      ? row.plan != null
        ? fmtPct(row.plan * 100, 1)
        : '—'
      : row.plan != null
        ? fmtK(row.plan)
        : '—'
  const pctDisplay = fmtPct(row.achievement_pct)
  const deltaDisplay = isRate ? fmtDeltaRatePpt(row.delta_k) : fmtDeltaK(row.delta_k)

  return (
    <tr style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'middle' }}>
      <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', color: 'var(--text)' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{mtdDisplay}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text-muted)' }}>{planDisplay}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{pctDisplay}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0', color: deltaColor }}>{deltaDisplay}</td>
    </tr>
  )
}

function BookingsMTDBlock({ data, overviewOnly, hidePipeCov }: { data: BookingsMTDResponse; overviewOnly?: boolean; hidePipeCov?: boolean }) {
  const { two_months_ago, previous_month, current_mtd, qtd, plan_message } = data
  const periods: BookingsPeriod[] = (
    overviewOnly
      ? [current_mtd, qtd]
      : [two_months_ago, previous_month, current_mtd, qtd]
  ).filter(Boolean) as BookingsPeriod[]
  const planNote = sanitizePlanMessage(plan_message)
  const needsGoogleConfig =
    planNote && /GOOGLE_SHEET_ID|not configured|credentials/i.test(planNote)
  return (
    <>
      {planNote && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          {planNote}
          {needsGoogleConfig && (
            <> — Set <strong>GOOGLE_SHEET_ID</strong> (and credentials) in the backend environment (e.g. Railway → Variables).</>
          )}
        </p>
      )}
      <div style={mtPeriodGridStyle(periods.length)}>
        {periods.map((period) => {
          // Pipe coverage applies to MTD/QTD only (open pipeline vs plan shortfall). Past calendar months omit the column.
          const showPipeCov = !hidePipeCov && period !== two_months_ago && period !== previous_month
          return (
          <div key={period.period_label}>
            <div style={{ fontSize: '1.05em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {period.period_label}
            </div>
            <table style={mtTableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem 0.25rem 0', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>
                  </th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>
                    {periodValueColumnLabel(period.period_label)}
                  </th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>Plan</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>Δ</th>
                  {showPipeCov && (
                    <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>
                      Pipe cov.
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                <MTDRow label="Total" row={period.total} pipeCoverage={period.pipe_coverage_total ?? null} showPipeCov={showPipeCov} />
                <MTDRow label="New business" row={period.new_business} pipeCoverage={period.pipe_coverage_new_business ?? null} showPipeCov={showPipeCov} />
                <MTDRow label="Expansion" row={period.expansion} pipeCoverage={period.pipe_coverage_expansion ?? null} showPipeCov={showPipeCov} />
                <MTDRowSub label="Mid-term" value={period.expansion_mid_term ?? 0} showPipeCov={showPipeCov} />
                <MTDRowSub label="Upon renewal" value={period.expansion_upon_renewal ?? 0} showPipeCov={showPipeCov} />
              </tbody>
            </table>
          </div>
        )})}
      </div>
    </>
  )
}

function CashMTDBlock({ data, overviewOnly }: { data: CashMTDResponse; overviewOnly?: boolean }) {
  const { two_months_ago, previous_month, current_mtd, qtd, plan_message, chargebee_message } = data
  const periods = (
    overviewOnly
      ? [current_mtd, qtd]
      : [two_months_ago, previous_month, current_mtd, qtd]
  ).filter(Boolean)
  const planNote = sanitizeCashMessage(plan_message)
  const needsGoogleConfig = planNote && /GOOGLE_SHEET_ID|not configured|credentials/i.test(planNote)
  return (
    <>
      {planNote && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          {planNote}
          {needsGoogleConfig && (
            <> — Set <strong>GOOGLE_SHEET_ID</strong> (and credentials) in the backend environment.</>
          )}
        </p>
      )}
      {chargebee_message && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          {sanitizeCashMessage(chargebee_message) || chargebee_message}
        </p>
      )}
      <div style={mtPeriodGridStyle(periods.length)}>
        {periods.map((period) => (
          <div key={period.period_label}>
            <div style={{ fontSize: '1.05em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {period.period_label}
            </div>
            <table style={mtTableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem 0.25rem 0', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }} />
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>{periodValueColumnLabel(period.period_label)}</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>Plan</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)', verticalAlign: 'bottom' }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'middle' }}>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', color: 'var(--text)' }}>Billings</td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>
                    {period.billings_actual != null ? fmtK(period.billings_actual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text-muted)' }}>
                    {period.billings_plan != null ? fmtK(period.billings_plan) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{fmtPct(period.billings_achievement_pct)}</td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0', color: period.billings_delta_k != null ? (period.billings_delta_k >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--text-muted)' }}>{fmtDeltaK(period.billings_delta_k)}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'middle' }}>
                  <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', color: 'var(--text)' }}>Collections</td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>
                    {period.collections_actual != null ? fmtK(period.collections_actual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text-muted)' }}>
                    {period.collections_plan != null ? fmtK(period.collections_plan) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{fmtPct(period.collections_achievement_pct)}</td>
                  <td style={{ textAlign: 'right', padding: '0.4rem 0', color: period.collections_delta_k != null ? (period.collections_delta_k >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--text-muted)' }}>{fmtDeltaK(period.collections_delta_k)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  )
}

function fmtPipeCoverage(value: number | null): string {
  return value != null ? `${value.toFixed(1)}×` : '—'
}

function MTDRow({
  label,
  row,
  pipeCoverage,
  showPipeCov,
}: {
  label: string
  row: BookingsMTDRow
  pipeCoverage?: number | null
  showPipeCov?: boolean
}) {
  const deltaColor = row.delta_k != null ? (row.delta_k >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--text-muted)'
  return (
    <tr style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'middle' }}>
      <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', color: 'var(--text)' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{fmtK(row.mtd)}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text-muted)' }}>
        {row.plan != null ? fmtK(row.plan) : '—'}
      </td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{fmtPct(row.achievement_pct)}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0', color: deltaColor }}>{fmtDeltaK(row.delta_k)}</td>
      {showPipeCov && (
        <td style={{ textAlign: 'right', padding: '0.4rem 0', color: 'var(--text)' }}>
          {fmtPipeCoverage(pipeCoverage ?? null)}
        </td>
      )}
    </tr>
  )
}

/** Indented sub-row: value only in first data column, no plan/%/delta; optional empty pipe cov cell for alignment */
function MTDRowSub({ label, value, showPipeCov }: { label: string; value: number; showPipeCov?: boolean }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)', verticalAlign: 'middle' }}>
      <td
        style={{
          padding: '0.4rem 0.5rem 0.4rem 0',
          color: 'var(--text-muted)',
          paddingLeft: '1.25rem',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text)' }}>{fmtK(value)}</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.4rem 0', color: 'var(--text-muted)' }}>—</td>
      {showPipeCov && (
        <td style={{ textAlign: 'right', padding: '0.4rem 0', color: 'var(--text-muted)' }}>—</td>
      )}
    </tr>
  )
}

