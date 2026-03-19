import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { getARRScheduleActiveARRByMonth, type ActiveARRByMonthRow } from '../api'

function fmtMoney(n: number) {
  const v = Math.round(n || 0)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v)
}

function fmtNumber(n: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

function productKeyMatchesCrm(k: string) {
  const s = (k || '').toLowerCase()
  return s.includes('crm')
}

function productKeyMatchesSeats(k: string) {
  const s = (k || '').toLowerCase()
  return s.includes('seat')
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = p * (sorted.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo] ?? 0
  return (sorted[lo] ?? 0) * (1 - (i - lo)) + (sorted[hi] ?? 0) * (i - lo)
}

function linearRegression(points: { x: number; y: number }[]) {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: 0, r2: 0, residualSE: 0, n: 0 }
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0
  for (const p of points) {
    sumX += p.x
    sumY += p.y
    sumXX += p.x * p.x
    sumXY += p.x * p.y
  }
  const meanX = sumX / n
  const meanY = sumY / n
  const denom = n * sumXX - sumX * sumX
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0
  const intercept = meanY - slope * meanX
  let ssRes = 0
  let ssTot = 0
  for (const p of points) {
    const fit = slope * p.x + intercept
    ssRes += (p.y - fit) ** 2
    ssTot += (p.y - meanY) ** 2
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0
  const residualSE = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0
  return { slope, intercept, r2, residualSE, n }
}

type Row = {
  account_name: string
  account_id: string | null
  crm_arr: number
  crm_seats: number | null
  arr_per_seat: number | null
  type: string | null
  owner_name: string | null
}

type SortKey = 'account_name' | 'crm_arr' | 'crm_seats' | 'arr_per_seat'
type SortDir = 'asc' | 'desc'

export default function AnalyticsCRMSeats() {
  const [scheduleRows, setScheduleRows] = useState<ActiveARRByMonthRow[]>([])
  const [salesforceBaseUrl, setSalesforceBaseUrl] = useState<string | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('crm_arr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filterType, setFilterType] = useState<string[]>([])
  const [filterOwner, setFilterOwner] = useState<string[]>([])
  const [openFilter, setOpenFilter] = useState<'type' | 'owner' | null>(null)
  const typeThRef = useRef<HTMLTableHeaderCellElement>(null)
  const typePopoverRef = useRef<HTMLDivElement>(null)
  const ownerThRef = useRef<HTMLTableHeaderCellElement>(null)
  const ownerPopoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setErr(null)
    getARRScheduleActiveARRByMonth()
      .then((res) => {
        setScheduleRows(res.rows ?? [])
        setSalesforceBaseUrl(
          res.salesforce_base_url &&
          (res.salesforce_base_url.includes('salesforce.com') || res.salesforce_base_url.includes('lightning.force.com'))
            ? res.salesforce_base_url
            : undefined
        )
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  const rows: Row[] = useMemo(() => {
    return (scheduleRows ?? [])
      .filter((r) => (r.active_arr ?? 0) > 0)
      .map((r) => {
        const byProduct = r.by_product ?? {}
        // Prefer backend-provided CRM metrics when present; fall back to heuristic from by_product.
        const backendCrmArr = (r as any).crm_arr as number | null | undefined
        const backendCrmSeats = (r as any).crm_seats as number | null | undefined
        const inferredCrmArr =
          backendCrmArr ??
          Object.entries(byProduct).reduce((sum, [k, v]) => (productKeyMatchesCrm(k) ? sum + (v ?? 0) : sum), 0)
        const seatArr = Object.entries(byProduct).reduce(
          (sum, [k, v]) => (productKeyMatchesSeats(k) ? sum + (v ?? 0) : sum),
          0,
        )
        const inferredSeats =
          backendCrmSeats != null
            ? backendCrmSeats
            : seatArr > 0
              ? Math.round(seatArr / 1200)
              : null
        const arrPerSeat =
          inferredCrmArr != null && inferredSeats && inferredSeats > 0 ? inferredCrmArr / inferredSeats : null
        return {
          account_name: r.account_name,
          account_id: r.account_id ?? null,
          crm_arr: inferredCrmArr ?? 0,
          crm_seats: inferredSeats,
          arr_per_seat: arrPerSeat,
          type: (r as any).type ?? null,
          owner_name: (r as any).owner_name ?? null,
        }
      })
      .filter((r) => r.crm_arr > 0)
  }, [scheduleRows])

  const sortedRows: Row[] = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      let av: string | number = 0
      let bv: string | number = 0
      switch (sortKey) {
        case 'account_name':
          av = a.account_name || ''
          bv = b.account_name || ''
          break
        case 'crm_arr':
          av = a.crm_arr
          bv = b.crm_arr
          break
        case 'crm_seats':
          av = a.crm_seats ?? 0
          bv = b.crm_seats ?? 0
          break
        case 'arr_per_seat':
          av = a.arr_per_seat ?? 0
          bv = b.arr_per_seat ?? 0
          break
      }
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
      const as = String(av).toLowerCase()
      const bs = String(bv).toLowerCase()
      return dir * (as < bs ? -1 : as > bs ? 1 : 0)
    })
  }, [rows, sortKey, sortDir])

  const filteredRows = useMemo(() => {
    let out = sortedRows
    if (filterType.length > 0) {
      out = out.filter((r) => {
        const t = (r.type ?? '').trim() || '—'
        return filterType.includes(t)
      })
    }
    if (filterOwner.length > 0) {
      out = out.filter((r) => {
        const o = (r.owner_name ?? '').trim() || '—'
        return filterOwner.includes(o)
      })
    }
    return out
  }, [sortedRows, filterType, filterOwner])

  const totals = useMemo(() => {
    const crmArr = filteredRows.reduce((s, r) => s + (r.crm_arr ?? 0), 0)
    const seats = filteredRows.reduce((s, r) => s + (r.crm_seats ?? 0), 0)
    return { crmArr, seats }
  }, [filteredRows])

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'))
        return prevKey
      }
      setSortDir(key === 'account_name' ? 'asc' : 'desc')
      return key
    })
  }, [])

  const scatterState = useMemo(() => {
    const pts = filteredRows
      .filter((r) => (r.crm_seats ?? 0) > 0 && (r.arr_per_seat ?? 0) > 0)
      .map((r) => ({
        name: r.account_name,
        x: r.crm_seats ?? 0,
        y: r.arr_per_seat ?? 0,
        z: r.crm_arr ?? 0,
      }))
    if (pts.length < 2) {
      const avgArrPerSeat = pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : 0
      return {
        points: pts,
        regression: null as ReturnType<typeof linearRegression> | null,
        segment: null as [ { x: number; y: number }, { x: number; y: number } ] | null,
        band: null as { xMin: number; xMax: number; y1: number; y2: number } | null,
        medianArrPerSeat: pts.length ? pts[0].y : 0,
        avgArrPerSeat,
        correlation: 0,
        maxZ: pts.length ? Math.max(...pts.map((p) => p.z)) : 0,
      }
    }
    const arrPerSeats = pts.map((p) => p.y).sort((a, b) => a - b)
    const avgArrPerSeat = arrPerSeats.length ? arrPerSeats.reduce((s, v) => s + v, 0) / arrPerSeats.length : 0
    const p1 = percentile(arrPerSeats, 0.01)
    const p99 = percentile(arrPerSeats, 0.99)
    const filtered = pts.filter((p) => p.y >= p1 && p.y <= p99)
    const regPts = filtered.map((p) => ({ x: p.x, y: p.y }))
    const reg = linearRegression(regPts)
    const xs = regPts.map((p) => p.x)
    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)
    const segment: [ { x: number; y: number }, { x: number; y: number } ] = [
      { x: xMin, y: reg.slope * xMin + reg.intercept },
      { x: xMax, y: reg.slope * xMax + reg.intercept },
    ]
    let band: { xMin: number; xMax: number; y1: number; y2: number } | null = null
    if (reg.residualSE > 0 && reg.n > 2) {
      const midX = (xMin + xMax) / 2
      const midY = reg.slope * midX + reg.intercept
      const t95 = 1.96
      band = {
        xMin,
        xMax,
        y1: midY - t95 * reg.residualSE,
        y2: midY + t95 * reg.residualSE,
      }
    }
    const meanX = regPts.reduce((s, p) => s + p.x, 0) / regPts.length
    const meanY = regPts.reduce((s, p) => s + p.y, 0) / regPts.length
    let ssX = 0
    let ssY = 0
    let ssXY = 0
    for (const p of regPts) {
      const dx = p.x - meanX
      const dy = p.y - meanY
      ssX += dx * dx
      ssY += dy * dy
      ssXY += dx * dy
    }
    const correlation = ssX > 0 && ssY > 0 ? ssXY / Math.sqrt(ssX * ssY) : 0
    const medianArrPerSeat = arrPerSeats.length ? arrPerSeats[Math.floor(arrPerSeats.length / 2)] : 0
    const maxZ = pts.length ? Math.max(...pts.map((p) => p.z)) : 0
    return {
      points: filtered,
      regression: reg.n >= 2 ? reg : null,
      segment,
      band,
      medianArrPerSeat,
      avgArrPerSeat,
      correlation,
      maxZ,
    }
  }, [filteredRows])

  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const t = (r.type ?? '').trim() || '—'
      set.add(t)
    }
    return Array.from(set).sort()
  }, [rows])

  const ownerOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const o = (r.owner_name ?? '').trim() || '—'
      set.add(o)
    }
    return Array.from(set).sort()
  }, [rows])

  useEffect(() => {
    if (openFilter === null) return
    const thRef = openFilter === 'type' ? typeThRef : ownerThRef
    const popRef = openFilter === 'type' ? typePopoverRef : ownerPopoverRef
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (thRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpenFilter(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [openFilter])

  const renderTh = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => {
    const active = sortKey === key
    return (
      <th
        key={key}
        style={{
          textAlign: align,
          padding: '0.6rem 0.75rem',
          color: 'var(--text-muted)',
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
        onClick={() => handleSort(key)}
      >
        {label}
        {active && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </th>
    )
  }

  return (
    <div style={{ color: 'var(--text)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: '0.25rem' }}>CRM Seat Pricing Analysis</h2>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Accounts with active ARR today that have CRM-related ARR.</div>
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Total CRM ARR: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtMoney(totals.crmArr)}</span>
          {'  '}·{'  '}
          Inferred seats: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtNumber(totals.seats)}</span>
        </div>
      </div>

      {err && <p style={{ color: 'var(--negative)' }}>{err}</p>}
      {!err && loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

      {!err && !loading && (
        <>
          {scatterState.points.length > 0 && (
            <div
              style={{
                marginTop: '1rem',
                marginBottom: '1.25rem',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '1rem 1.25rem',
                background: 'var(--surface)',
              }}
            >
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>
                ARR per Seat vs. Number of Seats — Pricing Analysis
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                Point size ∝ total CRM ARR. Trend line and 95% confidence band computed from accounts between the 1st and 99th ARR/seat percentiles.
              </div>
              <div style={{ width: '100%', height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 32, right: 30, bottom: 40, left: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      type="number"
                      dataKey="x"
                      name="Seats"
                      domain={[0, 220]}
                      stroke="var(--text-muted)"
                      tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      tickFormatter={(v) => fmtNumber(v)}
                      label={{ value: 'CRM seats', position: 'insideBottom', offset: -10, fill: 'var(--text-muted)', fontSize: 12 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="y"
                      name="ARR / seat"
                      domain={[0, 6000]}
                      ticks={[0, 1000, 2000, 3000, 4000, 5000, 6000]}
                      stroke="var(--text-muted)"
                      tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      tickFormatter={(v) => fmtMoney(v)}
                      label={{
                        value: 'ARR per seat',
                        angle: -90,
                        position: 'insideLeft',
                        offset: 0,
                        dx: -10,
                        dy: 30,
                        fill: 'var(--text-muted)',
                        fontSize: 12,
                      }}
                    />
                    <ZAxis dataKey="z" range={[80, 260]} />
                    <RechartsTooltip
                      cursor={{ stroke: 'var(--border)' }}
                      contentStyle={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        color: 'var(--text-muted)',
                        fontSize: '0.8rem',
                      }}
                      labelStyle={{ color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}
                      content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null
                        const p = payload[0].payload as { name: string; x: number; y: number; z: number }
                        return (
                          <div>
                            <div style={{ color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>
                              {p.name}
                            </div>
                            <div>Seats: {fmtNumber(p.x)}</div>
                            <div>ARR per seat: {fmtMoney(p.y)}</div>
                            <div>CRM ARR: {fmtMoney(p.z)}</div>
                          </div>
                        )
                      }}
                    />
                    {scatterState.band && (
                      <ReferenceArea
                        x1={scatterState.band.xMin}
                        x2={scatterState.band.xMax}
                        y1={scatterState.band.y1}
                        y2={scatterState.band.y2}
                        fill="var(--accent)"
                        fillOpacity={0.08}
                        strokeOpacity={0}
                      />
                    )}
                    {scatterState.segment && scatterState.regression && (
                      <ReferenceLine
                        segment={scatterState.segment}
                        stroke="var(--accent)"
                        strokeWidth={2}
                      />
                    )}
                    <Scatter
                      data={scatterState.points}
                      fill="var(--accent)"
                      shape={(props: any) => {
                        const { cx, cy, payload } = props
                        const maxZ = scatterState.maxZ || 1
                        const z = payload.z || 0
                        const r = 4 + (z / maxZ) * 10
                        return (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={r}
                            fill="var(--accent)"
                            fillOpacity={0.8}
                            stroke="var(--border)"
                            strokeWidth={1}
                          />
                        )
                      }}
                    />
                    {scatterState.regression && (
                      <text
                        x="50%"
                        y={22}
                        textAnchor="middle"
                        style={{ pointerEvents: 'none', fontSize: 12, fill: 'var(--text-muted)' }}
                      >
                        {`y = ${scatterState.regression.slope.toFixed(0)}/seat·x + ${fmtMoney(
                          scatterState.regression.intercept,
                        )}   |   R² = ${scatterState.regression.r2.toFixed(3)}`}
                      </text>
                    )}
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              {scatterState.regression && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                  Median ARR/seat: {fmtMoney(scatterState.medianArrPerSeat)} &nbsp;|&nbsp; Average ARR/seat:{' '}
                  {fmtMoney(scatterState.avgArrPerSeat)} &nbsp;|&nbsp; Correlation:{' '}
                  {scatterState.correlation.toFixed(3)} &nbsp;|&nbsp; n = {scatterState.regression!.n}
                </p>
              )}
            </div>
          )}

          <div style={{ marginTop: '0.5rem', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                  {renderTh('account_name', 'Account', 'left')}
                  <th
                    ref={ownerThRef}
                    style={{
                      textAlign: 'left',
                      padding: '0.6rem 0.75rem',
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      position: 'relative',
                      verticalAlign: 'bottom',
                      background: 'var(--surface)',
                    }}
                  >
                    <span style={{ userSelect: 'none' }}>Account Owner</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenFilter((f) => (f === 'owner' ? null : 'owner'))
                      }}
                      title="Filter by Account Owner"
                      style={{
                        marginLeft: 6,
                        padding: 2,
                        background: filterOwner.length ? 'var(--accent)' : 'transparent',
                        color: filterOwner.length ? '#fff' : 'var(--text-muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        cursor: 'pointer',
                        lineHeight: 1,
                      }}
                    >
                      ⋮
                    </button>
                    {openFilter === 'owner' && (
                      <div
                        ref={ownerPopoverRef}
                        style={{
                          position: 'absolute',
                          zIndex: 10,
                          top: 'calc(100% + 4px)',
                          left: 0,
                          width: 220,
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: 10,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <select
                          multiple
                          size={Math.min(6, Math.max(2, ownerOptions.length))}
                          value={filterOwner}
                          onChange={(e) => setFilterOwner(Array.from(e.target.selectedOptions, (o) => o.value))}
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
                          {ownerOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>
                          Ctrl+click to select multiple
                        </p>
                        {filterOwner.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setFilterOwner([])}
                            style={{
                              marginTop: 8,
                              padding: '0.25rem 0.5rem',
                              fontSize: '0.8rem',
                              cursor: 'pointer',
                              background: 'var(--bg)',
                              color: 'var(--text-muted)',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              width: '100%',
                            }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                  </th>
                  <th
                    ref={typeThRef}
                    style={{
                      textAlign: 'left',
                      padding: '0.6rem 0.75rem',
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      position: 'relative',
                      verticalAlign: 'bottom',
                      background: 'var(--surface)',
                    }}
                  >
                    <span style={{ userSelect: 'none' }}>Type</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenFilter((f) => (f === 'type' ? null : 'type'))
                      }}
                      title="Filter by Type"
                      style={{
                        marginLeft: 6,
                        padding: 2,
                        background: filterType.length ? 'var(--accent)' : 'transparent',
                        color: filterType.length ? '#fff' : 'var(--text-muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        cursor: 'pointer',
                        lineHeight: 1,
                      }}
                    >
                      ⋮
                    </button>
                    {openFilter === 'type' && (
                      <div
                        ref={typePopoverRef}
                        style={{
                          position: 'absolute',
                          zIndex: 10,
                          top: 'calc(100% + 4px)',
                          left: 0,
                          width: 220,
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: 10,
                        }}
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
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0 0' }}>
                          Ctrl+click to select multiple
                        </p>
                        {filterType.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setFilterType([])}
                            style={{
                              marginTop: 8,
                              padding: '0.25rem 0.5rem',
                              fontSize: '0.8rem',
                              cursor: 'pointer',
                              background: 'var(--bg)',
                              color: 'var(--text-muted)',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              width: '100%',
                            }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                  </th>
                  <th style={{ textAlign: 'left', padding: '0.6rem 0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    18 Digit SFDC Acct ID
                  </th>
                  {renderTh('crm_arr', 'CRM ARR', 'right')}
                  {renderTh('crm_seats', 'CRM seats', 'right')}
                  {renderTh('arr_per_seat', 'ARR / seat', 'right')}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, idx) => (
                  <tr key={r.account_id || r.account_name || `crm-seat-${idx}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                      {r.account_id && salesforceBaseUrl ? (
                        <a
                          href={
                            salesforceBaseUrl.includes('lightning.force.com')
                              ? `${salesforceBaseUrl}/lightning/r/Account/${r.account_id}/view`
                              : `${salesforceBaseUrl}/${r.account_id}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--accent)', textDecoration: 'none' }}
                          title="Open in Salesforce"
                        >
                          {r.account_name}
                        </a>
                      ) : (
                        r.account_name
                      )}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>{r.owner_name ?? '—'}</td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>{r.type ?? '—'}</td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{r.account_id ?? '—'}</td>
                    <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(r.crm_arr)}</td>
                    <td style={{ textAlign: 'right', padding: '0.5rem 0.5rem', color: 'var(--text)' }}>
                      {r.crm_seats != null ? fmtNumber(r.crm_seats) : '—'}
                    </td>
                    <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                      {r.arr_per_seat != null ? fmtMoney(r.arr_per_seat) : '—'}
                    </td>
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: '0.9rem 0.75rem', color: 'var(--text-muted)' }}>
                      No CRM seat rows found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
