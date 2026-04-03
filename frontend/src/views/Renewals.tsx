import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getRenewalsOverview,
  type RenewalsChartMonth,
  type RenewalsOverviewResponse,
  type RenewalsOverviewRow,
} from '../api'
import { loadRenewalsFilters, saveRenewalsFilters } from '../tableFilterStorage'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtOptionalMoney(n: number | null) {
  return n == null ? '—' : fmtMoney(n)
}

function renewalMonthKeyFromRow(renewalDate: string | null): string | null {
  if (!renewalDate || renewalDate.length < 7) return null
  return renewalDate.slice(0, 7)
}

function isClosedWonStage(stageName: string | null | undefined): boolean {
  if (!stageName) return false
  const s = stageName.replace(/[\s\u00A0\-_]+/g, ' ').trim().toLowerCase()
  if (s === 'closed won') return true
  if (s.includes('closed') && s.includes('won') && !s.includes('lost')) return true
  return false
}

function isClosedLostStage(stageName: string | null | undefined): boolean {
  if (!stageName) return false
  const s = stageName.replace(/[\s\u00A0\-_]+/g, ' ').trim().toLowerCase()
  if (s === 'closed lost') return true
  if (s.includes('closed') && s.includes('lost') && !s.includes('won')) return true
  return false
}

type RenewalChartSliceFilter =
  | { source: 'arr'; month: string | null; segment: 'churned' | 'renewed' | 'open' | 'cancelled' }
  | { source: 'count'; month: string | null; segment: 'lost' | 'renewed' | 'open' | 'cancelled' }

function rowMatchesRenewalChartSlice(row: RenewalsOverviewRow, f: RenewalChartSliceFilter): boolean {
  const mk = renewalMonthKeyFromRow(row.renewal_date)
  const isMid = row.midterm_cancellation_after_stage === 'Yes'

  if (f.segment === 'cancelled') {
    if (!isMid) return false
    if (f.month != null && mk !== f.month) return false
    return true
  }

  if (isMid) return false
  if (f.month != null && mk !== f.month) return false

  const st = row.stage_name
  if (f.source === 'arr') {
    if (f.segment === 'open') return !isClosedWonStage(st) && !isClosedLostStage(st)
    if (f.segment === 'churned') return row.delta != null && row.delta < 0
    if (f.segment === 'renewed') return isClosedWonStage(st) && (row.delta == null || row.delta >= 0)
  } else {
    if (f.segment === 'open') return !isClosedWonStage(st) && !isClosedLostStage(st)
    if (f.segment === 'lost') return isClosedLostStage(st)
    if (f.segment === 'renewed') return isClosedWonStage(st)
  }
  return false
}

type ChartSegmentDef = {
  key: string
  label: string
  color: string
  get: (r: RenewalsChartMonth) => number
}

/** Stacked segments with explicit pixel heights so clicks register on the intended slice (flex column-reverse is unreliable). */
function RenewalStackedBarSegments({
  row,
  source,
  segments,
  total,
  barHeight,
  chartSliceFilter,
  onToggleSegment,
  formatValue,
}: {
  row: RenewalsChartMonth
  source: 'arr' | 'count'
  segments: ChartSegmentDef[]
  total: number
  barHeight: number
  chartSliceFilter: RenewalChartSliceFilter | null
  onToggleSegment: (month: string, segSource: 'arr' | 'count', segment: string) => void
  formatValue: (raw: number) => string
}) {
  if (total <= 0 || barHeight <= 0) return null

  const parts: ReactNode[] = []
  let bottom = 0
  for (const seg of segments) {
    const raw = seg.get(row)
    if (raw <= 0) continue
    const h = (raw / total) * barHeight
    const showLabel = h >= 14
    const sliceSelected =
      chartSliceFilter != null &&
      chartSliceFilter.source === source &&
      chartSliceFilter.month === row.month &&
      chartSliceFilter.segment === seg.key

    parts.push(
      <div
        key={seg.key}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggleSegment(row.month, source, seg.key)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onToggleSegment(row.month, source, seg.key)
          }
        }}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom,
          height: h,
          minHeight: 1,
          background: seg.color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 600,
          fontSize: '0.7rem',
          textShadow: '0 0 1px rgba(0,0,0,0.5)',
          boxSizing: 'border-box',
          cursor: 'pointer',
          touchAction: 'manipulation',
          outline: sliceSelected ? '2px solid var(--accent)' : undefined,
          outlineOffset: -1,
        }}
        title={`${seg.label}: ${formatValue(raw)} — click to filter table`}
      >
        {showLabel ? formatValue(raw) : ''}
      </div>
    )
    bottom += h
  }

  return <>{parts}</>
}

type FilterColumn = 'stage' | 'midterm' | 'renewal_month'
type SortKey =
  | 'account_name'
  | 'opportunity_name'
  | 'stage_name'
  | 'midterm_cancellation_after_stage'
  | 'renewal_date'
  | 'up_for_renewal_arr'
  | 'renewed_arr'
  | 'delta'
type SortDir = 'asc' | 'desc'

export default function Renewals() {
  const [data, setData] = useState<RenewalsOverviewResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('renewal_date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const storedRenewals = useRef<ReturnType<typeof loadRenewalsFilters> | null>(null)
  if (storedRenewals.current === null) storedRenewals.current = loadRenewalsFilters()
  const rv = storedRenewals.current
  const [filterStage, setFilterStage] = useState<string[]>(() => rv.stage)
  const [filterRenewalMonth, setFilterRenewalMonth] = useState<string[]>(() => rv.months)
  const [filterMidterm, setFilterMidterm] = useState<string[]>(() => rv.midterm)
  const [chartSliceFilter, setChartSliceFilter] = useState<RenewalChartSliceFilter | null>(null)
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const stageThRef = useRef<HTMLTableHeaderCellElement>(null)
  const stagePopoverRef = useRef<HTMLDivElement>(null)
  const midtermThRef = useRef<HTMLTableHeaderCellElement>(null)
  const midtermPopoverRef = useRef<HTMLDivElement>(null)
  const renewalDateThRef = useRef<HTMLTableHeaderCellElement>(null)
  const renewalDatePopoverRef = useRef<HTMLDivElement>(null)

  const loadData = useCallback(() => {
    getRenewalsOverview({
      stage: filterStage.length ? filterStage : undefined,
      months: filterRenewalMonth.length ? filterRenewalMonth : undefined,
      midterm: filterMidterm.length ? filterMidterm : undefined,
    })
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [filterStage, filterRenewalMonth, filterMidterm])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    saveRenewalsFilters({
      stage: filterStage,
      months: filterRenewalMonth,
      midterm: filterMidterm,
    })
  }, [filterStage, filterRenewalMonth, filterMidterm])

  useEffect(() => {
    if (openFilter === null) return
    const thRef =
      openFilter === 'stage'
        ? stageThRef
        : openFilter === 'midterm'
          ? midtermThRef
          : renewalDateThRef
    const popRef =
      openFilter === 'stage'
        ? stagePopoverRef
        : openFilter === 'midterm'
          ? midtermPopoverRef
          : renewalDatePopoverRef
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (thRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpenFilter(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openFilter])

  const formatMonthLabel = (month: string) => {
    const [y, m] = month.split('-')
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }

  const renewalChartSliceSummary = (f: RenewalChartSliceFilter) => {
    const m = f.month != null ? formatMonthLabel(f.month) : 'All months'
    if (f.segment === 'cancelled') return `${m} · Cancelled`
    const src = f.source === 'arr' ? 'ARR' : 'Opportunities'
    const names: Record<string, string> = {
      churned: 'Churned/contracted',
      renewed: 'Renewed',
      open: 'Open',
      lost: 'Lost',
    }
    return `${m} · ${src} · ${names[f.segment] ?? f.segment}`
  }

  const rows = Array.isArray(data?.rows) ? data.rows : []
  const salesforce_base_url =
    data?.salesforce_base_url &&
    (data.salesforce_base_url.includes('salesforce.com') || data.salesforce_base_url.includes('lightning.force.com'))
      ? data.salesforce_base_url
      : undefined

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(
        key === 'account_name' || key === 'opportunity_name' || key === 'stage_name' || key === 'midterm_cancellation_after_stage'
          ? 'asc'
          : key === 'renewal_date'
            ? 'desc'
            : 'desc'
      )
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const aVal: string | number | null = a[sortKey as keyof typeof a] as string | number | null
      const bVal: string | number | null = b[sortKey as keyof typeof b] as string | number | null
      if (sortKey === 'up_for_renewal_arr' || sortKey === 'renewed_arr' || sortKey === 'delta') {
        const an = aVal == null ? Number.NEGATIVE_INFINITY : Number(aVal)
        const bn = bVal == null ? Number.NEGATIVE_INFINITY : Number(bVal)
        return dir * (an - bn)
      }
      if (sortKey === 'midterm_cancellation_after_stage') {
        const score = (v: string | number | null) => (v === 'Yes' ? 1 : 0)
        return dir * (score(aVal) - score(bVal))
      }
      const sa = String(aVal ?? '').toLowerCase()
      const sb = String(bVal ?? '').toLowerCase()
      return dir * (sa < sb ? -1 : sa > sb ? 1 : 0)
    })
  }, [rows, sortKey, sortDir])

  const displayRows = useMemo(() => {
    if (chartSliceFilter == null) return sortedRows
    return sortedRows.filter((r) => rowMatchesRenewalChartSlice(r, chartSliceFilter))
  }, [sortedRows, chartSliceFilter])

  const footerUp = useMemo(() => {
    if (chartSliceFilter == null) return data?.grand_up_for_renewal_arr ?? 0
    return Math.round(displayRows.reduce((s, r) => s + (r.up_for_renewal_arr ?? 0), 0) * 100) / 100
  }, [chartSliceFilter, data?.grand_up_for_renewal_arr, displayRows])

  const footerRen = useMemo(() => {
    if (chartSliceFilter == null) return data?.grand_renewed_arr ?? 0
    return Math.round(displayRows.reduce((s, r) => s + (r.renewed_arr ?? 0), 0) * 100) / 100
  }, [chartSliceFilter, data?.grand_renewed_arr, displayRows])

  const footerDelta = useMemo(() => {
    if (chartSliceFilter == null) return data?.grand_delta ?? 0
    return Math.round(displayRows.reduce((s, r) => s + (r.delta ?? 0), 0) * 100) / 100
  }, [chartSliceFilter, data?.grand_delta, displayRows])

  const toggleRenewalChartSlice = (month: string | null, source: 'arr' | 'count', segment: string) => {
    setChartSliceFilter((prev) => {
      if (prev && prev.month === month && prev.source === source && prev.segment === segment) return null
      if (source === 'arr') {
        return {
          source: 'arr',
          month,
          segment: segment as 'churned' | 'renewed' | 'open' | 'cancelled',
        }
      }
      return {
        source: 'count',
        month,
        segment: segment as 'lost' | 'renewed' | 'open' | 'cancelled',
      }
    })
  }

  const chartRows = useMemo(() => {
    const rc = data?.renewals_chart
    if (!Array.isArray(rc) || rc.length === 0) return []
    return rc
  }, [data?.renewals_chart])

  const PLOT_HEIGHT = 270

  const arrChartMax = useMemo(() => {
    let m = 0
    for (const r of chartRows) {
      m = Math.max(m, r.arr_open + r.arr_renewed + r.arr_churned)
    }
    return Math.max(50_000, Math.ceil(m / 50_000) * 50_000)
  }, [chartRows])

  const countChartMax = useMemo(() => {
    let m = 0
    for (const r of chartRows) {
      m = Math.max(m, r.count_open + r.count_renewed + r.count_lost)
    }
    return Math.max(5, Math.ceil(m / 5) * 5)
  }, [chartRows])

  const arrYTicks = useMemo(() => {
    const mx = arrChartMax
    return [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * mx))
  }, [arrChartMax])

  const countYTicks = useMemo(() => {
    const mx = countChartMax
    return [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * mx))
  }, [countChartMax])

  const formatArrTick = (tick: number) => (tick === 0 ? '$0' : `$${Math.round(tick / 1000)}K`)

  const fmtRenewalPct = (x: number | null | undefined) =>
    x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(1)}%`

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

  const thFilterStage = () => {
    const col: FilterColumn = 'stage'
    const options = data?.stages ?? []
    const selected = filterStage
    const isOpen = openFilter === col
    const sortKeyForCol: SortKey = 'stage_name'
    const isSortActive = sortKey === sortKeyForCol
    const hasActiveFilter = selected.length > 0
    return (
      <th
        ref={stageThRef}
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
          onClick={() => handleSort(sortKeyForCol)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort(sortKeyForCol)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          Stage
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenFilter((f) => (f === col ? null : col))
          }}
          title="Filter"
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
          <div ref={stagePopoverRef} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <select
              multiple
              size={Math.min(8, Math.max(2, options.length))}
              value={selected}
              onChange={(e) => setFilterStage(Array.from(e.target.selectedOptions, (o) => o.value))}
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
              {options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>Ctrl+click to select multiple</p>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterStage([])}
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

  const thFilterMidterm = () => {
    const col: FilterColumn = 'midterm'
    const options: { value: string; label: string }[] = [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ]
    const selected = filterMidterm
    const isOpen = openFilter === col
    const sortKeyForCol: SortKey = 'midterm_cancellation_after_stage'
    const isSortActive = sortKey === sortKeyForCol
    const hasActiveFilter = selected.length > 0
    return (
      <th
        ref={midtermThRef}
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
          onClick={() => handleSort(sortKeyForCol)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort(sortKeyForCol)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          Mid-term cancellation
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenFilter((f) => (f === col ? null : col))
          }}
          title="Filter"
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
          <div ref={midtermPopoverRef} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <select
              multiple
              size={2}
              value={selected}
              onChange={(e) => setFilterMidterm(Array.from(e.target.selectedOptions, (o) => o.value))}
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
              {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>Ctrl+click to select multiple</p>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterMidterm([])}
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

  const thFilterRenewalDate = () => {
    const col: FilterColumn = 'renewal_month'
    const options = data?.available_months ?? []
    const selected = filterRenewalMonth
    const isOpen = openFilter === col
    const sortKeyForCol: SortKey = 'renewal_date'
    const isSortActive = sortKey === sortKeyForCol
    const hasActiveFilter = selected.length > 0
    return (
      <th
        ref={renewalDateThRef}
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
          onClick={() => handleSort(sortKeyForCol)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort(sortKeyForCol)}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          Renewal date
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpenFilter((f) => (f === col ? null : col))
          }}
          title="Filter by month"
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
          <div ref={renewalDatePopoverRef} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <select
              multiple
              size={Math.min(8, Math.max(2, options.length))}
              value={selected}
              onChange={(e) => setFilterRenewalMonth(Array.from(e.target.selectedOptions, (o) => o.value))}
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
              {options.map((opt) => (
                <option key={opt} value={opt}>
                  {formatMonthLabel(opt)}
                </option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>Ctrl+click to select multiple</p>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setFilterRenewalMonth([])}
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

  const linkStyle = { color: 'var(--accent)', textDecoration: 'none' }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  const OPEN_GREY = '#94a3b8'
  /** column-reverse: first = bottom; Open last = top of bar */
  const arrSegments: { key: string; label: string; color: string; get: (r: RenewalsChartMonth) => number }[] = [
    { key: 'churned', label: 'Churned/contracted', color: '#dc2626', get: (r) => r.arr_churned },
    { key: 'renewed', label: 'Renewed', color: '#22c55e', get: (r) => r.arr_renewed },
    { key: 'open', label: 'Open', color: OPEN_GREY, get: (r) => r.arr_open },
  ]
  const countSegments: { key: string; label: string; color: string; get: (r: RenewalsChartMonth) => number }[] = [
    { key: 'lost', label: 'Lost', color: '#b91c1c', get: (r) => r.count_lost },
    { key: 'renewed', label: 'Renewed', color: '#22c55e', get: (r) => r.count_renewed },
    { key: 'open', label: 'Open', color: OPEN_GREY, get: (r) => r.count_open },
  ]

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Renewals (ARR)</h1>

      {(filterStage.length > 0 || filterRenewalMonth.length > 0 || filterMidterm.length > 0 || chartSliceFilter != null) && (
        <p style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => {
              setFilterStage([])
              setFilterRenewalMonth([])
              setFilterMidterm([])
              setChartSliceFilter(null)
              setOpenFilter(null)
            }}
            style={{
              padding: '0.5rem 1rem',
              fontSize: '0.9rem',
              cursor: 'pointer',
              background: 'var(--bg)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            Reset filters
          </button>
          {chartSliceFilter != null && (
            <span style={{ fontSize: '0.85rem', color: 'var(--text)' }}>
              Table: <strong>{renewalChartSliceSummary(chartSliceFilter)}</strong>
            </span>
          )}
        </p>
      )}

      {chartRows.length > 0 && (
        <div style={{ marginBottom: '1.5rem', maxWidth: '100%', display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
              Renewals by renewal month (ARR) — 3 months back, current month, 2 months ahead
            </div>
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem', alignItems: 'flex-start' }}>
                <div
                  style={{
                    width: 44,
                    flexShrink: 0,
                    paddingRight: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    color: 'var(--text-muted)',
                  }}
                >
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', fontSize: '0.7rem' }}>
                    {arrYTicks.slice().reverse().map((tick, i) => (
                      <span
                        key={tick}
                        style={{
                          position: 'absolute',
                          right: 8,
                          top: (i / Math.max(arrYTicks.length - 1, 1)) * PLOT_HEIGHT,
                          transform: 'translateY(-50%)',
                          lineHeight: 1,
                          textAlign: 'right',
                        }}
                      >
                        {formatArrTick(tick)}
                      </span>
                    ))}
                  </div>
                  {/* Same vertical space as month-label row so percentages line up with bar columns */}
                  <div style={{ marginTop: '0.35rem', minHeight: '1.1em', flexShrink: 0 }} aria-hidden />
                  <div style={{ marginTop: '0.35rem', fontSize: '0.65rem', lineHeight: 1.15, textAlign: 'left' }}>
                    Renewal
                    <br />
                    rate
                  </div>
                  <div style={{ marginTop: '0.35rem', fontSize: '0.65rem', lineHeight: 1.15, textAlign: 'left' }}>
                    Cancelled
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                      {arrYTicks.map((_, i) => (
                        <div
                          key={i}
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: (i / Math.max(arrYTicks.length - 1, 1)) * PLOT_HEIGHT,
                            height: 1,
                            background: 'var(--border)',
                            opacity: 0.7,
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                      {chartRows.map((row) => {
                        const total = row.arr_open + row.arr_renewed + row.arr_churned
                        const barHeightPct = total > 0 ? Math.min(100, (total / arrChartMax) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        const totalK = Math.round(total / 1000)
                        return (
                          <div
                            key={row.month}
                            style={{
                              flex: 1,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              minWidth: 0,
                              justifyContent: 'flex-end',
                              height: '100%',
                            }}
                          >
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                              {total > 0 ? `$${totalK}K` : '$0'}
                            </div>
                            <div
                              style={{
                                width: '100%',
                                maxWidth: 36,
                                height: total > 0 ? barHeight : 0,
                                minHeight: 0,
                                position: 'relative',
                                overflow: 'hidden',
                                borderRadius: '2px 2px 0 0',
                              }}
                            >
                              <RenewalStackedBarSegments
                                row={row}
                                source="arr"
                                segments={arrSegments}
                                total={total}
                                barHeight={total > 0 ? barHeight : 0}
                                chartSliceFilter={chartSliceFilter}
                                onToggleSegment={toggleRenewalChartSlice}
                                formatValue={(raw) => `$${Math.round(raw / 1000)}K`}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                    {chartRows.map((row) => (
                      <div key={row.month} style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>
                        {formatMonthLabel(row.month)}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                    {chartRows.map((row) => (
                      <div
                        key={`${row.month}-arr-rate`}
                        style={{ flex: 1, minWidth: 0, fontSize: '0.7rem', textAlign: 'center', color: 'var(--text)', fontWeight: 400 }}
                      >
                        {fmtRenewalPct(row.arr_renewal_rate)}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                    {chartRows.map((row) => {
                      const cancelledSel =
                        chartSliceFilter != null &&
                        chartSliceFilter.source === 'arr' &&
                        chartSliceFilter.month === row.month &&
                        chartSliceFilter.segment === 'cancelled'
                      return (
                        <div
                          key={`${row.month}-arr-midterm`}
                          role="button"
                          tabIndex={0}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleRenewalChartSlice(row.month, 'arr', 'cancelled')
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              toggleRenewalChartSlice(row.month, 'arr', 'cancelled')
                            }
                          }}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '0.7rem',
                            textAlign: 'center',
                            color: 'var(--text)',
                            fontWeight: 400,
                            cursor: 'pointer',
                            borderRadius: 4,
                            outline: cancelledSel ? '2px solid var(--accent)' : undefined,
                          }}
                          title="Click to filter table to mid-term cancellations in this month"
                        >
                          {fmtMoney(row.arr_midterm_cancellation ?? 0)}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {arrSegments.map((seg) => {
                  const legSel =
                    chartSliceFilter != null &&
                    chartSliceFilter.source === 'arr' &&
                    chartSliceFilter.month === null &&
                    chartSliceFilter.segment === seg.key
                  return (
                    <button
                      key={seg.key}
                      type="button"
                      onClick={() => toggleRenewalChartSlice(null, 'arr', seg.key)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '2px 6px',
                        margin: 0,
                        border: legSel ? '1px solid var(--accent)' : '1px solid transparent',
                        borderRadius: 4,
                        background: legSel ? 'var(--surface)' : 'transparent',
                        color: 'inherit',
                        font: 'inherit',
                        cursor: 'pointer',
                      }}
                      title="Filter table by this slice (all months)"
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: seg.color }} />
                      {seg.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
              Renewals by renewal month (# opportunities) — 3 months back, current month, 2 months ahead
            </div>
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem', alignItems: 'flex-start' }}>
                <div
                  style={{
                    width: 44,
                    flexShrink: 0,
                    paddingRight: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    color: 'var(--text-muted)',
                  }}
                >
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', fontSize: '0.7rem' }}>
                    {countYTicks.slice().reverse().map((tick, i) => (
                      <span
                        key={tick}
                        style={{
                          position: 'absolute',
                          right: 8,
                          top: (i / Math.max(countYTicks.length - 1, 1)) * PLOT_HEIGHT,
                          transform: 'translateY(-50%)',
                          lineHeight: 1,
                          textAlign: 'right',
                        }}
                      >
                        {tick}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: '0.35rem', minHeight: '1.1em', flexShrink: 0 }} aria-hidden />
                  <div style={{ marginTop: '0.35rem', fontSize: '0.65rem', lineHeight: 1.15, textAlign: 'left' }}>
                    Renewal
                    <br />
                    rate
                  </div>
                  <div style={{ marginTop: '0.35rem', fontSize: '0.65rem', lineHeight: 1.15, textAlign: 'left' }}>
                    Cancelled
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                      {countYTicks.map((_, i) => (
                        <div
                          key={i}
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: (i / Math.max(countYTicks.length - 1, 1)) * PLOT_HEIGHT,
                            height: 1,
                            background: 'var(--border)',
                            opacity: 0.7,
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                      {chartRows.map((row) => {
                        const totalCount = row.count_open + row.count_renewed + row.count_lost
                        const barHeightPct = totalCount > 0 ? Math.min(100, (totalCount / countChartMax) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        return (
                          <div
                            key={row.month}
                            style={{
                              flex: 1,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              minWidth: 0,
                              justifyContent: 'flex-end',
                              height: '100%',
                            }}
                          >
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>{totalCount}</div>
                            <div
                              style={{
                                width: '100%',
                                maxWidth: 36,
                                height: totalCount > 0 ? barHeight : 0,
                                minHeight: 0,
                                position: 'relative',
                                overflow: 'hidden',
                                borderRadius: '2px 2px 0 0',
                              }}
                            >
                              <RenewalStackedBarSegments
                                row={row}
                                source="count"
                                segments={countSegments}
                                total={totalCount}
                                barHeight={totalCount > 0 ? barHeight : 0}
                                chartSliceFilter={chartSliceFilter}
                                onToggleSegment={toggleRenewalChartSlice}
                                formatValue={(raw) => String(raw)}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                    {chartRows.map((row) => (
                      <div key={`c-${row.month}`} style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>
                        {formatMonthLabel(row.month)}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                    {chartRows.map((row) => (
                      <div
                        key={`${row.month}-opp-rate`}
                        style={{ flex: 1, minWidth: 0, fontSize: '0.7rem', textAlign: 'center', color: 'var(--text)', fontWeight: 400 }}
                      >
                        {fmtRenewalPct(row.opp_renewal_rate)}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                    {chartRows.map((row) => {
                      const cancelledSel =
                        chartSliceFilter != null &&
                        chartSliceFilter.source === 'count' &&
                        chartSliceFilter.month === row.month &&
                        chartSliceFilter.segment === 'cancelled'
                      return (
                        <div
                          key={`${row.month}-opp-midterm`}
                          role="button"
                          tabIndex={0}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleRenewalChartSlice(row.month, 'count', 'cancelled')
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              toggleRenewalChartSlice(row.month, 'count', 'cancelled')
                            }
                          }}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '0.7rem',
                            textAlign: 'center',
                            color: 'var(--text)',
                            fontWeight: 400,
                            cursor: 'pointer',
                            borderRadius: 4,
                            outline: cancelledSel ? '2px solid var(--accent)' : undefined,
                          }}
                          title="Click to filter table to mid-term cancellations in this month"
                        >
                          {row.count_midterm_cancellation ?? 0}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {countSegments.map((seg) => {
                  const legSel =
                    chartSliceFilter != null &&
                    chartSliceFilter.source === 'count' &&
                    chartSliceFilter.month === null &&
                    chartSliceFilter.segment === seg.key
                  return (
                    <button
                      key={seg.key}
                      type="button"
                      onClick={() => toggleRenewalChartSlice(null, 'count', seg.key)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '2px 6px',
                        margin: 0,
                        border: legSel ? '1px solid var(--accent)' : '1px solid transparent',
                        borderRadius: 4,
                        background: legSel ? 'var(--surface)' : 'transparent',
                        color: 'inherit',
                        font: 'inherit',
                        cursor: 'pointer',
                      }}
                      title="Filter table by this slice (all months)"
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: seg.color }} />
                      {seg.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {th('account_name', 'Account', 'left')}
              {th('opportunity_name', 'Opportunity', 'left')}
              {thFilterStage()}
              {thFilterMidterm()}
              {thFilterRenewalDate()}
              {th('up_for_renewal_arr', 'Up for renewal ARR', 'right')}
              {th('renewed_arr', 'Renewed ARR', 'right')}
              {th('delta', 'Delta', 'right')}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(footerUp)}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(footerRen)}</td>
              <td
                style={{
                  textAlign: 'right',
                  padding: '0.5rem 0.75rem',
                  color: footerDelta >= 0 ? 'var(--positive)' : 'var(--negative)',
                }}
              >
                {fmtMoney(footerDelta)}
              </td>
            </tr>
            {displayRows.map((row) => (
              <tr key={row.opportunity_sf_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {row.account_id && salesforce_base_url ? (
                    <a
                      href={
                        salesforce_base_url.includes('lightning.force.com')
                          ? `${salesforce_base_url}/lightning/r/Account/${row.account_id}/view`
                          : `${salesforce_base_url}/${row.account_id}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      style={linkStyle}
                      title="Open account in Salesforce"
                    >
                      {row.account_name}
                    </a>
                  ) : (
                    row.account_name
                  )}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {salesforce_base_url ? (
                    <a
                      href={
                        salesforce_base_url.includes('lightning.force.com')
                          ? `${salesforce_base_url}/lightning/r/Opportunity/${row.opportunity_sf_id}/view`
                          : `${salesforce_base_url}/${row.opportunity_sf_id}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      style={linkStyle}
                      title="Open opportunity in Salesforce"
                    >
                      {row.opportunity_name}
                    </a>
                  ) : (
                    row.opportunity_name
                  )}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.stage_name}</td>
                <td
                  style={{
                    padding: '0.5rem 0.75rem',
                    whiteSpace: 'nowrap',
                    color: row.midterm_cancellation_after_stage ? 'var(--text)' : 'var(--text-muted)',
                  }}
                >
                  {row.midterm_cancellation_after_stage ?? '—'}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.renewal_date ?? '—'}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem' }}>{fmtOptionalMoney(row.up_for_renewal_arr)}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem' }}>{fmtOptionalMoney(row.renewed_arr)}</td>
                <td
                  style={{
                    textAlign: 'right',
                    padding: '0.5rem 0.75rem',
                    fontWeight: 500,
                    color:
                      row.delta == null ? 'var(--text-muted)' : row.delta >= 0 ? 'var(--positive)' : 'var(--negative)',
                  }}
                >
                  {fmtOptionalMoney(row.delta)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(footerUp)}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(footerRen)}</td>
              <td
                style={{
                  textAlign: 'right',
                  padding: '0.5rem 0.75rem',
                  color: footerDelta >= 0 ? 'var(--positive)' : 'var(--negative)',
                }}
              >
                {fmtMoney(footerDelta)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          No renewal opportunities. Use Dashboard → Refresh app data to load data.
        </p>
      )}
      {rows.length > 0 && displayRows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          No rows match the chart selection. Click the same segment again or use Reset filters.
        </p>
      )}
    </>
  )
}
