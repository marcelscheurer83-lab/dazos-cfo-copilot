import { useEffect, useState, useMemo, useCallback, type CSSProperties } from 'react'
import { getCashFlow, getCFObservations, type CashFlowLine } from '../api'

const YEAR = 2026

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

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

function shortMonthLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function varColor(v: number) {
  if (Math.abs(v) < 0.5) return undefined
  return v > 0 ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)'
}

const SECTION_ORDER = ['operating', 'investing', 'financing'] as const
type Section = typeof SECTION_ORDER[number]
const SECTION_LABELS: Record<Section, string> = {
  operating: 'Operating Activities',
  investing: 'Investing Activities',
  financing: 'Financing Activities',
}

export default function CashFlow() {
  const [lines, setLines] = useState<CashFlowLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selectedPeriod, setSelectedPeriod] = useState<'ytd' | string>('ytd')
  const [observations, setObservations] = useState<string | null>(null)
  const [obsLoading, setObsLoading] = useState(false)

  const calendarMonthKey = `${new Date().getFullYear()}-${new Date().getMonth()}`
  const idealMonthEnds = useMemo(() => {
    const prior = endOfPreviousMonth(new Date())
    return monthEndsInYearThroughPrior(YEAR, prior)
  }, [calendarMonthKey])

  const anchorMonth = idealMonthEnds.length ? idealMonthEnds[idealMonthEnds.length - 1] : null

  useEffect(() => {
    if (!anchorMonth) { setLoading(false); return }
    getCashFlow(anchorMonth, idealMonthEnds.length)
      .then(setLines)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [anchorMonth, idealMonthEnds.length])

  const monthCols = useMemo(() => {
    const have = new Set(lines.map((l) => l.period_end))
    return idealMonthEnds.filter((p) => have.has(p))
  }, [lines, idealMonthEnds])

  const periodTabs = useMemo((): Array<{ id: 'ytd' | string; label: string }> => {
    const ytdLabel = `YTD ${String(YEAR).slice(-2)}`
    return [{ id: 'ytd', label: ytdLabel }, ...[...monthCols].reverse().map((pe) => ({ id: pe, label: shortMonthLabel(pe) }))]
  }, [monthCols])

  // section → category → period → {actual, plan}; also track subtotal flag per category
  const byData = useMemo(() => {
    const m: Record<string, Record<string, Record<string, { actual: number; plan: number | null }>>> = {}
    const order: Record<string, string[]> = {}
    const subtotals: Record<string, Record<string, boolean>> = {}
    const sorted = [...lines].sort((a, b) => a.sort_order - b.sort_order)
    for (const l of sorted) {
      if (!m[l.section]) { m[l.section] = {}; order[l.section] = []; subtotals[l.section] = {} }
      if (!m[l.section][l.category]) { m[l.section][l.category] = {}; order[l.section].push(l.category) }
      m[l.section][l.category][l.period_end] = { actual: l.amount, plan: l.plan_amount ?? null }
      subtotals[l.section][l.category] = l.is_subtotal ?? false
    }
    return { m, order, subtotals }
  }, [lines])

  const loadObservations = useCallback(() => {
    if (!anchorMonth) return
    setObsLoading(true)
    setObservations(null)
    getCFObservations(anchorMonth)
      .then((d) => setObservations(d.observations))
      .catch(() => setObservations('Could not generate observations.'))
      .finally(() => setObsLoading(false))
  }, [anchorMonth])

  const getCell = useCallback(
    (section: string, cat: string): { actual: number; plan: number | null } => {
      if (selectedPeriod === 'ytd') {
        let a = 0; let p: number | null = null; let anyPlan = false
        for (const pe of monthCols) {
          const c = byData.m[section]?.[cat]?.[pe]
          if (c) { a += c.actual; if (c.plan != null) { anyPlan = true; p = (p ?? 0) + c.plan } }
        }
        return { actual: a, plan: anyPlan ? p : null }
      }
      return byData.m[section]?.[cat]?.[selectedPeriod] ?? { actual: 0, plan: null }
    },
    [selectedPeriod, monthCols, byData],
  )

  // ── Styles ─────────────────────────────────────────────────────────────────
  const thStyle: CSSProperties = {
    textAlign: 'right', padding: '0.45rem 0.75rem', fontWeight: 500,
    color: 'var(--text-muted)', fontSize: '14px', whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)', background: 'var(--surface)',
  }
  const td: CSSProperties = {
    padding: '0.35rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.06)',
    textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '15px',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  }
  const tdLabel: CSSProperties = {
    ...td, textAlign: 'left', position: 'sticky', left: 0, zIndex: 1,
    background: 'var(--bg)', boxShadow: '4px 0 8px rgba(0,0,0,0.15)',
    fontFamily: 'inherit', fontSize: '15px', minWidth: 240,
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>

  const sections = SECTION_ORDER.filter((s) => (byData.order[s]?.length ?? 0) > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 600, color: 'var(--text)' }}>Cash Flow</h1>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {YEAR} actuals vs plan
          {anchorMonth && <> · through {new Date(anchorMonth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</>}
        </p>
      </div>

      {/* Period tab strip */}
      {!loading && monthCols.length > 0 && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {periodTabs.map((tab) => {
            const isActive = tab.id === selectedPeriod
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedPeriod(tab.id)}
                style={{
                  padding: '0.45rem 1.1rem', fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  background: 'transparent', border: 'none',
                  borderBottomWidth: 2, borderBottomStyle: 'solid',
                  borderBottomColor: isActive ? 'var(--accent)' : 'transparent',
                  cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1,
                  transition: 'color 0.15s',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      )}

      {/* FP&A observations panel */}
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

      {/* Table */}
      <div style={{ flex: 1, minHeight: 0, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', overflow: 'auto' }}>
        {loading ? (
          <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>Loading…</p>
        ) : monthCols.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', padding: '1rem', maxWidth: 520 }}>
            No completed months in {YEAR} yet, or no Cash Flow data. Run Data Sync → Parse first.
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
              {sections.map((section) => {
                const cats = byData.order[section] ?? []
                return [
                  // Section header
                  <tr key={`${section}-hdr`}>
                    <td
                      colSpan={4}
                      style={{
                        padding: '0.55rem 0.75rem',
                        fontWeight: 600, fontSize: '0.72rem',
                        textTransform: 'uppercase', letterSpacing: '0.07em',
                        color: 'var(--text-muted)',
                        background: 'rgba(255,255,255,0.03)',
                        borderBottom: '1px solid var(--border)',
                        position: 'sticky', left: 0,
                      }}
                    >
                      {SECTION_LABELS[section]}
                    </td>
                  </tr>,

                  // Category rows — real subtotal rows from data get bold treatment
                  ...cats.map((cat) => {
                    const c = getCell(section, cat)
                    const v = c.plan != null ? c.actual - c.plan : null
                    const isSub = byData.subtotals[section]?.[cat] ?? false
                    const rowBg = isSub ? 'rgba(255,255,255,0.05)' : undefined
                    return (
                      <tr key={`${section}-${cat}`} style={{ background: rowBg }}>
                        <td style={{
                          ...tdLabel,
                          background: rowBg ?? 'var(--bg)',
                          fontWeight: isSub ? 600 : 400,
                          color: isSub ? 'var(--text)' : 'var(--text-muted)',
                          paddingLeft: isSub ? '0.75rem' : '1.4rem',
                        }}>
                          {cat}
                        </td>
                        <td style={{ ...td, fontWeight: isSub ? 600 : 400 }}>{fmt(c.actual)}</td>
                        <td style={{ ...td, fontWeight: isSub ? 600 : 400, color: 'var(--text-muted)' }}>
                          {c.plan != null ? fmt(c.plan) : '—'}
                        </td>
                        <td style={{ ...td, fontWeight: isSub ? 600 : 400, color: v != null ? varColor(v) : undefined }}>
                          {v != null ? fmt(v) : '—'}
                        </td>
                      </tr>
                    )
                  }),
                ]
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
