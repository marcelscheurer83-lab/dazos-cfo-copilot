import { useCallback, useEffect, useMemo, useState } from 'react'
import { getContractedPipeline, refreshAppDataset, getDatasetStatus, type ContractedPipelineRow, type DatasetStatus } from '../api'

function formatDatasetUpdatedUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
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
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus | null>(null)

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
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
    getDatasetStatus()
      .then(setDatasetStatus)
      .catch(() => setDatasetStatus(null))
  }, [])

  const handleRefreshAppData = useCallback(async () => {
    setRefreshMessage(null)
    setRefreshLoading(true)
    try {
      const res = await refreshAppDataset()
      setRefreshLoading(false)
      if (res.ok) {
        setRefreshMessage('Refresh started — running in the background.')
      } else {
        setRefreshMessage(res.error ?? 'Refresh failed to start.')
      }
    } catch (e: unknown) {
      setRefreshLoading(false)
      setRefreshMessage(e instanceof Error ? e.message : 'Refresh failed')
    }
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

  function setSort(key: SortKey, defaultDir: 'asc' | 'desc') {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(defaultDir)
    }
  }

  const stickyHeaderCell: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 3,
    background: 'var(--ns-sticky-bg, var(--surface))',
    boxShadow: '0 1px 0 var(--border)',
  }

  const stickyTotalCell: React.CSSProperties = {
    position: 'sticky',
    top: '2.5rem',
    zIndex: 2,
    background: 'var(--ns-sticky-bg, var(--surface))',
    boxShadow: '0 1px 0 var(--border)',
  }

  if (loading) {
    return (
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Loading…</p>
    )
  }

  if (err) {
    return (
      <p style={{ fontSize: '0.9rem', color: 'var(--negative)' }}>{err}</p>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
          Contracted ARR Pipeline
        </h1>
        <button
          type="button"
          onClick={handleRefreshAppData}
          disabled={refreshLoading}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: refreshLoading ? 'wait' : 'pointer',
            background: 'var(--accent)',
            color: 'var(--accent-contrast, #fff)',
            border: 'none',
            borderRadius: 6,
          }}
        >
          {refreshLoading ? 'Refreshing…' : 'Refresh app data'}
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {datasetStatus?.updated_at
            ? `Last updated: ${formatDatasetUpdatedUtc(datasetStatus.updated_at)}`
            : 'No refresh yet'}
        </span>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {sorted.length} future-start subscription{sorted.length !== 1 ? 's' : ''} ·{' '}
          delta to Contracted ARR: <strong style={{ color: 'var(--text)' }}>{fmtMoney(totalArr)}</strong>
        </span>
      </div>
      {refreshMessage && (
        <p style={{
          fontSize: '0.9rem',
          color: refreshMessage.includes('failed') || refreshMessage.includes('error') ? 'var(--negative)' : 'var(--text-muted)',
          margin: '0 0 1rem',
        }}>
          {refreshMessage}
        </p>
      )}

      {rows.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No future-start Closed Won subscriptions found.</p>
      ) : (
        <div
          style={
            {
              minWidth: 0,
              overflow: 'auto',
              ['--ns-sticky-bg' as string]: '#10141c',
            } as React.CSSProperties
          }
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'separate',
              borderSpacing: 0,
            }}
          >
            <thead>
              <tr>
                {/* Account */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setSort('account_name', 'asc')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSort('account_name', 'asc') }}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    title={sortKey === 'account_name' ? (sortDir === 'asc' ? 'Sorted A→Z — click for Z→A' : 'Sorted Z→A — click for A→Z') : 'Sort by account name A→Z'}
                  >
                    Account
                    {sortKey === 'account_name' && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </span>
                </th>
                {/* SFDC ID */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  18 Digit SFDC Acct ID
                </th>
                {/* Type */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Type
                </th>
                {/* Status */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Status
                </th>
                {/* Start date */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setSort('contract_start_date', 'asc')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSort('contract_start_date', 'asc') }}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    title={sortKey === 'contract_start_date' ? (sortDir === 'asc' ? 'Sorted earliest first — click to reverse' : 'Sorted latest first — click to reverse') : 'Sort by subscription start date (earliest first)'}
                  >
                    Subscription start date
                    {sortKey === 'contract_start_date' && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </span>
                </th>
                {/* End date */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Subscription end date
                </th>
                {/* ARR */}
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'right',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setSort('arr', 'desc')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSort('arr', 'desc') }}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    title={sortKey === 'arr' ? (sortDir === 'desc' ? 'Sorted largest first — click for smallest first' : 'Sorted smallest first — click for largest first') : 'Sort by ARR (largest first)'}
                  >
                    ARR
                    {sortKey === 'arr' && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Sticky total row */}
              <tr style={{ fontWeight: 600 }}>
                <td style={{ ...stickyTotalCell, padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
                <td style={{ ...stickyTotalCell, padding: '0.5rem 0.75rem' }} />
                <td style={{ ...stickyTotalCell, padding: '0.5rem 0.75rem' }} />
                <td style={{ ...stickyTotalCell, padding: '0.5rem 0.75rem' }} />
                <td style={{ ...stickyTotalCell, padding: '0.5rem 0.75rem' }} />
                <td style={{ ...stickyTotalCell, padding: '0.5rem 0.75rem' }} />
                <td
                  style={{
                    ...stickyTotalCell,
                    textAlign: 'right',
                    padding: '0.5rem 0.75rem',
                    fontWeight: 600,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtMoney(totalArr)}
                </td>
              </tr>
              {sorted.map((row, idx) => {
                const href = accountHref(salesforceBaseUrl, row.account_id)
                return (
                  <tr key={`${row.account_id}-${idx}`}>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" title="Open account in Salesforce">
                          {row.account_name}
                        </a>
                      ) : (
                        row.account_name
                      )}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }} title={row.account_id}>
                      {row.account_id || '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>
                      {row.type ?? '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {row.status?.trim() ? row.status : '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {row.contract_start_date ?? '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {row.contract_end_date ?? '—'}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        padding: '0.5rem 0.75rem',
                        fontWeight: 400,
                        color: 'var(--text)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fmtMoney(row.arr)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
