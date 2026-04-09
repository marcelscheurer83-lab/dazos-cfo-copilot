import { useEffect, useState } from 'react'
import { getCashFlow, type CashFlowLine } from '../api'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

function fmtPeriod(s: string) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function varColor(v: number) {
  if (Math.abs(v) < 0.5) return undefined
  return v > 0 ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)'
}

const SECTIONS = ['operating', 'investing', 'financing'] as const
type Section = (typeof SECTIONS)[number]

type PeriodData = { actual: number; plan: number | null }

export default function CashFlow() {
  const [lines, setLines] = useState<CashFlowLine[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCashFlow(undefined, 6)
      .then(setLines)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (lines.length === 0) return <p style={{ color: 'var(--text-muted)' }}>No cash flow data. Sync your financial model first.</p>

  const displayPeriods = [...new Set(lines.map((l) => l.period_end))].sort().slice(-3).reverse()

  // Build section → category → period map
  type SectionMap = Record<string, Record<string, Record<string, PeriodData>>>
  const data: SectionMap = {}
  const catOrderBySec: Record<string, string[]> = {}

  for (const l of lines) {
    if (!data[l.section]) data[l.section] = {}
    if (!catOrderBySec[l.section]) catOrderBySec[l.section] = []
    if (!data[l.section][l.category]) {
      data[l.section][l.category] = {}
      catOrderBySec[l.section].push(l.category)
    }
    data[l.section][l.category][l.period_end] = { actual: l.amount, plan: l.plan_amount ?? null }
  }

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
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>Cash Flow</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
        Actual vs plan. Positive variance = more cash inflow / less outflow than planned.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left', width: 220 }} />
              {displayPeriods.map((p) => (
                <th key={p} colSpan={3} style={{ ...thStyle, textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
                  {fmtPeriod(p)}
                </th>
              ))}
            </tr>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left' }}>Category</th>
              {displayPeriods.flatMap((p) => [
                <th key={`${p}-a`} style={{ ...thStyle, borderLeft: '1px solid var(--border)' }}>Actual</th>,
                <th key={`${p}-p`} style={thStyle}>Plan</th>,
                <th key={`${p}-v`} style={thStyle}>Var</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map((section) => {
              const cats = catOrderBySec[section] ?? []
              if (cats.length === 0) return null

              // Section totals
              const sectionTotals: Record<string, { actual: number; plan: number | null }> = {}
              for (const p of displayPeriods) {
                const actualSum = cats.reduce((s, c) => s + (data[section]?.[c]?.[p]?.actual ?? 0), 0)
                const planLines = cats.map((c) => data[section]?.[c]?.[p]?.plan ?? null)
                const planSum = planLines.every((v) => v === null) ? null : planLines.reduce((s, v) => (s ?? 0) + (v ?? 0), null as number | null)
                sectionTotals[p] = { actual: actualSum, plan: planSum }
              }

              return [
                <tr key={`${section}-header`}>
                  <td
                    colSpan={1 + displayPeriods.length * 3}
                    style={{
                      padding: '0.6rem 0.75rem',
                      fontWeight: 600,
                      fontSize: '0.78rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--text-muted)',
                      background: 'var(--surface-hover, rgba(255,255,255,0.03))',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {section}
                  </td>
                </tr>,
                ...cats.map((cat) => (
                  <tr key={`${section}-${cat}`}>
                    <td style={{ padding: '0.45rem 0.75rem 0.45rem 1.25rem', borderBottom: '1px solid var(--border)', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {cat}
                    </td>
                    {displayPeriods.flatMap((p) => {
                      const d = data[section]?.[cat]?.[p]
                      const actual = d?.actual
                      const plan = d?.plan ?? null
                      const variance = actual != null && plan != null ? actual - plan : null
                      const vColor = variance != null ? varColor(variance) : undefined
                      return [
                        <td key={`${p}-a`} style={{ ...tdBase, borderLeft: '1px solid var(--border)' }}>
                          {actual != null ? fmt(actual) : '—'}
                        </td>,
                        <td key={`${p}-p`} style={{ ...tdBase, color: 'var(--text-muted)' }}>
                          {plan != null ? fmt(plan) : '—'}
                        </td>,
                        <td key={`${p}-v`} style={{ ...tdBase, color: vColor }}>
                          {variance != null ? fmt(variance) : '—'}
                        </td>,
                      ]
                    })}
                  </tr>
                )),
                <tr key={`${section}-total`} style={{ background: 'var(--surface-hover, rgba(255,255,255,0.04))' }}>
                  <td style={{ padding: '0.45rem 0.75rem', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: '0.85rem' }}>
                    Net {section}
                  </td>
                  {displayPeriods.flatMap((p) => {
                    const d = sectionTotals[p]
                    const variance = d.plan != null ? d.actual - d.plan : null
                    const vColor = variance != null ? varColor(variance) : undefined
                    return [
                      <td key={`${p}-a`} style={{ ...tdBase, borderLeft: '1px solid var(--border)', fontWeight: 600 }}>
                        {fmt(d.actual)}
                      </td>,
                      <td key={`${p}-p`} style={{ ...tdBase, color: 'var(--text-muted)', fontWeight: 600 }}>
                        {d.plan != null ? fmt(d.plan) : '—'}
                      </td>,
                      <td key={`${p}-v`} style={{ ...tdBase, color: vColor, fontWeight: 600 }}>
                        {variance != null ? fmt(variance) : '—'}
                      </td>,
                    ]
                  })}
                </tr>,
              ]
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
