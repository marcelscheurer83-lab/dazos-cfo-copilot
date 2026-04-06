import { useEffect, useState } from 'react'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Line,
} from 'recharts'
import {
  getForecastCurrentQuarter,
  getAIForecastCurrentQuarter,
  triggerAIRescore,
  ForecastResponse,
  ForecastMonthNB,
  ForecastMonthExp,
  ForecastMonthRenewal,
  AIForecastResponse,
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

function fmtDelta(d: number | null | undefined): string {
  if (d == null) return '–'
  const s = fmtK(Math.abs(d))
  return d >= 0 ? `+${s}` : `−${s}`
}

function deltaColor(d: number | null | undefined): string {
  if (d == null) return 'var(--text-muted)'
  return d >= 0 ? '#22c55e' : '#ef4444'
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
const C_ACTUAL   = '#e2e8f0'
const C_FORECAST = '#a78bfa'
const C_TARGET   = '#f59e0b'
const C_IQ       = '#7c3aed'
const C_AI       = '#38bdf8'

// ── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${highlight ? C_FORECAST : 'var(--border)'}`,
      borderRadius: 8,
      padding: '0.85rem 1rem',
      flex: '1 1 0',
      minWidth: 0,
      minHeight: 88,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.15rem',
      boxSizing: 'border-box',
    }}>
      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.3 }}>
        {label}
      </span>
      <span style={{ fontSize: '1.5rem', fontWeight: 700, color: highlight ? C_FORECAST : 'var(--text)', textAlign: 'center' }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center' }}>{sub}</span>}
    </div>
  )
}

// ── bookings bar chart ────────────────────────────────────────────────────────
type BookingsChartEntry = {
  month: string
  actuals: number
  pipeline_weighted: number
  pipeline_ai_weighted: number
  in_quarter_est: number
  adjusted_forecast: number
  target: number | null
  has_ai_scores: boolean
}

function BookingsChart({ data, title }: { data: BookingsChartEntry[]; title: string }) {
  const hasAI = data.some(d => d.has_ai_scores)
  return (
    <div style={{ marginBottom: '1rem' }}>
      <p style={{ margin: '0 0 0.4rem', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={fmtMonth} />
          <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 11 }} width={58} />
          <Tooltip formatter={(v: any) => fmtFull(v)} labelFormatter={(lbl: any) => fmtMonth(lbl)} />
          <Legend iconType="square" wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="actuals" name="Actuals" fill={C_ACTUAL} stackId="a" />
          <Bar dataKey={hasAI ? 'pipeline_ai_weighted' : 'pipeline_weighted'} name={hasAI ? 'Pipeline (AI)' : 'Pipeline (weighted)'} fill={hasAI ? C_AI : C_FORECAST} stackId="a" />
          {data.some(d => (d.in_quarter_est ?? 0) > 0) && (
            <Bar dataKey="in_quarter_est" name="In-quarter est." fill={C_IQ} stackId="a" />
          )}
          <Line dataKey="target" name="Target" stroke={C_TARGET} strokeWidth={2} dot={{ r: 3 }} strokeDasharray="4 3" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── renewals ARR bar chart ────────────────────────────────────────────────────
type RenewalsChartEntry = { month: string; due_arr: number; won_arr: number; pipeline_weighted: number }

function RenewalsChart({ data }: { data: RenewalsChartEntry[] }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <p style={{ margin: '0 0 0.4rem', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>Up for renewal vs. won + pipeline</p>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={fmtMonth} />
          <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 11 }} width={58} />
          <ReferenceLine y={0} stroke="#555" />
          <Tooltip formatter={(v: any) => fmtFull(v)} labelFormatter={(lbl: any) => fmtMonth(lbl)} />
          <Legend iconType="square" wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="due_arr" name="Up for Renewal" fill="#64748b" opacity={0.5} />
          <Bar dataKey="won_arr" name="Renewed" fill={C_ACTUAL} stackId="b" />
          <Bar dataKey="pipeline_weighted" name="Pipeline (weighted)" fill={C_AI} stackId="b" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── renewal rate chart ────────────────────────────────────────────────────────
type RenewalRateChartEntry = { month: string; rate_actual: number | null; rate_forecast: number | null; rate_target: number | null }

function RenewalRateChart({ data }: { data: RenewalRateChartEntry[] }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <p style={{ margin: '0 0 0.4rem', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>Renewal rate: actual vs. forecast vs. target</p>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={fmtMonth} />
          <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} width={46} domain={[0, 100]} />
          <Tooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} labelFormatter={(lbl: any) => fmtMonth(lbl)} />
          <Legend iconType="square" wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="rate_actual" name="Actual rate" fill={C_ACTUAL} />
          <Bar dataKey="rate_forecast" name="Forecast rate" fill={C_AI} />
          <Line dataKey="rate_target" name="Target rate" stroke={C_TARGET} strokeWidth={2} dot={{ r: 3 }} strokeDasharray="4 3" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── shared table styles ───────────────────────────────────────────────────────
const TH: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  fontWeight: 600,
  fontSize: '0.75rem',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  textAlign: 'right',
  borderBottom: '2px solid var(--border)',
  whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  fontSize: '0.82rem',
  textAlign: 'right',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  height: 36,
  boxSizing: 'border-box',
}
const TD_LABEL: React.CSSProperties = { ...TD, textAlign: 'left', fontWeight: 500 }
const TD_BOLD:  React.CSSProperties = { ...TD, fontWeight: 700 }
const TD_LABEL_BOLD: React.CSSProperties = { ...TD_LABEL, fontWeight: 700 }

// ── BookingsCard ──────────────────────────────────────────────────────────────
interface BookingsCardRow {
  label: string
  color?: string
  bold?: boolean
  isDelta?: boolean
  monthValues: (number | null)[]
  quarterValue: number | null
  isTopBorder?: boolean
}

function BookingsCard({ title, months, rows }: { title: string; months: string[]; rows: BookingsCardRow[] }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: '0.75rem' }}>
      <div style={{ padding: '0.5rem 0.6rem', borderBottom: '2px solid var(--border)' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...TH, textAlign: 'left', width: '36%' }}></th>
            {months.map(mk => <th key={mk} style={TH}>{fmtMonth(mk)}</th>)}
            <th style={{ ...TH, borderLeft: '2px solid var(--border)' }}>Quarter</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={row.isTopBorder ? { borderTop: '2px solid var(--border)' } : {}}>
              <td style={{ ...TD_LABEL, ...(row.bold ? { fontWeight: 700 } : {}), color: row.isDelta ? 'var(--text-muted)' : (row.color ?? 'var(--text)') }}>
                {row.label}
              </td>
              {row.monthValues.map((v, j) => {
                const cellColor = row.isDelta ? deltaColor(v) : (row.color ?? 'inherit')
                const display   = row.isDelta ? fmtDelta(v) : (v != null ? fmtK(v) : '–')
                return (
                  <td key={j} style={{ ...TD, ...(row.bold ? { fontWeight: 700 } : {}), color: cellColor }}>
                    {display}
                  </td>
                )
              })}
              <td style={{ ...TD, ...(row.bold ? { fontWeight: 700 } : {}), color: row.isDelta ? deltaColor(row.quarterValue) : (row.color ?? 'inherit'), borderLeft: '2px solid var(--border)' }}>
                {row.isDelta ? fmtDelta(row.quarterValue) : (row.quarterValue != null ? fmtK(row.quarterValue) : '–')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface BookingsCardsProps {
  months: string[]
  nb: ForecastMonthNB[]
  exp: ForecastMonthExp[]
  qt: {
    nb_actuals: number; nb_forecast: number; nb_forecast_ai: number; nb_in_quarter_est: number; nb_adjusted_forecast: number; nb_target: number | null
    exp_actuals: number; exp_forecast: number; exp_forecast_ai: number; exp_in_quarter_est: number; exp_adjusted_forecast: number; exp_target: number | null
    total_actuals: number; total_forecast: number; total_forecast_ai: number; total_in_quarter_est: number; total_adjusted_forecast: number
    has_ai_scores: boolean
  }
  quartersUsed: number
}

function BookingsCards({ months, nb, exp, qt, quartersUsed }: BookingsCardsProps) {
  const iqLabel = quartersUsed > 0 ? `In-quarter (hist. est., ${quartersUsed}Q avg)` : 'In-quarter (hist. est.)'
  const hasAI = qt.has_ai_scores
  const C = C_AI

  function makeRows(
    actuals: number[], pipeline: number[], inQ: number[],
    qActuals: number, qPipeline: number, qInQ: number,
    targets: (number | null)[], qTarget: number | null,
  ): BookingsCardRow[] {
    const forecasts = actuals.map((a, i) => a + pipeline[i] + inQ[i])
    const qForecast = qActuals + qPipeline + qInQ
    return [
      { label: 'Actuals',                                                           color: 'var(--text)', monthValues: actuals,   quarterValue: qActuals },
      { label: hasAI ? 'Pipeline (AI weighted)' : 'Pipeline (weighted)',            color: C,             monthValues: pipeline,  quarterValue: qPipeline },
      ...(inQ.some(v => v > 0) ? [{ label: iqLabel, color: C_IQ, monthValues: inQ.map(v => v > 0 ? v : null), quarterValue: qInQ > 0 ? qInQ : null } as BookingsCardRow] : []),
      { label: 'Forecast', bold: true, color: C, isTopBorder: true,                                      monthValues: forecasts, quarterValue: qForecast },
      { label: 'Target',                                                             color: C_TARGET,      monthValues: targets,   quarterValue: qTarget },
      { label: 'Delta to Target', isDelta: true,                                                          monthValues: forecasts.map((f, i) => targets[i] != null ? f - targets[i]! : null), quarterValue: qTarget != null ? qForecast - qTarget : null },
    ]
  }

  const nbPipe  = nb.map(m => hasAI ? m.pipeline_ai_weighted : m.pipeline_weighted)
  const expPipe = exp.map(m => hasAI ? m.pipeline_ai_weighted : m.pipeline_weighted)
  const nbInQ   = nb.map(m => m.in_quarter_est > 0 ? m.in_quarter_est : 0)
  const expInQ  = exp.map(m => m.in_quarter_est > 0 ? m.in_quarter_est : 0)

  const qNbPipe  = hasAI ? qt.nb_forecast_ai  - qt.nb_actuals  : qt.nb_forecast  - qt.nb_actuals
  const qExpPipe = hasAI ? qt.exp_forecast_ai - qt.exp_actuals : qt.exp_forecast - qt.exp_actuals

  const totalTarget = (qt.nb_target != null && qt.exp_target != null) ? qt.nb_target + qt.exp_target : null
  const totPipe    = nb.map((_m, i) => nbPipe[i] + expPipe[i])
  const totInQ     = nb.map((_, i) => nbInQ[i] + expInQ[i])
  const totActuals = nb.map((m, i) => m.actuals + (exp[i]?.actuals ?? 0))
  const totTargets = nb.map((_m, i) => nb[i]?.target != null && exp[i]?.target != null ? nb[i].target! + exp[i].target! : null)

  return (
    <>
      <BookingsCard title="New Business" months={months} rows={makeRows(
        nb.map(m => m.actuals), nbPipe, nbInQ,
        qt.nb_actuals, qNbPipe, qt.nb_in_quarter_est,
        nb.map(m => m.target), qt.nb_target,
      )} />
      <BookingsCard title="Expansion" months={months} rows={makeRows(
        exp.map(m => m.actuals), expPipe, expInQ,
        qt.exp_actuals, qExpPipe, qt.exp_in_quarter_est,
        exp.map(m => m.target), qt.exp_target,
      )} />
      <BookingsCard title="Total Bookings" months={months} rows={makeRows(
        totActuals, totPipe, totInQ,
        qt.total_actuals, qNbPipe + qExpPipe, qt.total_in_quarter_est,
        totTargets, totalTarget,
      )} />
    </>
  )
}

// ── RenewalsCard (card-style, matching BookingsCard) ─────────────────────────
interface RenewalsCardProps {
  months: string[]
  renewals: ForecastMonthRenewal[]
  quarter: {
    renewal_due: number; renewal_won: number; renewal_forecast: number
    rate_actual: number | null; rate_forecast: number | null; rate_target: number | null
  }
}

function RenewalsCard({ months, renewals, quarter }: RenewalsCardProps) {
  const pipelineQ = quarter.renewal_forecast - quarter.renewal_won

  function rateRow(label: string, key: 'rate_actual' | 'rate_forecast' | 'rate_target', color: string, bold?: boolean) {
    const qVal = quarter[key]
    return (
      <tr key={label}>
        <td style={{ ...TD_LABEL, ...(bold ? { fontWeight: 700 } : {}), color }}>{label}</td>
        {renewals.map(m => (
          <td key={m.month} style={{ ...TD, ...(bold ? { fontWeight: 700 } : {}), color }}>{fmtPct(m[key])}</td>
        ))}
        <td style={{ ...TD, ...(bold ? { fontWeight: 700 } : {}), color, borderLeft: '2px solid var(--border)' }}>{fmtPct(qVal)}</td>
      </tr>
    )
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: '0.75rem' }}>
      <div style={{ padding: '0.5rem 0.6rem', borderBottom: '2px solid var(--border)' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Renewals</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...TH, textAlign: 'left', width: '36%' }}></th>
            {months.map(mk => <th key={mk} style={TH}>{fmtMonth(mk)}</th>)}
            <th style={{ ...TH, borderLeft: '2px solid var(--border)' }}>Quarter</th>
          </tr>
        </thead>
        <tbody>
          {/* ARR rows */}
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
            <td style={{ ...TD_LABEL, color: C_AI }}>Pipeline (weighted)</td>
            {renewals.map(m => <td key={m.month} style={{ ...TD, color: C_AI }}>{fmtK(m.pipeline_weighted)}</td>)}
            <td style={{ ...TD, color: C_AI, borderLeft: '2px solid var(--border)' }}>{fmtK(pipelineQ)}</td>
          </tr>
          <tr style={{ borderTop: '2px solid var(--border)' }}>
            <td style={{ ...TD_LABEL_BOLD, color: C_AI }}>Forecast Renewed</td>
            {renewals.map(m => <td key={m.month} style={{ ...TD_BOLD, color: C_AI }}>{fmtK(m.forecast_arr)}</td>)}
            <td style={{ ...TD_BOLD, color: C_AI, borderLeft: '2px solid var(--border)' }}>{fmtK(quarter.renewal_forecast)}</td>
          </tr>

          {/* Rate rows — visually separated */}
          <tr style={{ borderTop: '2px solid var(--border)' }}>
            <td style={TD_LABEL}>Renewal Rate Actual</td>
            {renewals.map(m => <td key={m.month} style={TD}>{fmtPct(m.rate_actual)}</td>)}
            <td style={{ ...TD, borderLeft: '2px solid var(--border)' }}>{fmtPct(quarter.rate_actual)}</td>
          </tr>
          {rateRow('Renewal Rate Forecast', 'rate_forecast', C_AI, true)}
          {rateRow('Renewal Rate Target',   'rate_target',   C_TARGET)}
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
    </div>
  )
}

// ── AI Forecast Panel ─────────────────────────────────────────────────────────
function fmtPct2(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(0)}%`
}

function AIForecastPanel({ aiData, onRescore }: { aiData: AIForecastResponse | null; onRescore: () => void }) {
  const [rescoring, setRescoring] = useState(false)
  const [rescoreMsg, setRescoreMsg] = useState<string | null>(null)

  const handleRescore = async () => {
    setRescoring(true)
    setRescoreMsg(null)
    try {
      const r = await triggerAIRescore()
      setRescoreMsg(r.ok ? `Scored ${r.scored ?? 0} deals.` : (r.error ?? 'Failed'))
      if (r.ok) onRescore()
    } catch (e: unknown) {
      setRescoreMsg(e instanceof Error ? e.message : 'Error')
    } finally {
      setRescoring(false)
    }
  }

  const noScores = !aiData || aiData.total_scored_deals === 0

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', marginTop: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
          Dazos Forecast Agent
        </p>
        {aiData?.last_scored_at && (
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Last scored: {new Date(aiData.last_scored_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
            {' · '}{aiData.total_scored_deals} deals
          </span>
        )}
        <button
          onClick={handleRescore}
          disabled={rescoring}
          style={{
            padding: '0.25rem 0.75rem', fontSize: '0.78rem', borderRadius: 5,
            border: '1px solid var(--border)', cursor: rescoring ? 'not-allowed' : 'pointer',
            background: 'var(--surface)', color: 'var(--text-muted)',
          }}
        >
          {rescoring ? 'Scoring…' : 'Run AI Scoring'}
        </button>
        {rescoreMsg && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{rescoreMsg}</span>}
      </div>

      {noScores ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
          No AI scores yet. Set <code>OPENAI_API_KEY</code> in <code>backend/.env</code> and click "Run AI Scoring",
          or enable nightly scoring with <code>ENABLE_AI_FORECAST_SCORING=1</code>.
        </p>
      ) : (
        <>
          {/* Summary table + Observations side-by-side */}
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ overflowX: 'auto', flexShrink: 0 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem', color: 'var(--text)', minWidth: 340 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '0.4rem 0.75rem', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Month</th>
                    <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500 }}>AI Forecast</th>
                    <th style={{ padding: '0.4rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500 }}>Deals scored</th>
                  </tr>
                </thead>
                <tbody>
                  {(aiData?.month_data ?? []).map(m => (
                    <tr key={m.month} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.4rem 0.75rem' }}>{fmtMonth(m.month)}</td>
                      <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', color: C_AI, fontWeight: 600 }}>{fmtK(m.ai_forecast)}</td>
                      <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>{m.scored_deal_count} / {m.deal_count}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
                    <td style={{ padding: '0.4rem 0.75rem' }}>Quarter total</td>
                    <td style={{ padding: '0.4rem 0.75rem', textAlign: 'right', color: C_AI }}>{fmtK(aiData?.total_ai_forecast ?? 0)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Observations card */}
            {(aiData?.observations ?? []).length > 0 && (
              <div style={{
                flex: 1,
                minWidth: 260,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.85rem 1rem',
              }}>
                <p style={{ margin: '0 0 0.6rem 0', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                  Observations
                </p>
                <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  {(aiData?.observations ?? []).map((obs, i) => (
                    <li key={i} style={{ fontSize: '0.83rem', color: 'var(--text)', lineHeight: 1.55 }}>
                      {obs}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {(aiData?.month_data ?? []).map(m => m.top_deals.length > 0 && (
            <details key={m.month} style={{ marginBottom: '0.75rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-muted)', userSelect: 'none' }}>
                {fmtMonth(m.month)} — top deals ({m.top_deals.length})
              </summary>
              <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: '0.82rem', color: 'var(--text)', width: '100%', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '20%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '6%' }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '49%' }} />
                  </colgroup>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Account</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500 }}>ARR</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500 }}>AI %</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Stage</th>
                      <th style={{ padding: '0.35rem 0.6rem', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Reasoning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.top_deals.map(d => {
                      const sfUrl = aiData?.salesforce_base_url && d.sf_opp_id
                        ? `${aiData.salesforce_base_url}/${d.sf_opp_id}`
                        : null
                      return (
                      <tr key={d.sf_opp_id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.35rem 0.6rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sfUrl
                            ? <a href={sfUrl} target="_blank" rel="noopener noreferrer" style={{ color: C_AI, textDecoration: 'none' }}>{d.account_name ?? '—'}</a>
                            : (d.account_name ?? '—')}
                        </td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>{fmtK(d.arr)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right', color: C_AI, fontWeight: 600 }}>{fmtPct2(d.probability)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.stage ?? '—'}</td>
                        <td style={{ padding: '0.35rem 0.6rem', color: 'var(--text-muted)', whiteSpace: 'normal', lineHeight: 1.4 }}>{d.reasoning ?? '—'}</td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </>
      )}
    </div>
  )
}


// ── ForecastView ──────────────────────────────────────────────────────────────
export default function ForecastView() {
  const [data, setData] = useState<ForecastResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aiData, setAiData] = useState<AIForecastResponse | null>(null)

  const loadAI = () => {
    getAIForecastCurrentQuarter()
      .then(setAiData)
      .catch(() => setAiData(null))
  }

  useEffect(() => {
    getForecastCurrentQuarter()
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
    loadAI()
  }, [])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading forecast…</div>
  if (error)   return <div style={{ color: '#ef4444' }}>Error: {error}</div>
  if (!data)   return null

  const { quarter, months, new_business: nb, expansion: exp, renewals, quarter_totals: qt, in_quarter_quarters_used: iqQtrs } = data

  // ── KPI values ─────────────────────────────────────────────────────────────
  const totalBookingsForecast = qt.total_adjusted_forecast
  const totalBookingsTarget   = (qt.nb_target != null && qt.exp_target != null) ? qt.nb_target + qt.exp_target : null
  const pctOfTarget = (totalBookingsTarget && totalBookingsForecast)
    ? `${((totalBookingsForecast / totalBookingsTarget) * 100).toFixed(0)}% of target`
    : undefined

  // ── chart data ─────────────────────────────────────────────────────────────
  const nbChartData: BookingsChartEntry[] = nb.map(m => ({
    month: m.month, actuals: m.actuals,
    pipeline_weighted: m.pipeline_weighted, pipeline_ai_weighted: m.pipeline_ai_weighted,
    in_quarter_est: m.in_quarter_est, adjusted_forecast: m.adjusted_forecast,
    target: m.target, has_ai_scores: m.has_ai_scores,
  }))
  const expChartData: BookingsChartEntry[] = exp.map(m => ({
    month: m.month, actuals: m.actuals,
    pipeline_weighted: m.pipeline_weighted, pipeline_ai_weighted: m.pipeline_ai_weighted,
    in_quarter_est: m.in_quarter_est, adjusted_forecast: m.adjusted_forecast,
    target: m.target, has_ai_scores: m.has_ai_scores,
  }))
  const renewChartData: RenewalsChartEntry[] = renewals.map(m => ({
    month: m.month, due_arr: m.due_arr, won_arr: m.won_arr, pipeline_weighted: m.pipeline_weighted,
  }))
  const renewRateChartData: RenewalRateChartEntry[] = renewals.map(m => ({
    month: m.month, rate_actual: m.rate_actual, rate_forecast: m.rate_forecast, rate_target: m.rate_target,
  }))

  return (
    <div>
      <h1 style={{ margin: '0 0 1.25rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
        {quarter} Forecast
      </h1>

      {/* Two-column layout: Bookings | Renewals */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', alignItems: 'start' }}>

        {/* ── LEFT: Bookings ─────────────────────────────────────────────── */}
        <div style={{ minWidth: 0 }}>
          {/* Bookings KPI row */}
          <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1.25rem' }}>
            <KpiCard label="Bookings Actuals"  value={fmtK(qt.total_actuals)}        sub={`${quarter} QTD`} />
            <KpiCard label="Bookings Forecast" value={fmtK(totalBookingsForecast)}   sub={pctOfTarget} highlight />
            {totalBookingsTarget != null && <KpiCard label="Bookings Target" value={fmtK(totalBookingsTarget)} sub={quarter} />}
          </div>

          {/* NB + Expansion charts side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '0.5rem' }}>
            <BookingsChart data={nbChartData}  title="New Business" />
            <BookingsChart data={expChartData} title="Expansion" />
          </div>

          {/* Bookings cards */}
          <BookingsCards months={months} nb={nb} exp={exp} qt={qt} quartersUsed={iqQtrs ?? 0} />
        </div>

        {/* ── RIGHT: Renewals ────────────────────────────────────────────── */}
        <div style={{ minWidth: 0 }}>
          {/* Renewals KPI row */}
          <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1.25rem' }}>
            <KpiCard label="Renewal Rate Actual"   value={fmtPct(qt.rate_actual)}   sub={`${quarter} QTD`} />
            <KpiCard label="Renewal Rate Forecast"  value={fmtPct(qt.rate_forecast)} sub={quarter} highlight />
            {qt.rate_target != null && <KpiCard label="Renewal Rate Target" value={fmtPct(qt.rate_target)} sub={quarter} />}
          </div>

          {/* Renewals charts side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '0.5rem' }}>
            <RenewalsChart     data={renewChartData} />
            <RenewalRateChart  data={renewRateChartData} />
          </div>

          {/* Renewals card */}
          <RenewalsCard months={months} renewals={renewals} quarter={qt} />
        </div>
      </div>

      {/* AI Forecast — full width at bottom */}
      <AIForecastPanel aiData={aiData} onRescore={loadAI} />
    </div>
  )
}
