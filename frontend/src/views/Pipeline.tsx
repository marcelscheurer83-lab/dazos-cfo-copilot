import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPipelineOverview, syncSalesforce, type PipelineOverviewResponse } from '../api'

type FilterColumn = 'segment' | 'stage' | 'record_type'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

type SortKey = 'account_name' | 'segment' | 'opportunity_name' | 'stage_name' | 'record_type_name' | 'close_date' | 'arr'
type SortDir = 'asc' | 'desc'

export default function Pipeline() {
  const [data, setData] = useState<PipelineOverviewResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('arr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterSegment, setFilterSegment] = useState<string[]>([])
  const [filterStage, setFilterStage] = useState<string[]>([])
  const [filterRecordType, setFilterRecordType] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const segmentThRef = useRef<HTMLTableHeaderCellElement>(null)
  const segmentPopoverRef = useRef<HTMLDivElement>(null)
  const stageThRef = useRef<HTMLTableHeaderCellElement>(null)
  const stagePopoverRef = useRef<HTMLDivElement>(null)
  const recordTypeThRef = useRef<HTMLTableHeaderCellElement>(null)
  const recordTypePopoverRef = useRef<HTMLDivElement>(null)

  const loadData = useCallback(() => {
    getPipelineOverview({
      segment: filterSegment.length ? filterSegment : undefined,
      stage: filterStage.length ? filterStage : undefined,
      record_type: filterRecordType.length ? filterRecordType : undefined,
    })
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [filterSegment, filterStage, filterRecordType])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (openFilter === null) return
    const thRef = openFilter === 'segment' ? segmentThRef : openFilter === 'stage' ? stageThRef : recordTypeThRef
    const popRef = openFilter === 'segment' ? segmentPopoverRef : openFilter === 'stage' ? stagePopoverRef : recordTypePopoverRef
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
          setSyncMessage(
            `Synced ${res.synced_opportunities ?? 0} opportunities, ${res.synced_line_items ?? 0} product lines.`
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

  const rows = Array.isArray(data?.rows) ? data.rows : []
  const grand_total = data?.grand_total ?? 0

  // Aggregate by close month and segment (current month onwards only): ARR and count
  const chartData = useMemo(() => {
    const now = new Date()
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const arrMap = new Map<string, Map<string, number>>()
    const countMap = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const month = r.close_date ? r.close_date.slice(0, 7) : null
      if (!month || month < currentMonth) continue
      if (!arrMap.has(month)) {
        arrMap.set(month, new Map())
        countMap.set(month, new Map())
      }
      const seg = r.segment || '—'
      const arrSeg = arrMap.get(month)!
      const countSeg = countMap.get(month)!
      arrSeg.set(seg, (arrSeg.get(seg) ?? 0) + r.arr)
      countSeg.set(seg, (countSeg.get(seg) ?? 0) + 1)
    }
    const months = Array.from(arrMap.keys()).sort()
    const segmentsSet = new Set<string>()
    arrMap.forEach((segMap) => segMap.forEach((_, seg) => segmentsSet.add(seg)))
    const segments = Array.from(segmentsSet).sort()
    const segmentColors: Record<string, string> = {}
    const palette = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4']
    segments.forEach((s, i) => { segmentColors[s] = palette[i % palette.length] })
    const maxArr = Math.max(1, ...months.map((m) => Array.from(arrMap.get(m)!.values()).reduce((a, b) => a + b, 0)))
    const maxCount = Math.max(1, ...months.map((m) => Array.from(countMap.get(m)!.values()).reduce((a, b) => a + b, 0)))
    return { months, segments, arrMap, countMap, segmentColors, maxArr, maxCount }
  }, [rows])

  const formatMonthLabel = (month: string) => {
    const [y, m] = month.split('-')
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }

  const PLOT_HEIGHT = 180
  const ARR_Y_TICKS = [0, 1, 2, 3] // 0 = $0, 1 = $1M, 2 = $2M, 3 = $3M
  const formatArrTick = (tick: number) => (tick === 0 ? '$0' : `$${tick}M`)
  const COUNT_Y_TICKS = [0, 30, 60, 90, 120]

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
        key === 'account_name' || key === 'segment' || key === 'opportunity_name' || key === 'stage_name' || key === 'record_type_name' || key === 'close_date'
          ? 'asc'
          : 'desc'
      )
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const aVal: string | number = a[sortKey as keyof typeof a] ?? (sortKey === 'arr' ? 0 : '')
      const bVal: string | number = b[sortKey as keyof typeof b] ?? (sortKey === 'arr' ? 0 : '')
      if (typeof aVal === 'number' && typeof bVal === 'number') return dir * (aVal - bVal)
      const sa = String(aVal).toLowerCase()
      const sb = String(bVal).toLowerCase()
      return dir * (sa < sb ? -1 : sa > sb ? 1 : 0)
    })
  }, [rows, sortKey, sortDir])

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

  const thFilter = (
    col: FilterColumn,
    label: string,
    thRef: React.RefObject<HTMLTableHeaderCellElement | null>,
    popoverRef: React.RefObject<HTMLDivElement | null>,
    options: string[],
    selected: string[],
    setSelected: (v: string[]) => void
  ) => {
    const isOpen = openFilter === col
    return (
      <th
        ref={thRef as React.RefObject<HTMLTableHeaderCellElement>}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          setOpenFilter((f) => (f === col ? null : col))
        }}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpenFilter((f) => (f === col ? null : col))}
        style={{
          textAlign: 'left',
          padding: '0.5rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          userSelect: 'none',
          position: 'relative',
          verticalAlign: 'bottom',
        }}
      >
        {label}
        {selected.length > 0 && (
          <span style={{ marginLeft: 4, color: 'var(--accent)', fontWeight: 600 }}>({selected.length})</span>
        )}
        {isOpen && (
          <div
            ref={popoverRef as React.RefObject<HTMLDivElement>}
            style={popoverStyle}
            onClick={(e) => e.stopPropagation()}
          >
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
                <option key={opt} value={opt}>
                  {opt}
                </option>
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

  const linkStyle = { color: 'var(--accent)', textDecoration: 'none' }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Pipeline overview</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Open opportunities: New Business and Expansion only (not Closed Won / Closed Lost). One row per opportunity. ARR = MRR × 12 from Opportunity Finance Details.
      </p>
      {chartData.months.length > 0 && (
        <div style={{ marginBottom: '1.5rem', maxWidth: '100%', display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
          {/* ARR chart: Y-axis $0, $1M, $2M, $3M; bars sit on 0 line; month labels below x-axis; legend below */}
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and segment (ARR)</div>
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem' }}>
                <div style={{ width: 36, flexShrink: 0, height: PLOT_HEIGHT, position: 'relative', color: 'var(--text-muted)', fontSize: '0.7rem', paddingRight: 8 }}>
                  {ARR_Y_TICKS.slice().reverse().map((tick, i) => {
                    const topPx = (i / (ARR_Y_TICKS.length - 1)) * PLOT_HEIGHT
                    return (
                      <span
                        key={tick}
                        style={{
                          position: 'absolute',
                          right: 8,
                          top: topPx,
                          transform: 'translateY(-50%)',
                          lineHeight: 1,
                          textAlign: 'right',
                        }}
                      >
                        {formatArrTick(tick)}
                      </span>
                    )
                  })}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  {/* Bar area: fixed height so 0 grid line = bottom of bars; month labels go below */}
                  <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                      {ARR_Y_TICKS.map((_, i) => (
                        <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: (i / (ARR_Y_TICKS.length - 1)) * PLOT_HEIGHT, height: 1, background: 'var(--border)', opacity: 0.7 }} />
                      ))}
                    </div>
                    <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                      {chartData.months.map((month) => {
                        const segMap = chartData.arrMap.get(month)!
                        const total = Array.from(segMap.values()).reduce((a, b) => a + b, 0)
                        const arrMax = 3e6
                        const barHeightPct = total > 0 ? Math.min(100, (total / arrMax) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        return (
                          <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                              {total > 0 ? `$${(total / 1e6).toFixed(1)}M` : '$0'}
                            </div>
                            <div style={{ width: '100%', maxWidth: 36, height: total > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                              {chartData.segments.map((seg) => {
                                const arr = segMap.get(seg) ?? 0
                                if (arr <= 0) return null
                                const segPct = total > 0 ? (arr / total) * 100 : 0
                                const millions = arr / 1e6
                                return (
                                  <div
                                    key={seg}
                                    style={{
                                      height: `${segPct}%`,
                                      minHeight: millions >= 0.05 ? 20 : 0,
                                      background: chartData.segmentColors[seg],
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      color: '#fff',
                                      fontWeight: 600,
                                      fontSize: '0.7rem',
                                      textShadow: '0 0 1px rgba(0,0,0,0.5)',
                                    }}
                                    title={`${seg}: ${fmtMoney(arr)}`}
                                  >
                                    {millions >= 0.05 ? `$${millions.toFixed(1)}M` : ''}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  {/* X-axis: month labels below the 0 grid line */}
                  <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem', paddingLeft: 0 }}>
                    {chartData.months.map((month) => (
                      <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {chartData.segments.map((seg) => (
                  <span key={seg} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: chartData.segmentColors[seg] }} />
                    {seg}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {/* Opportunities chart: same layout — Y aligned with grid, 0 at baseline, months below, legend below */}
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and segment (# opportunities)</div>
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem' }}>
                <div style={{ width: 36, flexShrink: 0, height: PLOT_HEIGHT, position: 'relative', color: 'var(--text-muted)', fontSize: '0.7rem', paddingRight: 8 }}>
                  {COUNT_Y_TICKS.slice().reverse().map((tick, i) => {
                    const topPx = (i / (COUNT_Y_TICKS.length - 1)) * PLOT_HEIGHT
                    return (
                      <span
                        key={tick}
                        style={{
                          position: 'absolute',
                          right: 8,
                          top: topPx,
                          transform: 'translateY(-50%)',
                          lineHeight: 1,
                          textAlign: 'right',
                        }}
                      >
                        {tick}
                      </span>
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
                      {chartData.months.map((month) => {
                        const countSegMap = chartData.countMap.get(month)!
                        const totalCount = Array.from(countSegMap.values()).reduce((a, b) => a + b, 0)
                        const countMax = 120
                        const barHeightPct = totalCount > 0 ? Math.min(100, (totalCount / countMax) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        return (
                          <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                              {totalCount}
                            </div>
                            <div style={{ width: '100%', maxWidth: 36, height: totalCount > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                              {chartData.segments.map((seg) => {
                                const count = countSegMap.get(seg) ?? 0
                                if (count <= 0) return null
                                const segPct = totalCount > 0 ? (count / totalCount) * 100 : 0
                                return (
                                  <div
                                    key={seg}
                                    style={{
                                      height: `${segPct}%`,
                                      minHeight: count >= 1 ? 20 : 0,
                                      background: chartData.segmentColors[seg],
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      color: '#fff',
                                      fontWeight: 600,
                                      fontSize: '0.7rem',
                                      textShadow: '0 0 1px rgba(0,0,0,0.5)',
                                    }}
                                    title={`${seg}: ${count} opps`}
                                  >
                                    {count >= 1 ? count : ''}
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
                    {chartData.months.map((month) => (
                      <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {chartData.segments.map((seg) => (
                  <span key={seg} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: chartData.segmentColors[seg] }} />
                    {seg}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
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
        {syncStatus === 'ok' && syncMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--positive)' }}>{syncMessage}</span>
        )}
        {syncStatus === 'error' && syncMessage && (
          <span style={{ fontSize: '0.9rem', color: 'var(--negative)' }}>{syncMessage}</span>
        )}
        {(filterSegment.length > 0 || filterStage.length > 0 || filterRecordType.length > 0) && (
          <button
            type="button"
            onClick={() => {
              setFilterSegment([])
              setFilterStage([])
              setFilterRecordType([])
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
            Clear all filters
          </button>
        )}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 600, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {th('account_name', 'Account', 'left')}
              {thFilter('segment', 'Segment', segmentThRef, segmentPopoverRef, data.segments ?? [], filterSegment, setFilterSegment)}
              {th('opportunity_name', 'Opportunity', 'left')}
              {thFilter('stage', 'Stage', stageThRef, stagePopoverRef, data.stages ?? [], filterStage, setFilterStage)}
              {thFilter('record_type', 'Record type', recordTypeThRef, recordTypePopoverRef, data.record_types ?? [], filterRecordType, setFilterRecordType)}
              {th('close_date', 'Close date', 'left')}
              {th('arr', 'ARR', 'right')}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={5} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grand_total)}</td>
            </tr>
            {sortedRows.map((row) => (
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
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{row.segment}</td>
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
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.record_type_name}</td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.close_date ?? '—'}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500 }}>{fmtMoney(row.arr)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={5} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grand_total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>No open opportunities. Sync from Salesforce to load pipeline.</p>
      )}
    </>
  )
}
