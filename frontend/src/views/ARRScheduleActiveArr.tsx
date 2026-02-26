import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getARRScheduleActiveArr, syncSalesforce, type ActiveARRRow } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

type SortKey = 'account_name' | 'status' | 'segment' | 'subscription_start_date' | 'subscription_end_date' | 'no_new_business' | 'active_arr'
type SortDir = 'asc' | 'desc'
type FilterColumn = 'segment' | 'status'

export default function ARRScheduleActiveArrView() {
  const [rows, setRows] = useState<ActiveARRRow[]>([])
  const [grandTotal, setGrandTotal] = useState(0)
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('active_arr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterSegment, setFilterSegment] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const segmentThRef = useRef<HTMLTableHeaderCellElement>(null)
  const segmentPopoverRef = useRef<HTMLDivElement>(null)
  const statusThRef = useRef<HTMLTableHeaderCellElement>(null)
  const statusPopoverRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    getARRScheduleActiveArr()
      .then((res) => {
        setRows(res.rows || [])
        setGrandTotal(res.grand_total ?? 0)
        setSalesforceBaseUrl(
          res.salesforce_base_url &&
          (res.salesforce_base_url.includes('salesforce.com') || res.salesforce_base_url.includes('lightning.force.com'))
            ? res.salesforce_base_url
            : undefined
        )
      })
      .catch((e) => setErr(e.message))
  }, [])

  const handleSyncSalesforce = useCallback(() => {
    setSyncStatus('loading')
    setSyncMessage(null)
    syncSalesforce()
      .then((res) => {
        if (res.ok) {
          setSyncStatus('ok')
          setSyncMessage(
            res.synced_opportunities != null && res.synced_line_items != null
              ? `Synced ${res.synced_opportunities} opportunities, ${res.synced_line_items} product lines.`
              : 'Sync complete.'
          )
          load()
        } else {
          setSyncStatus('error')
          setSyncMessage(res.error ?? 'Sync failed')
        }
      })
      .catch((e) => {
        setSyncStatus('error')
        setSyncMessage(e.message ?? 'Sync failed')
      })
  }, [load])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (openFilter === null) return
    const thRef = openFilter === 'segment' ? segmentThRef : openFilter === 'status' ? statusThRef : null
    const popRef = openFilter === 'segment' ? segmentPopoverRef : openFilter === 'status' ? statusPopoverRef : null
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (thRef?.current?.contains(t) || popRef?.current?.contains(t)) return
      setOpenFilter(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openFilter])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'account_name' || key === 'status' || key === 'segment' || key === 'subscription_start_date' || key === 'subscription_end_date' || key === 'no_new_business' ? 'asc' : 'desc')
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      if (sortKey === 'account_name') {
        const av = (a.account_name ?? '').toLowerCase()
        const bv = (b.account_name ?? '').toLowerCase()
        return dir * (av < bv ? -1 : av > bv ? 1 : 0)
      }
      if (sortKey === 'segment') {
        const av = (a.segment ?? 'SMB/ MM').trim().toLowerCase()
        const bv = (b.segment ?? 'SMB/ MM').trim().toLowerCase()
        return dir * (av < bv ? -1 : av > bv ? 1 : 0)
      }
      if (sortKey === 'status') {
        const av = (a.status ?? '').trim().toLowerCase()
        const bv = (b.status ?? '').trim().toLowerCase()
        return dir * (av < bv ? -1 : av > bv ? 1 : 0)
      }
      if (sortKey === 'subscription_start_date') {
        const av = a.subscription_start_date ?? ''
        const bv = b.subscription_start_date ?? ''
        return dir * (av < bv ? -1 : av > bv ? 1 : 0)
      }
      if (sortKey === 'subscription_end_date') {
        const av = a.subscription_end_date ?? ''
        const bv = b.subscription_end_date ?? ''
        return dir * (av < bv ? -1 : av > bv ? 1 : 0)
      }
      if (sortKey === 'no_new_business') {
        const av = a.no_new_business ? 1 : 0
        const bv = b.no_new_business ? 1 : 0
        return dir * (av - bv)
      }
      return dir * ((a.active_arr ?? 0) - (b.active_arr ?? 0))
    })
  }, [rows, sortKey, sortDir])

  const segmentOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const seg = (r.segment ?? 'SMB/ MM').trim() || 'SMB/ MM'
      set.add(seg)
    }
    return Array.from(set).sort()
  }, [rows])

  const statusOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const st = (r.status ?? '').trim() || ''
      set.add(st)
    }
    return Array.from(set).sort()
  }, [rows])

  const displayRows = useMemo(() => {
    let out = sortedRows
    if (filterSegment.length > 0) {
      out = out.filter((r) => {
        const seg = (r.segment ?? 'SMB/ MM').trim() || 'SMB/ MM'
        return filterSegment.includes(seg)
      })
    }
    if (filterStatus.length > 0) {
      out = out.filter((r) => {
        const st = (r.status ?? '').trim() || ''
        return filterStatus.includes(st)
      })
    }
    return out
  }, [sortedRows, filterSegment, filterStatus])

  const hasActiveFilter = filterSegment.length > 0 || filterStatus.length > 0
  const grandTotalDisplay =
    hasActiveFilter ? displayRows.reduce((s, r) => s + (r.active_arr ?? 0), 0) : grandTotal

  const th = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => {
    const isActive = sortKey === key
    return (
      <th
        role="button"
        tabIndex={0}
        onClick={() => handleSort(key)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort(key)}
        style={{
          textAlign: align,
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {label}
        {isActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </th>
    )
  }

  const popoverStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: '100%',
    marginTop: 2,
    zIndex: 50,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.5rem',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    minWidth: 140,
  }

  const thSegmentFilter = () => {
    const isOpen = openFilter === 'segment'
    const isSortActive = sortKey === 'segment'
    const hasActiveFilter = filterSegment.length > 0
    return (
      <th
        ref={segmentThRef}
        style={{
          textAlign: 'left',
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          position: 'relative',
          verticalAlign: 'bottom',
        }}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={() => handleSort('segment')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort('segment')}
          style={{
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          Segment
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenFilter((f) => (f === 'segment' ? null : 'segment'))
          }}
          title="Filter by segment"
          style={{
            marginLeft: 4,
            padding: 2,
            background: hasActiveFilter ? 'var(--accent)' : 'transparent',
            color: hasActiveFilter ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ⋮
        </button>
        {isOpen && (
          <div
            ref={segmentPopoverRef}
            style={popoverStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <select
              multiple
              size={Math.min(6, Math.max(2, segmentOptions.length))}
              value={filterSegment}
              onChange={(e) => setFilterSegment(Array.from(e.target.selectedOptions, (o) => o.value))}
              style={{
                padding: '0.35rem 0.5rem',
                fontSize: '0.9rem',
                width: '100%',
                border: '1px solid var(--border)',
                borderRadius: 4,
                background: 'var(--bg)',
                color: 'var(--text)',
              }}
            >
              {segmentOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>Ctrl+click to select multiple</p>
            {filterSegment.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterSegment([])}
                style={{
                  marginTop: '0.35rem',
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  background: 'var(--bg)',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </th>
    )
  }

  const thStatusFilter = () => {
    const isOpen = openFilter === 'status'
    const isSortActive = sortKey === 'status'
    const hasActiveFilter = filterStatus.length > 0
    return (
      <th
        ref={statusThRef}
        style={{
          textAlign: 'left',
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          position: 'relative',
          verticalAlign: 'bottom',
        }}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={() => handleSort('status')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort('status')}
          style={{
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          Status
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenFilter((f) => (f === 'status' ? null : 'status'))
          }}
          title="Filter by status"
          style={{
            marginLeft: 4,
            padding: 2,
            background: hasActiveFilter ? 'var(--accent)' : 'transparent',
            color: hasActiveFilter ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ⋮
        </button>
        {isOpen && (
          <div
            ref={statusPopoverRef}
            style={popoverStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <select
              multiple
              size={Math.min(6, Math.max(2, statusOptions.length))}
              value={filterStatus}
              onChange={(e) => setFilterStatus(Array.from(e.target.selectedOptions, (o) => o.value))}
              style={{
                padding: '0.35rem 0.5rem',
                fontSize: '0.9rem',
                width: '100%',
                border: '1px solid var(--border)',
                borderRadius: 4,
                background: 'var(--bg)',
                color: 'var(--text)',
              }}
            >
              {statusOptions.map((opt) => (
                <option key={opt || '__empty__'} value={opt}>
                  {opt || '—'}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>Ctrl+click to select multiple</p>
            {filterStatus.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterStatus([])}
                style={{
                  marginTop: '0.35rem',
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  background: 'var(--bg)',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </th>
    )
  }

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
        Contracted ARR
      </h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        <strong>Contracted ARR</strong> = most recent closed-won renewal or new business + expansions after it, by account.
      </p>

      <p style={{ marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={handleSyncSalesforce}
          disabled={syncStatus === 'loading'}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            cursor: syncStatus === 'loading' ? 'wait' : 'pointer',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          {syncStatus === 'loading' ? 'Syncing…' : 'Sync from Salesforce'}
        </button>
        {hasActiveFilter && (
          <button
            type="button"
            onClick={() => {
              setFilterSegment([])
              setFilterStatus([])
              setOpenFilter(null)
            }}
            style={{
              marginLeft: '0.5rem',
              padding: '0.5rem 1rem',
              fontSize: '0.9rem',
              cursor: 'pointer',
              background: 'var(--surface)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            Clear filter
          </button>
        )}
        {syncStatus === 'ok' && syncMessage && (
          <span style={{ marginLeft: '0.75rem', fontSize: '0.9rem', color: 'var(--positive)' }}>{syncMessage}</span>
        )}
        {syncStatus === 'error' && syncMessage && (
          <span style={{ marginLeft: '0.75rem', fontSize: '0.9rem', color: 'var(--negative)' }}>{syncMessage}</span>
        )}
      </p>

      {err && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{err}</p>}
      {rows.length === 0 && !err && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No Closed Won opportunities found.</p>
      )}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              minWidth: 600,
              borderCollapse: 'collapse',
              fontSize: '0.9rem',
              color: 'var(--text)',
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {th('account_name', 'Account', 'left')}
                {thStatusFilter()}
                {thSegmentFilter()}
                {th('subscription_start_date', 'Subscription start')}
                {th('subscription_end_date', 'Subscription end')}
                {th('no_new_business', 'Note')}
                {th('active_arr', 'Contracted ARR', 'right')}
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
                <td style={{ padding: '0.5rem 0.75rem' }} />
                <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
              </tr>
              {displayRows.map((row, idx) => (
                <tr key={row.account_id ?? row.account_name ?? idx} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {row.account_id && salesforceBaseUrl ? (
                      <a
                        href={
                          salesforceBaseUrl.includes('lightning.force.com')
                            ? `${salesforceBaseUrl}/lightning/r/Account/${row.account_id}/view`
                            : `${salesforceBaseUrl}/${row.account_id}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'none' }}
                        title="Open in Salesforce"
                      >
                        {row.account_name}
                      </a>
                    ) : (
                      row.account_name
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {row.status?.trim() ? row.status : '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {row.segment?.trim() ? row.segment : '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>{row.subscription_start_date ?? '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>{row.subscription_end_date ?? '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {row.note ? (
                      <span style={{ color: 'var(--warning, #b8860b)', fontWeight: 500 }}>{row.note}</span>
                    ) : row.no_new_business ? (
                      <span style={{ color: 'var(--warning, #b8860b)', fontWeight: 500 }}>Renewals only</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 600, color: 'var(--text)' }}>
                    {fmtMoney(row.active_arr)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
                <td colSpan={6} style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                  Total
                </td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}
