import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPipelineOverview, syncSalesforce, type PipelineOverviewResponse } from '../api'

type FilterColumn = 'segment' | 'stage' | 'record_type' | 'close_date'

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
  const [filterCloseDate, setFilterCloseDate] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const segmentThRef = useRef<HTMLTableHeaderCellElement>(null)
  const segmentPopoverRef = useRef<HTMLDivElement>(null)
  const stageThRef = useRef<HTMLTableHeaderCellElement>(null)
  const stagePopoverRef = useRef<HTMLDivElement>(null)
  const recordTypeThRef = useRef<HTMLTableHeaderCellElement>(null)
  const recordTypePopoverRef = useRef<HTMLDivElement>(null)
  const closeDateThRef = useRef<HTMLTableHeaderCellElement>(null)
  const closeDatePopoverRef = useRef<HTMLDivElement>(null)

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
    const thRef =
      openFilter === 'segment'
        ? segmentThRef
        : openFilter === 'stage'
          ? stageThRef
          : openFilter === 'record_type'
            ? recordTypeThRef
            : closeDateThRef
    const popRef =
      openFilter === 'segment'
        ? segmentPopoverRef
        : openFilter === 'stage'
          ? stagePopoverRef
          : openFilter === 'record_type'
            ? recordTypePopoverRef
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

  /** Normalize close_date to YYYY-MM so all February rows land in one bucket (handles 2026-2 vs 2026-02). */
  const toMonthKey = (closeDate: string | null): string | null => {
    if (!closeDate || typeof closeDate !== 'string') return null
    const s = closeDate.trim().slice(0, 10)
    const match = s.match(/^(\d{4})-(\d{1,2})/)
    if (!match) return null
    const y = match[1]
    const m = String(parseInt(match[2], 10)).padStart(2, '0')
    return `${y}-${m}`
  }

  // Aggregate by close month and segment (current month onwards only)
  const chartData = useMemo(() => {
    const now = new Date()
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const arrMap = new Map<string, Map<string, number>>()
    const countMap = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const month = toMonthKey(r.close_date ?? null)
      if (!month || month < currentMonth) continue
      if (!arrMap.has(month)) {
        arrMap.set(month, new Map())
        countMap.set(month, new Map())
      }
      const seg = (r.segment || '—').replace(/\s+/g, ' ').trim() || '—'
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

  // Aggregate by close month and stage (current month onwards only)
  const chartDataByStage = useMemo(() => {
    const now = new Date()
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const arrMap = new Map<string, Map<string, number>>()
    const countMap = new Map<string, Map<string, number>>()
    // Key = only letters (lowercase); any variant of a stage name maps to same key so Feb/Mar match
    const stageToKey = (s: string) => (s || '').toLowerCase().replace(/[^a-z]/g, '')
    const KEY_TO_CANONICAL: Record<string, string> = {
      pricingnegotiation: 'Pricing & Negotiation',
      contractclose: 'Contract & Close',
      demosolutioning: 'Demo & Solutioning',
      discoveryapplicationoverview: 'Discovery & Application Overview',
      qualification: 'Qualification',
      qualif: 'Qualification',
      proposal: 'Proposal',
      internal: 'Internal',
    }
    const normalizeStage = (s: string) => {
      if (!s || typeof s !== 'string') return '—'
      let t = s.replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/g, '').trim()
      t = t.replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
      t = t.replace(/\s+and\s+/gi, ' & ')
      t = t.replace(/\s*[&\uFF06\u214B]\s*/g, ' & ')
      t = t.replace(/\s+/g, ' ').trim()
      const key = stageToKey(t)
      if (KEY_TO_CANONICAL[key]) return KEY_TO_CANONICAL[key]
      const canonical: Record<string, string> = {
        'pricing & negotiation': 'Pricing & Negotiation',
        'contract & close': 'Contract & Close',
        'demo & solutioning': 'Demo & Solutioning',
        'discovery & application overview': 'Discovery & Application Overview',
      }
      const lower = t.toLowerCase()
      return (canonical[lower] ?? t) || '—'
    }
    for (const r of rows) {
      const month = toMonthKey(r.close_date ?? null)
      if (!month || month < currentMonth) continue
      if (!arrMap.has(month)) {
        arrMap.set(month, new Map())
        countMap.set(month, new Map())
      }
      const stage = normalizeStage(r.stage_name || '—')
      const arrStage = arrMap.get(month)!
      const countStage = countMap.get(month)!
      arrStage.set(stage, (arrStage.get(stage) ?? 0) + r.arr)
      countStage.set(stage, (countStage.get(stage) ?? 0) + 1)
    }
    // Merge any remaining variant keys into canonical (e.g. "Qualif" -> "Qualification")
    const canonicalList = ['Pricing & Negotiation', 'Contract & Close', 'Demo & Solutioning', 'Discovery & Application Overview', 'Qualification', 'Proposal', 'Internal']
    for (const month of countMap.keys()) {
      const countStage = countMap.get(month)!
      for (const key of Array.from(countStage.keys())) {
        const canonical = canonicalList.find((c) => c.toLowerCase() === key.toLowerCase() || normalizeStage(key) === c)
        if (canonical && canonical !== key) {
          countStage.set(canonical, (countStage.get(canonical) ?? 0) + (countStage.get(key) ?? 0))
          countStage.delete(key)
        }
      }
    }
    for (const month of arrMap.keys()) {
      const arrStage = arrMap.get(month)!
      for (const key of Array.from(arrStage.keys())) {
        const canonical = canonicalList.find((c) => c.toLowerCase() === key.toLowerCase() || normalizeStage(key) === c)
        if (canonical && canonical !== key) {
          arrStage.set(canonical, (arrStage.get(canonical) ?? 0) + (arrStage.get(key) ?? 0))
          arrStage.delete(key)
        }
      }
    }
    const months = Array.from(arrMap.keys()).sort()
    const stagesSet = new Set<string>()
    arrMap.forEach((stageMap) => stageMap.forEach((_, stage) => stagesSet.add(stage)))
    countMap.forEach((stageMap) => stageMap.forEach((_, stage) => stagesSet.add(stage)))
    const stages = Array.from(stagesSet).sort()
    const stageColors: Record<string, string> = {}
    const palette = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316']
    // Ensure Qualification and Contract & Close are visually distinct (not same or too similar)
    const reservedForContractClose = '#8b5cf6'   // violet
    const reservedForQualification = '#06b6d4'   // cyan (distinct from violet)
    const reservedForDemoSolutioning = '#6b7280' // grey (tailwind gray-500)
    const remainingPalette = palette.filter(
      (c) => c !== reservedForContractClose && c !== reservedForQualification && c !== reservedForDemoSolutioning
    )
    let paletteIndex = 0
    for (const s of stages) {
      if (s === 'Contract & Close') stageColors[s] = reservedForContractClose
      else if (s === 'Qualification') stageColors[s] = reservedForQualification
      else if (s === 'Demo & Solutioning') stageColors[s] = reservedForDemoSolutioning
      else {
        stageColors[s] = remainingPalette[paletteIndex % remainingPalette.length]
        paletteIndex += 1
      }
    }
    return { months, stages, arrMap, countMap, stageColors }
  }, [rows])

  const formatMonthLabel = (month: string) => {
    const [y, m] = month.split('-')
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }

  const PLOT_HEIGHT = 180
  const ARR_Y_TICKS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] // gridlines every $0.5M, max $3.5M
  const formatArrTick = (tick: number) => (tick === 0 ? '$0.0M' : `$${Number(tick).toFixed(1)}M`)
  const COUNT_Y_TICKS = [0, 30, 60, 90, 120, 150]

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

  const closeDateOptions = useMemo(() => {
    const months = [...new Set(rows.map((r) => toMonthKey(r.close_date ?? null)).filter(Boolean))] as string[]
    return months.sort().reverse()
  }, [rows])

  const displayRows = useMemo(() => {
    if (filterCloseDate.length === 0) return sortedRows
    return sortedRows.filter((r) => {
      const m = toMonthKey(r.close_date ?? null)
      return m != null && filterCloseDate.includes(m)
    })
  }, [sortedRows, filterCloseDate])

  const grandTotalDisplay =
    filterCloseDate.length > 0 ? displayRows.reduce((s, r) => s + r.arr, 0) : grand_total

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
    record_type: 'record_type_name',
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
          style={{
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {label}
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
                  {optionLabel ? optionLabel(opt) : opt}
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
        <div style={{ marginBottom: '1.5rem', maxWidth: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
          {/* Row 1: by segment */}
          {/* Open pipeline by close month and segment (ARR) */}
          <div style={{ minWidth: 0 }}>
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
                        const arrMax = 3.5e6
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
          {/* Open pipeline by close month and segment (# opportunities) */}
          <div style={{ minWidth: 0 }}>
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
                        const segmentsThisMonth = Array.from(countSegMap.keys()).sort()
                        const totalCount = segmentsThisMonth.reduce((sum, seg) => sum + (countSegMap.get(seg) ?? 0), 0)
                        const countMax = 150
                        const barHeightPct = totalCount > 0 ? Math.min(100, (totalCount / countMax) * 100) : 0
                        const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                        return (
                          <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                            <div style={{ flex: 1, minHeight: 0 }} />
                            <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                              {totalCount}
                            </div>
                            <div style={{ width: '100%', maxWidth: 36, height: totalCount > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                              {segmentsThisMonth.map((seg) => {
                                const count = countSegMap.get(seg) ?? 0
                                if (count <= 0) return null
                                const segPct = totalCount > 0 ? (count / totalCount) * 100 : 0
                                const color = chartData.segmentColors[seg] ?? '#94a3b8'
                                return (
                                  <div
                                    key={seg}
                                    style={{
                                      height: `${segPct}%`,
                                      minHeight: count >= 1 ? 20 : 0,
                                      background: color,
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
          {/* Row 2: by stage */}
          {chartDataByStage.months.length > 0 && (
            <>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and stage (ARR)</div>
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
                            const arrMax = 3.5e6
                            const barHeightPct = total > 0 ? Math.min(100, (total / arrMax) * 100) : 0
                            const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                            return (
                              <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                                <div style={{ flex: 1, minHeight: 0 }} />
                                <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                                  {total > 0 ? `$${(total / 1e6).toFixed(1)}M` : '$0'}
                                </div>
                                <div style={{ width: '100%', maxWidth: 36, height: total > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                                  {chartDataByStage.stages.map((stage) => {
                                    const arr = stageMap.get(stage) ?? 0
                                    if (arr <= 0) return null
                                    const stagePct = total > 0 ? (arr / total) * 100 : 0
                                    const millions = arr / 1e6
                                    return (
                                      <div
                                        key={stage}
                                        style={{
                                          height: `${stagePct}%`,
                                          minHeight: millions >= 0.05 ? 20 : 0,
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
                      <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem', paddingLeft: 0 }}>
                        {chartDataByStage.months.map((month) => (
                          <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                        ))}
                      </div>
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
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and stage (# opportunities)</div>
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
                          {chartDataByStage.months.map((month) => {
                            const countStageMap = chartDataByStage.countMap.get(month)!
                            const totalCount = chartDataByStage.stages.reduce(
                              (sum, stage) => sum + (countStageMap.get(stage) ?? 0),
                              0
                            )
                            const countMax = 150
                            const barHeightPct = totalCount > 0 ? Math.min(100, (totalCount / countMax) * 100) : 0
                            const barHeight = (barHeightPct / 100) * PLOT_HEIGHT
                            return (
                              <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                                <div style={{ flex: 1, minHeight: 0 }} />
                                <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                                  {totalCount}
                                </div>
                                <div style={{ width: '100%', maxWidth: 36, height: totalCount > 0 ? barHeight : 0, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                                  {chartDataByStage.stages.map((stage) => {
                                    const count = countStageMap.get(stage) ?? 0
                                    if (count <= 0) return null
                                    const stagePct = totalCount > 0 ? (count / totalCount) * 100 : 0
                                    const color = chartDataByStage.stageColors[stage] ?? '#94a3b8'
                                    const segmentHeightPx = totalCount > 0 && barHeight > 0 ? (count / totalCount) * barHeight : 0
                                    const showLabel = segmentHeightPx >= 14
                                    return (
                                      <div
                                        key={stage}
                                        style={{
                                          flex: `${stagePct} 0 0`,
                                          minHeight: 0,
                                          background: color,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          color: '#fff',
                                          fontWeight: 600,
                                          fontSize: '0.7rem',
                                          lineHeight: 1,
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
                        {chartDataByStage.months.map((month) => (
                          <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem', textTransform: 'uppercase' }}>Stages</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {chartDataByStage.stages.map((stage) => (
                        <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: chartDataByStage.stageColors[stage], flexShrink: 0 }} />
                          {stage}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
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
        {(filterSegment.length > 0 || filterStage.length > 0 || filterRecordType.length > 0 || filterCloseDate.length > 0) && (
          <button
            type="button"
            onClick={() => {
              setFilterSegment([])
              setFilterStage([])
              setFilterRecordType([])
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
              {thFilter('close_date', 'Close date', closeDateThRef, closeDatePopoverRef, closeDateOptions, filterCloseDate, setFilterCloseDate, formatMonthLabel)}
              {th('arr', 'ARR', 'right')}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={5} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
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
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
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
