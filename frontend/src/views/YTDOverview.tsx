import { useEffect, useState, useMemo, useCallback, type CSSProperties } from 'react'
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
import { getPnL, getBalanceSheet, getCashFlow, getDeptDetail, getOverviewObservations, type PnLLine, type BalanceSheetLine, type CashFlowLine, type DeptDetailLine } from '../api'

const YEAR = 2026
const ACCENT = '#6366f1'
const PLAN_COLOR = 'rgba(255,255,255,0.25)'
const NEGATIVE_COLOR = '#ef4444'
const POSITIVE_COLOR = '#22c55e'

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

// ── Matchers ──────────────────────────────────────────────────────────────────
const isRevenue = (c: string) => /^(total\s+)?revenue$/i.test(c.trim()) || /^total\s+sales$/i.test(c.trim())
const isCOGS = (c: string) => /^total\s+co?gs$/i.test(c.trim()) || /^(total\s+)?cost\s+of\s+goods/i.test(c.trim())
const isGrossProfit = (c: string) => /gross\s+profit/i.test(c)
const isOpEx = (c: string) => /^total\s+op.?ex$/i.test(c.trim()) || /^total\s+operating/i.test(c.trim()) || /^operating\s+exp/i.test(c.trim())
const isNetIncome = (c: string) => /^net\s+income$/i.test(c.trim()) || /^net\s+(income|loss)/i.test(c.trim())

function varColor(v: number) {
  if (Math.abs(v) < 0.5) return 'var(--text-muted)'
  return v > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR
}

// ── KPI Card ─────────────────────────────────────────────────────────────────
function KPICard({
  label, actual, plan, variance, pctMode = false, isCurrency = true, suffix = '', invertVariance = false,
}: {
  label: string
  actual: number | null
  plan: number | null
  variance: number | null
  pctMode?: boolean
  isCurrency?: boolean
  suffix?: string
  invertVariance?: boolean
}) {
  const fmtVal = (v: number | null) => {
    if (v == null || !Number.isFinite(v)) return '—'
    if (pctMode) return `${v.toFixed(1)}%`
    return fmtUSD(v)
  }

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.3rem',
        flex: 1,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ fontSize: '1.45rem', fontWeight: 700, color: 'var(--text)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {fmtVal(actual)}
      </span>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.1rem' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Plan {fmtVal(plan)}
        </span>
        {variance != null && Number.isFinite(variance) && (
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: (invertVariance ? -variance : variance) > 0 ? POSITIVE_COLOR : (invertVariance ? -variance : variance) < 0 ? NEGATIVE_COLOR : 'var(--text-muted)',
            }}
          >
            {fmtVar(variance, pctMode)}{suffix}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Department table ─────────────────────────────────────────────────────────
type DeptRow = {
  label: string
  mAct: number | null; mPlan: number | null
  ytdAct: number | null; ytdPlan: number | null
  isSubtotal?: boolean
  pctMode?: boolean
  invertVar?: boolean
}

function DeptTable({ title, rows, monthName, ytdLabel, monthShort }: {
  title: string
  rows: DeptRow[]
  monthName: string
  ytdLabel: string
  monthShort?: string
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
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.75rem' }}>
          {monthName} · {ytdLabel}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '22%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '14%' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'left' }}>Line item</th>
              <th style={{ ...thS, textAlign: 'right' }}>YTD Actual</th>
              <th style={{ ...thS, textAlign: 'right' }}>YTD Plan</th>
              <th style={{ ...thS, textAlign: 'right' }}>YTD Var</th>
              <th style={{ ...thS, textAlign: 'right', borderLeft: '1px solid var(--border)' }}>{monthShort ?? 'Month'} Actual</th>
              <th style={{ ...thS, textAlign: 'right' }}>{monthShort ?? 'Month'} Plan</th>
              <th style={{ ...thS, textAlign: 'right' }}>{monthShort ?? 'Month'} Var</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const fmt = (v: number | null) => {
                if (v == null || !Number.isFinite(v)) return '—'
                return row.pctMode ? `${v.toFixed(1)}%` : fmtUSD(v)
              }
              const fmtV = (v: number | null) => {
                if (v == null || !Number.isFinite(v)) return '—'
                return row.pctMode ? fmtVar(v, true) : fmtVar(v)
              }
              const mVar = row.mAct != null && row.mPlan != null ? row.mAct - row.mPlan : null
              const ytdVar = row.ytdAct != null && row.ytdPlan != null ? row.ytdAct - row.ytdPlan : null
              const mVarC = mVar != null ? ((row.invertVar ? -mVar : mVar) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR) : 'var(--text-muted)'
              const ytdVarC = ytdVar != null ? ((row.invertVar ? -ytdVar : ytdVar) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR) : 'var(--text-muted)'
              const fw = row.isSubtotal ? 600 : 400
              const bg = row.isSubtotal ? 'rgba(255,255,255,0.04)' : undefined
              const isLast = i === rows.length - 1
              return (
                <tr key={row.label} style={{ background: bg }}>
                  <td style={{ ...tdBase, textAlign: 'left', fontFamily: 'inherit', fontWeight: fw, color: row.isSubtotal ? 'var(--text)' : 'var(--text-muted)', paddingLeft: row.isSubtotal ? '0.9rem' : '1.4rem', borderBottom: isLast ? 'none' : undefined }}>{row.label}</td>
                  <td style={{ ...tdBase, textAlign: 'right', fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmt(row.ytdAct)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', color: 'var(--text-muted)', fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmt(row.ytdPlan)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', color: ytdVarC, fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmtV(ytdVar)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', borderLeft: '1px solid var(--border)', fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmt(row.mAct)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', color: 'var(--text-muted)', fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmt(row.mPlan)}</td>
                  <td style={{ ...tdBase, textAlign: 'right', color: mVarC, fontWeight: fw, background: bg, borderBottom: isLast ? 'none' : undefined }}>{fmtV(mVar)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Chart tooltip formatters ──────────────────────────────────────────────────
const currencyTooltip = (value: number) => fmtK(value)
const pctTooltip = (value: number) => `${value.toFixed(1)}%`

// ── Main component ────────────────────────────────────────────────────────────
export default function YTDOverview() {
  const [pnlLines, setPnlLines] = useState<PnLLine[]>([])
  const [bsLines, setBsLines] = useState<BalanceSheetLine[]>([])
  const [cfLines, setCfLines] = useState<CashFlowLine[]>([])
  const [deptLines, setDeptLines] = useState<DeptDetailLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [observations, setObservations] = useState<string | null>(null)
  const [obsLoading, setObsLoading] = useState(false)
  const [obsLoaded, setObsLoaded] = useState(false)

  // Available months through end of last complete month
  const monthEnds = useMemo(() => {
    const out: string[] = []
    const today = new Date()
    const prior = new Date(today.getFullYear(), today.getMonth(), 0)
    for (let m = 0; m < 12; m++) {
      const me = new Date(YEAR, m + 1, 0)
      if (me > prior) break
      out.push(endOfMonth(YEAR, m))
    }
    return out
  }, [])

  const anchorMonth = monthEnds.length ? monthEnds[monthEnds.length - 1] : null

  useEffect(() => {
    if (!anchorMonth) { setLoading(false); return }
    Promise.all([
      getPnL(anchorMonth, 12),
      getBalanceSheet(anchorMonth, 12),
      getCashFlow(anchorMonth, 12),
      getDeptDetail(anchorMonth, 12),
    ])
      .then(([pnl, bs, cf, dept]) => { setPnlLines(pnl); setBsLines(bs); setCfLines(cf); setDeptLines(dept) })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [anchorMonth])

  const loadObservations = useCallback(() => {
    if (!anchorMonth) return
    setObsLoading(true)
    getOverviewObservations(anchorMonth)
      .then((d) => { setObservations(d.observations); setObsLoaded(true) })
      .catch(() => { setObservations(null); setObsLoaded(true) })
      .finally(() => setObsLoading(false))
  }, [anchorMonth])

  // ── Aggregate by period ────────────────────────────────────────────────────
  const byPeriod = useMemo(() => {
    const m: Record<string, Record<string, { actual: number; plan: number | null }>> = {}
    for (const l of pnlLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      m[l.period_end][l.category] = { actual: l.amount, plan: l.plan_amount ?? null }
    }
    return m
  }, [pnlLines])

  const bsByPeriod = useMemo(() => {
    const m: Record<string, Record<string, { actual: number; plan: number | null }>> = {}
    for (const l of bsLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      m[l.period_end][l.category] = { actual: l.amount, plan: l.plan_amount ?? null }
    }
    return m
  }, [bsLines])

  const cfByPeriod = useMemo(() => {
    const m: Record<string, Record<string, { actual: number; plan: number | null; section: string }>> = {}
    for (const l of cfLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      m[l.period_end][l.category] = { actual: l.amount, plan: l.plan_amount ?? null, section: l.section }
    }
    return m
  }, [cfLines])

  // Find canonical category names
  const catNames = useMemo(() => {
    const all = [...new Set(pnlLines.map((l) => l.category))]
    return {
      revenue: all.find(isRevenue) ?? null,
      cogs: all.find(isCOGS) ?? null,
      grossProfit: all.find(isGrossProfit) ?? null,
      opex: all.find(isOpEx) ?? null,
      netIncome: all.find(isNetIncome) ?? null,
      ebitda: all.find((c) => /^ebitda$/i.test(c.trim())) ?? null,
    }
  }, [pnlLines])

  const cashCat = useMemo(() => {
    const all = [...new Set(bsLines.map((l) => l.category))]
    return all.find((c) => /^cash$/i.test(c.trim())) ?? null
  }, [bsLines])

  // Get value for a category in a period
  function getVal(period: string, cat: string | null): { actual: number; plan: number | null } {
    if (!cat) return { actual: 0, plan: null }
    return byPeriod[period]?.[cat] ?? { actual: 0, plan: null }
  }
  function getBsVal(period: string, cat: string | null): { actual: number; plan: number | null } {
    if (!cat) return { actual: 0, plan: null }
    return bsByPeriod[period]?.[cat] ?? { actual: 0, plan: null }
  }

  // YTD aggregations
  const availMonths = useMemo(() => monthEnds.filter((pe) => byPeriod[pe]), [monthEnds, byPeriod])
  const latestMonth = availMonths.length ? availMonths[availMonths.length - 1] : null

  function ytdSum(cat: string | null): { actual: number; plan: number | null } {
    if (!cat) return { actual: 0, plan: null }
    let a = 0; let p: number | null = null; let anyPlan = false
    for (const pe of availMonths) {
      const c = byPeriod[pe]?.[cat]
      if (c) { a += c.actual; if (c.plan != null) { anyPlan = true; p = (p ?? 0) + c.plan } }
    }
    return { actual: a, plan: anyPlan ? p : null }
  }

  function ytdCfSum(cat: string): { actual: number; plan: number | null } {
    let a = 0; let p: number | null = null; let anyPlan = false
    for (const pe of availMonths) {
      const c = cfByPeriod[pe]?.[cat]
      if (c) { a += c.actual; if (c.plan != null) { anyPlan = true; p = (p ?? 0) + c.plan } }
    }
    return { actual: a, plan: anyPlan ? p : null }
  }

  function getLatestBs(cat: string): { actual: number; plan: number | null } {
    if (!latestMonth) return { actual: 0, plan: null }
    return bsByPeriod[latestMonth]?.[cat] ?? { actual: 0, plan: null }
  }

  function getLatestCf(cat: string): { actual: number; plan: number | null } {
    if (!latestMonth) return { actual: 0, plan: null }
    return cfByPeriod[latestMonth]?.[cat] ?? { actual: 0, plan: null }
  }

  // Build a DeptRow from a PnL category
  function pnlRow(cat: string, isSubtotal = false, invertVar = false): DeptRow {
    const m = latestMonth ? byPeriod[latestMonth]?.[cat] ?? { actual: 0, plan: null } : { actual: 0, plan: null }
    const ytd = ytdSum(cat)
    return { label: cat, mAct: m.actual, mPlan: m.plan, ytdAct: ytd.actual, ytdPlan: ytd.plan, isSubtotal, invertVar }
  }

  function cfRow(cat: string, isSubtotal = false): DeptRow {
    const m = getLatestCf(cat)
    const ytd = ytdCfSum(cat)
    return { label: cat, mAct: m.actual, mPlan: m.plan, ytdAct: ytd.actual, ytdPlan: ytd.plan, isSubtotal }
  }

  function bsRow(cat: string, isSubtotal = false): DeptRow {
    const cur = getLatestBs(cat)
    // Balance sheet is point-in-time — YTD = same as current
    return { label: cat, mAct: cur.actual, mPlan: cur.plan, ytdAct: cur.actual, ytdPlan: cur.plan, isSubtotal }
  }

  // ── Chart data ─────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    return availMonths.map((pe) => {
      const rev = getVal(pe, catNames.revenue)
      const gp = getVal(pe, catNames.grossProfit)
      const ni = getVal(pe, catNames.ebitda)
      const cash = getBsVal(pe, cashCat)
      const revActual = rev.actual
      const gpPct = revActual !== 0 ? (gp.actual / revActual) * 100 : null
      const gpPlanPct = rev.plan != null && gp.plan != null && rev.plan !== 0 ? (gp.plan / rev.plan) * 100 : null
      return {
        month: monthLabel(pe),
        revenueActual: rev.actual,
        revenuePlan: rev.plan,
        gmActual: gpPct,
        gmPlan: gpPlanPct,
        niActual: ni.actual,
        niPlan: ni.plan,
        cashActual: cash.actual,
        cashPlan: cash.plan,
      }
    })
  }, [availMonths, catNames, cashCat, byPeriod, bsByPeriod])

  // ── KPI values ─────────────────────────────────────────────────────────────
  const ytdRev = ytdSum(catNames.revenue)
  const ytdGP = ytdSum(catNames.grossProfit)
  const ytdOpEx = ytdSum(catNames.opex)
  const ytdNI = ytdSum(catNames.netIncome)
  const latestCash = latestMonth ? getBsVal(latestMonth, cashCat) : { actual: 0, plan: null }

  const ytdEBITDA = ytdSum(catNames.ebitda)
  const ytdGMActual = ytdRev.actual !== 0 ? (ytdGP.actual / ytdRev.actual) * 100 : null
  const ytdGMPlan = ytdRev.plan != null && ytdGP.plan != null && ytdRev.plan !== 0
    ? (ytdGP.plan / ytdRev.plan) * 100 : null
  const ytdEBITDAMarginAct = ytdRev.actual !== 0 ? (ytdEBITDA.actual / ytdRev.actual) * 100 : null
  const ytdEBITDAMarginPlan = ytdRev.plan != null && ytdEBITDA.plan != null && ytdRev.plan !== 0
    ? (ytdEBITDA.plan / ytdRev.plan) * 100 : null

  // ── MBR table rows ─────────────────────────────────────────────────────────
  const mbrRows = useMemo(() => {
    if (!latestMonth) return []
    const revM = getVal(latestMonth, catNames.revenue)
    const gpM = getVal(latestMonth, catNames.grossProfit)
    const opexM = getVal(latestMonth, catNames.opex)
    const niM = getVal(latestMonth, catNames.netIncome)
    const cashM = getBsVal(latestMonth, cashCat)

    const ebitdaM = getVal(latestMonth, catNames.ebitda)
    const revAct = revM.actual
    const gmActM = revAct !== 0 ? (gpM.actual / revAct) * 100 : null
    const gmPlanM = revM.plan != null && gpM.plan != null && revM.plan !== 0
      ? (gpM.plan / revM.plan) * 100 : null
    const ebMarginActM = revAct !== 0 ? (ebitdaM.actual / revAct) * 100 : null
    const ebMarginPlanM = revM.plan != null && ebitdaM.plan != null && revM.plan !== 0
      ? (ebitdaM.plan / revM.plan) * 100 : null

    return [
      {
        label: 'Revenue',
        mAct: revM.actual, mPlan: revM.plan, mVar: revM.plan != null ? revM.actual - revM.plan : null,
        ytdAct: ytdRev.actual, ytdPlan: ytdRev.plan, ytdVar: ytdRev.plan != null ? ytdRev.actual - ytdRev.plan : null,
        pctMode: false,
      },
      {
        label: 'Gross Margin %',
        mAct: gmActM, mPlan: gmPlanM, mVar: gmActM != null && gmPlanM != null ? gmActM - gmPlanM : null,
        ytdAct: ytdGMActual, ytdPlan: ytdGMPlan, ytdVar: ytdGMActual != null && ytdGMPlan != null ? ytdGMActual - ytdGMPlan : null,
        pctMode: true,
      },
      {
        label: 'Operating Expenses',
        mAct: opexM.actual, mPlan: opexM.plan, mVar: opexM.plan != null ? opexM.actual - opexM.plan : null,
        ytdAct: ytdOpEx.actual, ytdPlan: ytdOpEx.plan, ytdVar: ytdOpEx.plan != null ? ytdOpEx.actual - ytdOpEx.plan : null,
        pctMode: false, invertVar: true,
      },
      {
        label: 'EBITDA Margin %',
        mAct: ebMarginActM, mPlan: ebMarginPlanM, mVar: ebMarginActM != null && ebMarginPlanM != null ? ebMarginActM - ebMarginPlanM : null,
        ytdAct: ytdEBITDAMarginAct, ytdPlan: ytdEBITDAMarginPlan, ytdVar: ytdEBITDAMarginAct != null && ytdEBITDAMarginPlan != null ? ytdEBITDAMarginAct - ytdEBITDAMarginPlan : null,
        pctMode: true,
      },
      {
        label: 'Net Income (Loss)',
        mAct: niM.actual, mPlan: niM.plan, mVar: niM.plan != null ? niM.actual - niM.plan : null,
        ytdAct: ytdNI.actual, ytdPlan: ytdNI.plan, ytdVar: ytdNI.plan != null ? ytdNI.actual - ytdNI.plan : null,
        pctMode: false,
      },
      {
        label: 'Cash Balance',
        mAct: cashM.actual, mPlan: cashM.plan, mVar: cashM.plan != null ? cashM.actual - cashM.plan : null,
        ytdAct: cashM.actual, ytdPlan: cashM.plan, ytdVar: cashM.plan != null ? cashM.actual - cashM.plan : null,
        pctMode: false,
      },
    ]
  }, [latestMonth, catNames, cashCat, byPeriod, bsByPeriod, ytdRev, ytdGP, ytdOpEx, ytdNI, ytdEBITDA, ytdGMActual, ytdGMPlan, ytdEBITDAMarginAct, ytdEBITDAMarginPlan])

  // ── Department section rows ─────────────────────────────────────────────────
  // CoGS
  const cogsRows: DeptRow[] = useMemo(() => {
    const cats = pnlLines.filter((l) => l.line_type === 'cogs').map((l) => l.category)
    const uniq = [...new Set(cats)]
    const sorted = [...pnlLines].sort((a, b) => a.sort_order - b.sort_order)
    const ordered = [...new Set(sorted.filter((l) => l.line_type === 'cogs').map((l) => l.category))]
    return ordered.map((cat) => {
      const sub = uniq.find((c) => /^(cost of goods|total.*cog)/i.test(c)) === cat
      return pnlRow(cat, sub || /^(cost of goods|total.*cog)/i.test(cat), true)
    })
  }, [pnlLines, latestMonth, byPeriod, availMonths])

  // OpEx departments — S&M, R&D, G&A
  const opexDeptRows: DeptRow[] = useMemo(() => {
    const sorted = [...pnlLines].sort((a, b) => a.sort_order - b.sort_order)
    const opexCats = [...new Set(sorted.filter((l) => l.line_type === 'opex').map((l) => l.category))]
    return opexCats.map((cat) => pnlRow(cat, /^(total|operating exp)/i.test(cat), true))
  }, [pnlLines, latestMonth, byPeriod, availMonths])

  // Selected CF items
  const cfSectionRows: DeptRow[] = useMemo(() => {
    const cfCats = [...new Set(cfLines.map((l) => l.category))]
    const operatingNet = cfCats.find((c) => /net cash.*operat/i.test(c)) ?? null
    const investingNet = cfCats.find((c) => /net cash.*invest/i.test(c)) ?? null
    const financingNet = cfCats.find((c) => /net cash.*financ/i.test(c)) ?? null
    const netIncrease = cfCats.find((c) => /net cash increase/i.test(c)) ?? null

    const workingCapital = cfCats.filter((c) =>
      !/net cash|net income/i.test(c) &&
      cfLines.find((l) => l.category === c)?.section === 'operating'
    )

    const rows: DeptRow[] = []
    // Working capital movements
    workingCapital.forEach((cat) => rows.push(cfRow(cat)))
    if (operatingNet) rows.push(cfRow(operatingNet, true))
    if (investingNet) rows.push({ ...cfRow(investingNet, true) })
    if (financingNet) rows.push({ ...cfRow(financingNet, true) })
    if (netIncrease) rows.push({ ...cfRow(netIncrease, true) })
    return rows
  }, [cfLines, latestMonth, cfByPeriod, availMonths])

  // Selected BS items
  const bsSummaryRows: DeptRow[] = useMemo(() => {
    const bsCats = [...new Set(bsLines.map((l) => l.category))]
    const want = [
      { cat: 'Cash', sub: false },
      { cat: 'Accounts receivable', sub: false },
      { cat: 'Prepaid expenses', sub: false },
      { cat: 'Deferred revenue', sub: false },
    ]
    return want
      .filter(({ cat }) => bsCats.some((c) => c.toLowerCase() === cat.toLowerCase()))
      .map(({ cat, sub }) => {
        const match = bsCats.find((c) => c.toLowerCase() === cat.toLowerCase()) ?? cat
        return bsRow(match, sub)
      })
  }, [bsLines, latestMonth, bsByPeriod])

  // ── Dept detail ────────────────────────────────────────────────────────────
  // period → dept → category → { actual, plan }
  const deptByPeriod = useMemo(() => {
    const m: Record<string, Record<string, Record<string, { actual: number; plan: number | null }>>> = {}
    for (const l of deptLines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      if (!m[l.period_end][l.dept]) m[l.period_end][l.dept] = {}
      m[l.period_end][l.dept][l.category] = { actual: l.amount, plan: l.plan_amount ?? null }
    }
    return m
  }, [deptLines])

  function deptRow(dept: string, cat: string, isSubtotal = false): DeptRow {
    const mData = latestMonth ? deptByPeriod[latestMonth]?.[dept]?.[cat] ?? { actual: 0, plan: null } : { actual: 0, plan: null }
    // YTD = sum across all available months
    let ytdAct = 0, ytdPlan = 0, hasPlan = false
    for (const pe of availMonths) {
      const v = deptByPeriod[pe]?.[dept]?.[cat]
      if (v) {
        ytdAct += v.actual
        if (v.plan != null) { ytdPlan += v.plan; hasPlan = true }
      }
    }
    return { label: cat, mAct: mData.actual, mPlan: mData.plan, ytdAct, ytdPlan: hasPlan ? ytdPlan : null, isSubtotal, invertVar: true }
  }

  const DEPT_ORDER = ['Sales & Marketing', 'Sales', 'Marketing', 'Customer Success', 'Product & Engineering', 'General & Administrative']

  const deptTableRows = useMemo((): Record<string, DeptRow[]> => {
    const sorted = [...deptLines].sort((a, b) => a.sort_order - b.sort_order)
    const out: Record<string, DeptRow[]> = {}
    for (const dept of DEPT_ORDER) {
      const cats = [...new Set(sorted.filter((l) => l.dept === dept).map((l) => l.category))]
      if (cats.length === 0) continue
      out[dept] = cats.map((cat) => {
        const meta = sorted.find((l) => l.dept === dept && l.category === cat)
        return deptRow(dept, cat, meta?.is_subtotal ?? false)
      })
    }
    return out
  }, [deptLines, latestMonth, deptByPeriod, availMonths])

  // ── Styles ─────────────────────────────────────────────────────────────────
  const chartCard: CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '1.1rem 1.25rem',
    flex: '1 1 0',
    minWidth: 0,
  }
  const chartTitle: CSSProperties = {
    fontSize: '0.78rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: '0.75rem',
  }
  const thS: CSSProperties = {
    padding: '0.45rem 0.9rem',
    fontWeight: 600,
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
  }
  const tdS: CSSProperties = {
    padding: '0.45rem 0.9rem',
    fontSize: '0.85rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (loading) return <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>Loading…</p>
  if (availMonths.length === 0) return (
    <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>
      No {YEAR} data yet. Run Data Sync → Parse to load financials.
    </p>
  )

  const monthName = latestMonth
    ? new Date(latestMonth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : ''
  const monthShort = latestMonth
    ? new Date(latestMonth + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })
    : 'Month'
  const ytdLabel = `Jan–${new Date((latestMonth ?? '') + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })} ${YEAR}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div>
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 600, color: 'var(--text)' }}>YTD Overview</h1>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {YEAR} actuals vs plan · through {monthName}
        </p>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <KPICard
          label={`Revenue YTD`}
          actual={ytdRev.actual}
          plan={ytdRev.plan}
          variance={ytdRev.plan != null ? ytdRev.actual - ytdRev.plan : null}
        />
        <KPICard
          label="Gross Margin % YTD"
          actual={ytdGMActual}
          plan={ytdGMPlan}
          variance={ytdGMActual != null && ytdGMPlan != null ? ytdGMActual - ytdGMPlan : null}
          pctMode
        />
        <KPICard
          label="OpEx YTD"
          actual={ytdOpEx.actual}
          plan={ytdOpEx.plan}
          variance={ytdOpEx.plan != null ? ytdOpEx.actual - ytdOpEx.plan : null}
          invertVariance
        />
        <KPICard
          label="Net Income YTD"
          actual={ytdNI.actual}
          plan={ytdNI.plan}
          variance={ytdNI.plan != null ? ytdNI.actual - ytdNI.plan : null}
        />
        <KPICard
          label="Cash Balance"
          actual={latestCash.actual}
          plan={latestCash.plan}
          variance={latestCash.plan != null ? latestCash.actual - latestCash.plan : null}
        />
      </div>

      {/* ── FP&A Observations ───────────────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '0.75rem 1.1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>FP&A Observations</span>
          <button
            type="button"
            onClick={loadObservations}
            disabled={obsLoading || !anchorMonth}
            style={{
              background: obsLoading ? 'transparent' : 'var(--accent)',
              color: obsLoading ? 'var(--text-muted)' : '#fff',
              border: obsLoading ? '1px solid var(--border)' : 'none',
              borderRadius: 5,
              padding: '0.25rem 0.6rem',
              fontSize: '0.75rem',
              cursor: obsLoading || !anchorMonth ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {obsLoading ? 'Analyzing…' : obsLoaded ? 'Refresh' : 'Generate'}
          </button>
          {!obsLoaded && !obsLoading && anchorMonth && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Executive summary across P&L, cash, and balance sheet through <strong style={{ color: 'var(--text)' }}>{monthName}</strong>.
            </span>
          )}
          {obsLoading && <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Analyzing…</span>}
        </div>
        {observations && !obsLoading && (
          <ul style={{ margin: '0.6rem 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {observations
              .split('\n')
              .map((line) => line.replace(/^[•\-*]\s*/, '').trim())
              .filter(Boolean)
              .map((line, i) => (
                <li key={i} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '0.1rem' }}>•</span>
                  <span>{line}</span>
                </li>
              ))}
          </ul>
        )}
        <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Dazos FP&A Agent · Claude Sonnet
        </div>
      </div>

      {/* ── Charts row 1 ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {/* Revenue vs Plan */}
        <div style={chartCard}>
          <div style={chartTitle}>Revenue</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => fmtK(v)} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
              <Tooltip
                formatter={(value: number, name: string) => [fmtK(value), name === 'revenueActual' ? 'Actual' : 'Plan']}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={(v) => v === 'revenueActual' ? 'Actual' : 'Plan'} wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
              <Bar dataKey="revenueActual" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={32} />
              <Bar dataKey="revenuePlan" fill={PLAN_COLOR} radius={[3, 3, 0, 0]} maxBarSize={32} />
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
                formatter={(value: number, name: string) => [pctTooltip(value), name === 'gmActual' ? 'Actual' : 'Plan']}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={(v) => v === 'gmActual' ? 'Actual' : 'Plan'} wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
              <Line dataKey="gmActual" stroke={ACCENT} strokeWidth={2} dot={{ r: 3, fill: ACCENT }} connectNulls />
              <Line dataKey="gmPlan" stroke={PLAN_COLOR} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Charts row 2 ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {/* Net Income (Burn) */}
        <div style={chartCard}>
          <div style={chartTitle}>EBITDA</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => fmtK(v)} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
              <Tooltip
                formatter={(value: number, name: string) => [fmtK(value), name === 'niActual' ? 'Actual' : 'Plan']}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={(v) => v === 'niActual' ? 'Actual' : 'Plan'} wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
              <Bar dataKey="niActual" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={32} />
              <Bar dataKey="niPlan" fill={PLAN_COLOR} radius={[3, 3, 0, 0]} maxBarSize={32} />
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
              <YAxis tickFormatter={(v) => fmtK(v)} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={55} />
              <Tooltip
                formatter={(value: number, name: string) => [fmtK(value), name === 'cashActual' ? 'Actual' : 'Plan']}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
              />
              <Legend formatter={(v) => v === 'cashActual' ? 'Actual' : 'Plan'} wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
              <Bar dataKey="cashActual" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={32} />
              <Bar dataKey="cashPlan" fill={PLAN_COLOR} radius={[3, 3, 0, 0]} maxBarSize={32} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── MBR Financial Overview Table ────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '0.9rem 1.1rem 0.6rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>Financial Overview</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.75rem' }}>
            {monthName} · {ytdLabel}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'left' }}>Metric</th>
                <th style={{ ...thS, textAlign: 'right' }}>YTD Actual</th>
                <th style={{ ...thS, textAlign: 'right' }}>YTD Plan</th>
                <th style={{ ...thS, textAlign: 'right' }}>YTD Var</th>
                <th style={{ ...thS, textAlign: 'right', borderLeft: '1px solid var(--border)' }}>{monthShort} Actual</th>
                <th style={{ ...thS, textAlign: 'right' }}>{monthShort} Plan</th>
                <th style={{ ...thS, textAlign: 'right' }}>{monthShort} Var</th>
              </tr>
            </thead>
            <tbody>
              {mbrRows.map((row, i) => {
                const fmtCell = (v: number | null) => {
                  if (v == null || !Number.isFinite(v)) return '—'
                  return row.pctMode ? `${v.toFixed(1)}%` : fmtUSD(v)
                }
                const fmtVarCell = (v: number | null) => {
                  if (v == null || !Number.isFinite(v)) return '—'
                  return row.pctMode ? fmtVar(v, true) : fmtVar(v)
                }
                const mVarColor = row.mVar != null
                  ? ((row.invertVar ? -row.mVar : row.mVar) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR)
                  : 'var(--text-muted)'
                const ytdVarColor = row.ytdVar != null
                  ? ((row.invertVar ? -row.ytdVar : row.ytdVar) > 0 ? POSITIVE_COLOR : NEGATIVE_COLOR)
                  : 'var(--text-muted)'
                const isLast = i === mbrRows.length - 1
                const rowBorder = isLast ? 'none' : undefined
                return (
                  <tr key={row.label}>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 500, color: 'var(--text)', borderBottom: rowBorder }}>{row.label}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', borderBottom: rowBorder }}>{fmtCell(row.ytdAct)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', borderBottom: rowBorder }}>{fmtCell(row.ytdPlan)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: ytdVarColor, borderBottom: rowBorder }}>{fmtVarCell(row.ytdVar)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', borderLeft: '1px solid var(--border)', borderBottom: rowBorder }}>{fmtCell(row.mAct)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', borderBottom: rowBorder }}>{fmtCell(row.mPlan)}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: mVarColor, borderBottom: rowBorder }}>{fmtVarCell(row.mVar)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Department Sections ──────────────────────────────────────────────── */}
      {cogsRows.length > 0 && (
        <DeptTable title="Cost of Goods Sold" rows={cogsRows} monthName={monthName} ytdLabel={ytdLabel} monthShort={monthShort} />
      )}

      {opexDeptRows.length > 0 && (
        <DeptTable title="Operating Expenses by Department" rows={opexDeptRows} monthName={monthName} ytdLabel={ytdLabel} monthShort={monthShort} />
      )}

      {/* ── Department Detail ────────────────────────────────────────────────── */}
      {DEPT_ORDER.filter((d) => deptTableRows[d]?.length).map((dept) => (
        <DeptTable
          key={dept}
          title={dept === 'Sales & Marketing' ? 'Total Sales & Marketing & Customer Success' : dept}
          rows={deptTableRows[dept]}
          monthName={monthName}
          ytdLabel={ytdLabel}
          monthShort={monthShort}
        />
      ))}

      {/* ── Selected Balance Sheet Items ─────────────────────────────────────── */}
      {bsSummaryRows.length > 0 && (
        <DeptTable
          title="Selected Balance Sheet Items"
          rows={bsSummaryRows.map((r) => ({ ...r, ytdAct: r.mAct, ytdPlan: r.mPlan }))}
          monthName={monthName}
          ytdLabel={`as of ${monthName}`}
          monthShort={monthShort}
        />
      )}

    </div>
  )
}
