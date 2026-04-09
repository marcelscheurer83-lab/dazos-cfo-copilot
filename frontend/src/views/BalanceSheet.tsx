import { useEffect, useState } from 'react'
import { getBalanceSheet, type BalanceSheetLine } from '../api'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

function fmtPeriod(s: string) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function varColor(v: number) {
  if (Math.abs(v) < 0.5) return undefined
  return v > 0 ? 'var(--positive, #22c55e)' : 'var(--negative, #ef4444)'
}

const SECTION_ORDER = ['asset', 'liability', 'equity']
const SECTION_LABELS: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
}

export default function BalanceSheet() {
  const [lines, setLines] = useState<BalanceSheetLine[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getBalanceSheet(undefined, 3)
      .then(setLines)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (lines.length === 0) return <p style={{ color: 'var(--text-muted)' }}>No balance sheet data. Sync your financial model first.</p>

  const displayPeriods = [...new Set(lines.map((l) => l.period_end))].sort().slice(-3).reverse()

  // Build section → category map preserving sort_order
  type CatData = Record<string, Record<string, { actual: number; plan: number | null; is_subtotal: boolean }>>
  const data: CatData = {}
  const catOrderBySec: Record<string, string[]> = {}
  const catMeta: Record<string, { is_subtotal: boolean }> = {}

  const sorted = [...lines].sort((a, b) => a.sort_order - b.sort_order)
  for (const l of sorted) {
    const key = `${l.section}__${l.category}`
    if (!data[l.section]) data[l.section] = {}
    if (!catOrderBySec[l.section]) catOrderBySec[l.section] = []
    if (!data[l.section][l.category]) {
      data[l.section][l.category] = {}
      catOrderBySec[l.section].push(l.category)
      catMeta[key] = { is_subtotal: l.is_subtotal }
    }
    data[l.section][l.category][l.period_end] = {
      actual: l.amount,
      plan: l.plan_amount ?? null,
      is_subtotal: l.is_subtotal,
    }
  }

  const thStyle: React.CSSProperties = {
    textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500,
    color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)',
  }
  const tdBase: React.CSSProperties = {
    padding: '0.45rem 0.75rem', borderBottom: '1px solid var(--border)', textAlign: 'right',
    fontFamily: 'var(--font-mono)', fontSize: '0.82rem', whiteSpace: 'nowrap',
  }

  const sections = SECTION_ORDER.filter((s) => catOrderBySec[s]?.length > 0)

  return (
    <>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>Balance Sheet</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
        Actual vs plan. Variance = actual − plan.
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
              <th style={{ ...thStyle, textAlign: 'left' }}>Line item</th>
              {displayPeriods.flatMap((p) => [
                <th key={`${p}-a`} style={{ ...thStyle, borderLeft: '1px solid var(--border)' }}>Actual</th>,
                <th key={`${p}-p`} style={thStyle}>Plan</th>,
                <th key={`${p}-v`} style={thStyle}>Var</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => {
              const cats = catOrderBySec[section] ?? []
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
                    {SECTION_LABELS[section] ?? section}
                  </td>
                </tr>,
                ...cats.map((cat) => {
                  const key = `${section}__${cat}`
                  const isSubtotal = catMeta[key]?.is_subtotal ?? false
                  return (
                    <tr
                      key={`${section}-${cat}`}
                      style={{ background: isSubtotal ? 'var(--surface-hover, rgba(255,255,255,0.04))' : undefined }}
                    >
                      <td
                        style={{
                          padding: `0.45rem 0.75rem 0.45rem ${isSubtotal ? '0.75rem' : '1.25rem'}`,
                          borderBottom: '1px solid var(--border)',
                          fontSize: '0.85rem',
                          fontWeight: isSubtotal ? 600 : 400,
                          color: isSubtotal ? 'var(--text)' : 'var(--text-muted)',
                        }}
                      >
                        {cat}
                      </td>
                      {displayPeriods.flatMap((p) => {
                        const d = data[section]?.[cat]?.[p]
                        const actual = d?.actual
                        const plan = d?.plan ?? null
                        const variance = actual != null && plan != null ? actual - plan : null
                        const vColor = variance != null ? varColor(variance) : undefined
                        return [
                          <td key={`${p}-a`} style={{ ...tdBase, borderLeft: '1px solid var(--border)', fontWeight: isSubtotal ? 600 : 400 }}>
                            {actual != null ? fmt(actual) : '—'}
                          </td>,
                          <td key={`${p}-p`} style={{ ...tdBase, color: 'var(--text-muted)' }}>
                            {plan != null ? fmt(plan) : '—'}
                          </td>,
                          <td key={`${p}-v`} style={{ ...tdBase, color: vColor, fontWeight: isSubtotal ? 600 : 400 }}>
                            {variance != null ? fmt(variance) : '—'}
                          </td>,
                        ]
                      })}
                    </tr>
                  )
                }),
              ]
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
