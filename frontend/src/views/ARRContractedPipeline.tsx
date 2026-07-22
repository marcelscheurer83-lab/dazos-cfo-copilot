import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getContractedPipeline,
  type ContractedPipelineRow,
} from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`
}

function accountHref(base: string | undefined, accountId: string): string | null {
  if (!base || !accountId) return null
  return base.includes('lightning.force.com')
    ? `${base}/lightning/r/Account/${accountId}/view`
    : `${base}/${accountId}`
}

type SortKey = 'contract_start_date' | 'account_name' | 'arr'

export default function ARRContractedPipeline() {
  const [rows, setRows] = useState<ContractedPipelineRow[]>([])
  const [totalArr, setTotalArr] = useState<number>(0)
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('contract_start_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const load = useCallback(() => {
    setLoading(true)
    setErr(null)
    getContractedPipeline()
      .then((res) => {
        setRows(res.rows ?? [])
        setTotalArr(res.total_arr ?? 0)
        const b = res.salesforce_base_url
        setSalesforceBaseUrl(
          b && (b.includes('salesforce.com') || b.includes('lightning.force.com')) ? b : undefined
        )
      })
      .catch((e) => setErr(e.message ?? 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'contract_start_date') {
        cmp = (a.contract_start_date ?? '').localeCompare(b.contract_start_date ?? '')
      } else if (sortKey === 'account_name') {
        cmp = a.account_name.toLowerCase().localeCompare(b.account_name.toLowerCase())
      } else {
        cmp = a.arr - b.arr
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [rows, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'arr' ? 'desc' : 'asc')
    }
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span style={{ opacity: 0.3, marginLeft: 4 }}>⇅</span>
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const thStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    textAlign: 'left',
    fontSize: '0.72rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    userSelect: 'none',
    position: 'sticky',
    top: 0,
    background: 'var(--surface)',
    zIndex: 1,
  }

  const tdStyle: React.CSSProperties = {
    padding: '0.45rem 0.75rem',
    fontSize: '0.82rem',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  }

  const tfootTd: React.CSSProperties = {
    ...tdStyle,
    fontWeight: 700,
    borderTop: '2px solid var(--border)',
    borderBottom: 'none',
    background: 'var(--surface)',
    position: 'sticky',
    bottom: 0,
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
        Loading contracted pipeline…
      </div>
    )
  }

  if (err) {
    return (
      <div style={{ padding: '2rem', color: 'var(--danger, #e55)', fontSize: '0.875rem' }}>
        {err}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', marginBottom: '1rem', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
          Contracted ARR Pipeline
        </h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {sorted.length} subscription{sorted.length !== 1 ? 's' : ''} · future-start Closed Won ·{' '}
          <strong style={{ color: 'var(--text)' }}>{fmtMoney(totalArr)}</strong> total contracted delta
        </span>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          No future-start Closed Won subscriptions found.
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
            <thead>
              <tr>
                <th style={thStyle} onClick={() => toggleSort('account_name')}>
                  Account <SortIcon col="account_name" />
                </th>
                <th style={{ ...thStyle, cursor: 'default' }}>SFDC Account ID</th>
                <th style={{ ...thStyle, cursor: 'default' }}>Type</th>
                <th style={{ ...thStyle, cursor: 'default' }}>Status</th>
                <th style={thStyle} onClick={() => toggleSort('contract_start_date')}>
                  Start Date <SortIcon col="contract_start_date" />
                </th>
                <th style={{ ...thStyle, cursor: 'default' }}>End Date</th>
                <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('arr')}>
                  ARR <SortIcon col="arr" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const href = accountHref(salesforceBaseUrl, row.account_id)
                return (
                  <tr
                    key={`${row.account_id}-${i}`}
                    style={{ background: i % 2 === 0 ? 'transparent' : 'var(--surface-alt, rgba(255,255,255,0.02))' }}
                  >
                    <td style={tdStyle}>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--accent)', textDecoration: 'none' }}
                        >
                          {row.account_name}
                        </a>
                      ) : (
                        row.account_name
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {row.account_id || '—'}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{row.type || '—'}</td>
                    <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{row.status || '—'}</td>
                    <td style={tdStyle}>{fmtDate(row.contract_start_date)}</td>
                    <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{fmtDate(row.contract_end_date)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtMoney(row.arr)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={tfootTd} colSpan={6}>Total</td>
                <td style={{ ...tfootTd, textAlign: 'right' }}>{fmtMoney(totalArr)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
