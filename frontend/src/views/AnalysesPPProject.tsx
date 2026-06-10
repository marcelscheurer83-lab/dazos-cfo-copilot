import { useEffect, useState } from 'react'
import {
  exportPPProjectToSheet,
  getPPProjectExport,
  type PPProjectExportResponse,
  type PPProjectExportRow,
} from '../api'

const SHEET_TAB = "P&P project export_May '26"

function fmtMoney0(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtCohortMonth(ym: string) {
  if (!ym || ym.length < 7) return ym || '—'
  const [y, m] = ym.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  if (!y || !m || m < 1 || m > 12) return ym
  return `${months[m - 1]} ${y}`
}

export default function AnalysesPPProject() {
  const [data, setData] = useState<PPProjectExportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportUrl, setExportUrl] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getPPProjectExport()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  const handleExport = () => {
    setExportStatus('loading')
    setExportMessage(null)
    setExportUrl(null)
    exportPPProjectToSheet()
      .then((res) => {
        if (res.ok) {
          setExportStatus('ok')
          setExportUrl(res.spreadsheet_url ?? null)
          setExportMessage(res.message ?? `Exported to "${SHEET_TAB}".`)
        } else {
          setExportStatus('error')
          setExportMessage(res.error ?? 'Export failed')
        }
      })
      .catch((e) => {
        setExportStatus('error')
        setExportMessage(e instanceof Error ? e.message : 'Export failed')
      })
  }

  const rows: PPProjectExportRow[] = data?.rows ?? []
  const preview = rows.slice(0, 50)

  return (
    <div style={{ maxWidth: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: '0 0 0.35rem', fontSize: '1.15rem', fontWeight: 600, color: 'var(--text)' }}>
            P&amp;P Project (May &apos;26)
          </h2>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 720, lineHeight: 1.45 }}>
            Investor snapshot as of May 31, 2026 — one row per customer × active product SKU.
            Total ARR reconciles to the ARR bridge; cohort month is the first month with ARR &gt; 0;
            subscription dates reflect the term active at month-end; quantity = CRM seats, IQ/MR locations, or RVK agents where applicable.
          </p>
          {data?.as_of && (
            <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {data.account_count.toLocaleString()} accounts · {data.line_count.toLocaleString()} rows · {fmtMoney0(data.grand_total)} total ARR
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exportStatus === 'loading' || loading || !!error}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.85rem',
            fontWeight: 600,
            borderRadius: 6,
            border: 'none',
            cursor: exportStatus === 'loading' || loading || error ? 'not-allowed' : 'pointer',
            background: 'var(--accent)',
            color: '#fff',
            opacity: exportStatus === 'loading' || loading || error ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {exportStatus === 'loading' ? 'Exporting…' : `Export to "${SHEET_TAB}"`}
        </button>
      </div>

      {exportMessage && (
        <p style={{ fontSize: '0.85rem', color: exportStatus === 'error' ? 'var(--negative)' : 'var(--text)', marginBottom: '0.75rem' }}>
          {exportMessage}
          {exportUrl && (
            <>
              {' '}
              <a href={exportUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                Open sheet
              </a>
            </>
          )}
        </p>
      )}

      {loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading preview…</p>}
      {error && !loading && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{error}</p>}

      {!loading && !error && rows.length > 0 && (
        <>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Preview (first {preview.length} of {rows.length} rows)
          </p>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                  {[
                    'Customer',
                    'Total ARR',
                    'Cohort',
                    'Sub start',
                    'Sub end',
                    'Product SKU',
                    'SKU ARR',
                    'Qty',
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: h === 'Customer' || h === 'Product SKU' ? 'left' : 'right',
                        padding: '0.45rem 0.6rem',
                        fontWeight: 500,
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={`${r.customer_name}-${r.product_sku}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.45rem 0.6rem', color: 'var(--text)' }}>{r.customer_name}</td>
                    <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>{fmtMoney0(r.total_customer_arr)}</td>
                    <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtCohortMonth(r.cohort_month)}</td>
                    <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: 'var(--text-muted)' }}>{r.subscription_start || '—'}</td>
                    <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: 'var(--text-muted)' }}>{r.subscription_end || '—'}</td>
                    <td style={{ padding: '0.45rem 0.6rem', color: 'var(--text)' }}>{r.product_sku || '—'}</td>
                    <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>{r.sku_arr != null ? fmtMoney0(r.sku_arr) : '—'}</td>
                    <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                      {r.quantity != null ? r.quantity.toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!loading && !error && rows.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No export data for May 2026. Sync from Salesforce first.</p>
      )}
    </div>
  )
}
