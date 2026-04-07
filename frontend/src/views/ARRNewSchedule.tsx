import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getNewScheduleAccounts,
  exportNewScheduleToSheet,
  refreshAppDataset,
  getDatasetStatus,
  type NewScheduleAccountRow,
  type DatasetStatus,
} from '../api'

const DATASET_REFRESH_TIMEOUT_MS = 15 * 60 * 1000

function isLegacyQuickBooksBanner(msg: string | null | undefined): boolean {
  if (msg == null || msg === '') return false
  const s = msg.toLowerCase()
  return (
    s.includes('quickbooks') ||
    s.includes('profitandloss') ||
    s.includes('token refresh failed') ||
    s.includes('invalid refresh token')
  )
}

function formatDatasetUpdatedUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
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

type FilterColumn = 'status' | 'type'

function normType(r: NewScheduleAccountRow): string {
  return (r.type ?? '').trim() || '—'
}

function normStatus(r: NewScheduleAccountRow): string {
  return (r.status ?? '').trim() || ''
}

/** Fallback if API omits ``month_columns`` (Dec '25–Dec '26). */
const NEW_SCHEDULE_MONTH_KEYS_DEFAULT = [
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
  '2026-12',
] as const

function monthKeyToLabel(ym: string): string {
  const parts = ym.split('-')
  if (parts.length !== 2) return ym
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (Number.isNaN(y) || Number.isNaN(m) || m < 1 || m > 12) return ym
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[m - 1]} '${String(y).slice(2)}`
}

export default function ARRNewSchedule() {
  const [rows, setRows] = useState<NewScheduleAccountRow[]>([])
  const [monthColumns, setMonthColumns] = useState<string[]>(() => [...NEW_SCHEDULE_MONTH_KEYS_DEFAULT])
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string[]>([])
  const [filterType, setFilterType] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportSpreadsheetUrl, setExportSpreadsheetUrl] = useState<string | null>(null)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus | null>(null)
  /** `live_arr` + `desc` = largest ARR first (default). `account_name` + `asc` = A→Z. */
  const [sortKey, setSortKey] = useState<'live_arr' | 'account_name'>('live_arr')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const statusThRef = useRef<HTMLTableHeaderCellElement>(null)
  const statusPopoverRef = useRef<HTMLDivElement>(null)
  const typeThRef = useRef<HTMLTableHeaderCellElement>(null)
  const typePopoverRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    setErr(null)
    getNewScheduleAccounts()
      .then((res) => {
        setRows(res.rows ?? [])
        if (res.month_columns && res.month_columns.length > 0) setMonthColumns(res.month_columns)
        const b = res.salesforce_base_url
        setSalesforceBaseUrl(
          b && (b.includes('salesforce.com') || b.includes('lightning.force.com')) ? b : undefined
        )
      })
      .catch((e) => setErr(e.message ?? 'Failed to load'))
    getDatasetStatus()
      .then(setDatasetStatus)
      .catch(() => setDatasetStatus(null))
  }, [])

  const handleRefreshAppData = useCallback(() => {
    setRefreshMessage(null)
    setRefreshLoading(true)
    const ac = new AbortController()
    const timeoutId = window.setTimeout(() => ac.abort(), DATASET_REFRESH_TIMEOUT_MS)
    refreshAppDataset(ac.signal)
      .then((res) => {
        window.clearTimeout(timeoutId)
        setRefreshLoading(false)
        const err = res.ok ? null : (res.error ?? 'Refresh failed')
        setRefreshMessage(err && !isLegacyQuickBooksBanner(err) ? err : (res.ok ? (res.message ?? 'Refresh complete.') : null))
        load()
      })
      .catch((e: unknown) => {
        window.clearTimeout(timeoutId)
        setRefreshLoading(false)
        if (e instanceof Error && e.name === 'AbortError') {
          setRefreshMessage('Refresh timed out. The server may still be working — wait and reload, or check backend logs.')
        } else {
          setRefreshMessage(e instanceof Error ? e.message : 'Refresh failed')
        }
      })
  }, [load])

  const handleExport = useCallback(() => {
    setExportStatus('loading')
    setExportMessage(null)
    setExportSpreadsheetUrl(null)
    exportNewScheduleToSheet()
      .then((res) => {
        if (res.ok) {
          setExportStatus('ok')
          setExportSpreadsheetUrl(res.spreadsheet_url ?? null)
          setExportMessage(
            res.message ?? (res.rows_written != null ? `Exported ${res.rows_written} rows to "ARR_Cockpit export".` : 'Exported.')
          )
        } else {
          setExportStatus('error')
          setExportMessage(res.error ?? 'Export failed')
        }
      })
      .catch((e: unknown) => {
        setExportStatus('error')
        setExportMessage(e instanceof Error ? e.message : 'Export failed')
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (openFilter === null) return
    const thRef = openFilter === 'status' ? statusThRef : typeThRef
    const popRef = openFilter === 'status' ? statusPopoverRef : typePopoverRef
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (thRef?.current?.contains(t) || popRef?.current?.contains(t)) return
      setOpenFilter(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openFilter])

  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      set.add(normType(r))
    }
    return Array.from(set).sort()
  }, [rows])

  const statusOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      set.add(normStatus(r))
    }
    return Array.from(set).sort()
  }, [rows])

  const displayRows = useMemo(() => {
    let out = rows
    if (filterType.length > 0) {
      out = out.filter((r) => filterType.includes(normType(r)))
    }
    if (filterStatus.length > 0) {
      out = out.filter((r) => filterStatus.includes(normStatus(r)))
    }
    return out
  }, [rows, filterType, filterStatus])

  const sortedDisplayRows = useMemo(() => {
    const arr = [...displayRows]
    if (sortKey === 'account_name') {
      const mul = sortDir === 'asc' ? 1 : -1
      arr.sort((a, b) => {
        const cmp = (a.account_name ?? '').localeCompare(b.account_name ?? '', undefined, { sensitivity: 'base' })
        if (cmp !== 0) return mul * cmp
        return (a.account_id ?? '').localeCompare(b.account_id ?? '')
      })
    } else {
      const mul = sortDir === 'desc' ? -1 : 1
      arr.sort((a, b) => {
        const va = typeof a.live_arr === 'number' ? a.live_arr : 0
        const vb = typeof b.live_arr === 'number' ? b.live_arr : 0
        if (va !== vb) return mul * (va - vb)
        return (a.account_name ?? '').localeCompare(b.account_name ?? '', undefined, { sensitivity: 'base' })
      })
    }
    return arr
  }, [displayRows, sortKey, sortDir])

  const hasActiveFilter = filterType.length > 0 || filterStatus.length > 0

  const totalLiveArr = useMemo(() => {
    const sum = (list: NewScheduleAccountRow[]) =>
      list.reduce((s, r) => s + (typeof r.live_arr === 'number' ? r.live_arr : 0), 0)
    return hasActiveFilter ? sum(displayRows) : sum(rows)
  }, [rows, displayRows, hasActiveFilter])

  const totalContractedArr = useMemo(() => {
    const sum = (list: NewScheduleAccountRow[]) =>
      list.reduce((s, r) => s + (typeof r.contracted_arr === 'number' ? r.contracted_arr : 0), 0)
    return hasActiveFilter ? sum(displayRows) : sum(rows)
  }, [rows, displayRows, hasActiveFilter])

  const totalArrByMonth = useMemo(() => {
    const keys = monthColumns.length > 0 ? monthColumns : [...NEW_SCHEDULE_MONTH_KEYS_DEFAULT]
    const out: Record<string, number> = {}
    for (const k of keys) out[k] = 0
    const list = hasActiveFilter ? displayRows : rows
    for (const r of list) {
      const m = r.arr_by_month ?? {}
      for (const k of keys) {
        const v = m[k]
        out[k] += typeof v === 'number' ? v : 0
      }
    }
    for (const k of keys) {
      out[k] = Math.round(out[k] * 100) / 100
    }
    return out
  }, [rows, displayRows, hasActiveFilter, monthColumns])

  /** Match thead row height so the Total row sticks directly under the header. */
  const stickyTotalTop = '2.5rem'
  const stickyHeaderCell: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 3,
    background: 'var(--ns-sticky-bg, var(--surface))',
    boxShadow: '0 1px 0 var(--border)',
  }
  const stickyTotalCell: React.CSSProperties = {
    position: 'sticky',
    top: stickyTotalTop,
    zIndex: 2,
    background: 'var(--ns-sticky-bg, var(--surface))',
    boxShadow: '0 1px 0 var(--border)',
  }

  const popoverStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: '100%',
    marginTop: 2,
    zIndex: 50,
    background: 'var(--ns-sticky-bg, #10141c)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '0.5rem',
    boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
    minWidth: 140,
  }

  const thTypeFilter = () => {
    const isOpen = openFilter === 'type'
    const hasActiveFilterCol = filterType.length > 0
    return (
      <th
        ref={typeThRef}
        style={{
          ...stickyHeaderCell,
          textAlign: 'left',
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          verticalAlign: 'bottom',
        }}
      >
        <span>Type</span>
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
            background: hasActiveFilterCol ? 'var(--accent)' : 'transparent',
            color: hasActiveFilterCol ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ⋮
        </button>
        {isOpen && (
          <div ref={typePopoverRef} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <select
              multiple
              size={Math.min(6, Math.max(2, typeOptions.length))}
              value={filterType}
              onChange={(e) => setFilterType(Array.from(e.target.selectedOptions, (o) => o.value))}
              style={{
                padding: '0.35rem 0.5rem',
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
            <p style={{ color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>
              Ctrl+click to select multiple
            </p>
            {filterType.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterType([])}
                style={{
                  marginTop: '0.35rem',
                  padding: '0.25rem 0.5rem',
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
    const hasActiveFilterCol = filterStatus.length > 0
    return (
      <th
        ref={statusThRef}
        style={{
          ...stickyHeaderCell,
          textAlign: 'left',
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          verticalAlign: 'bottom',
        }}
      >
        <span>Status</span>
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
            background: hasActiveFilterCol ? 'var(--accent)' : 'transparent',
            color: hasActiveFilterCol ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ⋮
        </button>
        {isOpen && (
          <div ref={statusPopoverRef} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <select
              multiple
              size={Math.min(6, Math.max(2, statusOptions.length))}
              value={filterStatus}
              onChange={(e) => setFilterStatus(Array.from(e.target.selectedOptions, (o) => o.value))}
              style={{
                padding: '0.35rem 0.5rem',
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
            <p style={{ color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>
              Ctrl+click to select multiple
            </p>
            {filterStatus.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterStatus([])}
                style={{
                  marginTop: '0.35rem',
                  padding: '0.25rem 0.5rem',
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
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
          ARR Schedule
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
          {datasetStatus?.last_refresh_ok === false &&
            datasetStatus?.last_error &&
            !isLegacyQuickBooksBanner(datasetStatus.last_error) && (
              <span style={{ color: 'var(--negative)', marginLeft: '0.5rem' }}>
                Last run error: {datasetStatus.last_error}
              </span>
            )}
        </span>
      </div>
      {refreshMessage && !isLegacyQuickBooksBanner(refreshMessage) && (
        <p style={{
          fontSize: '0.9rem',
          color: refreshMessage.includes('failed') || refreshMessage.includes('error') ? 'var(--negative)' : 'var(--text-muted)',
          margin: '0 0 1rem',
        }}>
          {refreshMessage}
        </p>
      )}

      <p style={{ marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem 0.75rem' }}>
        <button
          type="button"
          onClick={handleExport}
          disabled={exportStatus === 'loading' || rows.length === 0}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            cursor: exportStatus === 'loading' || rows.length === 0 ? 'not-allowed' : 'pointer',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
          title={rows.length === 0 ? 'No data to export' : 'Export Schedule to the "ARR_Cockpit export" tab in the financial model'}
        >
          {exportStatus === 'loading' ? 'Exporting…' : 'Export to ARR_Cockpit export'}
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Writes to the &quot;ARR_Cockpit export&quot; tab in your financial model (creates the tab if it doesn&apos;t exist).
        </span>
        {exportStatus === 'ok' && exportMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--positive)' }}>
            {exportMessage}
            {exportSpreadsheetUrl && (
              <>
                {' '}
                <a href={exportSpreadsheetUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                  Open sheet
                </a>
              </>
            )}
          </span>
        )}
        {exportStatus === 'error' && exportMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--negative)' }}>{exportMessage}</span>
        )}
      </p>

      {err && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{err}</p>}
      {!err && rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No matching accounts found.</p>
      )}
      {rows.length > 0 && (
        <div
          className="new-schedule-arr-table"
          style={
            {
              minWidth: 0,
              overflow: 'auto',
              ['--ns-sticky-bg' as string]: '#10141c',
            } as React.CSSProperties
          }
        >
          {hasActiveFilter && (
            <p style={{ margin: '0 0 0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  setFilterType([])
                  setFilterStatus([])
                  setOpenFilter(null)
                }}
                style={{
                  padding: '0.5rem 1rem',
                  cursor: 'pointer',
                  background: 'var(--surface)',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                }}
              >
                Clear filters
              </button>
              <span style={{ color: 'var(--text-muted)' }}>
                Total reflects filtered rows only.
              </span>
            </p>
          )}
          <table
            style={{
              width: '100%',
              minWidth: 2800,
              borderCollapse: 'separate',
              borderSpacing: 0,
            }}
          >
            <thead>
              <tr>
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
                    onClick={() => {
                      if (sortKey !== 'account_name') {
                        setSortKey('account_name')
                        setSortDir('asc')
                      } else {
                        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      if (sortKey !== 'account_name') {
                        setSortKey('account_name')
                        setSortDir('asc')
                      } else {
                        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
                      }
                    }}
                    style={{
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    title={
                      sortKey === 'account_name'
                        ? sortDir === 'asc'
                          ? 'Sorted A→Z — click for Z→A'
                          : 'Sorted Z→A — click for A→Z'
                        : 'Click to sort by account name A→Z'
                    }
                  >
                    Account
                    {sortKey === 'account_name' && (
                      <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </span>
                </th>
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
                {thTypeFilter()}
                {thStatusFilter()}
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
                  Subscription start date
                </th>
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
                    onClick={() => {
                      if (sortKey !== 'live_arr') {
                        setSortKey('live_arr')
                        setSortDir('desc')
                      } else {
                        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      if (sortKey !== 'live_arr') {
                        setSortKey('live_arr')
                        setSortDir('desc')
                      } else {
                        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
                      }
                    }}
                    style={{
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    title={
                      sortKey === 'live_arr'
                        ? sortDir === 'desc'
                          ? 'Sorted largest to smallest — click for smallest to largest'
                          : 'Sorted smallest to largest — click for largest to smallest'
                        : 'Click to sort by Live ARR (largest first)'
                    }
                  >
                    Live ARR (today)
                    {sortKey === 'live_arr' && (
                      <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </span>
                </th>
                <th
                  style={{
                    ...stickyHeaderCell,
                    textAlign: 'right',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                  title="Live ARR (today) + ARR from all Closed Won opps with contract start in the future"
                >
                  Contracted ARR
                </th>
                {monthColumns.map((mk) => (
                  <th
                    key={mk}
                    style={{
                      ...stickyHeaderCell,
                      textAlign: 'right',
                      padding: '0.5rem 0.5rem',
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                    }}
                    title={`Live ARR (same as today) as of last day of ${mk}`}
                  >
                    {monthKeyToLabel(mk)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
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
                  {fmtMoney(totalLiveArr)}
                </td>
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
                  {fmtMoney(totalContractedArr)}
                </td>
                {monthColumns.map((mk) => (
                  <td
                    key={mk}
                    style={{
                      ...stickyTotalCell,
                      textAlign: 'right',
                      padding: '0.5rem 0.5rem',
                      fontWeight: 600,
                      color: 'var(--text)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtMoney(totalArrByMonth[mk] ?? 0)}
                  </td>
                ))}
              </tr>
              {sortedDisplayRows.map((row, idx) => {
                const href = accountHref(salesforceBaseUrl, row.account_id)
                return (
                  <tr key={row.account_id || idx}>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" title="Open account in Salesforce">
                          {row.account_name}
                        </a>
                      ) : (
                        row.account_name
                      )}
                    </td>
                    <td
                      className="ns-id-cell"
                      style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}
                      title={row.account_id}
                    >
                      {row.account_id}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>{row.type ?? '—'}</td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {row.status?.trim() ? row.status : '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {row.subscription_start_date ?? '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {row.subscription_end_date ?? '—'}
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
                      {fmtMoney(row.live_arr ?? 0)}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        padding: '0.5rem 0.75rem',
                        fontWeight: 400,
                        color: 'var(--text)',
                        whiteSpace: 'nowrap',
                      }}
                      title="Live ARR (today) + future contract-start Closed Won ARR"
                    >
                      {fmtMoney(row.contracted_arr ?? 0)}
                    </td>
                    {monthColumns.map((mk) => (
                      <td
                        key={mk}
                        style={{
                          textAlign: 'right',
                          padding: '0.5rem 0.5rem',
                          fontWeight: 400,
                          color: 'var(--text)',
                          whiteSpace: 'nowrap',
                        }}
                        title={`Live ARR as of last day of ${mk}`}
                      >
                        {fmtMoney(row.arr_by_month?.[mk] ?? 0)}
                      </td>
                    ))}
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
