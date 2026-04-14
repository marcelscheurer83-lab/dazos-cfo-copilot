import { useEffect, useState, useMemo, useCallback, type CSSProperties } from 'react'
import { getBalanceSheet, getBSObservations, type BalanceSheetLine } from '../api'

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

const SECTION_ORDER = ['asset', 'liability', 'equity'] as const
type Section = typeof SECTION_ORDER[number]
const SECTION_LABELS: Record<Section, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
}

export default function BalanceSheet() {
  const [lines, setLines] = useState<BalanceSheetLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  /** Balance sheet is a snapshot — "latest" month is the default tab */
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null)
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
    getBalanceSheet(anchorMonth, idealMonthEnds.length)
      .then(setLines)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [anchorMonth, idealMonthEnds.length])

  const monthCols = useMemo(() => {
    const have = new Set(lines.map((l) => l.period_end))
    return idealMonthEnds.filter((p) => have.has(p))
  }, [lines, idealMonthEnds])

  /** Default to newest month when data loads */
  const activePeriod = selectedPeriod ?? (monthCols.length ? monthCols[monthCols.length - 1] : null)

  /** Tabs: newest month first (no YTD — balance sheet is a point-in-time snapshot) */
  const periodTabs = useMemo(
    () => [...monthCols].reverse().map((pe) => ({ id: pe, label: shortMonthLabel(pe) })),
    [monthCols],
  )

  // section → category → period → {actual, plan, is_subtotal}
  const byData = useMemo(() => {
    type Cell = { actual: number; plan: number | null; is_subtotal: boolean }
    const m: Record<string, Record<string, Record<string, Cell>>> = {}
    const order: Record<string, string[]> = {}
    const meta: Record<string, boolean> = {} // `${section}__${cat}` → is_subtotal
    const sorted = [...lines].sort((a, b) => a.sort_order - b.sort_order)
    for (const l of sorted) {
      if (!m[l.section]) { m[l.section] = {}; order[l.section] = [] }
      if (!m[l.section][l.category]) {
        m[l.section][l.category] = {}
        order[l.section].push(l.category)
        meta[`${l.section}__${l.category}`] = l.is_subtotal
      }
      m[l.section][l.category][l.period_end] = { actual: l.amount, plan: l.plan_amount ?? null, is_subtotal: l.is_subtotal }
    }
    return { m, order, meta }
  }, [lines])

  const getCell = useCallback(
    (section: string, cat: string): { actual: number; plan: number | null } => {
      if (!activePeriod) return { actual: 0, plan: null }
      return byData.m[section]?.[cat]?.[activePeriod] ?? { actual: 0, plan: null }
    },
    [activePeriod, byData],
  )

  const loadObservations = useCallback(() => {
    if (!activePeriod) return
    setObsLoading(true)
    setObservations(null)
    getBSObservations(activePeriod)
      .then((d) => setObservations(d.observations))
      .catch(() => setObservations('Could not generate observations.'))
      .finally(() => setObsLoading(false))
  }, [activePeriod])

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
        <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 600, color: 'var(--text)' }}>Balance Sheet</h1>
        <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {YEAR} actuals vs plan · snapshot at period end
          {anchorMonth && <> · through {new Date(anchorMonth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</>}
        </p>
      </div>

      {/* Period tab strip */}
      {!loading && monthCols.length > 0 && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {periodTabs.map((tab) => {
            const isActive = tab.id === activePeriod
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
            disabled={obsLoading || !activePeriod}
            style={{
              background: obsLoading ? 'transparent' : 'var(--accent)',
              color: obsLoading ? 'var(--text-muted)' : '#fff',
              border: obsLoading ? '1px solid var(--border)' : 'none',
              borderRadius: 5,
              padding: '0.25rem 0.6rem',
              fontSize: '0.75rem',
              cursor: obsLoading || !activePeriod ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {obsLoading ? 'Analyzing…' : observations ? 'Refresh' : 'Generate'}
          </button>
          {!observations && !obsLoading && activePeriod && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Generate notes for <strong style={{ color: 'var(--text)' }}>{shortMonthLabel(activePeriod)}</strong> balance sheet.
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
            No completed months in {YEAR} yet, or no Balance Sheet data. Run Data Sync → Parse first.
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

                  // Category rows
                  ...cats.map((cat) => {
                    const key = `${section}__${cat}`
                    const isSubtotal = byData.meta[key] ?? false
                    const fw = isSubtotal ? 600 : 400
                    const bg = isSubtotal ? 'rgba(255,255,255,0.05)' : undefined
                    const c = getCell(section, cat)
                    const v = c.plan != null ? c.actual - c.plan : null
                    return (
                      <tr key={`${section}-${cat}`} style={{ background: bg }}>
                        <td
                          style={{
                            ...tdLabel,
                            fontWeight: fw,
                            color: isSubtotal ? 'var(--text)' : 'var(--text-muted)',
                            background: bg ?? 'var(--bg)',
                            paddingLeft: isSubtotal ? '0.75rem' : '1.25rem',
                          }}
                        >
                          {cat}
                        </td>
                        <td style={{ ...td, fontWeight: fw, background: bg }}>{fmt(c.actual)}</td>
                        <td style={{ ...td, fontWeight: fw, color: 'var(--text-muted)', background: bg }}>
                          {c.plan != null ? fmt(c.plan) : '—'}
                        </td>
                        <td style={{ ...td, fontWeight: fw, color: v != null ? varColor(v) : undefined, background: bg }}>
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
