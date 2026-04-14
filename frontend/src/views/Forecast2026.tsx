import { useEffect, useState, useMemo, type CSSProperties } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  LineChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { getPnL, getBalanceSheet, getDeptDetail, type PnLLine, type BalanceSheetLine, type DeptDetailLine } from '../api'

const YEAR = 2026
const ACCENT = '#6366f1'
const PLAN_COLOR = 'rgba(255,255,255,0.25)'
const FORECAST_COLOR = '#a78bfa'  // lighter purple for forecast (future months)
const POSITIVE_COLOR = '#22c55e'
const NEGATIVE_COLOR = '#ef4444'

function toISODate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function endOfMonth(year: number, month: number) {
  return toISODate(new Date(year, month + 1, 0))
}
function monthLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })
}

function fmtK(n: number) {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`
  return `${sign}$${Math.round(abs)}`
}
function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function fmtPct(n: number | null) {
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`
}
function fmtVar(n: number, pctMode = false) {
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return pctMode ? `${sign}${n.toFixed(1)}pp` : `${sign}${fmtK(n)}`
}

const isRevenue    = (c: string) => /^(total\s+)?revenue$/i.test(c.trim()) || /^total\s+sales$/i.test(c.trim())
const isCOGS       = (c: string) => /^total\s+co?gs$/i.test(c.trim()) || /^(total\s+)?cost\s+of\s+goods/i.test(c.trim())
const isGrossProfit = (c: string) => /gross\s+profit/i.test(c)
const isOpEx       = (c: string) => /^total\s+op.?ex$/i.test(c.trim()) || /^total\s+operating/i.test(c.trim()) || /^operating\s+exp/i.test(c.trim())
const isNetIncome  = (c: string) => /^net\s+income$/i.test(c.trim()) || /^net\s+(income|loss)/i.test(c.trim())

function varColor(v: number, invert = false) {
  const eff = invert ? -v : v
  if (Math.abs(eff) < 0.5) return 'var(--text-muted)'
  return eff > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR
}

// ── KPI Card ─────────────────────────────────────────────────────────────────
function KPICard({
  label, actual, plan, variance, pctMode = false, invertVariance = false,
}: {
  label: string; actual: number | null; plan: number | null; variance: number | null
  pctMode?: boolean; invertVariance?: boolean
}) {
  const fmtVal = (v: number | null) => {
    if (v == null || !Number.isFinite(v)) return '—'
    return pctMode ? `${v.toFixed(1)}%` : fmtUSD(v)
  }
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: '1.45rem', fontWeight: 700, color: 'var(--text)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(actual)}</span>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.1rem' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Plan {fmtVal(plan)}</span>
        {variance != null && Number.isFinite(variance) && (
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: (invertVariance ? -variance : variance) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR }}>
            {fmtVar(variance, pctMode)}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Forecast table (4 columns: Line Item | FY Forecast | FY Plan | Var) ──────
type ForecastRow = {
  label: string
  forecast: number | null
  plan: number | null
  isSubtotal?: boolean
  pctMode?: boolean
  invertVar?: boolean
}

function ForecastTable({ title, rows, yearLabel = 'FY2026' }: {
  title: string; rows: ForecastRow[]; yearLabel?: string
}) {
  const thS: CSSProperties = {
    padding: '0.4rem 0.9rem', fontWeight: 600, fontSize: '0.72rem',
    color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
    whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
  }
  const tdBase: CSSProperties = {
    padding: '0.4rem 0.9rem', fontSize: '0.83rem',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    fontFamily: 'var(--font-mono)',
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '0.9rem 1.1rem 0.6rem', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.75rem' }}>{yearLabel}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '34%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'left' }}>Line item</th>
              <th style={{ ...thS, textAlign: 'right' }}>{yearLabel} Forecast</th>
              <th style={{ ...thS, textAlign: 'right' }}>{yearLabel} Plan</th>
              <th style={{ ...thS, textAlign: 'right' }}>Variance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const fmt = (v: number | null) => {
                if (v == null || !Number.isFinite(v)) return '—'
                return row.pctMode ? `${v.toFixed(1)}%` : fmtUSD(v)
              }
              const variance = row.forecast != null && row.plan != null ? row.forecast - row.plan : null
              const varColor = variance != null
                ? ((row.invertVar ? -variance : variance) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR)
                : 'var(--text-muted)'
              const varStr = variance != null ? (row.pctMode ? fmtVar(variance, true) : fmtVar(variance)) : '—'
              const fw = row.isSubtotal ? 600 : 400
              const bg = row.isSubtotal ? 'rgba(255,255,255,0.04)' : undefined
              const isLast = i === rows.length - 1
              return (
                <tr key={row.label + i} style={{ background: bg }}>
                  <td style={{ ...tdBase, textAlign: 'left', fontFamily: 'inherit', fontWeight: fw, color: row.isSubtotal ? 'var(--text)' : 'var(--text-muted)', paddingLeft: row.isSubtotal ? '0.9rem' : '1.4rem', borderBottom: isLast ? 'none' : undefined }}>{row.label}</td>
                  <td style={{ ...tdBase, textAlign: 'right', fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmt(row.forecast)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', color: 'var(--text-muted)', fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmt(row.plan)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', color: varColor, fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{varStr}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Forecast2026() {
  const [pnlLines, setPnlLines] = useState<PnLLine[]>([])
  const [bsLines, setBsLines] = useState<BalanceSheetLine[]>([])
  const [deptLines, setDeptLines] = useState<DeptDetailLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Anchor at end of year to get all 12 months
  const anchorFY = endOfMonth(YEAR, 11)  // Dec 31 2026

  useEffect(() => {
    Promise.all([
      getPnL(anchorFY, 12),
      getBalanceSheet(anchorFY, 12),
      getDeptDetail(anchorFY, 12),
    ])
      .then(([pnl, bs, dept]) => { setPnlLines(pnl); setBsLines(bs); setDeptLines(dept) })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [anchorFY])

  // All 12 months of the year
  const allYear2026 = useMemo(() => {
    const out: string[] = []
    for (let m = 0; m < 12; m++) out.push(endOfMonth(YEAR, m))
    return out
  }, [])

  // Set of months that have actual (non-plan-only) data
  const actualMonthsSet = useMemo(() => {
    return new Set(pnlLines.filter(l => !l.is_plan_only).map(l => l.period_end))
  }, [pnlLines])

  const lastActualMonth = useMemo(() => {
    const sorted = [...actualMonthsSet].sort()
    return sorted.length ? sorted[sorted.length - 1] : null
  }, [actualMonthsSet])

  // Aggregate by period, carrying is_plan_only flag
  type PeriodVal = { actual: number; plan: number | null; is_plan_only: boolean }
  const byPeriod = useMemo(() => {
    const m: Record<string, Record<string, PeriodVal>> = {}
    for (const l of pnlLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      m[l.period_end][l.category] = { actual: l.amount, plan: l.plan_amount ?? null, is_plan_only: l.is_plan_only }
    }
    return m
  }, [pnlLines])

  const bsByPeriod = useMemo(() => {
    const m: Record<string, Record<string, PeriodVal>> = {}
    for (const l of bsLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      m[l.period_end][l.category] = { actual: l.amount, plan: l.plan_amount ?? null, is_plan_only: false }
    }
    return m
  }, [bsLines])

  const catNames = useMemo(() => {
    const all = [...new Set(pnlLines.map((l) => l.category))]
    return {
      revenue:    all.find(isRevenue) ?? null,
      cogs:       all.find(isCOGS) ?? null,
      grossProfit: all.find(isGrossProfit) ?? null,
      opex:       all.find(isOpEx) ?? null,
      netIncome:  all.find(isNetIncome) ?? null,
      ebitda:     all.find((c) => /^ebitda$/i.test(c.trim())) ?? null,
    }
  }, [pnlLines])

  const cashCat = useMemo(() => {
    const all = [...new Set(bsLines.map((l) => l.category))]
    return all.find((c) => /^cash$/i.test(c.trim())) ?? null
  }, [bsLines])

  // Get value for a period, returning { actual, plan, is_plan_only }
  function getVal(period: string, cat: string | null): PeriodVal {
    if (!cat) return { actual: 0, plan: null, is_plan_only: false }
    return byPeriod[period]?.[cat] ?? { actual: 0, plan: null, is_plan_only: !actualMonthsSet.has(period) }
  }
  function getBsVal(period: string, cat: string | null): PeriodVal {
    if (!cat) return { actual: 0, plan: null, is_plan_only: false }
    return bsByPeriod[period]?.[cat] ?? { actual: 0, plan: null, is_plan_only: false }
  }

  // Full-year forecast for a P&L category:
  // actual months → use amount; future months → use plan_amount
  function fyForecast(cat: string | null): { forecast: number; plan: number | null } {
    if (!cat) return { forecast: 0, plan: null }
    let fc = 0, pl = 0, anyPlan = false
    for (const pe of allYear2026) {
      const c = byPeriod[pe]?.[cat]
      if (!c) continue
      fc += c.is_plan_only ? (c.plan ?? 0) : c.actual
      if (c.plan != null) { pl += c.plan; anyPlan = true }
    }
    return { forecast: fc, plan: anyPlan ? pl : null }
  }

  // Get BS value at end of year (either actual if Dec is synced, or latest actual)
  function fyBs(cat: string | null): { forecast: number; plan: number | null } {
    if (!cat) return { forecast: 0, plan: null }
    // Use the latest actual BS month
    const sortedActual = [...actualMonthsSet].sort()
    const latestActualBsMonth = sortedActual.length ? sortedActual[sortedActual.length - 1] : null
    if (!latestActualBsMonth) return { forecast: 0, plan: null }
    const v = bsByPeriod[latestActualBsMonth]?.[cat]
    if (!v) return { forecast: 0, plan: null }
    return { forecast: v.actual, plan: v.plan }
  }

  // Full-year KPIs
  const fyRev     = fyForecast(catNames.revenue)
  const fyGP      = fyForecast(catNames.grossProfit)
  const fyOpEx    = fyForecast(catNames.opex)
  const fyNI      = fyForecast(catNames.netIncome)
  const fyEBITDA  = fyForecast(catNames.ebitda)
  const fyCash    = fyBs(cashCat)

  const fyGMActual = fyRev.forecast !== 0 ? (fyGP.forecast / fyRev.forecast) * 100 : null
  const fyGMPlan   = fyRev.plan != null && fyGP.plan != null && fyRev.plan !== 0
    ? (fyGP.plan / fyRev.plan) * 100 : null
  const fyEBITDAMarginAct  = fyRev.forecast !== 0 ? (fyEBITDA.forecast / fyRev.forecast) * 100 : null
  const fyEBITDAMarginPlan = fyRev.plan != null && fyEBITDA.plan != null && fyRev.plan !== 0
    ? (fyEBITDA.plan / fyRev.plan) * 100 : null

  // Chart data: all 12 months, 3 series (actual / forecast / plan)
  const chartData = useMemo(() => {
    return allYear2026.map((pe) => {
      const isPast = actualMonthsSet.has(pe)
      const rev  = getVal(pe, catNames.revenue)
      const gp   = getVal(pe, catNames.grossProfit)
      const ni   = getVal(pe, catNames.ebitda)
      const cash = getBsVal(pe, cashCat)

      const gmActual   = isPast && rev.actual !== 0 ? (gp.actual / rev.actual) * 100 : null
      const gmForecast = !isPast && rev.plan != null && rev.plan !== 0 && gp.plan != null
        ? (gp.plan / rev.plan) * 100 : null
      const gmPlan = rev.plan != null && rev.plan !== 0 && gp.plan != null
        ? (gp.plan / rev.plan) * 100 : null

      return {
        month:           monthLabel(pe),
        // Actual: only for past months
        revenueActual:   isPast ? rev.actual : null,
        niActual:        isPast ? ni.actual : null,
        cashActual:      isPast ? cash.actual : null,
        gmActual,
        // Forecast: plan for future months (plan-only rows)
        revenueForecast: !isPast ? rev.plan : null,
        niForecast:      !isPast ? ni.plan : null,
        cashForecast:    !isPast ? cash.plan : null,
        gmForecast,
        // Plan: always shown as reference
        revenuePlan:     rev.plan,
        niPlan:          ni.plan,
        cashPlan:        cash.plan,
        gmPlan,
      }
    })
  }, [allYear2026, actualMonthsSet, catNames, cashCat, byPeriod, bsByPeriod])

  // Financial Overview rows
  const overviewRows = useMemo((): ForecastRow[] => {
    const revFY = fyForecast(catNames.revenue)
    const gpFY  = fyForecast(catNames.grossProfit)
    const opexFY = fyForecast(catNames.opex)
    const niFY  = fyForecast(catNames.netIncome)
    const ebFY  = fyForecast(catNames.ebitda)
    const cashFY = fyBs(cashCat)

    const gmForecast = revFY.forecast !== 0 ? (gpFY.forecast / revFY.forecast) * 100 : null
    const gmPlan     = revFY.plan != null && gpFY.plan != null && revFY.plan !== 0
      ? (gpFY.plan / revFY.plan) * 100 : null

    const ebMarginF  = revFY.forecast !== 0 ? (ebFY.forecast / revFY.forecast) * 100 : null
    const ebMarginP  = revFY.plan != null && ebFY.plan != null && revFY.plan !== 0
      ? (ebFY.plan / revFY.plan) * 100 : null

    return [
      { label: 'Revenue',           forecast: revFY.forecast,  plan: revFY.plan },
      { label: 'Gross Margin %',    forecast: gmForecast,      plan: gmPlan,    pctMode: true },
      { label: 'Operating Expenses',forecast: opexFY.forecast, plan: opexFY.plan, invertVar: true },
      { label: 'EBITDA Margin %',   forecast: ebMarginF,       plan: ebMarginP, pctMode: true },
      { label: 'Net Income (Loss)', forecast: niFY.forecast,   plan: niFY.plan },
      { label: 'Cash Balance',      forecast: cashFY.forecast, plan: cashFY.plan },
    ]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnlLines, bsLines, catNames, cashCat, allYear2026, actualMonthsSet, byPeriod, bsByPeriod])

  // CoGS rows
  const cogsRows: ForecastRow[] = useMemo(() => {
    const sorted = [...pnlLines].sort((a, b) => a.sort_order - b.sort_order)
    const cats = [...new Set(sorted.filter((l) => l.line_type === 'cogs').map((l) => l.category))]
    return cats.map((cat) => {
      const fy = fyForecast(cat)
      return { label: cat, forecast: fy.forecast, plan: fy.plan, isSubtotal: /^(cost of goods|total.*cog)/i.test(cat), invertVar: true }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnlLines, byPeriod, allYear2026, actualMonthsSet])

  // OpEx dept rows
  const opexDeptRows: ForecastRow[] = useMemo(() => {
    const sorted = [...pnlLines].sort((a, b) => a.sort_order - b.sort_order)
    const cats = [...new Set(sorted.filter((l) => l.line_type === 'opex').map((l) => l.category))]
    return cats.map((cat) => {
      const fy = fyForecast(cat)
      return { label: cat, forecast: fy.forecast, plan: fy.plan, isSubtotal: /^(total|operating exp)/i.test(cat), invertVar: true }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnlLines, byPeriod, allYear2026, actualMonthsSet])

  // ── Dept detail ────────────────────────────────────────────────────────────
  const deptByPeriod = useMemo(() => {
    const m: Record<string, Record<string, Record<string, PeriodVal>>> = {}
    for (const l of deptLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      if (!m[l.period_end][l.dept]) m[l.period_end][l.dept] = {}
      m[l.period_end][l.dept][l.category] = { actual: l.amount, plan: l.plan_amount ?? null, is_plan_only: l.is_plan_only }
    }
    return m
  }, [deptLines])

  function fyDeptForecast(dept: string, cat: string): { forecast: number; plan: number | null } {
    let fc = 0, pl = 0, anyPlan = false
    for (const pe of allYear2026) {
      const v = deptByPeriod[pe]?.[dept]?.[cat]
      if (!v) continue
      fc += v.is_plan_only ? (v.plan ?? 0) : v.actual
      if (v.plan != null) { pl += v.plan; anyPlan = true }
    }
    return { forecast: fc, plan: anyPlan ? pl : null }
  }

  const DEPT_ORDER = ['Sales & Marketing', 'Sales', 'Marketing', 'Customer Success', 'Product & Engineering', 'General & Administrative']

  const deptTableRows = useMemo((): Record<string, ForecastRow[]> => {
    const sorted = [...deptLines].sort((a, b) => a.sort_order - b.sort_order)
    const out: Record<string, ForecastRow[]> = {}
    for (const dept of DEPT_ORDER) {
      const cats = [...new Set(sorted.filter((l) => l.dept === dept).map((l) => l.category))]
      if (cats.length === 0) continue
      out[dept] = cats.map((cat) => {
        const meta = sorted.find((l) => l.dept === dept && l.category === cat)
        const fy = fyDeptForecast(dept, cat)
        return { label: cat, forecast: fy.forecast, plan: fy.plan, isSubtotal: meta?.is_subtotal ?? false, invertVar: true }
      })
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptLines, deptByPeriod, allYear2026, actualMonthsSet])

  // BS summary rows
  const bsSummaryRows: ForecastRow[] = useMemo(() => {
    const bsCats = [...new Set(bsLines.map((l) => l.category))]
    const want = ['Cash', 'Accounts receivable', 'Prepaid expenses', 'Deferred revenue']
    return want
      .filter((cat) => bsCats.some((c) => c.toLowerCase() === cat.toLowerCase()))
      .map((cat) => {
        const match = bsCats.find((c) => c.toLowerCase() === cat.toLowerCase()) ?? cat
        const fy = fyBs(match)
        return { label: match, forecast: fy.forecast, plan: fy.plan }
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bsLines, bsByPeriod, actualMonthsSet])

  // ── Styles ─────────────────────────────────────────────────────────────────
  const chartCard: CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '1.1rem 1.25rem', flex: '1 1 0', minWidth: 0,
  }
  const chartTitle: CSSProperties = {
    fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.75rem',
  }
  const thS: CSSProperties = {
    padding: '0.45rem 0.9rem', fontWeight: 600, fontSize: '0.75rem',
    color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
    whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
  }
  const tdS: CSSProperties = {
    padding: '0.45rem 0.9rem', fontSize: '0.85rem',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (loading) return <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>Loading…</p>
  if (actualMonthsSet.size === 0) return (
    <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>
      No {YEAR} data yet. Run Data Sync → Parse to load financials.
    </p>
  )

  const lastActualLabel = lastActualMonth
    ? new Date(lastActualMonth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : ''

  const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }
  const legendStyle = { fontSize: 11, color: 'var(--text-muted)' }

  const fmtLegend = (v: string) => {
    if (v.endsWith('Actual'))   return 'Actual'
    if (v.endsWith('Forecast')) return 'Forecast'
    if (v.endsWith('Plan'))     return 'Plan'
    return v
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div>
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 600, color: 'var(--text)' }}>2026 Forecast</h1>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Full year 2026 · actuals through {lastActualLabel} + plan for remaining months
        </p>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <KPICard
          label="FY2026 Revenue"
          actual={fyRev.forecast}
          plan={fyRev.plan}
          variance={fyRev.plan != null ? fyRev.forecast - fyRev.plan : null}
        />
        <KPICard
          label="FY2026 Gross Margin %"
          actual={fyGMActual}
          plan={fyGMPlan}
          variance={fyGMActual != null && fyGMPlan != null ? fyGMActual - fyGMPlan : null}
          pctMode
        />
        <KPICard
          label="FY2026 OpEx"
          actual={fyOpEx.forecast}
          plan={fyOpEx.plan}
          variance={fyOpEx.plan != null ? fyOpEx.forecast - fyOpEx.plan : null}
          invertVariance
        />
        <KPICard
          label="FY2026 Net Income"
          actual={fyNI.forecast}
          plan={fyNI.plan}
          variance={fyNI.plan != null ? fyNI.forecast - fyNI.plan : null}
        />
        <KPICard
          label="Cash (latest actual)"
          actual={fyCash.forecast}
          plan={fyCash.plan}
          variance={fyCash.plan != null ? fyCash.forecast - fyCash.plan : null}
        />
      </div>

      {/* ── Charts row 1 ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {/* Revenue */}
        <div style={chartCard}>
          <div style={chartTitle}>Revenue</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
              <Tooltip
                formatter={(value: number, name: string) => [fmtK(value), fmtLegend(name)]}
                contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={fmtLegend} wrapperStyle={legendStyle} />
              <Bar dataKey="revenuePlan"     fill={PLAN_COLOR}     radius={[3,3,0,0]} maxBarSize={32} />
              <Bar dataKey="revenueActual"   fill={ACCENT}         radius={[3,3,0,0]} maxBarSize={32} />
              <Bar dataKey="revenueForecast" fill={FORECAST_COLOR} radius={[3,3,0,0]} maxBarSize={32} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Gross Margin % */}
        <div style={chartCard}>
          <div style={chartTitle}>Gross Margin %</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v.toFixed(0)}%`} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={40} domain={['auto', 'auto']} />
              <Tooltip
                formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, fmtLegend(name)]}
                contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={fmtLegend} wrapperStyle={legendStyle} />
              <Line dataKey="gmPlan"     stroke={PLAN_COLOR}     strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
              <Line dataKey="gmActual"   stroke={ACCENT}         strokeWidth={2} dot={{ r: 3, fill: ACCENT }} connectNulls />
              <Line dataKey="gmForecast" stroke={FORECAST_COLOR} strokeWidth={2} strokeDasharray="5 2" dot={{ r: 3, fill: FORECAST_COLOR }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Charts row 2 ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {/* EBITDA */}
        <div style={chartCard}>
          <div style={chartTitle}>EBITDA</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
              <Tooltip
                formatter={(value: number, name: string) => [fmtK(value), fmtLegend(name)]}
                contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={fmtLegend} wrapperStyle={legendStyle} />
              <Bar dataKey="niPlan"     fill={PLAN_COLOR}     radius={[3,3,0,0]} maxBarSize={32} />
              <Bar dataKey="niActual"   fill={ACCENT}         radius={[3,3,0,0]} maxBarSize={32} />
              <Bar dataKey="niForecast" fill={FORECAST_COLOR} radius={[3,3,0,0]} maxBarSize={32} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Cash Balance */}
        <div style={chartCard}>
          <div style={chartTitle}>Cash Balance</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
              <Tooltip
                formatter={(value: number, name: string) => [fmtK(value), fmtLegend(name)]}
                contentStyle={tooltipStyle} labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={fmtLegend} wrapperStyle={legendStyle} />
              <Bar dataKey="cashPlan"     fill={PLAN_COLOR}     radius={[3,3,0,0]} maxBarSize={32} />
              <Bar dataKey="cashActual"   fill={ACCENT}         radius={[3,3,0,0]} maxBarSize={32} />
              <Bar dataKey="cashForecast" fill={FORECAST_COLOR} radius={[3,3,0,0]} maxBarSize={32} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Financial Overview Table ─────────────────────────────────────────── */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '0.9rem 1.1rem 0.6rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>Financial Overview</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.75rem' }}>FY2026</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '34%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '22%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'left' }}>Metric</th>
                <th style={{ ...thS, textAlign: 'right' }}>FY2026 Forecast</th>
                <th style={{ ...thS, textAlign: 'right' }}>FY2026 Plan</th>
                <th style={{ ...thS, textAlign: 'right' }}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {overviewRows.map((row, i) => {
                const fmtCell = (v: number | null) => {
                  if (v == null || !Number.isFinite(v)) return '—'
                  return row.pctMode ? `${v.toFixed(1)}%` : fmtUSD(v)
                }
                const variance = row.forecast != null && row.plan != null ? row.forecast - row.plan : null
                const vc = variance != null
                  ? ((row.invertVar ? -variance : variance) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR)
                  : 'var(--text-muted)'
                const isLast = i === overviewRows.length - 1
                return (
                  <tr key={row.label}>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 500, color: 'var(--text)', borderBottom: isLast ? 'none' : undefined }}>{row.label}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', borderBottom: isLast ? 'none' : undefined }}>{fmtCell(row.forecast)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', borderBottom: isLast ? 'none' : undefined }}>{fmtCell(row.plan)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: vc, borderBottom: isLast ? 'none' : undefined }}>
                      {variance != null ? (row.pctMode ? fmtVar(variance, true) : fmtVar(variance)) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── CoGS ─────────────────────────────────────────────────────────────── */}
      {cogsRows.length > 0 && (
        <ForecastTable title="Cost of Goods Sold" rows={cogsRows} />
      )}

      {/* ── OpEx by department ───────────────────────────────────────────────── */}
      {opexDeptRows.length > 0 && (
        <ForecastTable title="Operating Expenses by Department" rows={opexDeptRows} />
      )}

      {/* ── Department Detail ────────────────────────────────────────────────── */}
      {DEPT_ORDER.filter((d) => deptTableRows[d]?.length).map((dept) => (
        <ForecastTable
          key={dept}
          title={dept === 'Sales & Marketing' ? 'Total Sales & Marketing & Customer Success' : dept}
          rows={deptTableRows[dept]}
        />
      ))}

      {/* ── Selected Balance Sheet Items ─────────────────────────────────────── */}
      {bsSummaryRows.length > 0 && (
        <ForecastTable
          title="Selected Balance Sheet Items"
          rows={bsSummaryRows}
          yearLabel={`as of ${lastActualLabel}`}
        />
      )}

    </div>
  )
}
