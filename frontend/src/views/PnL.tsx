import { useEffect, useState } from 'react'
import { getPnL, type PnLLine } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtPeriod(s: string) {
  return new Date(s).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export default function PnL() {
  const [lines, setLines] = useState<PnLLine[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getPnL(undefined, 3)
      .then(setLines)
      .catch((e) => setErr(e.message))
  }, [])

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>

  const periods = [...new Set(lines.map((l) => l.period_end))].sort().reverse()

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600 }}>P&L</h1>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                Line
              </th>
              {periods.map((p) => (
                <th key={p} style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                  {fmtPeriod(p)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const byCategory: Record<string, Record<string, number>> = {}
              lines.forEach((l) => {
                if (!byCategory[l.category]) byCategory[l.category] = {}
                byCategory[l.category][l.period_end] = l.amount
              })
              const categories = [...new Set(lines.map((l) => l.category))]
              return categories.map((cat) => (
                <tr key={cat}>
                  <td style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', fontWeight: lines.find((l) => l.category === cat)?.is_subtotal ? 600 : 400 }}>
                    {cat}
                  </td>
                  {periods.map((p) => {
                    const amt = byCategory[cat]?.[p]
                    const isNeg = amt != null && amt < 0
                    return (
                      <td key={p} className={isNeg ? 'negative' : ''} style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>
                        {amt != null ? fmtMoney(amt) : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))
            })()}
          </tbody>
        </table>
      </div>
    </>
  )
}
