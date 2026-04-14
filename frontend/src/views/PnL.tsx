import { useEffect, useState, useCallback, useMemo, type CSSProperties } from 'react'
import { getPnL, getPnLPeriods, getPnLObservations, type PnLLine } from '../api'

const YEAR = 2026

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const fmtPct1 = (n: number | null) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`)

function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function endOfPreviousMonth(ref: Date): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), 0)
}

function monthEndsInYearThroughPrior(year: number, endOfPrior: Date): string[] {
  const yearStart = new Date(year, 0, 1)
  const lastInYear = new Date(year, 11, 31)
  const cap = endOfPrior < lastInYear ? endOfPrior : lastInYear
  if (cap < new Date(year, 0, 31)) return []
  const out: string[] = []
  for (let m = 0; m < 12; m++) {
    const monthEnd = new Date(year, m + 1, 0)
    if (monthEnd > cap) break
    if (monthEnd >= yearStart) out.push(toISODate(monthEnd))
  }
  return out
}

function varColor(v: number) {
  if (Math.abs(v) < 0.5) return undefined
  return v > 0 ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)'
}

function shortMonthLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

type CatMeta = { line_type: string; is_subtotal: boolean; sort_order: number }

export default function PnL() {
  const [periods, setPeriods] = useState<string[]>([])
  const [lines, setLines] = useState<PnLLine[]>([])
  const [observations, setObservations] = useState<string | null>(null)
  const [obsLoading, setObsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /** 'ytd' or an ISO period_end string */
  const [selectedPeriod, setSelectedPeriod] = useState<'ytd' | string>('ytd')

  const calendarMonthKey = `${new Date().getFullYear()}-${new Date().getMonth()}`
  const idealMonthEnds = useMemo(() => {
    const prior = endOfPreviousMonth(new Date())
    return monthEndsInYearThroughPrior(YEAR, prior)
  }, [calendarMonthKey])

  const anchorMonth = idealMonthEnds.length ? idealMonthEnds[idealMonthEnds.length - 1] : null

  const loadData = useCallback(async () => {
    if (!anchorMonth || idealMonthEnds.length === 0) {
      setLines([])
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const n = idealMonthEnds.length
      const data = await getPnL(anchorMonth, Math.min(24, Math.max(n, 1)))
      setLines(data)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [anchorMonth, idealMonthEnds.length])

  useEffect(() => {
    getPnLPeriods()
      .then(setPeriods)
      .catch((e) => setErr(e.message))
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const loadObservations = useCallback(() => {
    if (!anchorMonth) return
    setObsLoading(true)
    setObservations(null)
    getPnLObservations(anchorMonth)
      .then((d) => setObservations(d.observations))
      .catch(() => setObservations('Could not generate observations.'))
      .finally(() => setObsLoading(false))
  }, [anchorMonth])

  const monthCols = useMemo(() => {
    const have = new Set(lines.map((l) => l.period_end))
    return idealMonthEnds.filter((p) => have.has(p))
  }, [lines, idealMonthEnds])

  /** Tabs: YTD 26 first, then newest month → oldest */
  const periodTabs = useMemo((): Array<{ id: 'ytd' | string; label: string }> => {
    const ytdLabel = `YTD ${String(YEAR).slice(-2)}`
    const monthTabs = [...monthCols].reverse().map((pe) => ({ id: pe, label: shortMonthLabel(pe) }))
    return [{ id: 'ytd', label: ytdLabel }, ...monthTabs]
  }, [monthCols])

  const byPeriod: Record<string, Record<string, { actual: number; plan: number | null }>> = useMemo(() => {
    const m: Record<string, Record<string, { actual: number; plan: number | null }>> = {}
    for (const l of lines) {
      if (!m[l.period_end]) m[l.period_end] = {}
      m[l.period_end][l.category] = { actual: l.amount, plan: l.plan_amount ?? null }
    }
    return m
  }, [lines])

  const categories = useMemo(() => {
    const meta: Record<string, CatMeta> = {}
    const order: string[] = []
    for (const l of lines) {
      if (!order.includes(l.category)) order.push(l.category)
      meta[l.category] = {
        line_type: l.line_type,
        is_subtotal: l.is_subtotal,
        sort_order: l.sort_order,
      }
    }
    order.sort((a, b) => (meta[a].sort_order - meta[b].sort_order) || a.localeCompare(b))
    return { order, meta }
  }, [lines])

  const ytdFor = useCallback(
    (cat: string) => {
      let a = 0
      let p: number | null = null
      let anyPlan = false
      for (const pe of monthCols) {
        const cell = byPeriod[pe]?.[cat]
        if (cell) {
          a += cell.actual
          if (cell.plan != null) {
            anyPlan = true
            p = (p ?? 0) + cell.plan
          }
        }
      }
      return { actual: a, plan: anyPlan ? p : null }
    },
    [byPeriod, monthCols],
  )

  const getValues = useCallback(
    (cat: string): { actual: number; plan: number | null } => {
      if (selectedPeriod === 'ytd') return ytdFor(cat)
      return byPeriod[selectedPeriod]?.[cat] ?? { actual: 0, plan: null }
    },
    [selectedPeriod, ytdFor, byPeriod],
  )

  const revenueMatcher = (c: string) => /^(total\s+)?revenue$/i.test(c.trim()) || /^total\s+sales$/i.test(c.trim())
  const gpMatcher = (c: string) => /gross\s+profit/i.test(c)
  const ebitdaMatcher = (c: string) => /^ebitda$/i.test(c.trim()) || /\bebitda\b/i.test(c)

  const marginPcts = useCallback(
    (numeratorMatcher: (c: string) => boolean): { actual: number | null; plan: number | null } => {
      let revCat: string | null = null
      let numCat: string | null = null
      for (const cat of categories.order) {
        if (!revCat && revenueMatcher(cat)) revCat = cat
        if (!numCat && numeratorMatcher(cat)) numCat = cat
      }
      const revVals = revCat ? getValues(revCat) : { actual: 0, plan: null }
      const numVals = numCat ? getValues(numCat) : { actual: 0, plan: null }
      const actualPct = Math.abs(revVals.actual) < 1e-9 ? null : (numVals.actual / revVals.actual) * 100
      const planPct =
        revVals.plan != null && numVals.plan != null && Math.abs(revVals.plan) >= 1e-9
          ? (numVals.plan / revVals.plan) * 100
          : null
      return { actual: actualPct, plan: planPct }
    },
    [categories.order, getValues],
  )

  // ── Styles ──────────────────────────────────────────────────────────────────

  const thStyle: CSSProperties = {
    textAlign: 'right',
    padding: '0.45rem 0.75rem',
    fontWeight: 500,
    color: 'var(--text-muted)',
    fontSize: '14px',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
  }
  const td: CSSProperties = {
    padding: '0.35rem 0.75rem',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    textAlign: 'right',
    fontFamily: 'var(--font-mono)',
    fontSize: '15px',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }
  const tdLabel: CSSProperties = {
    ...td,
    textAlign: 'left',
    position: 'sticky',
    left: 0,
    zIndex: 1,
    background: 'var(--bg)',
    boxShadow: '4px 0 8px rgba(0,0,0,0.15)',
    fontFamily: 'inherit',
    fontSize: '15px',
    minWidth: 220,
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', minHeight: 0 }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap', flexShrink: 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 600, color: 'var(--text)' }}>P&L</h1>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {YEAR} actuals vs plan
            {anchorMonth && (
              <> · through {new Date(anchorMonth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</>
            )}
          </p>
        </div>
      </div>

      {/* ── Period tab strip ────────────────────────────────────────────────── */}
      {!loading && monthCols.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          {periodTabs.map((tab) => {
            const isActive = tab.id === selectedPeriod
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedPeriod(tab.id)}
                style={{
                  padding: '0.45rem 1.1rem',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'transparent',
                  border: 'none',
                  borderBottomWidth: 2,
                  borderBottomStyle: 'solid',
                  borderBottomColor: isActive ? 'var(--accent)' : 'transparent',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  marginBottom: -1,
                  transition: 'color 0.15s',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── FP&A observations panel (above table) ──────────────────────────── */}
      <div
        style={{
          flexShrink: 0,
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
            {obsLoading ? 'Analyzing…' : observations ? 'Refresh' : 'Generate'}
          </button>
          {!observations && !obsLoading && anchorMonth && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Generate notes for <strong style={{ color: 'var(--text)' }}>{shortMonthLabel(anchorMonth)}</strong> and YTD through that month.
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

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          overflow: 'auto',
        }}
      >
        {loading ? (
          <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>Loading…</p>
        ) : monthCols.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', padding: '1rem', maxWidth: 520 }}>
            No completed months in {YEAR} yet, or no P&L rows in the database.
            {periods.length === 0 && ' Run Data Sync → Parse for P&L first.'}
          </p>
        ) : (
          <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2, boxShadow: '4px 0 8px rgba(0,0,0,0.12)' }}>
                  Line item
                </th>
                <th style={{ ...thStyle, minWidth: 110 }}>Actual</th>
                <th style={{ ...thStyle, minWidth: 110 }}>Plan</th>
                <th style={{ ...thStyle, minWidth: 100 }}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {categories.order.map((cat) => {
                const meta = categories.meta[cat]
                const fw = meta.is_subtotal ? 600 : 400
                const bg = meta.is_subtotal ? 'rgba(255,255,255,0.05)' : undefined
                const cell = getValues(cat)
                const v = cell.actual - (cell.plan ?? 0)
                // Cost items: spending less than plan is favorable (green).
                // Revenue subtotals (Gross profit, EBITDA, Net Income) keep normal logic.
                const isCostRow = (meta.line_type === 'cogs' || meta.line_type === 'opex')
                  || (meta.line_type === 'other' && !meta.is_subtotal)
                const vColor = v != null ? varColor(isCostRow ? -v : v) : undefined
                const isGP = gpMatcher(cat)
                const isEBITDA = ebitdaMatcher(cat)
                return (
                  <>
                    <tr key={cat} style={{ background: bg }}>
                      <td
                        style={{
                          ...tdLabel,
                          fontWeight: fw,
                          color: meta.is_subtotal ? 'var(--text)' : 'var(--text-muted)',
                          background: bg ?? 'var(--bg)',
                        }}
                      >
                        {cat}
                      </td>
                      <td style={{ ...td, fontWeight: fw, background: bg }}>{fmt(cell.actual)}</td>
                      <td style={{ ...td, color: 'var(--text-muted)', fontWeight: fw, background: bg }}>
                        {cell.plan != null ? fmt(cell.plan) : '—'}
                      </td>
                      <td style={{ ...td, color: vColor, fontWeight: fw, background: bg }}>
                        {v != null ? fmt(v) : '—'}
                      </td>
                    </tr>
                    {isGP && (() => {
                      const gp = marginPcts(gpMatcher)
                      const gpVar = gp.actual != null && gp.plan != null ? gp.actual - gp.plan : null
                      const gpVarColor = gpVar != null ? (gpVar >= 0 ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)') : undefined
                      return (
                        <tr key={`${cat}-gp-margin`} style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <td style={{ ...tdLabel, fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)', paddingLeft: '1.5rem', fontStyle: 'italic' }}>
                            Gross profit margin
                          </td>
                          <td style={{ ...td, fontSize: '0.78rem', fontWeight: 400, color: 'var(--text)', background: 'rgba(255,255,255,0.03)' }}>
                            {fmtPct1(gp.actual)}
                          </td>
                          <td style={{ ...td, fontSize: '0.78rem', fontWeight: 400, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)' }}>
                            {fmtPct1(gp.plan)}
                          </td>
                          <td style={{ ...td, fontSize: '0.78rem', fontWeight: 400, color: gpVarColor, background: 'rgba(255,255,255,0.03)' }}>
                            {gpVar != null ? `${gpVar >= 0 ? '+' : ''}${gpVar.toFixed(1)}pp` : '—'}
                          </td>
                        </tr>
                      )
                    })()}
                    {isEBITDA && (() => {
                      const eb = marginPcts(ebitdaMatcher)
                      const ebVar = eb.actual != null && eb.plan != null ? eb.actual - eb.plan : null
                      const ebVarColor = ebVar != null ? (ebVar >= 0 ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)') : undefined
                      return (
                        <tr key={`${cat}-ebitda-margin`} style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <td style={{ ...tdLabel, fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)', paddingLeft: '1.5rem', fontStyle: 'italic' }}>
                            EBITDA margin
                          </td>
                          <td style={{ ...td, fontSize: '0.78rem', fontWeight: 400, color: 'var(--text)', background: 'rgba(255,255,255,0.03)' }}>
                            {fmtPct1(eb.actual)}
                          </td>
                          <td style={{ ...td, fontSize: '0.78rem', fontWeight: 400, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)' }}>
                            {fmtPct1(eb.plan)}
                          </td>
                          <td style={{ ...td, fontSize: '0.78rem', fontWeight: 400, color: ebVarColor, background: 'rgba(255,255,255,0.03)' }}>
                            {ebVar != null ? `${ebVar >= 0 ? '+' : ''}${ebVar.toFixed(1)}pp` : '—'}
                          </td>
                        </tr>
                      )
                    })()}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
