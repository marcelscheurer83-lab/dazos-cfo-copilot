import { useEffect, useState } from 'react'
import { getPnL, type PnLLine } from '../api'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

function fmtPeriod(s: string) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function varColor(v: number, isExpense: boolean) {
  if (Math.abs(v) < 0.5) return undefined
  const favorable = isExpense ? v < 0 : v > 0
  return favorable ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)'
}

type Row = {
  category: string
  line_type: string
  is_subtotal: boolean
  byPeriod: Record<string, { actual: number; plan: number | null }>
  ytd: { actual: number; plan: number | null }
}

export default function PnL() {
  const [lines, setLines] = useState<PnLLine[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPnL(undefined, 12)
      .then(setLines)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (lines.length === 0) return <p style={{ color: 'var(--text-muted)' }}>No P&L data. Sync your financial model first.</p>

  const allPeriods = [...new Set(lines.map((l) => l.period_end))].sort()
  const latestYear = new Date(allPeriods[allPeriods.length - 1] + 'T12:00:00').getFullYear()
  const ytdPeriods = allPeriods.filter((p) => new Date(p + 'T12:00:00').getFullYear() === latestYear)
  const displayPeriods = allPeriods.slice(-3).reverse()

  // Build rows preserving order
  const catOrder: string[] = []
  const seen = new Set<string>()
  for (const l of lines) {
    if (!seen.has(l.category)) { seen.add(l.category); catOrder.push(l.category) }
  }

  const rows: Row[] = catOrder.map((cat) => {
    const catLines = lines.filter((l) => l.category === cat)
    const byPeriod: Record<string, { actual: number; plan: number | null }> = {}
    for (const l of catLines) {
      byPeriod[l.period_end] = { actual: l.amount, plan: l.plan_amount ?? null }
    }
    const ytdActual = ytdPeriods.reduce((s, p) => s + (byPeriod[p]?.actual ?? 0), 0)
    const ytdPlanLines = ytdPeriods.map((p) => byPeriod[p]?.plan ?? null)
    const ytdPlan = ytdPlanLines.every((v) => v === null) ? null : ytdPlanLines.reduce((s, v) => (s ?? 0) + (v ?? 0), null as number | null)
    const info = catLines[0]
    return { category: cat, line_type: info.line_type, is_subtotal: info.is_subtotal, byPeriod, ytd: { actual: ytdActual, plan: ytdPlan } }
  })

  const isExpenseRow = (r: Row) => ['cogs', 'opex'].includes(r.line_type)

  const thStyle: React.CSSProperties = {
    textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500,
    color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)',
  }
  const tdBase: React.CSSProperties = {
    padding: '0.45rem 0.75rem', borderBottom: '1px solid var(--border)', textAlign: 'right',
    fontFamily: 'var(--font-mono)', fontSize: '0.82rem', whiteSpace: 'nowrap',
  }

  return (
    <>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>P&L</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
        Actual vs plan — month and YTD. Variance = actual − plan.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
          <colgroup>
            <col style={{ width: '200px' }} />
            {displayPeriods.flatMap(() => [
              <col key="a" style={{ width: '100px' }} />,
              <col key="p" style={{ width: '90px' }} />,
              <col key="v" style={{ width: '90px' }} />,
            ])}
            <col style={{ width: '100px' }} />
            <col style={{ width: '90px' }} />
            <col style={{ width: '90px' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left', padding: '0.5rem 0.75rem' }} />
              {displayPeriods.map((p) => (
                <th key={p} colSpan={3} style={{ ...thStyle, textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
                  {fmtPeriod(p)}
                </th>
              ))}
              <th colSpan={3} style={{ ...thStyle, textAlign: 'center', borderLeft: '2px solid var(--border)', color: 'var(--accent)' }}>
                YTD {latestYear}
              </th>
            </tr>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left' }}>Line item</th>
              {displayPeriods.flatMap((p) => [
                <th key={`${p}-a`} style={{ ...thStyle, borderLeft: '1px solid var(--border)' }}>Actual</th>,
                <th key={`${p}-p`} style={thStyle}>Plan</th>,
                <th key={`${p}-v`} style={thStyle}>Var</th>,
              ])}
              <th style={{ ...thStyle, borderLeft: '2px solid var(--border)' }}>Actual</th>
              <th style={thStyle}>Plan</th>
              <th style={thStyle}>Var</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isExp = isExpenseRow(row)
              return (
                <tr
                  key={row.category}
                  style={{
                    background: row.is_subtotal ? 'var(--surface-hover, rgba(255,255,255,0.04))' : undefined,
                  }}
                >
                  <td
                    style={{
                      padding: '0.45rem 0.75rem',
                      borderBottom: '1px solid var(--border)',
                      fontWeight: row.is_subtotal ? 600 : 400,
                      fontSize: '0.85rem',
                      color: row.is_subtotal ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    {row.category}
                  </td>
                  {displayPeriods.flatMap((p) => {
                    const d = row.byPeriod[p]
                    const actual = d?.actual
                    const plan = d?.plan ?? null
                    const variance = actual != null && plan != null ? actual - plan : null
                    const pct = variance != null && plan != null && plan !== 0 ? (variance / Math.abs(plan)) * 100 : null
                    const vColor = variance != null ? varColor(variance, isExp) : undefined
                    return [
                      <td key={`${p}-a`} style={{ ...tdBase, borderLeft: '1px solid var(--border)', fontWeight: row.is_subtotal ? 600 : 400 }}>
                        {actual != null ? fmt(actual) : '—'}
                      </td>,
                      <td key={`${p}-p`} style={{ ...tdBase, color: 'var(--text-muted)' }}>
                        {plan != null ? fmt(plan) : '—'}
                      </td>,
                      <td key={`${p}-v`} style={{ ...tdBase, color: vColor, fontWeight: row.is_subtotal ? 600 : 400 }}>
                        {variance != null ? (
                          <>
                            {fmt(variance)}
                            {pct != null && (
                              <span style={{ fontSize: '0.72rem', marginLeft: '0.3rem', opacity: 0.8 }}>
                                {fmtPct(pct)}
                              </span>
                            )}
                          </>
                        ) : '—'}
                      </td>,
                    ]
                  })}
                  {/* YTD */}
                  {(() => {
                    const ytdActual = row.ytd.actual
                    const ytdPlan = row.ytd.plan
                    const ytdVar = ytdPlan != null ? ytdActual - ytdPlan : null
                    const ytdPct = ytdVar != null && ytdPlan !== 0 && ytdPlan != null ? (ytdVar / Math.abs(ytdPlan)) * 100 : null
                    const ytdColor = ytdVar != null ? varColor(ytdVar, isExp) : undefined
                    return (
                      <>
                        <td style={{ ...tdBase, borderLeft: '2px solid var(--border)', fontWeight: row.is_subtotal ? 700 : 400 }}>
                          {fmt(ytdActual)}
                        </td>
                        <td style={{ ...tdBase, color: 'var(--text-muted)' }}>
                          {ytdPlan != null ? fmt(ytdPlan) : '—'}
                        </td>
                        <td style={{ ...tdBase, color: ytdColor, fontWeight: row.is_subtotal ? 700 : 400 }}>
                          {ytdVar != null ? (
                            <>
                              {fmt(ytdVar)}
                              {ytdPct != null && (
                                <span style={{ fontSize: '0.72rem', marginLeft: '0.3rem', opacity: 0.8 }}>
                                  {fmtPct(ytdPct)}
                                </span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                      </>
                    )
                  })()}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
