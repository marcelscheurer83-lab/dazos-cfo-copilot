import { useEffect, useState } from 'react'
import { getBudgetVsActual, type BudgetVsActual } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

export default function BudgetVsActual() {
  const [rows, setRows] = useState<BudgetVsActual[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getBudgetVsActual()
      .then(setRows)
      .catch((e) => setErr(e.message))
  }, [])

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600 }}>Budget vs actual</h1>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                Category
              </th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                Budget
              </th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                Actual
              </th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                Variance
              </th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500 }}>
                %
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.period_end}-${r.category}`}>
                <td style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>{r.category}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>{fmtMoney(r.budget_amount)}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>{fmtMoney(r.actual_amount)}</td>
                <td className={r.variance > 0 ? 'negative' : r.variance < 0 ? 'positive' : ''} style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>
                  {fmtMoney(r.variance)}
                </td>
                <td className={r.variance_pct != null && r.variance_pct > 0 ? 'negative' : r.variance_pct != null && r.variance_pct < 0 ? 'positive' : ''} style={{ textAlign: 'right', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)' }}>
                  {r.variance_pct != null ? `${r.variance_pct}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
