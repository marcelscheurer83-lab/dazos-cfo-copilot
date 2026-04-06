import { useEffect, useState } from 'react'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Line,
} from 'recharts'
import {
  getForecastCurrentQuarter,
  ForecastResponse,
  ForecastMonthNB,
  ForecastMonthExp,
  ForecastMonthRenewal,
} from '../api'

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-')
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${MONTHS[parseInt(m) - 1]} '${y.slice(2)}`
}

function fmtK(n: number | null | undefined): string {
  if (n == null) return '–'
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000).toLocaleString('en-US')}K`
  return `$${Math.round(n)}`
}

function fmtDelta(forecast: number | null | undefined, target: number | null | undefined): string {
  if (forecast == null || target == null) return '–'
  const d = forecast - target
  const s = fmtK(Math.abs(d))
  return d >= 0 ? `+${s}` : `−${s}`
}

function deltaColor(forecast: number | null | undefined, target: number | null | undefined): string {
  if (forecast == null || target == null) return 'var(--text-muted)'
  return forecast >= target ? '#22c55e' : '#ef4444'
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '–'
  return `${n.toFixed(1)}%`
}

function fmtFull(n: number | null | undefined): string {
  if (n == null) return '–'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

// ── colours ───────────────────────────────────────────────────────────────────
const C_ACTUAL    = '#3b82f6'
const C_FORECAST  = '#a78bfa'
const C_TARGET    = '#f59e0b'

// ── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${highlight ? C_FORECAST : 'var(--border)'}`,
      borderRadius: 8,
      padding: '1rem 1.25rem',
      flex: '1 1 0',
      minWidth: 0,
      minHeight: 96,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.2rem',
      boxSizing: 'border-box',
    }}>
      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.3 }}>
        {label}
      </span>
      <span style={{ fontSize: '1.75rem', fontWeight: 700, color: highlight ? C_FORECAST : 'var(--text)', textAlign: 'center' }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center' }}>{sub}</span>}
    </div>
  )
}

// ── bookings bar chart ────────────────────────────────────────────────────────
type BookingsChartEntry = { month: string; actuals: number; pipeline_weighted: number; target: number | null }

function BookingsChart({ data, title }: { data: BookingsChartEntry[]; title: string }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} tickFormatter={fmtMonth} />
          <YAxis yAxisId="left" tickFormatter={v => fmtK(v)} tick={{ fontSize: 12 }} width={68} />
          <Tooltip formatter={(v: any) => fmtFull(v)} labelFormatter={(lbl: any) => fmtMonth(lbl)} />
          <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="left" dataKey="actuals" name="Actuals" fill={C_ACTUAL} stackId="a" />
          <Bar yAxisId="left" dataKey="pipeline_weighted" name="Pipeline (weighted)" fill={C_FORECAST} stackId="a" />
          <Line yAxisId="left" dataKey="target" name="Target" stroke={C_TARGET} strokeWidth={2} dot={{ r: 4 }} strokeDasharray="4 3" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── renewals bar chart ────────────────────────────────────────────────────────
type RenewalsChartEntry = { month: string; due_arr: number; won_arr: number; pipeline_weighted: number }

function RenewalsChart({ data }: { data: RenewalsChartEntry[] }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>Up for renewal vs. renewed + pipeline</p>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} tickFormatter={fmtMonth} />
          <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 12 }} width={68} />
          <ReferenceLine y={0} stroke="#555" />
          <Tooltip formatter={(v: any) => fmtFull(v)} labelFormatter={(lbl: any) => fmtMonth(lbl)} />
          <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="due_arr" name="Due for Renewal" fill="#64748b" opacity={0.5} />
          <Bar dataKey="won_arr" name="Won" fill={C_ACTUAL} />
          <Bar dataKey="pipeline_weighted" name="Pipeline (weighted)" fill={C_FORECAST} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── detail table ──────────────────────────────────────────────────────────────
const TH: React.CSSProperties = {
  padding: '0.45rem 0.75rem',
  fontWeight: 600,
  fontSize: '0.78rem',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  textAlign: 'right',
  borderBottom: '2px solid var(--border)',
  whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  fontSize: '0.85rem',
  textAlign: 'right',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}
const TD_LABEL: React.CSSProperties = { ...TD, textAlign: 'left', fontWeight: 500 }
const TD_BOLD: React.CSSProperties = { ...TD, fontWeight: 700 }
const TD_LABEL_BOLD: React.CSSProperties = { ...TD_LABEL, fontWeight: 700 }

type ForecastTableSection = 'bookings' | 'renewals'

interface BookingsTableProps {
  months: string[]
  nb: ForecastMonthNB[]
  exp: ForecastMonthExp[]
  quarter: ForecastQuarterTotals_
}
interface ForecastQuarterTotals_ {
  nb_actuals: number; nb_forecast: number; nb_target: number | null
  exp_actuals: number; exp_forecast: number; exp_target: number | null
  total_actuals: number; total_forecast: number
}

function BookingsTable({ months, nb, exp, quarter }: BookingsTableProps) {
  const colLabel = 'Quarter'
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ ...TH, textAlign: 'left' }}>Bookings</th>
          {months.map(mk => <th key={mk} style={TH}>{fmtMonth(mk)}</th>)}
          <th style={{ ...TH, borderLeft: '2px solid var(--border)' }}>{colLabel}</th>
        </tr>
      </thead>
      <tbody>
        {/* New Business */}
        <tr>
          <td style={{ ...TD_LABEL, color: 'var(--text-muted)', fontSize: '0.72rem', paddingTop: '0.6rem' }} colSpan={months.length + 2}>
            NEW BUSINESS
          </td>
        </tr>
        <tr>
          <td style={TD_LABEL}>Actuals</td>
          {nb.map(m => <td key={m.month} style={TD}>{fmtK(m.actuals)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)' }}>{fmtK(quarter.nb_actuals)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL}>Pipeline (weighted)</td>
          {nb.map(m => <td key={m.month} style={{ ...TD, color: C_FORECAST }}>{fmtK(m.pipeline_weighted)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.nb_forecast - quarter.nb_actuals)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL_BOLD}>Forecast</td>
          {nb.map(m => <td key={m.month} style={{ ...TD_BOLD, color: C_FORECAST }}>{fmtK(m.forecast)}</td>)}
          <td style={{ ...TD_BOLD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.nb_forecast)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: C_TARGET }}>Target</td>
          {nb.map(m => <td key={m.month} style={{ ...TD, color: C_TARGET }}>{fmtK(m.target)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_TARGET }}>{fmtK(quarter.nb_target)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: 'var(--text-muted)' }}>Delta to Target</td>
          {nb.map(m => <td key={m.month} style={{ ...TD, color: deltaColor(m.forecast, m.target) }}>{fmtDelta(m.forecast, m.target)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: deltaColor(quarter.nb_forecast, quarter.nb_target) }}>{fmtDelta(quarter.nb_forecast, quarter.nb_target)}</td>
        </tr>

        {/* Expansion */}
        <tr>
          <td style={{ ...TD_LABEL, color: 'var(--text-muted)', fontSize: '0.72rem', paddingTop: '0.8rem' }} colSpan={months.length + 2}>
            EXPANSION
          </td>
        </tr>
        <tr>
          <td style={TD_LABEL}>Actuals</td>
          {exp.map(m => <td key={m.month} style={TD}>{fmtK(m.actuals)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)' }}>{fmtK(quarter.exp_actuals)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL}>Pipeline (weighted)</td>
          {exp.map(m => <td key={m.month} style={{ ...TD, color: C_FORECAST }}>{fmtK(m.pipeline_weighted)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.exp_forecast - quarter.exp_actuals)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL_BOLD}>Forecast</td>
          {exp.map(m => <td key={m.month} style={{ ...TD_BOLD, color: C_FORECAST }}>{fmtK(m.forecast)}</td>)}
          <td style={{ ...TD_BOLD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.exp_forecast)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: C_TARGET }}>Target</td>
          {exp.map(m => <td key={m.month} style={{ ...TD, color: C_TARGET }}>{fmtK(m.target)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_TARGET }}>{fmtK(quarter.exp_target)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: 'var(--text-muted)' }}>Delta to Target</td>
          {exp.map(m => <td key={m.month} style={{ ...TD, color: deltaColor(m.forecast, m.target) }}>{fmtDelta(m.forecast, m.target)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: deltaColor(quarter.exp_forecast, quarter.exp_target) }}>{fmtDelta(quarter.exp_forecast, quarter.exp_target)}</td>
        </tr>

        {/* Total */}
        <tr style={{ borderTop: '2px solid var(--border)' }}>
          <td style={{ ...TD_LABEL_BOLD, paddingTop: '0.5rem' }}>Total Bookings Actuals</td>
          {months.map((mk, i) => <td key={mk} style={{ ...TD_BOLD, paddingTop: '0.5rem' }}>{fmtK((nb[i]?.actuals ?? 0) + (exp[i]?.actuals ?? 0))}</td>)}
          <td style={{ ...TD_BOLD, borderLeft: '2px solid var(--border)', paddingTop: '0.5rem' }}>{fmtK(quarter.total_actuals)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL_BOLD, color: C_FORECAST }}>Total Bookings Forecast</td>
          {months.map((mk, i) => <td key={mk} style={{ ...TD_BOLD, color: C_FORECAST }}>{fmtK((nb[i]?.forecast ?? 0) + (exp[i]?.forecast ?? 0))}</td>)}
          <td style={{ ...TD_BOLD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.total_forecast)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: C_TARGET }}>Total Bookings Target</td>
          {months.map((mk, i) => {
            const t = (nb[i]?.target != null && exp[i]?.target != null) ? (nb[i].target! + exp[i].target!) : null
            return <td key={mk} style={{ ...TD, color: C_TARGET }}>{fmtK(t)}</td>
          })}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_TARGET }}>
            {fmtK((quarter.nb_target != null && quarter.exp_target != null) ? quarter.nb_target + quarter.exp_target : null)}
          </td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: 'var(--text-muted)' }}>Total Delta to Target</td>
          {months.map((mk, i) => {
            const t = (nb[i]?.target != null && exp[i]?.target != null) ? (nb[i].target! + exp[i].target!) : null
            const f = (nb[i]?.forecast ?? 0) + (exp[i]?.forecast ?? 0)
            return <td key={mk} style={{ ...TD, color: deltaColor(f, t) }}>{fmtDelta(f, t)}</td>
          })}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: deltaColor(
            quarter.total_forecast,
            (quarter.nb_target != null && quarter.exp_target != null) ? quarter.nb_target + quarter.exp_target : null
          )}}>
            {fmtDelta(quarter.total_forecast, (quarter.nb_target != null && quarter.exp_target != null) ? quarter.nb_target + quarter.exp_target : null)}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

interface RenewalsTableProps {
  months: string[]
  renewals: ForecastMonthRenewal[]
  quarter: {
    renewal_due: number; renewal_won: number; renewal_forecast: number
    rate_actual: number | null; rate_forecast: number | null; rate_target: number | null
  }
}

function RenewalsTable({ months, renewals, quarter }: RenewalsTableProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ ...TH, textAlign: 'left' }}>Renewals</th>
          {months.map(mk => <th key={mk} style={TH}>{fmtMonth(mk)}</th>)}
          <th style={{ ...TH, borderLeft: '2px solid var(--border)' }}>Quarter</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={TD_LABEL}>Up for Renewal</td>
          {renewals.map(m => <td key={m.month} style={TD}>{fmtK(m.due_arr)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)' }}>{fmtK(quarter.renewal_due)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL}>Renewed</td>
          {renewals.map(m => <td key={m.month} style={TD}>{fmtK(m.won_arr)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)' }}>{fmtK(quarter.renewal_won)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL}>Pipeline (weighted)</td>
          {renewals.map(m => <td key={m.month} style={{ ...TD, color: C_FORECAST }}>{fmtK(m.pipeline_weighted)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.renewal_forecast - quarter.renewal_won)}</td>
        </tr>
        <tr>
          <td style={TD_LABEL_BOLD}>Forecast Renewed</td>
          {renewals.map(m => <td key={m.month} style={{ ...TD_BOLD, color: C_FORECAST }}>{fmtK(m.forecast_arr)}</td>)}
          <td style={{ ...TD_BOLD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtK(quarter.renewal_forecast)}</td>
        </tr>
        <tr style={{ borderTop: '1px solid var(--border)' }}>
          <td style={TD_LABEL}>Renewal Rate Actual</td>
          {renewals.map(m => <td key={m.month} style={TD}>{fmtPct(m.rate_actual)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)' }}>{fmtPct(quarter.rate_actual)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: C_FORECAST }}>Renewal Rate Forecast</td>
          {renewals.map(m => <td key={m.month} style={{ ...TD, color: C_FORECAST }}>{fmtPct(m.rate_forecast)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_FORECAST }}>{fmtPct(quarter.rate_forecast)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: C_TARGET }}>Renewal Rate Target</td>
          {renewals.map(m => <td key={m.month} style={{ ...TD, color: C_TARGET }}>{fmtPct(m.rate_target)}</td>)}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: C_TARGET }}>{fmtPct(quarter.rate_target)}</td>
        </tr>
        <tr>
          <td style={{ ...TD_LABEL, color: 'var(--text-muted)' }}>Delta to Target (rate)</td>
          {renewals.map(m => {
            const d = m.rate_forecast != null && m.rate_target != null ? m.rate_forecast - m.rate_target : null
            const color = d == null ? 'var(--text-muted)' : d >= 0 ? '#22c55e' : '#ef4444'
            const label = d == null ? '–' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} ppt`
            return <td key={m.month} style={{ ...TD, color }}>{label}</td>
          })}
          <td style={{ ...TD, borderLeft: '2px solid var(--border)', color: (() => {
            const d = quarter.rate_forecast != null && quarter.rate_target != null ? quarter.rate_forecast - quarter.rate_target : null
            return d == null ? 'var(--text-muted)' : d >= 0 ? '#22c55e' : '#ef4444'
          })() }}>
            {(() => {
              const d = quarter.rate_forecast != null && quarter.rate_target != null ? quarter.rate_forecast - quarter.rate_target : null
              return d == null ? '–' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} ppt`
            })()}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

// ── weights legend ────────────────────────────────────────────────────────────
const BOOKING_WEIGHTS = [
  { label: 'Commit', weight: '90%' },
  { label: 'Best Case', weight: '60%' },
  { label: 'Upside', weight: '25%' },
]
const RENEWAL_WEIGHTS = [
  { label: 'Positive Outlook', weight: '90%' },
  { label: 'Neutral', weight: '70%' },
  { label: 'At Risk', weight: '10%' },
  { label: 'Intent to Churn', weight: '0%' },
]

function WeightLegend({ title, weights }: { title: string; weights: { label: string; weight: string }[] }) {
  return (
    <div style={{ display: 'inline-block', marginRight: '2rem', verticalAlign: 'top' }}>
      <p style={{ margin: '0 0 0.25rem', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{title}</p>
      {weights.map(w => (
        <p key={w.label} style={{ margin: '0.1rem 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--text)' }}>{w.label}</span> → {w.weight}
        </p>
      ))}
    </div>
  )
}

// ── ForecastView ──────────────────────────────────────────────────────────────
export default function ForecastView() {
  const [data, setData] = useState<ForecastResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<ForecastTableSection>('bookings')

  useEffect(() => {
    getForecastCurrentQuarter()
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading forecast…</div>
  if (error)   return <div style={{ color: '#ef4444' }}>Error: {error}</div>
  if (!data)   return null

  const { quarter, months, new_business: nb, expansion: exp, renewals, quarter_totals: qt } = data

  // ── KPI cards ─────────────────────────────────────────────────────────────
  const totalBookingsForecast = qt.total_forecast
  const totalBookingsTarget   = (qt.nb_target != null && qt.exp_target != null) ? qt.nb_target + qt.exp_target : null
  const pctOfTarget = (totalBookingsTarget && totalBookingsForecast)
    ? `${((totalBookingsForecast / totalBookingsTarget) * 100).toFixed(0)}% of target`
    : undefined

  // ── chart data ────────────────────────────────────────────────────────────
  const nbChartData: BookingsChartEntry[] = nb.map(m => ({
    month: m.month, actuals: m.actuals, pipeline_weighted: m.pipeline_weighted, target: m.target,
  }))
  const expChartData: BookingsChartEntry[] = exp.map(m => ({
    month: m.month, actuals: m.actuals, pipeline_weighted: m.pipeline_weighted, target: m.target,
  }))
  const renewChartData: RenewalsChartEntry[] = renewals.map(m => ({
    month: m.month, due_arr: m.due_arr, won_arr: m.won_arr, pipeline_weighted: m.pipeline_weighted,
  }))

  return (
    <div>
      <h1 style={{ margin: '0 0 1.25rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
        Current Forecast
      </h1>

      {/* KPI row */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem' }}>
        <KpiCard label="Total Bookings Actuals" value={fmtK(qt.total_actuals)} sub={`${quarter} QTD`} />
        <KpiCard label="Total Bookings Forecast" value={fmtK(qt.total_forecast)} sub={pctOfTarget} highlight />
        {totalBookingsTarget != null && <KpiCard label="Total Bookings Target" value={fmtK(totalBookingsTarget)} sub={quarter} />}
        <KpiCard label="Renewal Rate Actual"   value={fmtPct(qt.rate_actual)}   sub={`${quarter} QTD`} />
        <KpiCard label="Renewal Rate Forecast"  value={fmtPct(qt.rate_forecast)} sub={quarter} highlight />
        {qt.rate_target != null && <KpiCard label="Renewal Rate Target" value={fmtPct(qt.rate_target)} sub={quarter} />}
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
        <div>
          <BookingsChart data={nbChartData} title="New Business" />
        </div>
        <div>
          <BookingsChart data={expChartData} title="Expansion" />
        </div>
        <div>
          <RenewalsChart data={renewChartData} />
        </div>
      </div>

      {/* Table toggle */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {(['bookings', 'renewals'] as ForecastTableSection[]).map(s => (
          <button
            key={s}
            onClick={() => setSection(s)}
            style={{
              padding: '0.3rem 0.85rem',
              fontSize: '0.85rem',
              borderRadius: 6,
              border: '1px solid var(--border)',
              cursor: 'pointer',
              background: section === s ? 'var(--accent)' : 'var(--surface)',
              color: section === s ? '#fff' : 'var(--text)',
              fontWeight: section === s ? 600 : 400,
            }}
          >
            {s === 'bookings' ? 'Bookings' : 'Renewals'}
          </button>
        ))}
      </div>

      {/* Detail table */}
      <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
        {section === 'bookings' && (
          <BookingsTable months={months} nb={nb} exp={exp} quarter={qt} />
        )}
        {section === 'renewals' && (
          <RenewalsTable months={months} renewals={renewals} quarter={qt} />
        )}
      </div>

      {/* Pipeline weights */}
      <div style={{
        borderTop: '1px solid var(--border)',
        paddingTop: '1rem',
        marginTop: '0.5rem',
      }}>
      <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
        Pipeline weights
      </p>
      <WeightLegend title="New Business & Expansion" weights={BOOKING_WEIGHTS} />
      <WeightLegend title="Renewals" weights={RENEWAL_WEIGHTS} />
      </div>
    </div>
  )
}
