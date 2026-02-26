import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRenewalsOverview, syncSalesforce, type RenewalsOverviewResponse } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

type FilterColumn = 'segment' | 'stage' | 'close_date'
type SortKey = 'account_name' | 'segment' | 'opportunity_name' | 'stage_name' | 'close_date' | 'ufr_arr' | 'arr' | 'renewal_change_arr'
type SortDir = 'asc' | 'desc'

export default function Renewals() {
  const [data, setData] = useState<RenewalsOverviewResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('close_date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterSegment, setFilterSegment] = useState<string[]>([])
  const [filterStage, setFilterStage] = useState<string[]>([])
  const [filterCloseDate, setFilterCloseDate] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const segmentThRef = useRef<HTMLTableHeaderCellElement>(null)
  const segmentPopoverRef = useRef<HTMLDivElement>(null)
  const stageThRef = useRef<HTMLTableHeaderCellElement>(null)
  const stagePopoverRef = useRef<HTMLDivElement>(null)
  const closeDateThRef = useRef<HTMLTableHeaderCellElement>(null)
  const closeDatePopoverRef = useRef<HTMLDivElement>(null)

  // Last 6 months (current + previous 5) — used for API filter and charts so backend is source of truth for renewal date bucketing
  const last6Months = useMemo(() => {
    const now = new Date()
    const out: string[] = []
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }
    return out
  }, [])

  const loadData = useCallback(() => {
    getRenewalsOverview({
      segment: filterSegment.length ? filterSegment : undefined,
      stage: filterStage.length ? filterStage : undefined,
      months: filterCloseDate.length ? filterCloseDate : last6Months,
    })
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [filterSegment, filterStage, filterCloseDate, last6Months])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (openFilter === null) return
    const thRef =
      openFilter === 'segment'
        ? segmentThRef
        : openFilter === 'stage'
          ? stageThRef
          : closeDateThRef
    const popRef =
      openFilter === 'segment'
        ? segmentPopoverRef
        : openFilter === 'stage'
          ? stagePopoverRef
          : closeDatePopoverRef
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (thRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpenFilter(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openFilter])

  const handleSyncSalesforce = () => {
    setSyncStatus('loading')
    setSyncMessage(null)
    syncSalesforce()
      .then((res) => {
        if (res.ok) {
          setSyncStatus('ok')
          let msg = res.message ?? `Synced ${res.synced_opportunities ?? 0} opportunities, ${res.synced_line_items ?? 0} product lines.`
          if (res.renewal_date_field_configured !== undefined) {
            msg += res.renewal_date_field_used
              ? ' Renewal date field: in use.'
              : ' Renewal date field: not used (check API name in Railway and restart backend).'
          }
          setSyncMessage(msg)
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

  const rows = Array.isArray(data?.rows) ? data.rows : []
  const salesforce_base_url =
    data?.salesforce_base_url &&
    (data.salesforce_base_url.includes('salesforce.com') || data.salesforce_base_url.includes('lightning.force.com'))
      ? data.salesforce_base_url
      : undefined

  // Left ARR chart: Churned/contracted, Renewed, Open (delta-based).
  const chartDataByStage = useMemo(() => {
    const monthSet = new Set(last6Months)
    const arrMap = new Map<string, Map<string, number>>()
    const countMap = new Map<string, Map<string, number>>()
    const CHURNED = 'Churned/ contracted'
    const RENEWED = 'Renewed'
    const OPEN = 'Open'
    function isClosed(s: string | undefined): boolean {
      const t = (s || '').trim()
      return t === 'Closed Won' || t === 'Closed Lost'
    }
    for (const r of rows) {
      const dateStr = r.renewal_date ?? r.close_date
      const month = dateStr ? dateStr.slice(0, 7) : null
      if (!month || !monthSet.has(month)) continue
      if (!arrMap.has(month)) {
        arrMap.set(month, new Map())
        countMap.set(month, new Map())
      }
      const aMap = arrMap.get(month)!
      const cMap = countMap.get(month)!
      const closed = isClosed(r.stage_name)
      const ufr = r.ufr_arr ?? 0
      const delta = r.renewal_change_arr ?? 0
      if (closed) {
        const churned = delta < 0 ? -delta : 0
        aMap.set(CHURNED, (aMap.get(CHURNED) ?? 0) + churned)
        const renewed = ufr - churned
        aMap.set(RENEWED, (aMap.get(RENEWED) ?? 0) + renewed)
        cMap.set(CHURNED, (cMap.get(CHURNED) ?? 0) + (delta < 0 ? 1 : 0))
        cMap.set(RENEWED, (cMap.get(RENEWED) ?? 0) + (delta >= 0 ? 1 : 0))
      } else {
        aMap.set(OPEN, (aMap.get(OPEN) ?? 0) + ufr)
        cMap.set(OPEN, (cMap.get(OPEN) ?? 0) + 1)
      }
    }
    const months = last6Months.filter((m) => arrMap.has(m)).reverse()
    const stages = [CHURNED, RENEWED, OPEN]
    const stageColors: Record<string, string> = {
      [CHURNED]: '#ef4444',
      [RENEWED]: '#10b981',
      [OPEN]: '#94a3b8',
    }
    return { months, stages, arrMap, countMap, stageColors }
  }, [rows, last6Months])

  // Right chart: Renewed = Closed Won, Lost = Closed Lost, Open = open. Renewal rate = renewed / (renewed + open + lost).
  const chartDataByStageCount = useMemo(() => {
    const monthSet = new Set(last6Months)
    const arrMap = new Map<string, Map<string, number>>()
    const countMap = new Map<string, Map<string, number>>()
    const RENEWED = 'Renewed'
    const LOST = 'Lost'
    const OPEN = 'Open'
    for (const r of rows) {
      const dateStr = r.renewal_date ?? r.close_date
      const month = dateStr ? dateStr.slice(0, 7) : null
      if (!month || !monthSet.has(month)) continue
      if (!arrMap.has(month)) {
        arrMap.set(month, new Map())
        countMap.set(month, new Map())
      }
      const aMap = arrMap.get(month)!
      const cMap = countMap.get(month)!
      const stage = (r.stage_name || '').trim()
      const ufr = r.ufr_arr ?? 0
      const arr = r.arr ?? 0
      if (stage === 'Closed Won') {
        aMap.set(RENEWED, (aMap.get(RENEWED) ?? 0) + arr)
        cMap.set(RENEWED, (cMap.get(RENEWED) ?? 0) + 1)
      } else if (stage === 'Closed Lost') {
        aMap.set(LOST, (aMap.get(LOST) ?? 0) + ufr)
        cMap.set(LOST, (cMap.get(LOST) ?? 0) + 1)
      } else {
        aMap.set(OPEN, (aMap.get(OPEN) ?? 0) + ufr)
        cMap.set(OPEN, (cMap.get(OPEN) ?? 0) + 1)
      }
    }
    const months = last6Months.filter((m) => arrMap.has(m)).reverse()
    const stages = [RENEWED, LOST, OPEN]
    const stageColors: Record<string, string> = {
      [RENEWED]: '#10b981',
      [LOST]: '#ef4444',
      [OPEN]: '#94a3b8',
    }
    return { months, stages, arrMap, countMap, stageColors }
  }, [rows, last6Months])

  const PLOT_HEIGHT = 180
  const ARR_Y_MAX = 400_000 // $400K
  const ARR_Y_TICKS = [0, 100, 200, 300, 400]
  const formatArrTick = (tick: number) => (tick === 0 ? '$0' : `$${tick}K`)
  const COUNT_Y_TICKS = [0, 5, 10, 15, 20]
  const COUNT_Y_MAX = 20

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(
        key === 'account_name' || key === 'segment' || key === 'opportunity_name' || key === 'stage_name' || key === 'close_date'
          ? 'asc'
          : 'desc' // ufr_arr, arr, renewal_change_arr
      )
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const numKeys = ['arr', 'ufr_arr', 'renewal_change_arr']
      const aVal: string | number = a[sortKey as keyof typeof a] ?? (numKeys.includes(sortKey) ? 0 : '')
      const bVal: string | number = b[sortKey as keyof typeof b] ?? (numKeys.includes(sortKey) ? 0 : '')
      if (typeof aVal === 'number' && typeof bVal === 'number') return dir * (aVal - bVal)
      const sa = String(aVal).toLowerCase()
      const sb = String(bVal).toLowerCase()
      return dir * (sa < sb ? -1 : sa > sb ? 1 : 0)
    })
  }, [rows, sortKey, sortDir])

  const closeDateOptions = data?.available_months ?? []

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

  const filterColToSortKey: Record<FilterColumn, SortKey> = {
    segment: 'segment',
    stage: 'stage_name',
    close_date: 'close_date',
  }

  const thFilter = (
    col: FilterColumn,
    label: string,
    thRef: React.RefObject<HTMLTableHeaderCellElement | null>,
    popoverRef: React.RefObject<HTMLDivElement | null>,
    options: string[],
    selected: string[],
    setSelected: (v: string[]) => void,
    optionLabel?: (value: string) => string
  ) => {
    const isOpen = openFilter === col
    const sortKeyForCol = filterColToSortKey[col]
    const isSortActive = sortKey === sortKeyForCol
    const hasActiveFilter = selected.length > 0
    return (
      <th
        ref={thRef as React.RefObject<HTMLTableHeaderCellElement>}
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
          {label}
          {isSortActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpenFilter((f) => (f === col ? null : col)) }}
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
          <div ref={popoverRef as React.RefObject<HTMLDivElement>} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
            <select
              multiple
              size={Math.min(6, Math.max(2, options.length))}
              value={selected}
              onChange={(e) => setSelected(Array.from(e.target.selectedOptions, (o) => o.value))}
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
                <option key={opt} value={opt}>{optionLabel ? optionLabel(opt) : opt}</option>
              ))}
            </select>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>Ctrl+click to select multiple</p>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => setSelected([])}
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

  const formatMonthLabel = (month: string) => {
    const [y, m] = month.split('-')
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }

  const linkStyle = { color: 'var(--accent)', textDecoration: 'none' }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Renewals Overview</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Open and closed renewal opportunities. Shown by renewal date (close date). ARR from product line items (excl. iVerify/Kipu).
      </p>
      {data?.renewal_date_used === false && (
        <p style={{ fontSize: '0.85rem', color: 'var(--warning)', marginBottom: '1rem', padding: '0.5rem 0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6 }}>
          Months are based on <strong>close date</strong>. To bucket by renewal date (e.g. so opps like Innovative Billing Solutions appear in the correct month), set <code>SALESFORCE_RENEWAL_DATE_FIELD</code> in the backend (e.g. <code>Renewal_Date__c</code>) and run Sync from Salesforce.
        </p>
      )}

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
        {syncStatus === 'ok' && syncMessage && <span style={{ fontSize: '0.9rem', color: 'var(--positive)' }}>{syncMessage}</span>}
        {syncStatus === 'error' && syncMessage && <span style={{ fontSize: '0.9rem', color: 'var(--negative)' }}>{syncMessage}</span>}
        {(filterSegment.length > 0 || filterStage.length > 0 || filterCloseDate.length > 0) && (
          <button
            type="button"
            onClick={() => {
              setFilterSegment([])
              setFilterStage([])
              setFilterCloseDate([])
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
        )}
      </p>

      {chartDataByStage.months.length > 0 && (
        <div style={{ marginBottom: '1.5rem', maxWidth: '100%', display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
              Renewals by renewal date and stage (ARR) — last 6 months
            </div>
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem' }}>
                <div style={{ width: 40, flexShrink: 0, height: PLOT_HEIGHT, position: 'relative', color: 'var(--text-muted)', fontSize: '0.7rem', paddingRight: 8 }}>
                  {ARR_Y_TICKS.slice().reverse().map((tick, i) => {
                    const topPx = (i / (ARR_Y_TICKS.length - 1)) * PLOT_HEIGHT
                    return (
                      <span key={tick} style={{ position: 'absolute', right: 8, top: topPx, transform: 'translateY(-50%)', lineHeight: 1, textAlign: 'right' }}>
                        {formatArrTick(tick)}
                      </span>
                    )
                  })}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                      {ARR_Y_TICKS.map((_, i) => (
                        <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: (i / (ARR_Y_TICKS.length - 1)) * PLOT_HEIGHT, height: 1, background: 'var(--border)', opacity: 0.7 }} />
                      ))}
                    </div>
                    <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                      {chartDataByStage.months.map((month) => {
                        const stageMap = chartDataByStage.arrMap.get(month)!
                        const total = Array.from(stageMap.values()).reduce((a, b) => a + b, 0)
                        const barHeightPct = total > 0 ? Math.min(100, (total / ARR_Y_MAX) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        const totalK = Math.round(total / 1000)
                        return (
                          <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.5rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.25em', flexShrink: 0 }}>
                              {total > 0 ? `$${totalK}K` : '$0'}
                            </div>
                            <div style={{ width: '100%', maxWidth: 36, height: total > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0', flexShrink: 0 }}>
                              {chartDataByStage.stages.map((stage) => {
                                const arr = stageMap.get(stage) ?? 0
                                if (arr <= 0) return null
                                const pct = total > 0 ? (arr / total) * 100 : 0
                                const arrK = Math.round(arr / 1000)
                                const segmentHeightPx = total > 0 && barHeight > 0 ? (arr / total) * barHeight : 0
                                const showLabel = segmentHeightPx >= 14
                                return (
                                  <div
                                    key={stage}
                                    style={{
                                      flex: `${pct} 0 0`,
                                      minHeight: 0,
                                      background: chartDataByStage.stageColors[stage],
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      color: '#fff',
                                      fontWeight: 600,
                                      fontSize: '0.7rem',
                                      textShadow: '0 0 1px rgba(0,0,0,0.5)',
                                    }}
                                    title={`${stage}: ${fmtMoney(arr)}`}
                                  >
                                    {showLabel ? `$${arrK}K` : ''}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem', paddingLeft: 0 }}>
                    {chartDataByStage.months.map((month) => (
                      <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                    ))}
                  </div>
                </div>
              </div>
              {/* Renewal rate row (left): Renewed / Up for renewal (renewed + churned + open) */}
              <div style={{ display: 'flex', gap: 0, marginTop: '0.5rem', alignItems: 'center', fontSize: '0.75rem' }}>
                <div style={{ width: 40, flexShrink: 0, paddingRight: 8, paddingLeft: 0, color: 'var(--text-muted)', textAlign: 'left' }}>Renewal rate</div>
                <div style={{ flex: 1, minWidth: 0, paddingLeft: 4, display: 'flex', gap: '0.25rem' }}>
                  {chartDataByStage.months.map((month) => {
                    const stageMap = chartDataByStage.arrMap.get(month)!
                    const renewed = stageMap.get('Renewed') ?? 0
                    const churned = stageMap.get('Churned/ contracted') ?? 0
                    const open = stageMap.get('Open') ?? 0
                    const upForRenewal = renewed + churned + open
                    const rate = upForRenewal > 0 ? (renewed / upForRenewal) * 100 : null
                    return (
                      <div key={month} style={{ flex: 1, textAlign: 'center', fontWeight: 600, color: rate != null ? 'var(--text)' : 'var(--text-muted)' }}>
                        {rate != null ? `${rate.toFixed(1)}%` : '—'}
                      </div>
                    )
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {chartDataByStage.stages.map((stage) => (
                  <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: chartDataByStage.stageColors[stage] }} />
                    {stage}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
              Renewals by renewal date and stage (# opportunities) — last 6 months
            </div>
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem' }}>
                <div style={{ width: 36, flexShrink: 0, height: PLOT_HEIGHT, position: 'relative', color: 'var(--text-muted)', fontSize: '0.7rem', paddingRight: 8 }}>
                  {COUNT_Y_TICKS.slice().reverse().map((tick, i) => {
                    const topPx = (i / (COUNT_Y_TICKS.length - 1)) * PLOT_HEIGHT
                    return (
                      <span key={tick} style={{ position: 'absolute', right: 8, top: topPx, transform: 'translateY(-50%)', lineHeight: 1, textAlign: 'right' }}>{tick}</span>
                    )
                  })}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                      {COUNT_Y_TICKS.map((_, i) => (
                        <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: (i / (COUNT_Y_TICKS.length - 1)) * PLOT_HEIGHT, height: 1, background: 'var(--border)', opacity: 0.7 }} />
                      ))}
                    </div>
                    <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                      {chartDataByStageCount.months.map((month) => {
                        const countStageMap = chartDataByStageCount.countMap.get(month)!
                        const totalCount = Array.from(countStageMap.values()).reduce((a, b) => a + b, 0)
                        const barHeightPct = totalCount > 0 ? Math.min(100, (totalCount / COUNT_Y_MAX) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        return (
                          <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.5rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.25em', flexShrink: 0 }}>{totalCount}</div>
                            <div style={{ width: '100%', maxWidth: 36, height: totalCount > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0', flexShrink: 0 }}>
                              {chartDataByStageCount.stages.map((stage) => {
                                const count = countStageMap.get(stage) ?? 0
                                if (count <= 0) return null
                                const segPct = totalCount > 0 ? (count / totalCount) * 100 : 0
                                const segmentHeightPx = totalCount > 0 && barHeight > 0 ? (count / totalCount) * barHeight : 0
                                const showLabel = segmentHeightPx >= 14
                                return (
                                  <div
                                    key={stage}
                                    style={{
                                      flex: `${segPct} 0 0`,
                                      minHeight: 0,
                                      background: chartDataByStageCount.stageColors[stage],
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      color: '#fff',
                                      fontWeight: 600,
                                      fontSize: '0.7rem',
                                      textShadow: '0 0 1px rgba(0,0,0,0.5)',
                                    }}
                                    title={`${stage}: ${count} opps`}
                                  >
                                    {showLabel ? count : ''}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem', paddingLeft: 0 }}>
                    {chartDataByStageCount.months.map((month) => (
                      <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                    ))}
                  </div>
                </div>
              </div>
              {/* Renewal rate row: Renewed / (Renewed + Open + Lost) */}
              <div style={{ display: 'flex', gap: 0, marginTop: '0.5rem', alignItems: 'center', fontSize: '0.75rem' }}>
                <div style={{ width: 36, flexShrink: 0, paddingRight: 8, paddingLeft: 0, color: 'var(--text-muted)', textAlign: 'left' }}>Renewal rate</div>
                <div style={{ flex: 1, minWidth: 0, paddingLeft: 4, display: 'flex', gap: '0.25rem' }}>
                  {chartDataByStageCount.months.map((month) => {
                    const countStageMap = chartDataByStageCount.countMap.get(month)!
                    const renewed = countStageMap.get('Renewed') ?? 0
                    const open = countStageMap.get('Open') ?? 0
                    const lost = countStageMap.get('Lost') ?? 0
                    const upForRenewal = renewed + open + lost
                    const rate = upForRenewal > 0 ? (renewed / upForRenewal) * 100 : null
                    return (
                      <div key={month} style={{ flex: 1, textAlign: 'center', fontWeight: 600, color: rate != null ? 'var(--text)' : 'var(--text-muted)' }}>
                        {rate != null ? `${rate.toFixed(1)}%` : '—'}
                      </div>
                    )
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {chartDataByStageCount.stages.map((stage) => (
                  <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: chartDataByStageCount.stageColors[stage] }} />
                    {stage}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 600, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {th('account_name', 'Account', 'left')}
              {thFilter('segment', 'Segment', segmentThRef, segmentPopoverRef, data.segments ?? [], filterSegment, setFilterSegment)}
              {th('opportunity_name', 'Opportunity', 'left')}
              {thFilter('stage', 'Stage', stageThRef, stagePopoverRef, data.stages ?? [], filterStage, setFilterStage)}
              {thFilter('close_date', 'Renewal date', closeDateThRef, closeDatePopoverRef, closeDateOptions, filterCloseDate, setFilterCloseDate, formatMonthLabel)}
              {th('ufr_arr', 'UFR ARR', 'right')}
              {th('arr', 'Renewed ARR', 'right')}
              {th('renewal_change_arr', 'Delta', 'right')}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(rows.reduce((s, r) => s + (r.ufr_arr ?? 0), 0))}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(rows.reduce((s, r) => s + r.arr, 0))}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(rows.reduce((s, r) => s + (r.renewal_change_arr ?? 0), 0))}</td>
            </tr>
            {sortedRows.map((row) => (
              <tr key={row.opportunity_sf_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {row.account_id && salesforce_base_url ? (
                    <a href={salesforce_base_url.includes('lightning.force.com') ? `${salesforce_base_url}/lightning/r/Account/${row.account_id}/view` : `${salesforce_base_url}/${row.account_id}`} target="_blank" rel="noopener noreferrer" style={linkStyle} title="Open account in Salesforce">{row.account_name}</a>
                  ) : (
                    row.account_name
                  )}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{row.segment}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {salesforce_base_url ? (
                    <a href={salesforce_base_url.includes('lightning.force.com') ? `${salesforce_base_url}/lightning/r/Opportunity/${row.opportunity_sf_id}/view` : `${salesforce_base_url}/${row.opportunity_sf_id}`} target="_blank" rel="noopener noreferrer" style={linkStyle} title="Open opportunity in Salesforce">{row.opportunity_name}</a>
                  ) : (
                    row.opportunity_name
                  )}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.stage_name}</td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{(row.renewal_date ?? row.close_date) ?? '—'}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500 }}>{row.ufr_arr != null ? fmtMoney(row.ufr_arr) : '—'}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500 }}>
                  {row.stage_name !== 'Closed Won' && row.stage_name !== 'Closed Lost' ? '—' : fmtMoney(row.arr)}
                </td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500, color: row.stage_name !== 'Closed Won' && row.stage_name !== 'Closed Lost' ? undefined : (row.renewal_change_arr ?? 0) > 0 ? 'var(--positive)' : (row.renewal_change_arr ?? 0) < 0 ? 'var(--negative)' : undefined }}>
                  {row.stage_name !== 'Closed Won' && row.stage_name !== 'Closed Lost' ? '—' : ((row.renewal_change_arr ?? 0) >= 0 ? '+' : '') + fmtMoney(row.renewal_change_arr ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={4} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(rows.reduce((s, r) => s + (r.ufr_arr ?? 0), 0))}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(rows.reduce((s, r) => s + r.arr, 0))}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(rows.reduce((s, r) => s + (r.renewal_change_arr ?? 0), 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          No renewal opportunities. Sync from Salesforce to load data.
        </p>
      )}
    </>
  )
}
