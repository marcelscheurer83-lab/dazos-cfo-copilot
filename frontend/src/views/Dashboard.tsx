import { useEffect, useState } from 'react'
import {
  getDashboardKPI,
  getDashboardBookingsMTD,
  syncSalesforce,
  syncGoogleSheet,
  type DashboardKPI,
  type BookingsMTDResponse,
  type BookingsMTDRow,
  type BookingsPeriod,
} from '../api'

const ARR_2026P_RANGE = 'ARR_Calculations_2026P!A1:ZZ1000'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtDeltaK(deltaK: number | null | undefined): string {
  if (deltaK == null) return '—'
  const sign = deltaK >= 0 ? '+' : ''
  return `${sign}$${Math.round(deltaK)}K`
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return '—'
  return `${pct.toFixed(0)}%`
}

/** Sync from Salesforce and sheet at most once per app session (when Dashboard first loads). */
const hasAutoSyncedThisSession = { current: false }
const hasSyncedSheetThisSession = { current: false }

const blockStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '1rem 1.25rem',
}

export default function Dashboard() {
  const [kpi, setKpi] = useState<DashboardKPI | null>(null)
  const [bookingsMTD, setBookingsMTD] = useState<BookingsMTDResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [bookingsErr, setBookingsErr] = useState<string | null>(null)

  useEffect(() => {
    const fetchKpi = () => getDashboardKPI().then(setKpi).catch((e) => setErr(e.message))
    const fetchBookings = () =>
      getDashboardBookingsMTD()
        .then(setBookingsMTD)
        .catch((e) => setBookingsErr(e.message))

    const runSyncAndFetch = () => {
      fetchKpi()
      fetchBookings()
    }

    if (!hasAutoSyncedThisSession.current) {
      hasAutoSyncedThisSession.current = true
      // Sync Salesforce and plan sheet on first open, then fetch
      const afterSync = () => {
        if (!hasSyncedSheetThisSession.current) {
          hasSyncedSheetThisSession.current = true
          syncGoogleSheet(ARR_2026P_RANGE).finally(() => runSyncAndFetch())
        } else {
          runSyncAndFetch()
        }
      }
      syncSalesforce()
        .then(() => afterSync())
        .catch(() => afterSync())
    } else {
      runSyncAndFetch()
    }
  }, [])

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
        {/* Block 1: New business and expansion bookings */}
        <div style={{ ...blockStyle, gridColumn: '1 / -1' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            New business and expansion bookings (Closed Won)
          </div>
          {bookingsErr && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{bookingsErr}</p>
          )}
          {!bookingsErr && bookingsMTD && (
            <BookingsMTDBlock data={bookingsMTD} />
          )}
          {!bookingsErr && !bookingsMTD && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>
          )}
        </div>

        {/* Block 2: Renewals — placeholder */}
        <div style={blockStyle}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
            Renewals
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Coming soon</p>
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

function BookingsMTDBlock({ data }: { data: BookingsMTDResponse }) {
  const { previous_month, current_mtd, qtd, plan_message } = data
  const periods: BookingsPeriod[] = [previous_month, current_mtd, qtd]
  return (
    <>
      {plan_message && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{plan_message}</p>
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
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>MTD</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>Plan</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>%</th>
                  <th style={{ textAlign: 'right', padding: '0.25rem 0', fontWeight: 500, color: 'var(--text-muted)' }}>Δ $K</th>
                </tr>
              </thead>
              <tbody>
                <MTDRow label="Total" row={period.total} />
                <MTDRow label="New business" row={period.new_business} />
                <MTDRow label="Expansion" row={period.expansion} />
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  )
}

function MTDRow({ label, row }: { label: string; row: BookingsMTDRow }) {
  const deltaColor = row.delta_k != null ? (row.delta_k >= 0 ? 'var(--positive)' : 'var(--negative)') : 'var(--text-muted)'
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '0.35rem 0.5rem 0.35rem 0', color: 'var(--text)' }}>{label}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtMoney(row.mtd)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text-muted)' }}>
        {row.plan != null ? fmtMoney(row.plan) : '—'}
      </td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'var(--text)' }}>{fmtPct(row.achievement_pct)}</td>
      <td style={{ textAlign: 'right', padding: '0.35rem 0', color: deltaColor }}>{fmtDeltaK(row.delta_k)}</td>
    </tr>
  )
}
