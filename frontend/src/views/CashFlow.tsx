import { useEffect, useState } from 'react'
import { getCashFlow, type CashFlowLine } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtPeriod(s: string) {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export default function CashFlow() {
  const [lines, setLines] = useState<CashFlowLine[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getCashFlow(undefined, 3)
      .then(setLines)
      .catch((e) => setErr(e.message))
  }, [])

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>

  const byPeriod = lines.reduce<Record<string, CashFlowLine[]>>((acc, l) => {
    if (!acc[l.period_end]) acc[l.period_end] = []
    acc[l.period_end].push(l)
    return acc
  }, {})
  const periods = Object.keys(byPeriod).sort().reverse()

  const sections = ['operating', 'investing', 'financing'] as const

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600 }}>Cash flow</h1>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                Section / Category
              </th>
              {periods.map((p) => (
                <th key={p} style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                  {fmtPeriod(p)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => {
              const sectionLines = lines.filter((l) => l.section === section)
              const cats = [...new Set(sectionLines.map((l) => l.category))]
              return cats.map((cat) => (
                <tr key={`${section}-${cat}`}>
                  <td style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ textTransform: 'capitalize', color: 'var(--text-muted)', marginRight: '0.5rem' }}>{section}</span>
                    {cat}
                  </td>
                  {periods.map((p) => {
                    const line = byPeriod[p]?.find((l) => l.section === section && l.category === cat)
                    const amt = line?.amount
                    const isNeg = amt != null && amt < 0
                    return (
                      <td key={p} className={isNeg ? 'negative' : ''} style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>
                        {amt != null ? fmtMoney(amt) : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
