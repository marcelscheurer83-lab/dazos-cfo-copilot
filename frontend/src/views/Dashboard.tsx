import { useEffect, useState } from 'react'
import {
  getDashboardKPI,
  getDashboardBookingsMTD,
  getDashboardRenewalsMTD,
  getDashboardCashMTD,
  getARRScheduleActiveArr,
  syncSalesforce,
  syncGoogleSheet,
  type DashboardKPI,
  type BookingsMTDResponse,
  type BookingsMTDRow,
  type BookingsPeriod,
  type RenewalsMTDResponse,
  type RenewalsMTDPeriod,
  type CashMTDResponse,
} from '../api'

const ARR_2026P_RANGE = 'ARR_Calculations_2026P!A1:ZZ1000'
const BS_2026P_RANGE = 'BS_2026P!A1:ZZ1000'

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

/** Sync from Salesforce and sheet at most once per app session (when Dashboard first loads). */
const hasAutoSyncedThisSession = { current: false }
const hasSyncedSheetThisSession = { current: false }
const hasRetriedPlanRefetch = { current: false }

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

const blockStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '1rem 1.25rem',
}

export default function Dashboard() {
  const [kpi, setKpi] = useState<DashboardKPI | null>(null)
  const [bookingsMTD, setBookingsMTD] = useState<BookingsMTDResponse | null>(null)
  const [renewalsMTD, setRenewalsMTD] = useState<RenewalsMTDResponse | null>(null)
  const [cashMTD, setCashMTD] = useState<CashMTDResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [bookingsErr, setBookingsErr] = useState<string | null>(null)
  const [renewalsErr, setRenewalsErr] = useState<string | null>(null)
  const [cashErr, setCashErr] = useState<string | null>(null)
  const [sheetSyncError, setSheetSyncError] = useState<string | null>(null)
  const [liveArrTotal, setLiveArrTotal] = useState<number | null>(null)
  const [liveArrErr, setLiveArrErr] = useState<string | null>(null)
  const [liveCrmSeatsTotal, setLiveCrmSeatsTotal] = useState<number | null>(null)

  useEffect(() => {
    const fetchKpi = () =>
      getDashboardKPI()
        .then(setKpi)
        .catch((e) => setErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Dashboard')))
    const fetchBookings = () =>
      getDashboardBookingsMTD()
        .then(setBookingsMTD)
        .catch((e) => setBookingsErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Bookings')))
    const fetchRenewals = () =>
      getDashboardRenewalsMTD()
        .then(setRenewalsMTD)
        .catch((e) => setRenewalsErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Renewals')))
    const fetchCash = () =>
      getDashboardCashMTD()
        .then(setCashMTD)
        .catch((e) => setCashErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Cash')))

    const fetchLiveArr = () =>
      getARRScheduleActiveArr()
        .then((res) => {
          setLiveArrTotal(res.grand_total)
          const totalSeats = (res.rows ?? []).reduce(
            (sum, row) => sum + ((row as any).crm_seats ?? 0),
            0,
          )
          setLiveCrmSeatsTotal(totalSeats)
          setLiveArrErr(null)
        })
        .catch((e) => setLiveArrErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Live ARR')))

    const runSyncAndFetch = () => {
      fetchKpi()
      fetchBookings()
      fetchRenewals()
      fetchCash()
      fetchLiveArr()
    }

    const runInitialLoad = async () => {
      if (!hasAutoSyncedThisSession.current) {
        hasAutoSyncedThisSession.current = true
        syncSalesforce().catch(() => {})
        if (!hasSyncedSheetThisSession.current) {
          hasSyncedSheetThisSession.current = true
          // Sync plan sheets so plan numbers load automatically on first open
          try {
            await syncGoogleSheet(ARR_2026P_RANGE)
            const resBs = await syncGoogleSheet(BS_2026P_RANGE)
            if (!resBs.ok && resBs.error) setSheetSyncError(resBs.error)
          } catch (e) {
            setSheetSyncError((e as Error)?.message || 'Sheet sync failed')
          }
        }
      }
      runSyncAndFetch()
    }

    runInitialLoad()
  }, [])

  // If plan is missing after first load, retry sheet sync once and refetch so plan numbers appear
  useEffect(() => {
    if (hasRetriedPlanRefetch.current) return
    const needsPlan = (renewalsMTD?.plan_message && /no snapshot|sync.*first/i.test(renewalsMTD.plan_message)) ||
      (bookingsMTD?.plan_message && /no snapshot|sync.*first/i.test(bookingsMTD.plan_message)) ||
      (cashMTD?.plan_message && /no snapshot|sync.*first/i.test(cashMTD.plan_message))
    if (!needsPlan) return
    hasRetriedPlanRefetch.current = true
    const t = setTimeout(() => {
      syncGoogleSheet(ARR_2026P_RANGE)
        .then((res) => {
          if (res.ok) {
            // Delay refetch so backend can finish sync and release DB; avoids "invalid data" on first open
            setTimeout(() => {
              getDashboardBookingsMTD()
                .then((d) => { setBookingsMTD(d); setBookingsErr(null) })
                .catch((e) => setBookingsErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Bookings')))
              getDashboardRenewalsMTD()
                .then((d) => { setRenewalsMTD(d); setRenewalsErr(null) })
                .catch((e) => setRenewalsErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Renewals')))
            }, 600)
          }
        })
        .catch(() => {})
      syncGoogleSheet(BS_2026P_RANGE)
        .then((res) => {
          if (res.ok) {
            setTimeout(() => {
              getDashboardCashMTD()
                .then((d) => { setCashMTD(d); setCashErr(null) })
                .catch((e) => setCashErr(normalizeFetchError(e instanceof Error ? e.message : String(e), 'Cash')))
            }, 600)
          }
        })
        .catch(() => {})
    }, 800)
    return () => clearTimeout(t)
  }, [renewalsMTD?.plan_message, bookingsMTD?.plan_message, cashMTD?.plan_message])

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!kpi) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600 }}>Dashboard</h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '1.25rem',
        }}
      >
        {/* Live ARR + CRM seats — from Schedule */}
        <div
          style={{
            display: 'flex',
            gap: '1.25rem',
            alignItems: 'stretch',
            gridColumn: '1 / -1',
          }}
        >
          <div
            style={{
              ...blockStyle,
              flex: '0 0 220px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: 96,
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center' }}>
              Live ARR
            </div>
            {liveArrErr && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>{liveArrErr}</p>
            )}
            {!liveArrErr && liveArrTotal != null && (
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(liveArrTotal)}
              </div>
            )}
            {!liveArrErr && liveArrTotal == null && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
            )}
          </div>

          <div
            style={{
              ...blockStyle,
              flex: '0 0 220px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: 96,
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textAlign: 'center' }}>
              Live CRM seats
            </div>
            {liveArrErr && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>{liveArrErr}</p>
            )}
            {!liveArrErr && liveCrmSeatsTotal != null && (
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                {liveCrmSeatsTotal.toLocaleString('en-US')}
              </div>
            )}
            {!liveArrErr && liveCrmSeatsTotal == null && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>Loading…</p>
            )}
          </div>
        </div>

        {/* Block 1: Bookings */}
        <div style={{ ...blockStyle, gridColumn: '1 / -1' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Bookings (ARR)
          </div>
          {bookingsErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{normalizeFetchError(bookingsErr, 'Bookings')}</p>
          )}
          {!bookingsErr && bookingsMTD && (
            <BookingsMTDBlock data={bookingsMTD} sheetSyncError={sheetSyncError} />
          )}
          {!bookingsErr && !bookingsMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

        {/* Block 2: Renewals */}
        <div style={{ ...blockStyle, gridColumn: '1 / -1' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Renewals (ARR)
          </div>
          {renewalsErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{normalizeFetchError(renewalsErr, 'Renewals')}</p>
          )}
          {!renewalsErr && renewalsMTD && (
            <RenewalsMTDBlock data={renewalsMTD} sheetSyncError={sheetSyncError} />
          )}
          {!renewalsErr && !renewalsMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

        {/* Block 3: Cash */}
        <div style={{ ...blockStyle, gridColumn: '1 / -1' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Cash
          </div>
          {cashErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{normalizeFetchError(cashErr, 'Cash')}</p>
          )}
          {!cashErr && cashMTD && (
            <CashMTDBlock data={cashMTD} sheetSyncError={sheetSyncError} />
          )}
          {!cashErr && !cashMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

      </div>
    </>
  )
}

/** Value column header from period label: Q1 26 QTD → QTD, Feb 26 MTD → MTD, Jan 26 → Actual */
function periodValueColumnLabel(periodLabel: string | undefined): string {
  if (!periodLabel) return 'Actual'
  if (periodLabel.includes('QTD')) return 'QTD'
  if (periodLabel.includes('MTD')) return 'MTD'
  return 'Actual'
}

function BookingsMTDBlock({ data, sheetSyncError }: { data: BookingsMTDResponse; sheetSyncError?: string | null }) {
  const { two_months_ago, previous_month, current_mtd, qtd, plan_message } = data
  const periods: BookingsPeriod[] = [two_months_ago, previous_month, current_mtd, qtd]
  const planNote = sanitizePlanMessage(sheetSyncError) || sanitizePlanMessage(plan_message)
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
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${periods.length}, 1fr)`, gap: '1.5rem', minWidth: 0 }}>
        {periods.map((period) => {
          // Keep layout identical across periods: always render the "Pipe cov." column.
          // For the previous_month block, coverage values may be missing and will display as '—'.
          const showPipeCov = true
          return (
          <div key={period.period_label}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {period.period_label}
            </div>
            <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem 0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>
                  </th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                    {periodValueColumnLabel(period.period_label)}
                  </th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>Plan</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>Δ</th>
                  {showPipeCov && (
                    <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>
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

function CashMTDBlock({ data, sheetSyncError }: { data: CashMTDResponse; sheetSyncError?: string | null }) {
  const { two_months_ago, previous_month, current_mtd, qtd, plan_message, chargebee_message } = data
  const periods = [two_months_ago, previous_month, current_mtd, qtd]
  const planNote = sanitizeCashMessage(sheetSyncError) || sanitizeCashMessage(plan_message)
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
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${periods.length}, 1fr)`, gap: '1.5rem', minWidth: 0 }}>
        {periods.map((period) => (
          <div key={period.period_label}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {period.period_label}
            </div>
            <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem 0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }} />
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>{periodValueColumnLabel(period.period_label)}</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>Plan</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.35rem 0.5rem 0.35rem 0', color: 'var(--text)' }}>Billings</td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>
                    {period.billings_actual != null ? fmtK(period.billings_actual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>
                    {period.billings_plan != null ? fmtK(period.billings_plan) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtPct(period.billings_achievement_pct)}</td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0', color: period.billings_delta_k != null ? (period.billings_delta_k >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--text-muted)' }}>{fmtDeltaK(period.billings_delta_k)}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.35rem 0.5rem 0.35rem 0', color: 'var(--text)' }}>Collections</td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>
                    {period.collections_actual != null ? fmtK(period.collections_actual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>
                    {period.collections_plan != null ? fmtK(period.collections_plan) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtPct(period.collections_achievement_pct)}</td>
                  <td style={{ textAlign: 'right', padding: '0.35rem 0', color: period.collections_delta_k != null ? (period.collections_delta_k >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--text-muted)' }}>{fmtDeltaK(period.collections_delta_k)}</td>
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
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '0.35rem 0.5rem 0.35rem 0', color: 'var(--text)' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtK(row.mtd)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>
        {row.plan != null ? fmtK(row.plan) : '—'}
      </td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtPct(row.achievement_pct)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: deltaColor }}>{fmtDeltaK(row.delta_k)}</td>
      {showPipeCov && (
        <td style={{ textAlign: 'right', padding: '0.35rem 0', color: 'var(--text)' }}>
          {fmtPipeCoverage(pipeCoverage ?? null)}
        </td>
      )}
    </tr>
  )
}

/** Indented sub-row: value only in first data column, no plan/%/delta; optional empty pipe cov cell for alignment */
function MTDRowSub({ label, value, showPipeCov }: { label: string; value: number; showPipeCov?: boolean }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td
        style={{
          padding: '0.35rem 0.5rem 0.35rem 0',
          color: 'var(--text-muted)',
          paddingLeft: '1.25rem',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtK(value)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: 'var(--text-muted)' }}>—</td>
      {showPipeCov && (
        <td style={{ textAlign: 'right', padding: '0.35rem 0', color: 'var(--text-muted)' }}>—</td>
      )}
    </tr>
  )
}

function RenewalsMTDRow({
  label,
  row,
  asPct,
  deltaNeutral,
  deltaBadWhenPositive,
}: {
  label: string
  row: BookingsMTDRow
  asPct?: boolean
  /** Up for renewal: delta irrelevant (always 0), use neutral color */
  deltaNeutral?: boolean
  /** Churn/Contraction: higher than plan is bad → red when delta > 0 */
  deltaBadWhenPositive?: boolean
}) {
  const deltaColor =
    row.delta_k == null || deltaNeutral
      ? 'var(--text-muted)'
      : deltaBadWhenPositive
        ? (row.delta_k > 0 ? 'var(--negative)' : row.delta_k < 0 ? 'var(--positive)' : 'var(--text-muted)')
        : (row.delta_k >= 0 ? 'var(--positive)' : 'var(--negative)')
  const fmtVal = (n: number) => (asPct ? `${n.toFixed(1)}%` : fmtK(n))
  const fmtDelta = () => {
    if (row.delta_k == null) return '—'
    if (asPct) return (row.delta_k >= 0 ? '+' : '') + row.delta_k.toFixed(1) + ' pp'
    return fmtDeltaK(row.delta_k)
  }
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '0.35rem 0.5rem 0.35rem 0', color: 'var(--text)' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtVal(row.mtd)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>
        {row.plan != null ? fmtVal(row.plan) : '—'}
      </td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtPct(row.achievement_pct, asPct ? 1 : 0)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: deltaColor }}>{fmtDelta()}</td>
    </tr>
  )
}

function RenewalsMTDBlock({
  data,
  sheetSyncError,
}: {
  data: RenewalsMTDResponse
  sheetSyncError?: string | null
}) {
  const { two_months_ago, previous_month, current_mtd, qtd, plan_message } = data
  const periods: RenewalsMTDPeriod[] = [two_months_ago, previous_month, current_mtd, qtd]
  const planNote = sanitizePlanMessage(sheetSyncError) || sanitizePlanMessage(plan_message)
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
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${periods.length}, 1fr)`, gap: '1.5rem', minWidth: 0 }}>
          {periods.map((period, idx) => (
          <div key={period.period_label ?? idx}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {period.period_label ??
                (idx === 0 ? 'Two months ago' : idx === 1 ? 'Prev month' : idx === 2 ? 'MTD' : 'QTD')}
            </div>
            <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem 0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }} />
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>{periodValueColumnLabel(period.period_label)}</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>Plan</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                <RenewalsMTDRow label="Up for renewal" row={period.total} deltaNeutral />
                <RenewalsMTDRow label="Renewed" row={period.renewed} />
                <RenewalsMTDRow label="Open" row={period.open} />
                <RenewalsMTDRow label="Churn" row={period.churn} deltaBadWhenPositive />
                <RenewalsMTDRow label="Contraction" row={period.contraction} deltaBadWhenPositive />
                <RenewalsMTDRow label="Renewal rate" row={period.renewal_rate} asPct />
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  )
}
