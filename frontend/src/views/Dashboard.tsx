import { useEffect, useState } from 'react'
import {
  getDashboardKPI,
  getDashboardBookingsMTD,
  getDashboardRenewalsMTD,
  syncSalesforce,
  syncGoogleSheet,
  type DashboardKPI,
  type BookingsMTDResponse,
  type BookingsMTDRow,
  type BookingsPeriod,
  type RenewalsMTDResponse,
  type RenewalsMTDPeriod,
} from '../api'

const ARR_2026P_RANGE = 'ARR_Calculations_2026P!A1:ZZ1000'

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
  const [err, setErr] = useState<string | null>(null)
  const [bookingsErr, setBookingsErr] = useState<string | null>(null)
  const [renewalsErr, setRenewalsErr] = useState<string | null>(null)
  const [sheetSyncError, setSheetSyncError] = useState<string | null>(null)

  useEffect(() => {
    const fetchKpi = () => getDashboardKPI().then(setKpi).catch((e) => setErr(e.message))
    const fetchBookings = () =>
      getDashboardBookingsMTD()
        .then(setBookingsMTD)
        .catch((e) => setBookingsErr(e.message))
    const fetchRenewals = () =>
      getDashboardRenewalsMTD()
        .then(setRenewalsMTD)
        .catch((e) => setRenewalsErr(e.message))

    const runSyncAndFetch = () => {
      fetchKpi()
      fetchBookings()
      fetchRenewals()
    }

    const runInitialLoad = async () => {
      if (!hasAutoSyncedThisSession.current) {
        hasAutoSyncedThisSession.current = true
        syncSalesforce().catch(() => {})
        if (!hasSyncedSheetThisSession.current) {
          hasSyncedSheetThisSession.current = true
          // Sync plan sheet first so plan numbers load automatically on first open
          try {
            const res = await syncGoogleSheet(ARR_2026P_RANGE)
            if (!res.ok && res.error) setSheetSyncError(res.error)
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
      (bookingsMTD?.plan_message && /no snapshot|sync.*first/i.test(bookingsMTD.plan_message))
    if (!needsPlan) return
    hasRetriedPlanRefetch.current = true
    const t = setTimeout(() => {
      syncGoogleSheet(ARR_2026P_RANGE)
        .then((res) => {
          if (res.ok) {
            getDashboardBookingsMTD().then(setBookingsMTD).catch(() => {})
            getDashboardRenewalsMTD().then(setRenewalsMTD).catch(() => {})
          }
        })
        .catch(() => {})
    }, 800)
    return () => clearTimeout(t)
  }, [renewalsMTD?.plan_message, bookingsMTD?.plan_message])

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
        {/* Block 1: Bookings */}
        <div style={{ ...blockStyle, gridColumn: '1 / -1' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Bookings
          </div>
          {bookingsErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{bookingsErr}</p>
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
            Renewals
          </div>
          {renewalsErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{renewalsErr}</p>
          )}
          {!renewalsErr && renewalsMTD && (
            <RenewalsMTDBlock data={renewalsMTD} sheetSyncError={sheetSyncError} />
          )}
          {!renewalsErr && !renewalsMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

        {/* Block 3: Open pipeline */}
        <div style={blockStyle}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Open pipeline
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Coming soon</p>
        </div>

        {/* Block 4: Pipeline generation — placeholder */}
        <div style={blockStyle}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Pipeline generation
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Coming soon</p>
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
  const { previous_month, current_mtd, qtd, plan_message } = data
  const periods: BookingsPeriod[] = [previous_month, current_mtd, qtd]
  const planNote = sheetSyncError || plan_message
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
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>Δ $K</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>Pipe cov.</th>
                </tr>
              </thead>
              <tbody>
                <MTDRow label="Total" row={period.total} pipeCoverage={period.pipe_coverage_total ?? null} />
                <MTDRow label="New business" row={period.new_business} pipeCoverage={period.pipe_coverage_new_business ?? null} />
                <MTDRow label="Expansion" row={period.expansion} pipeCoverage={period.pipe_coverage_expansion ?? null} />
                <MTDRowSub label="Mid-term" value={period.expansion_mid_term ?? 0} />
                <MTDRowSub label="Upon renewal" value={period.expansion_upon_renewal ?? 0} />
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

function MTDRow({ label, row, pipeCoverage }: { label: string; row: BookingsMTDRow; pipeCoverage?: number | null }) {
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
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: 'var(--text)' }}>{fmtPipeCoverage(pipeCoverage ?? null)}</td>
    </tr>
  )
}

/** Indented sub-row: value only in first data column, no plan/%/delta/pipe coverage */
function MTDRowSub({ label, value }: { label: string; value: number }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '0.35rem 0.5rem 0.35rem 0', color: 'var(--text-muted)', paddingLeft: '1.25rem' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtK(value)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: 'var(--text-muted)' }}>—</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: 'var(--text-muted)' }}>—</td>
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
  const { previous_month, current_mtd, qtd, plan_message } = data
  const periods: RenewalsMTDPeriod[] = [previous_month, current_mtd, qtd]
  const planNote = sheetSyncError || plan_message
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
              {period.period_label ?? (idx === 0 ? 'Prev month' : idx === 1 ? 'MTD' : 'QTD')}
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
