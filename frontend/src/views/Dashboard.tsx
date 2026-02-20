import { useEffect, useState } from 'react'
import { getDashboardKPI, syncSalesforce, type DashboardKPI } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

/** Sync from Salesforce at most once per app session (when Dashboard first loads). */
const hasAutoSyncedThisSession = { current: false }

export default function Dashboard() {
  const [kpi, setKpi] = useState<DashboardKPI | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const fetchKpi = () => getDashboardKPI().then(setKpi).catch((e) => setErr(e.message))

    if (!hasAutoSyncedThisSession.current) {
      hasAutoSyncedThisSession.current = true
      syncSalesforce()
        .then((res) => {
          if (res.ok) fetchKpi()
          else fetchKpi()
        })
        .catch(() => fetchKpi())
    } else {
      fetchKpi()
    }
  }, [])

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!kpi) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  const cards = [
    { label: 'CARR', value: fmtMoney(kpi.arr), sub: 'Contracted ARR' },
    { label: 'Pipeline', value: fmtMoney(kpi.pipeline), sub: 'Open opportunities' },
  ]

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600 }}>Dashboard</h1>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        {cards.map((c) => (
          <div
            key={c.label}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '1rem 1.25rem',
            }}
          >
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{c.label}</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>{c.value}</div>
            {c.sub && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{c.sub}</div>}
          </div>
        ))}
      </div>
    </>
  )
}
