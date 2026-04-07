import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAIObservations, getPipelineOverview, type AIObservationsResponse, type PipelineOverviewResponse } from '../api'
import { loadPipelineFilters, savePipelineFilters } from '../tableFilterStorage'

type FilterColumn = 'stage' | 'record_type' | 'close_date' | 'deal_tier'

/** Map deal tier label → floor probability % string shown in the Tier % column. */
function tierPct(tier: string | null | undefined): string {
  if (!tier) return '—'
  const t = tier.toLowerCase()
  if (t.includes('commit')) return '90%'
  if (t.includes('strong')) return '50%'
  if (t.includes('weak')) return '25%'
    if (t.includes('hail') || t.includes('mary')) return '10%'
  return '—'
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

type SortKey = 'account_name' | 'opportunity_name' | 'stage_name' | 'record_type_name' | 'close_date' | 'arr'
type SortDir = 'asc' | 'desc'

/** Same stage bucket as stacked charts (must match chartDataByStage). */
function pipelineChartStageKey(stageName: string | null | undefined): string {
  if (!stageName || typeof stageName !== 'string') return '—'
  let t = stageName.replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/g, '').trim()
  t = t.replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
  t = t.replace(/\s+and\s+/gi, ' & ')
  t = t.replace(/\s*[&\uFF06\u214B]\s*/g, ' & ')
  t = t.replace(/\s+/g, ' ').trim()
  const stageToKey = (s: string) => (s || '').toLowerCase().replace(/[^a-z]/g, '')
  const key = stageToKey(t)
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

const PIPELINE_CHART_CANONICAL_MERGE = [
  'Pricing & Negotiation',
  'Contract & Close',
  'Demo & Solutioning',
  'Discovery & Application Overview',
  'Qualification',
  'Proposal',
  'Internal',
] as const

/** Stage key after the same merge pass as chart maps (for filtering rows to a stack). */
function mergedPipelineChartStage(stageName: string | null | undefined): string {
  const key = pipelineChartStageKey(stageName || '—')
  const canonical = PIPELINE_CHART_CANONICAL_MERGE.find(
    (c) => c.toLowerCase() === key.toLowerCase() || pipelineChartStageKey(key) === c
  )
  return canonical && canonical !== key ? canonical : key
}

export default function Pipeline() {
  const [data, setData] = useState<PipelineOverviewResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [observations, setObservations] = useState<AIObservationsResponse | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('arr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const storedPipeline = useRef<ReturnType<typeof loadPipelineFilters> | null>(null)
  if (storedPipeline.current === null) storedPipeline.current = loadPipelineFilters()
  const pv = storedPipeline.current
  const [filterStage, setFilterStage] = useState<string[]>(() => pv.stage)
  const [filterRecordType, setFilterRecordType] = useState<string[]>(() => pv.recordType)
  const [filterCloseDate, setFilterCloseDate] = useState<string[]>(() => pv.closeDate)
  const [filterDealTier, setFilterDealTier] = useState<string[]>([])
  /** Chart stack selection: close month + stage bucket (month null = all months). */
  const [chartSliceFilter, setChartSliceFilter] = useState<{ month: string | null; stage: string } | null>(
    () => pv.chartSlice
  )
  /** Tier chart selection: close month + tier (month null = all months). */
  const [tierSliceFilter, setTierSliceFilter] = useState<{ month: string | null; tier: string } | null>(null)
  const [openFilter, setOpenFilter] = useState<FilterColumn | null>(null)
  const [aiTooltip, setAiTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const stageThRef = useRef<HTMLTableHeaderCellElement>(null)
  const stagePopoverRef = useRef<HTMLDivElement>(null)
  const recordTypeThRef = useRef<HTMLTableHeaderCellElement>(null)
  const recordTypePopoverRef = useRef<HTMLDivElement>(null)
  const closeDateThRef = useRef<HTMLTableHeaderCellElement>(null)
  const closeDatePopoverRef = useRef<HTMLDivElement>(null)
  const dealTierThRef = useRef<HTMLTableHeaderCellElement>(null)
  const dealTierPopoverRef = useRef<HTMLDivElement>(null)

  const loadData = useCallback(() => {
    getPipelineOverview({
      stage: filterStage.length ? filterStage : undefined,
      record_type: filterRecordType.length ? filterRecordType : undefined,
    })
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [filterStage, filterRecordType])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    getAIObservations('pipeline').then(setObservations).catch(() => {})
  }, [])

  useEffect(() => {
    savePipelineFilters({
      stage: filterStage,
      recordType: filterRecordType,
      closeDate: filterCloseDate,
      chartSlice: chartSliceFilter,
    })
  }, [filterStage, filterRecordType, filterCloseDate, chartSliceFilter])

  useEffect(() => {
    if (openFilter === null) return
    const thRef =
      openFilter === 'stage'
        ? stageThRef
        : openFilter === 'record_type'
          ? recordTypeThRef
          : openFilter === 'close_date'
            ? closeDateThRef
            : dealTierThRef
    const popRef =
      openFilter === 'stage'
        ? stagePopoverRef
        : openFilter === 'record_type'
          ? recordTypePopoverRef
          : openFilter === 'close_date'
            ? closeDatePopoverRef
            : dealTierPopoverRef
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (thRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpenFilter(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openFilter])

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

  // Aggregate by close month and stage (current month onwards only)
  const chartDataByStage = useMemo(() => {
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
      const stage = pipelineChartStageKey(r.stage_name || '—')
      const arrStage = arrMap.get(month)!
      const countStage = countMap.get(month)!
      arrStage.set(stage, (arrStage.get(stage) ?? 0) + r.arr)
      countStage.set(stage, (countStage.get(stage) ?? 0) + 1)
    }
    // Merge any remaining variant keys into canonical (e.g. "Qualif" -> "Qualification")
    const canonicalList = [...PIPELINE_CHART_CANONICAL_MERGE]
    for (const month of countMap.keys()) {
      const countStage = countMap.get(month)!
      for (const key of Array.from(countStage.keys())) {
        const canonical = canonicalList.find((c) => c.toLowerCase() === key.toLowerCase() || pipelineChartStageKey(key) === c)
        if (canonical && canonical !== key) {
          countStage.set(canonical, (countStage.get(canonical) ?? 0) + (countStage.get(key) ?? 0))
          countStage.delete(key)
        }
      }
    }
    for (const month of arrMap.keys()) {
      const arrStage = arrMap.get(month)!
      for (const key of Array.from(arrStage.keys())) {
        const canonical = canonicalList.find((c) => c.toLowerCase() === key.toLowerCase() || pipelineChartStageKey(key) === c)
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

  // Fixed tier order + colours (Tier 1 = best)
  const TIER_ORDER = ['Tier 1 - Commit', 'Tier 2 - Strong Upside', 'Tier 3 - Weak Upside', 'Tier 4 - Hail Mary']
  const TIER_COLORS: Record<string, string> = {
    'Tier 1 - Commit':        '#10b981', // green
    'Tier 2 - Strong Upside': '#3b82f6', // blue
    'Tier 3 - Weak Upside':   '#f59e0b', // amber
    'Tier 4 - Hail Mary':     '#ef4444', // red
  }

  const chartDataByTier = useMemo(() => {
    const now = new Date()
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const arrMap = new Map<string, Map<string, number>>()
    const countMap = new Map<string, Map<string, number>>()
    for (const r of rows) {
      if (!r.deal_tier) continue   // only tiered deals
      const month = toMonthKey(r.close_date ?? null)
      if (!month || month < currentMonth) continue
      if (!arrMap.has(month)) { arrMap.set(month, new Map()); countMap.set(month, new Map()) }
      const tier = r.deal_tier
      const am = arrMap.get(month)!; const cm = countMap.get(month)!
      am.set(tier, (am.get(tier) ?? 0) + r.arr)
      cm.set(tier, (cm.get(tier) ?? 0) + 1)
    }
    const months = Array.from(arrMap.keys()).sort()
    // Only include tiers that have data
    const tiersSet = new Set<string>()
    arrMap.forEach((m) => m.forEach((_, t) => tiersSet.add(t)))
    countMap.forEach((m) => m.forEach((_, t) => tiersSet.add(t)))
    const tiers = TIER_ORDER.filter((t) => tiersSet.has(t))
    // Dynamic ARR max: round up total across all months
    let maxArr = 0
    arrMap.forEach((m) => { const t = Array.from(m.values()).reduce((a, b) => a + b, 0); if (t > maxArr) maxArr = t })
    const arrCeil = Math.max(500000, Math.ceil(maxArr / 500000) * 500000)
    const arrTickCount = Math.min(8, arrCeil / 500000)
    const arrTicks = Array.from({ length: arrTickCount + 1 }, (_, i) => (i / arrTickCount) * arrCeil)
    let maxCount = 0
    countMap.forEach((m) => { const t = Array.from(m.values()).reduce((a, b) => a + b, 0); if (t > maxCount) maxCount = t })
    const countCeil = Math.max(10, Math.ceil(maxCount / 10) * 10)
    const countTick = Math.ceil(countCeil / 5)
    const countTicks = Array.from({ length: 6 }, (_, i) => i * countTick)
    return { months, tiers, arrMap, countMap, arrCeil, arrTicks, countCeil, countTicks }
  }, [rows])

  const formatMonthLabel = (month: string) => {
    const [y, m] = month.split('-')
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }

  const PLOT_HEIGHT = 270
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
        key === 'account_name' || key === 'opportunity_name' || key === 'stage_name' || key === 'record_type_name' || key === 'close_date'
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

  const dealTierOptions = useMemo(() => {
    const vals = [...new Set(rows.map((r) => r.deal_tier ?? '—'))].sort()
    return vals
  }, [rows])

  const displayRows = useMemo(() => {
    let out = sortedRows
    if (filterDealTier.length > 0) {
      out = out.filter((r) => filterDealTier.includes(r.deal_tier ?? '—'))
    }
    if (filterCloseDate.length > 0) {
      out = out.filter((r) => {
        const m = toMonthKey(r.close_date ?? null)
        return m != null && filterCloseDate.includes(m)
      })
    }
    if (chartSliceFilter != null) {
      out = out.filter((r) => {
        if (mergedPipelineChartStage(r.stage_name) !== chartSliceFilter.stage) return false
        if (chartSliceFilter.month != null) {
          const m = toMonthKey(r.close_date ?? null)
          if (m !== chartSliceFilter.month) return false
        }
        return true
      })
    }
    if (tierSliceFilter != null) {
      out = out.filter((r) => {
        if ((r.deal_tier ?? '') !== tierSliceFilter.tier) return false
        if (tierSliceFilter.month != null) {
          const m = toMonthKey(r.close_date ?? null)
          if (m !== tierSliceFilter.month) return false
        }
        return true
      })
    }
    return out
  }, [sortedRows, filterDealTier, filterCloseDate, chartSliceFilter, tierSliceFilter])

  const grandTotalDisplay = useMemo(() => {
    if (chartSliceFilter == null && tierSliceFilter == null && filterCloseDate.length === 0) return grand_total
    return displayRows.reduce((s, r) => s + r.arr, 0)
  }, [chartSliceFilter, tierSliceFilter, filterCloseDate, grand_total, displayRows])

  const toggleChartSliceFilter = (month: string | null, stage: string) => {
    setTierSliceFilter(null)
    setChartSliceFilter((prev) => {
      if (prev && prev.month === month && prev.stage === stage) return null
      return { month, stage }
    })
  }

  const toggleTierSliceFilter = (month: string | null, tier: string) => {
    setChartSliceFilter(null)
    setTierSliceFilter((prev) => {
      if (prev && prev.month === month && prev.tier === tier) return null
      return { month, tier }
    })
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
    stage: 'stage_name',
    record_type: 'record_type_name',
    close_date: 'close_date',
    deal_tier: 'stage_name',
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
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Pipeline</h1>
      {/* ── Observations + Charts row ── */}
      {chartDataByStage.months.length > 0 && (
        <>
        {/* Single unified grid: observations (left, spans 2 rows) + 2×2 charts (right) */}
        <div style={{ marginBottom: '1.5rem', maxWidth: '100%', display: 'grid', gridTemplateColumns: '300px 1fr 1fr', gridTemplateRows: 'auto auto', gap: '1.5rem' }}>

          {/* Observations card — spans both chart rows */}
          <div style={{
            gridColumn: '1',
            gridRow: '1 / 3',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '1rem 1rem 0.85rem',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <p style={{ margin: '0 0 0.15rem', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#38bdf8' }}>
              Dazos Forecast Agent
            </p>
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text)', letterSpacing: '0.02em' }}>
              Observations
            </p>
            {!observations && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 'auto' }}>Loading…</p>
            )}
            {observations && observations.observations.length === 0 && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                No pipeline observations yet — run AI scoring from the Forecast view.
              </p>
            )}
            {observations && observations.observations.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                {observations.observations.map((obs, i) => (
                  <li key={i} style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.55 }}>{obs}</li>
                ))}
              </ul>
            )}
            {observations && (observations.scored_at ?? observations.last_ai_run_at) && (
              <p style={{ margin: '0.75rem 0 0', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                {observations.scored_at ? 'Updated' : 'Last scored'}{' '}
                {new Date((observations.scored_at ?? observations.last_ai_run_at)!).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
          </div>
          {/* Stage ARR chart — row 1, col 2 */}
              <div style={{ gridColumn: '2', gridRow: '1', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and stage (ARR)</div>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
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
                                    const segmentHeightPx = total > 0 && barHeight > 0 ? (arr / total) * barHeight : 0
                                    const showLabel = segmentHeightPx >= 14
                                    const sliceSelected =
                                      chartSliceFilter != null &&
                                      chartSliceFilter.month === month &&
                                      chartSliceFilter.stage === stage
                                    return (
                                      <div
                                        key={stage}
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          toggleChartSliceFilter(month, stage)
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault()
                                            toggleChartSliceFilter(month, stage)
                                          }
                                        }}
                                        style={{
                                          flex: `${stagePct} 0 0`,
                                          minHeight: 0,
                                          background: chartDataByStage.stageColors[stage],
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          color: '#fff',
                                          fontWeight: 600,
                                          fontSize: '0.7rem',
                                          textShadow: '0 0 1px rgba(0,0,0,0.5)',
                                          cursor: 'pointer',
                                          boxSizing: 'border-box',
                                          outline: sliceSelected ? '2px solid var(--accent)' : 'none',
                                          outlineOffset: -1,
                                        }}
                                        title={`${stage}: ${fmtMoney(arr)} — click to filter table`}
                                      >
                                        {showLabel ? `$${millions.toFixed(1)}M` : ''}
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
                    {chartDataByStage.stages.map((stage) => {
                      const legSel = chartSliceFilter != null && chartSliceFilter.month === null && chartSliceFilter.stage === stage
                      return (
                        <button
                          key={stage}
                          type="button"
                          onClick={() => toggleChartSliceFilter(null, stage)}
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
                          title="Filter table by this stage (all close months)"
                        >
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: chartDataByStage.stageColors[stage] }} />
                          {stage}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
          {/* Stage Count chart — row 1, col 3 */}
              <div style={{ gridColumn: '3', gridRow: '1', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and stage (# opportunities)</div>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
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
                                    const sliceSelected =
                                      chartSliceFilter != null &&
                                      chartSliceFilter.month === month &&
                                      chartSliceFilter.stage === stage
                                    return (
                                      <div
                                        key={stage}
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          toggleChartSliceFilter(month, stage)
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault()
                                            toggleChartSliceFilter(month, stage)
                                          }
                                        }}
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
                                          cursor: 'pointer',
                                          boxSizing: 'border-box',
                                          outline: sliceSelected ? '2px solid var(--accent)' : 'none',
                                          outlineOffset: -1,
                                        }}
                                        title={`${stage}: ${count} opps — click to filter table`}
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
                </div>
              </div>

          {/* Tier ARR chart — row 2, col 2 */}
            <div style={{ gridColumn: '2', gridRow: '2', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and tier (ARR)</div>
              <div style={{ flex: 1, background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
                <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem' }}>
                  <div style={{ width: 36, flexShrink: 0, height: PLOT_HEIGHT, position: 'relative', color: 'var(--text-muted)', fontSize: '0.7rem', paddingRight: 8 }}>
                    {chartDataByTier.arrTicks.slice().reverse().map((tick, i) => (
                      <span key={tick} style={{ position: 'absolute', right: 8, top: (i / (chartDataByTier.arrTicks.length - 1)) * PLOT_HEIGHT, transform: 'translateY(-50%)', lineHeight: 1, textAlign: 'right' }}>
                        {tick === 0 ? '$0' : `$${(tick / 1e6).toFixed(1)}M`}
                      </span>
                    ))}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                    <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                        {chartDataByTier.arrTicks.map((_, i) => (
                          <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: (i / (chartDataByTier.arrTicks.length - 1)) * PLOT_HEIGHT, height: 1, background: 'var(--border)', opacity: 0.7 }} />
                        ))}
                      </div>
                      <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                        {chartDataByTier.months.map((month) => {
                          const tierMap = chartDataByTier.arrMap.get(month)!
                          const total = Array.from(tierMap.values()).reduce((a, b) => a + b, 0)
                          const barHeight = total > 0 ? Math.min(PLOT_HEIGHT, (total / chartDataByTier.arrCeil) * PLOT_HEIGHT) : 0
                          return (
                            <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                              <div style={{ flex: 1, minHeight: 0 }} />
                              <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                                {total > 0 ? `$${(total / 1e6).toFixed(1)}M` : ''}
                              </div>
                              <div style={{ width: '100%', maxWidth: 36, height: barHeight, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                                {chartDataByTier.tiers.map((tier) => {
                                  const arr = tierMap.get(tier) ?? 0
                                  if (arr <= 0) return null
                                  const pct = total > 0 ? (arr / total) * 100 : 0
                                  const segH = total > 0 && barHeight > 0 ? (arr / total) * barHeight : 0
                                  const sliceSelected = tierSliceFilter != null && tierSliceFilter.month === month && tierSliceFilter.tier === tier
                                  return (
                                    <div key={tier}
                                      role="button" tabIndex={0}
                                      onClick={(e) => { e.stopPropagation(); toggleTierSliceFilter(month, tier) }}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTierSliceFilter(month, tier) } }}
                                      style={{ flex: `${pct} 0 0`, minHeight: 0, background: TIER_COLORS[tier] ?? '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: '0.7rem', textShadow: '0 0 1px rgba(0,0,0,0.5)', cursor: 'pointer', outline: sliceSelected ? '2px solid var(--accent)' : 'none', outlineOffset: -1 }}
                                      title={`${tier}: ${fmtMoney(arr)} — click to filter table`}>
                                      {segH >= 14 ? `$${(arr / 1e6).toFixed(1)}M` : ''}
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                      {chartDataByTier.months.map((month) => (
                        <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                      ))}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {chartDataByTier.tiers.map((tier) => {
                    const legSel = tierSliceFilter != null && tierSliceFilter.month === null && tierSliceFilter.tier === tier
                    return (
                      <button key={tier} type="button" onClick={() => toggleTierSliceFilter(null, tier)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '2px 6px', margin: 0, border: legSel ? '1px solid var(--accent)' : '1px solid transparent', borderRadius: 4, background: legSel ? 'var(--surface)' : 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
                        title="Filter table by this tier (all close months)">
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIER_COLORS[tier] ?? '#94a3b8', flexShrink: 0 }} />
                        {tier}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

          {/* Tier Count chart — row 2, col 3 */}
            <div style={{ gridColumn: '3', gridRow: '2', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>Open pipeline by close month and tier (# opportunities)</div>
              <div style={{ flex: 1, background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: 6 }}>
                <div style={{ display: 'flex', gap: 0, fontSize: '0.75rem' }}>
                  <div style={{ width: 36, flexShrink: 0, height: PLOT_HEIGHT, position: 'relative', color: 'var(--text-muted)', fontSize: '0.7rem', paddingRight: 8 }}>
                    {chartDataByTier.countTicks.slice().reverse().map((tick, i) => (
                      <span key={tick} style={{ position: 'absolute', right: 8, top: (i / (chartDataByTier.countTicks.length - 1)) * PLOT_HEIGHT, transform: 'translateY(-50%)', lineHeight: 1, textAlign: 'right' }}>
                        {tick}
                      </span>
                    ))}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                    <div style={{ height: PLOT_HEIGHT, position: 'relative', flexShrink: 0 }}>
                      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
                        {chartDataByTier.countTicks.map((_, i) => (
                          <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: (i / (chartDataByTier.countTicks.length - 1)) * PLOT_HEIGHT, height: 1, background: 'var(--border)', opacity: 0.7 }} />
                        ))}
                      </div>
                      <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', gap: '0.25rem', position: 'relative', zIndex: 1 }}>
                        {chartDataByTier.months.map((month) => {
                          const cMap = chartDataByTier.countMap.get(month)!
                          const total = Array.from(cMap.values()).reduce((a, b) => a + b, 0)
                          const barHeight = total > 0 ? Math.min(PLOT_HEIGHT, (total / chartDataByTier.countCeil) * PLOT_HEIGHT) : 0
                          return (
                            <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, justifyContent: 'flex-end', height: '100%' }}>
                              <div style={{ flex: 1, minHeight: 0 }} />
                              <div style={{ marginBottom: '0.2rem', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text)', minHeight: '1.1em' }}>
                                {total > 0 ? total : ''}
                              </div>
                              <div style={{ width: '100%', maxWidth: 36, height: barHeight, minHeight: 0, display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                                {chartDataByTier.tiers.map((tier) => {
                                  const count = cMap.get(tier) ?? 0
                                  if (count <= 0) return null
                                  const pct = total > 0 ? (count / total) * 100 : 0
                                  const segH = total > 0 && barHeight > 0 ? (count / total) * barHeight : 0
                                  const sliceSelected = tierSliceFilter != null && tierSliceFilter.month === month && tierSliceFilter.tier === tier
                                  return (
                                    <div key={tier}
                                      role="button" tabIndex={0}
                                      onClick={(e) => { e.stopPropagation(); toggleTierSliceFilter(month, tier) }}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTierSliceFilter(month, tier) } }}
                                      style={{ flex: `${pct} 0 0`, minHeight: 0, background: TIER_COLORS[tier] ?? '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: '0.7rem', textShadow: '0 0 1px rgba(0,0,0,0.5)', cursor: 'pointer', outline: sliceSelected ? '2px solid var(--accent)' : 'none', outlineOffset: -1 }}
                                      title={`${tier}: ${count} opps — click to filter table`}>
                                      {segH >= 14 ? count : ''}
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                      {chartDataByTier.months.map((month) => (
                        <div key={month} style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.7rem', textAlign: 'center' }}>{formatMonthLabel(month)}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </>
      )}
      {(chartSliceFilter != null ||
        tierSliceFilter != null ||
        filterStage.length > 0 ||
        filterRecordType.length > 0 ||
        filterCloseDate.length > 0 ||
        filterDealTier.length > 0) && (
        <p style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {chartSliceFilter != null && (
            <span style={{ fontSize: '0.85rem', color: 'var(--text)' }}>
              Table:{' '}
              <strong>{chartSliceFilter.month != null ? formatMonthLabel(chartSliceFilter.month) : 'All months'}</strong>
              {' · '}
              <strong>{chartSliceFilter.stage}</strong>
            </span>
          )}
          {tierSliceFilter != null && (
            <span style={{ fontSize: '0.85rem', color: 'var(--text)' }}>
              Table:{' '}
              <strong>{tierSliceFilter.month != null ? formatMonthLabel(tierSliceFilter.month) : 'All months'}</strong>
              {' · '}
              <strong>{tierSliceFilter.tier}</strong>
            </span>
          )}
          {(filterStage.length > 0 || filterRecordType.length > 0 || filterCloseDate.length > 0 || filterDealTier.length > 0 || chartSliceFilter != null || tierSliceFilter != null) && (
            <button
              type="button"
              onClick={() => {
                setFilterStage([])
                setFilterRecordType([])
                setFilterCloseDate([])
                setFilterDealTier([])
                setChartSliceFilter(null)
                setTierSliceFilter(null)
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
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 600, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {th('account_name', 'Account', 'left')}
              {th('opportunity_name', 'Opportunity', 'left')}
              {thFilter('stage', 'Stage', stageThRef, stagePopoverRef, data.stages ?? [], filterStage, setFilterStage)}
              {thFilter('deal_tier', 'Deal Tier', dealTierThRef, dealTierPopoverRef, dealTierOptions, filterDealTier, setFilterDealTier)}
              <th style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>Tier %</th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>AI %</th>
              {thFilter('record_type', 'Record type', recordTypeThRef, recordTypePopoverRef, data.record_types ?? [], filterRecordType, setFilterRecordType)}
              {thFilter('close_date', 'Close date', closeDateThRef, closeDatePopoverRef, closeDateOptions, filterCloseDate, setFilterCloseDate, formatMonthLabel)}
              {th('arr', 'ARR', 'right')}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={7} />
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
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.deal_tier ?? '—'}</td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{tierPct(row.deal_tier)}</td>
                <td
                  style={{ textAlign: 'right', padding: '0.5rem 0.75rem', whiteSpace: 'nowrap', color: '#38bdf8', fontWeight: 600, cursor: row.ai_reasoning ? 'help' : 'default' }}
                  onMouseEnter={row.ai_reasoning ? (e) => {
                    const rect = (e.target as HTMLElement).getBoundingClientRect()
                    setAiTooltip({ text: row.ai_reasoning!, x: rect.left, y: rect.bottom + 6 })
                  } : undefined}
                  onMouseLeave={() => setAiTooltip(null)}
                >
                  {row.ai_probability != null ? `${(row.ai_probability * 100).toFixed(0)}%` : '—'}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.record_type_name}</td>
                <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.close_date ?? '—'}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 500 }}>{fmtMoney(row.arr)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={7} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grandTotalDisplay)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>No open opportunities. Use Dashboard → Refresh app data to load pipeline.</p>
      )}
      {rows.length > 0 && displayRows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          No rows match the chart selection. Click the same stack again or use Clear all filters.
        </p>
      )}

      {/* AI reasoning tooltip */}
      {aiTooltip && (
        <div
          style={{
            position: 'fixed',
            top: aiTooltip.y,
            left: Math.min(aiTooltip.x, window.innerWidth - 340),
            zIndex: 9999,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0.65rem 0.9rem',
            maxWidth: 320,
            fontSize: '0.82rem',
            color: 'var(--text)',
            lineHeight: 1.55,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            pointerEvents: 'none',
          }}
        >
          <p style={{ margin: '0 0 0.3rem', fontSize: '0.72rem', fontWeight: 600, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            AI Reasoning
          </p>
          {aiTooltip.text}
        </div>
      )}
    </>
  )
}
