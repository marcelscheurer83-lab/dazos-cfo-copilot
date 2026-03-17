import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { getActiveARRAnalytics, getARRScheduleActiveARRByMonth, type ActiveARRByMonthRow } from '../api'

/** From as_of date "YYYY-MM-DD" return month key "YYYY-MM" for by_month lookups. */
function monthKeyFromAsOf(asOf: string): string {
  if (!asOf || asOf.length < 7) return ''
  return asOf.slice(0, 7)
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

/** Format integer with thousands separator (e.g. 2885 → "2,885"). */
function fmtNumber(n: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

/** Linear regression: slope, intercept, R², residual SE. Exclude NaN. */
function linearRegression(points: { x: number; y: number }[]): {
  slope: number
  intercept: number
  r2: number
  residualSE: number
  n: number
} {
  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  const n = valid.length
  if (n < 2) return { slope: 0, intercept: 0, r2: 0, residualSE: 0, n }
  const sumX = valid.reduce((s, p) => s + p.x, 0)
  const sumY = valid.reduce((s, p) => s + p.y, 0)
  const sumXX = valid.reduce((s, p) => s + p.x * p.x, 0)
  const sumXY = valid.reduce((s, p) => s + p.x * p.y, 0)
  const meanX = sumX / n
  const meanY = sumY / n
  const denom = n * sumXX - sumX * sumX
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0
  const intercept = meanY - slope * meanX
  const ssRes = valid.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0)
  const ssTot = valid.reduce((s, p) => s + (p.y - meanY) ** 2, 0)
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0
  const residualSE = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0
  return { slope, intercept, r2, residualSE, n }
}

/** Percentile of sorted array (0..1). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = p * (sorted.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo] ?? 0
  return (sorted[lo] ?? 0) * (1 - (i - lo)) + (sorted[hi] ?? 0) * (i - lo)
}

type SortKey = 'account_name' | 'crm_arr' | 'crm_seats' | 'arr_per_seat'
type SortDir = 'asc' | 'desc'

export default function AnalyticsCRMSeats() {
  const [asOf, setAsOf] = useState<string | null>(null)
  const [scheduleRows, setScheduleRows] = useState<ActiveARRByMonthRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('crm_arr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    setLoading(true)
    setErr(null)
    Promise.all([getActiveARRAnalytics(), getARRScheduleActiveARRByMonth()])
      .then(([arrRes, byMonthRes]) => {
        setAsOf(arrRes.as_of ?? null)
        setScheduleRows(byMonthRes.rows ?? [])
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoading(false))
  }, [])

  const monthKey = monthKeyFromAsOf(asOf ?? '')
  const withActiveARR =
    monthKey === ''
      ? scheduleRows
      : scheduleRows.filter((row) => (row.by_month?.[monthKey] ?? 0) > 0)

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'account_name' ? 'asc' : 'desc')
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...withActiveARR].sort((a, b) => {
      const aSeats = a.crm_seats ?? 0
      const bSeats = b.crm_seats ?? 0
      const aArr = a.crm_arr ?? 0
      const bArr = b.crm_arr ?? 0
      const aArrPerSeat = aSeats > 0 ? aArr / aSeats : 0
      const bArrPerSeat = bSeats > 0 ? bArr / bSeats : 0
      let aVal: string | number
      let bVal: string | number
      switch (sortKey) {
        case 'account_name':
          aVal = a.account_name ?? ''
          bVal = b.account_name ?? ''
          break
        case 'crm_arr':
          aVal = aArr
          bVal = bArr
          break
        case 'crm_seats':
          aVal = aSeats
          bVal = bSeats
          break
        case 'arr_per_seat':
          aVal = aArrPerSeat
          bVal = bArrPerSeat
          break
        default:
          aVal = 0
          bVal = 0
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') return dir * (aVal - bVal)
      const sa = String(aVal).toLowerCase()
      const sb = String(bVal).toLowerCase()
      return dir * (sa < sb ? -1 : sa > sb ? 1 : 0)
    })
  }, [withActiveARR, sortKey, sortDir])

  const totalSeats = sortedRows.reduce((s, r) => s + (r.crm_seats ?? 0), 0)
  const totalCrmArr = sortedRows.reduce((s, r) => s + (r.crm_arr ?? 0), 0)
  const arrPerSeatTotal = totalSeats > 0 ? totalCrmArr / totalSeats : 0

  // Scatter plot: exclude 0 ARR or 0 seats; optional outlier removal (1st/99th percentile of ARR/seat)
  const scatterState = useMemo(() => {
    const withValid = withActiveARR.filter((r) => (r.crm_arr ?? 0) > 0 && (r.crm_seats ?? 0) > 0)
    const points = withValid.map((r) => ({
      name: r.account_name ?? '—',
      x: r.crm_seats ?? 0,
      y: (r.crm_arr ?? 0) / (r.crm_seats ?? 1),
      z: r.crm_arr ?? 0,
    }))
    if (points.length < 2) {
      return {
        scatterData: points,
        regression: null as ReturnType<typeof linearRegression> | null,
        regressionSegment: null as [ { x: number; y: number }, { x: number; y: number } ] | null,
        confidenceBand: null as { xMin: number; xMax: number; y1: number; y2: number } | null,
        medianArrPerSeat: points.length ? points.map((p) => p.y).sort((a, b) => a - b)[Math.floor(points.length / 2)] ?? 0 : 0,
        correlation: 0,
      }
    }
    const arrPerSeats = points.map((p) => p.y).sort((a, b) => a - b)
    const p1 = percentile(arrPerSeats, 0.01)
    const p99 = percentile(arrPerSeats, 0.99)
    const filtered = points.filter((p) => p.y >= p1 && p.y <= p99)
    const regPoints = filtered.map((p) => ({ x: p.x, y: p.y }))
    const regression = linearRegression(regPoints)
    const xMin = Math.min(...regPoints.map((p) => p.x))
    const xMax = Math.max(...regPoints.map((p) => p.x))
    const regressionSegment: [ { x: number; y: number }, { x: number; y: number } ] = [
      { x: xMin, y: regression.slope * xMin + regression.intercept },
      { x: xMax, y: regression.slope * xMax + regression.intercept },
    ]
    const t95 = 1.96
    const midX = (xMin + xMax) / 2
    const fittedMidY = regression.slope * midX + regression.intercept
    const confidenceBand =
      regression.residualSE > 0 && regression.n > 2
        ? {
            xMin,
            xMax,
            y1: fittedMidY - t95 * regression.residualSE,
            y2: fittedMidY + t95 * regression.residualSE,
          }
        : null
    const meanX = regPoints.reduce((a, q) => a + q.x, 0) / regPoints.length
    const meanY = regPoints.reduce((a, q) => a + q.y, 0) / regPoints.length
    const ssX = regPoints.reduce((s, p) => s + (p.x - meanX) ** 2, 0)
    const ssY = regPoints.reduce((s, p) => s + (p.y - meanY) ** 2, 0)
    const ssXY = regPoints.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0)
    const correlation = ssX > 0 && ssY > 0 ? ssXY / Math.sqrt(ssX * ssY) : 0
    const medianArrPerSeat = arrPerSeats.length ? (arrPerSeats[Math.floor(arrPerSeats.length / 2)] ?? 0) : 0
    return {
      scatterData: filtered,
      regression: regression.n >= 2 ? regression : null,
      regressionSegment,
      confidenceBand,
      medianArrPerSeat,
      correlation,
    }
  }, [withActiveARR])

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

  return (
    <div
      style={{
        background: 'var(--bg)',
        minHeight: '100%',
        margin: '0 -2rem',
        padding: '2rem',
      }}
    >
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>
        CRM seats
      </h1>

      {loading && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading…</p>}
      {err && !loading && <p style={{ color: 'var(--negative)', fontSize: '0.9rem' }}>{err}</p>}

      {!loading && !err && (
        <>
          {/* Scatter: ARR per seat vs. number of seats (no points with 0 ARR or 0 seats) */}
          {scatterState.scatterData.length > 0 && (
            <div
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '1rem 1.25rem',
                maxWidth: '96%',
                marginBottom: '1rem',
              }}
            >
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.5rem' }}>
                ARR per Seat vs. Number of Seats — Pricing Analysis
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>
                Point size ∝ total ARR. Trend line: linear regression (excluding 1st/99th %ile ARR/seat). No points with 0 ARR or 0 seats.
              </p>
              <div style={{ width: '100%', height: 380 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 44, right: 20, bottom: 36, left: 52 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      type="number"
                      dataKey="x"
                      name="Seats"
                      unit=" seats"
                      stroke="var(--text-muted)"
                      tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      tickFormatter={(v) => (Number.isFinite(v) ? fmtNumber(v) : '')}
                      label={{ value: 'Number of seats', position: 'insideBottom', offset: 0, fill: 'var(--text-muted)', fontSize: 12 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="y"
                      name="ARR/seat"
                      stroke="var(--text-muted)"
                      tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      tickFormatter={(v) => (Number.isFinite(v) ? fmtMoney(v) : '')}
                      label={{ value: 'ARR per seat', angle: -90, position: 'insideLeft', offset: -24, fill: 'var(--text-muted)', fontSize: 12 }}
                    />
                    <ZAxis type="number" dataKey="z" range={[120, 800]} name="ARR" />
                    <Tooltip
                      cursor={{ stroke: 'var(--border)' }}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }}
                      labelStyle={{ color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const p = payload[0].payload as { name: string; x: number; y: number; z: number }
                        return (
                          <div style={{ padding: '4px 0' }}>
                            <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 6 }}>{p.name}</div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                              Seats: {fmtNumber(p.x)}
                            </div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                              ARR/seat: {fmtMoney(p.y)}
                            </div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                              ARR: {fmtMoney(p.z)}
                            </div>
                          </div>
                        )
                      }}
                    />
                    {scatterState.confidenceBand && (
                      <ReferenceArea
                        x1={scatterState.confidenceBand.xMin}
                        x2={scatterState.confidenceBand.xMax}
                        y1={scatterState.confidenceBand.y1}
                        y2={scatterState.confidenceBand.y2}
                        strokeOpacity={0}
                        fill="var(--accent)"
                        fillOpacity={0.08}
                      />
                    )}
                    {scatterState.regressionSegment && scatterState.regression && (
                      <ReferenceLine
                        segment={scatterState.regressionSegment}
                        stroke="var(--accent)"
                        strokeWidth={2}
                        strokeDasharray="none"
                      />
                    )}
                    <Scatter
                      name="Accounts"
                      data={scatterState.scatterData}
                      fill="var(--accent)"
                      fillOpacity={0.7}
                      shape={(props: any) => {
                        const { cx, cy, payload } = props
                        const maxZ = Math.max(...scatterState.scatterData.map((d) => d.z), 1)
                        const r = 4 + (payload.z / maxZ) * 10
                        return <circle cx={cx} cy={cy} r={r} fill="var(--accent)" fillOpacity={0.7} stroke="var(--border)" strokeWidth={1} />
                      }}
                    />
                    <Legend
                      verticalAlign="top"
                      wrapperStyle={{ fontSize: '0.8rem', paddingBottom: 4 }}
                      formatter={() => (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {scatterState.regression
                            ? `y = ${scatterState.regression.slope.toFixed(0)}/seat·x + ${fmtMoney(scatterState.regression.intercept)}  |  R² = ${scatterState.regression.r2.toFixed(3)}`
                            : 'Accounts'}
                        </span>
                      )}
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              {scatterState.regression && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                  Median ARR/seat: {fmtMoney(scatterState.medianArrPerSeat)}  |  Correlation: {scatterState.correlation.toFixed(3)}  |  n = {scatterState.regression.n}
                </p>
              )}
            </div>
          )}

          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '1rem 1.25rem',
              maxWidth: '96%',
            }}
          >
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>
              ARR and seats from three CRM SKUs: Additional CRM Seats, Dazos CRM Platform (Includes 5 Seats), Dazos CRM Platform (Legacy). Same logic as active ARR. Click column headers to sort.
            </p>
            {sortedRows.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No accounts with active ARR in this period.</p>
          ) : (
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.85rem',
                color: 'var(--text)',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {th('account_name', 'Account', 'left')}
                  {th('crm_arr', 'ARR', 'right')}
                  {th('crm_seats', 'Seats', 'right')}
                  {th('arr_per_seat', 'ARR/seat', 'right')}
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
                  <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
                  <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(totalCrmArr)}</td>
                  <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtNumber(totalSeats)}</td>
                  <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {totalSeats > 0 ? fmtMoney(arrPerSeatTotal) : '—'}
                  </td>
                </tr>
                {sortedRows.map((row, idx) => {
                  const seats = row.crm_seats ?? 0
                  const arr = row.crm_arr ?? 0
                  const arrPerSeat = seats > 0 ? arr / seats : null
                  return (
                    <tr key={row.account_id || row.account_name || `crm-seats-${idx}`} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{row.account_name ?? '—'}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>{fmtMoney(arr)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>{fmtNumber(seats)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: 'var(--text)' }}>
                        {arrPerSeat !== null ? fmtMoney(arrPerSeat) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        </>
      )}
    </div>
  )
}
