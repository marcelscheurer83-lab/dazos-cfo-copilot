import { useEffect, useState } from 'react'
import { getARRByAccountProduct, syncSalesforce, type ARRByAccountProductResponse } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

export default function ARR() {
  const [data, setData] = useState<ARRByAccountProductResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

  const loadData = () => {
    getARRByAccountProduct()
      .then(setData)
      .catch((e) => setErr(e.message))
  }

  // Auto-sync from Salesforce when the page loads so data is fresh without clicking the button
  useEffect(() => {
    setSyncStatus('loading')
    setSyncMessage(null)
    syncSalesforce()
      .then((res) => {
        if (res.ok) {
          setSyncStatus('ok')
          setSyncMessage(
            `Synced ${res.synced_opportunities ?? 0} opportunities, ${res.synced_line_items ?? 0} product lines. ${res.renewal_opportunities_count ?? 0} open renewal(s) for ARR.`
          )
          loadData()
        } else {
          setSyncStatus('error')
          setSyncMessage(res.error ?? 'Sync failed')
          loadData() // still load whatever is in the DB
        }
      })
      .catch((e) => {
        setSyncStatus('error')
        setSyncMessage(e.message ?? 'Sync failed')
        loadData() // still load whatever is in the DB
      })
  }, [])

  const handleSyncSalesforce = () => {
    setSyncStatus('loading')
    setSyncMessage(null)
    syncSalesforce()
      .then((res) => {
        if (res.ok) {
          setSyncStatus('ok')
          setSyncMessage(
            `Synced ${res.synced_opportunities ?? 0} opportunities, ${res.synced_line_items ?? 0} product lines. ${res.renewal_opportunities_count ?? 0} open renewal(s) for ARR.`
          )
          loadData()
        } else {
          setSyncStatus('error')
          setSyncMessage(res.error ?? 'Sync failed')
        }
      })
      .catch((e) => {
        setSyncStatus('error')
        setSyncMessage(e.message ?? 'Sync failed')
      })
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!data)
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        {syncStatus === 'loading' ? 'Syncing from Salesforce…' : 'Loading…'}
      </p>
    )

  const { products, rows, total_by_product, grand_total } = data
  const productLabels = products.map((p) => (p === '—' ? 'Product' : p))

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Customer overview</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Rows = accounts. Columns = ARR by product (Dazos product list; open renewals only). Last column = total ARR per account. ARR = MRR × 12. iVerify Monthly Credits and Kipu API excluded from ARR.
      </p>
      <p style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleSyncSalesforce}
          disabled={syncStatus === 'loading'}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: syncStatus === 'loading' ? 'wait' : 'pointer',
            background: 'var(--bg)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          {syncStatus === 'loading' ? 'Syncing…' : 'Sync from Salesforce'}
        </button>
        {syncStatus === 'ok' && syncMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--positive)' }}>{syncMessage}</span>
        )}
        {syncStatus === 'error' && syncMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--negative)' }}>{syncMessage}</span>
        )}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 400, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontWeight: 500, position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>
                Account
              </th>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                Segment
              </th>
              {products.map((p, i) => (
                <th key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {productLabels[i]}
                </th>
              ))}
              <th style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', right: 0, background: 'var(--surface)', zIndex: 1 }}>
                Total ARR
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.account_id ?? row.account_name} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', left: 0, background: 'var(--bg)', zIndex: 0 }}>{row.account_name}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{row.segment?.trim() ? row.segment : 'SMB/ MM'}</td>
                {products.map((p) => (
                  <td key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {fmtMoney(row.by_product[p] ?? 0)}
                  </td>
                ))}
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 600, color: 'var(--text)', position: 'sticky', right: 0, background: 'var(--bg)', zIndex: 0 }}>{fmtMoney(row.total_arr)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} />
              {products.map((p) => (
                <td key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {fmtMoney(total_by_product[p] ?? 0)}
                </td>
              ))}
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', right: 0, background: 'var(--surface)', zIndex: 1 }}>{fmtMoney(grand_total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>No accounts with open renewal opportunities.</p>
      )}
    </>
  )
}
