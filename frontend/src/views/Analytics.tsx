import { useEffect, useState } from 'react'
import { getActiveARRAnalytics, getARRScheduleActiveARRByMonth, type ActiveARRAnalyticsGroup } from '../api'
import ProductPenetration, { KeyTakeaways, accountsFromByProduct, accountsFromByProductWithArr } from '../components/ProductPenetration'

function fmtMoney0(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

/** From as_of date "YYYY-MM-DD" return month key "YYYY-MM" for by_month lookups. */
function monthKeyFromAsOf(asOf: string): string {
  if (!asOf || asOf.length < 7) return ''
  return asOf.slice(0, 7)
}

/** The four product lines that add up to the table total; Other/Unmapped are excluded from total. */
const MAIN_PRODUCT_LABELS = ['CRM (Platform + Seats)', 'IQ', 'iCampaign', 'Marketing reports']

export default function AnalyticsView() {
  const [asOf, setAsOf] = useState<string | null>(null)
  const [groups, setGroups] = useState<ActiveARRAnalyticsGroup[]>([])
  const [grandTotal, setGrandTotal] = useState(0)
  const [penetrationAccounts, setPenetrationAccounts] = useState<ReturnType<typeof accountsFromByProduct>>([])
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    setErr(null)
    Promise.all([getActiveARRAnalytics(), getARRScheduleActiveARRByMonth()])
      .then(([arrRes, byMonthRes]) => {
        setAsOf(arrRes.as_of)
        setGroups(
          (arrRes.groups || []).filter(
            (g) =>
              (g.label || '').toLowerCase() !== 'other' &&
              !(g.label || '').toLowerCase().includes('premium support')
          )
        )
        setGrandTotal(arrRes.grand_total ?? 0)
        setSalesforceBaseUrl(byMonthRes.salesforce_base_url ?? null)

        const monthKey = monthKeyFromAsOf(arrRes.as_of ?? '')
        const rows = byMonthRes.rows ?? []
        const withActiveARR =
          monthKey === ''
            ? rows
            : rows.filter((row) => (row.by_month?.[monthKey] ?? 0) > 0)
        const allAccounts =
          monthKey
            ? accountsFromByProductWithArr(withActiveARR, monthKey)
            : accountsFromByProduct(withActiveARR)
        const withAtLeastOneProduct = allAccounts.filter(
          (a) => a.hasCrm || a.hasIq || a.hasICampaign || a.hasMr
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
                Active ARR by product line (excl. Alleva)
              </div>
              {asOfLabel && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  As of {asOfLabel}
                </div>
              )}
            </div>

            {groups.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No ARR schedule data found.</p>
            ) : (
              (() => {
                const totalFour = groups
                  .filter((g) => MAIN_PRODUCT_LABELS.includes(g.label))
                  .reduce((s, g) => s + g.arr, 0)
                return (
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
                    const isMain = MAIN_PRODUCT_LABELS.includes(g.label)
                    const pct = isMain && totalFour > 0 ? (g.arr / totalFour) * 100 : 0
                    return (
                      <tr key={g.label} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{g.label}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney0(g.arr)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                          {isMain && totalFour > 0 ? `${pct.toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>Total</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney0(totalFour)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>100%</td>
                  </tr>
                </tfoot>
              </table>
                )
              })()
            )}
          </div>

          {/* Rows 2–4: Product penetration panels (Depth | Per-product, Attach | Revenue, White space | Cross-sell) + selected depth */}
          {penetrationAccounts.length > 0 && (
            <ProductPenetration
              accounts={penetrationAccounts}
              salesforceBaseUrl={salesforceBaseUrl}
              currentArrTotal={grandTotal}
              panelsOnly
            />
          )}
        </div>
      )}
    </div>
  )
}

