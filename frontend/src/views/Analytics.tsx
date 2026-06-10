import { useEffect, useState } from 'react'
import { getActiveARRAnalytics, type ActiveARRAnalyticsGroup } from '../api'
import ProductPenetration, { KeyTakeaways, accountsFromByGroup } from '../components/ProductPenetration'

function fmtMoney0(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

export default function AnalyticsView() {
  const [asOf, setAsOf] = useState<string | null>(null)
  const [groups, setGroups] = useState<ActiveARRAnalyticsGroup[]>([])
  const [grandTotal, setGrandTotal] = useState(0)
  const [penetrationAccounts, setPenetrationAccounts] = useState<ReturnType<typeof accountsFromByGroup>>([])
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    setErr(null)
    getActiveARRAnalytics()
      .then((arrRes) => {
        setAsOf(arrRes.as_of)
        setGroups(arrRes.groups || [])
        setGrandTotal(arrRes.grand_total ?? 0)
        setSalesforceBaseUrl(arrRes.salesforce_base_url ?? null)

        // Per-account reconciled family ARR (same accounts/ARR as the bridges, Alleva included).
        const allAccounts = accountsFromByGroup(arrRes.accounts ?? [])
        const withAtLeastOneProduct = allAccounts.filter(
          (a) => a.hasCrm || a.hasICampaign || a.hasIqMr || a.hasRvk
        )
        setPenetrationAccounts(withAtLeastOneProduct)
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoading(false))
  }, [])

  let asOfLabel: string | null = null
  if (asOf) {
    const parts = asOf.split('-').map((p) => Number(p))
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      const [y, m, d] = parts
      const localDate = new Date(y, m - 1, d) // Interpret as local calendar date, not UTC
      asOfLabel = localDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    } else {
      asOfLabel = asOf
    }
  }

  const tableTotal = groups.reduce((s, g) => s + (g.arr || 0), 0)
  const effectiveTotal = tableTotal > 0 ? tableTotal : grandTotal

  return (
    <div
      style={{
        background: 'var(--bg)',
        minHeight: '100%',
        margin: '0 -2rem',
        padding: '2rem',
      }}
    >
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
        Product penetration and white space analysis
      </h1>

      {loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading…</p>}
      {err && !loading && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{err}</p>}

      {!loading && !err && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: '0.75rem',
            maxWidth: '96%',
          }}
        >
          {/* Row 1: Key takeaways (left) | Active ARR by product line (right) */}
          <KeyTakeaways />
          {/* Active ARR by product line */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '1rem 1.25rem',
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                Active ARR by product line (incl. Alleva)
              </div>
              {asOfLabel && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  As of {asOfLabel}
                </div>
              )}
            </div>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Reconciled to the Total ARR bridge.
            </p>

            {groups.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No ARR schedule data found.</p>
            ) : (
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.85rem',
                  color: 'var(--text)',
                }}
              >
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                      Product line
                    </th>
                    <th style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                      Active ARR
                    </th>
                    <th style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                      Mix
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const mix = tableTotal > 0 && g.arr > 0 ? (g.arr / tableTotal) * 100 : 0
                    return (
                    <tr key={g.key ?? g.label} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{g.label}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney0(g.arr)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                        {g.arr > 0 ? `${mix.toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>Total</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney0(tableTotal)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>100%</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          {/* Rows 2–4: Product penetration panels (Depth | Per-product, Attach | Revenue, White space | Cross-sell) + selected depth */}
          {penetrationAccounts.length > 0 && (
            <ProductPenetration
              accounts={penetrationAccounts}
              salesforceBaseUrl={salesforceBaseUrl}
              currentArrTotal={effectiveTotal}
              panelsOnly
            />
          )}
        </div>
      )}
    </div>
  )
}

