import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getARRScheduleActiveARRByMonth, syncSalesforce, exportCopilotARRScheduleToSheet, type ActiveARRByMonthRow } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function shortMonthLabel(monthKey: string) {
  const [y, m] = monthKey.split('-').map(Number)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[m - 1]} '${String(y).slice(2)}`
}

type SortKey = 'account_name' | 'account_id' | 'status' | 'segment' | 'type' | 'subscription_start_date' | 'subscription_end_date' | 'active_arr' | 'total_all_months' | (string & {})
type SortDir = 'asc' | 'desc'
type FilterColumn = 'segment' | 'status' | 'type'

export default function ARRScheduleActiveArrView() {
  const [rows, setRows] = useState<ActiveARRByMonthRow[]>([])
  const [months, setMonths] = useState<string[]>([])
  const [totalsByMonth, setTotalsByMonth] = useState<Record<string, number>>({})
  const [grandTotal, setGrandTotal] = useState(0)
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportSpreadsheetUrl, setExportSpreadsheetUrl] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('account_name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filterSegment, setFilterSegment] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<string[]>([])
  const [filterType, setFilterType] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const segmentThRef = useRef<HTMLTableHeaderCellElement>(null)
  const segmentPopoverRef = useRef<HTMLDivElement>(null)
  const statusThRef = useRef<HTMLTableHeaderCellElement>(null)
  const statusPopoverRef = useRef<HTMLDivElement>(null)
  const typeThRef = useRef<HTMLTableHeaderCellElement>(null)
  const typePopoverRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    getARRScheduleActiveARRByMonth()
      .then((res) => {
        setRows(res.rows || [])
        setMonths(res.months ?? [])
        setTotalsByMonth(res.totals_by_month ?? {})
        setGrandTotal(res.rows?.reduce((s, r) => s + (r.active_arr ?? 0), 0) ?? 0)
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

  const handleExportToSheet = useCallback(() => {
    setExportStatus('loading')
    setExportMessage(null)
    setExportSpreadsheetUrl(null)
    exportCopilotARRScheduleToSheet()
      .then((res) => {
        if (res.ok) {
          setExportStatus('ok')
          setExportSpreadsheetUrl(res.spreadsheet_url ?? null)
          let msg =
            res.message ?? (res.rows_written != null ? `Exported ${res.rows_written} rows to "Copilot ARR export" sheet.` : 'Exported to "Copilot ARR export" sheet.')
          if (res.read_back?.length) {
            const header = (res.read_back[0] ?? []).slice(0, 5).join(' | ')
            msg += ` Read back: ${header}${(res.read_back[0]?.length ?? 0) > 5 ? '…' : ''}`
          }
          if (res.range_used) msg += ` Range: ${res.range_used}`
          setExportMessage(msg)
        } else {
          setExportStatus('error')
          setExportMessage(res.error ?? 'Export failed')
        }
      })
      .catch((e) => {
        setExportStatus('error')
        setExportMessage(e.message ?? 'Export failed')
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (openFilter === null) return
    const thRef =
      openFilter === 'segment' ? segmentThRef : openFilter === 'status' ? statusThRef : openFilter === 'type' ? typeThRef : null
    const popRef =
      openFilter === 'segment'
        ? segmentPopoverRef
        : openFilter === 'status'
          ? statusPopoverRef
          : openFilter === 'type'
            ? typePopoverRef
            : null
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
      setSortDir(key === 'account_name' || key === 'account_id' || key === 'status' || key === 'segment' || key === 'subscription_start_date' || key === 'subscription_end_date' ? 'asc' : 'desc')
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const totalAllMonths = (r: ActiveARRByMonthRow) =>
      months.reduce((s, m) => s + (r.by_month?.[m] ?? 0), 0)
    return [...rows].sort((a, b) => {
      if (sortKey === 'total_all_months') {
        return dir * (totalAllMonths(a) - totalAllMonths(b))
      }
      if (sortKey === 'account_name') {
        const av = (a.account_name ?? '').toLowerCase()
        const bv = (b.account_name ?? '').toLowerCase()
        return dir * (av < bv ? -1 : av > bv ? 1 : 0)
      }
      if (sortKey === 'account_id') {
        const av = (a.account_id ?? '').toLowerCase()
        const bv = (b.account_id ?? '').toLowerCase()
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
      if (sortKey === 'type') {
        const av = ((a as any).type ?? '').trim().toLowerCase()
        const bv = ((b as any).type ?? '').trim().toLowerCase()
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
      if (months.includes(sortKey)) {
        const av = a.by_month?.[sortKey] ?? 0
        const bv = b.by_month?.[sortKey] ?? 0
        return dir * (av - bv)
      }
      return dir * ((a.active_arr ?? 0) - (b.active_arr ?? 0))
    })
  }, [rows, sortKey, sortDir, months])

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

  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const t = (((r as any).type as string | null | undefined) ?? '').trim() || '—'
      set.add(t)
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
    if (filterType.length > 0) {
      out = out.filter((r) => {
        const t = (((r as any).type as string | null | undefined) ?? '').trim() || '—'
        return filterType.includes(t)
      })
    }
    return out
  }, [sortedRows, filterSegment, filterStatus, filterType])

  const hasActiveFilter = filterSegment.length > 0 || filterStatus.length > 0 || filterType.length > 0
  const grandTotalDisplay =
    hasActiveFilter ? displayRows.reduce((s, r) => s + (r.active_arr ?? 0), 0) : grandTotal

  const th = (key: SortKey, label: string, align: 'left' | 'right' = 'left', sticky = false) => {
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
          background: 'var(--surface)',
          ...(sticky
            ? {
                position: 'sticky' as const,
                left: 0,
                zIndex: 2,
                background: 'var(--surface)',
                borderRight: '1px solid var(--border)',
              }
            : {}),
        }}
      >
        {label}
        {isActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </th>
    )
  }

  const stickyFirstCell = (bg: string): React.CSSProperties => ({
    position: 'sticky',
    left: 0,
    zIndex: 1,
    background: bg,
    borderRight: '1px solid var(--border)',
  })

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
          background: 'var(--surface)',
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
          background: 'var(--surface)',
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

  const thTypeFilter = () => {
    const isOpen = openFilter === 'type'
    const isSortActive = sortKey === 'type'
    const hasActiveFilter = filterType.length > 0
    return (
      <th
        ref={typeThRef}
        style={{
          textAlign: 'left',
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          position: 'relative',
          verticalAlign: 'bottom',
          background: 'var(--surface)',
        }}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={() => handleSort('type')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort('type')}
          style={{
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          Type
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenFilter((f) => (f === 'type' ? null : 'type'))
          }}
          title="Filter by type"
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
            ref={typePopoverRef}
            style={popoverStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <select
              multiple
              size={Math.min(6, Math.max(2, typeOptions.length))}
              value={filterType}
              onChange={(e) => setFilterType(Array.from(e.target.selectedOptions, (o) => o.value))}
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
              {typeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>Ctrl+click to select multiple</p>
            {filterType.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterType([])}
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
        Schedule
      </h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        <strong>Active ARR as of today</strong> = ARR from the period that contains today. The schedule includes
        <strong> all closed-won new business and renewal</strong> periods per account (e.g. ex-post-added past NB before a renewal).
        Subscription start/end = earliest period start to latest period end.
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
        <button
          type="button"
          onClick={handleExportToSheet}
          disabled={exportStatus === 'loading' || rows.length === 0}
          style={{
            marginLeft: '0.5rem',
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            cursor: exportStatus === 'loading' || rows.length === 0 ? 'not-allowed' : 'pointer',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
          title={rows.length === 0 ? 'No data to export' : 'Export current schedule to the "Copilot ARR export" sheet in the financial model'}
        >
          {exportStatus === 'loading' ? 'Exporting…' : 'Export to Copilot ARR export'}
        </button>
        <span style={{ marginLeft: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Export writes to the &quot;Copilot ARR export&quot; tab in your financial model (create that tab if it doesn’t exist).
        </span>
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
        {exportStatus === 'ok' && exportMessage && (
          <span style={{ marginLeft: '0.75rem', fontSize: '0.9rem', color: 'var(--positive)' }}>
            {exportMessage}
            {exportSpreadsheetUrl && (
              <>
                {' '}
                <a
                  href={exportSpreadsheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  Open sheet
                </a>
              </>
            )}
          </span>
        )}
        {exportStatus === 'error' && exportMessage && (
          <span style={{ marginLeft: '0.75rem', fontSize: '0.9rem', color: 'var(--negative)' }}>{exportMessage}</span>
        )}
      </p>

      {err && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{err}</p>}
      {rows.length === 0 && !err && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No Closed Won opportunities found.</p>
      )}
      {rows.length > 0 && (
        <div
          style={{
            overflow: 'auto',
            maxHeight: 'calc(100vh - 12rem)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
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
              <tr
                style={{
                  borderBottom: '1px solid var(--border)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 3,
                  background: 'var(--surface)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                }}
              >
                {th('account_name', 'Account', 'left', true)}
                {th('account_id', '18 Digit SFDC Acct ID', 'left', false)}
                {thTypeFilter()}
                {thStatusFilter()}
                {thSegmentFilter()}
                {th('subscription_start_date', 'Subscription start')}
                {th('subscription_end_date', 'Subscription end')}
                {th('total_all_months', 'Active ARR (today)', 'right')}
                {months.map((m) => (
                  <th
                    key={m}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSort(m)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort(m)}
                    style={{
                      textAlign: 'right',
                      padding: '0.5rem 0.75rem',
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      userSelect: 'none',
                      background: 'var(--surface)',
                    }}
                  >
                    {shortMonthLabel(m)}
                    {sortKey === m && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', ...stickyFirstCell('var(--surface)') }}>Total</td>
                <td style={{ padding: '0.5rem 0.75rem' }} />
                <td style={{ padding: '0.5rem 0.75rem' }} />
                <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
                {months.map((m) => (
                  <td key={m} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {fmtMoney(totalsByMonth[m] ?? 0)}
                  </td>
                ))}
              </tr>
              {displayRows.map((row, idx) => (
                <tr
                  key={row.account_id ?? row.account_name ?? idx}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    color: row.no_new_business ? 'var(--warning, #b8860b)' : undefined,
                  }}
                >
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', ...stickyFirstCell('var(--bg)') }}>
                    {row.account_id && salesforceBaseUrl ? (
                      <a
                        href={
                          salesforceBaseUrl.includes('lightning.force.com')
                            ? `${salesforceBaseUrl}/lightning/r/Account/${row.account_id}/view`
                            : `${salesforceBaseUrl}/${row.account_id}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: row.no_new_business ? 'inherit' : 'var(--accent)', textDecoration: 'none' }}
                        title="Open in Salesforce"
                      >
                        {row.account_name}
                      </a>
                    ) : (
                      row.account_name
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }} title={row.account_id ?? undefined}>
                    {row.account_id ?? '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>
                    {(row as any).type ?? '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {row.status?.trim() ? row.status : '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {row.segment?.trim() ? row.segment : '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>{row.subscription_start_date ?? '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>{row.subscription_end_date ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 600, color: 'var(--text)' }}>
                    {fmtMoney(row.active_arr)}
                  </td>
                  {months.map((m) => (
                    <td key={m} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>
                      {(row.by_month?.[m] ?? 0) > 0 ? fmtMoney(row.by_month[m]) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
                <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)', ...stickyFirstCell('var(--surface)') }}>
                  Total
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }} />
                <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
                {months.map((m) => (
                  <td key={m} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {fmtMoney(totalsByMonth[m] ?? 0)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}
