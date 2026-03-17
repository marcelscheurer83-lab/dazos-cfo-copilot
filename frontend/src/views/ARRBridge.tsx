import type React from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts'

const RAW_DATA = {
  arr_start: 4_200_000,
  new_business: 185_000,
  expansion: 97_000,
  contraction: 42_000,
  churn: 118_000,
} as const

const fmt = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

type BridgeDatum = {
  name: string
  offset: number
  value: number
  color: string
  kind: 'start' | 'increase' | 'decrease' | 'current'
}

const buildBridgeData = (): { data: BridgeDatum[]; arrCurrent: number } => {
  const { arr_start, new_business, expansion, contraction, churn } = RAW_DATA
  const arr_current = arr_start + new_business + expansion - contraction - churn

  const data: BridgeDatum[] = [
    { name: 'Last Month', offset: 0, value: arr_start, color: '#3a3a5c', kind: 'start' },
    {
      name: 'New Business',
      offset: arr_start,
      value: new_business,
      color: '#00d4aa',
      kind: 'increase',
    },
    {
      name: 'Expansion',
      offset: arr_start + new_business,
      value: expansion,
      color: '#7c6af7',
      kind: 'increase',
    },
    {
      name: 'Contraction',
      offset: arr_start + new_business + expansion - contraction,
      value: contraction,
      color: '#f5a623',
      kind: 'decrease',
    },
    {
      name: 'Churn',
      offset: arr_start + new_business + expansion - contraction - churn,
      value: churn,
      color: '#e8445a',
      kind: 'decrease',
    },
    {
      name: 'Current MTD',
      offset: 0,
      value: arr_current,
      color: '#5a5a8c',
      kind: 'current',
    },
  ]

  return { data, arrCurrent: arr_current }
}

const valueLabelForDatum = (d: BridgeDatum): string => {
  const base = fmt(d.value)
  if (d.kind === 'increase') return `+${base}`
  if (d.kind === 'decrease') return `-${base}`
  return base
}

const BarLabel: React.FC<any> = (props) => {
  const { x, y, width, value, index, data } = props
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number') return null
  const datum: BridgeDatum | undefined = Array.isArray(data) ? data[index] : undefined
  if (!datum || typeof value !== 'number' || value === 0) return null
  const label = valueLabelForDatum(datum)
  const cx = x + width / 2
  const cy = y - 8
  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      fill="#e8e8f0"
      fontSize={11}
      fontFamily="'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace"
    >
      {label}
    </text>
  )
}

const BridgeTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null
  const datum: BridgeDatum | undefined = payload[0]?.payload
  if (!datum) return null
  const direction =
    datum.kind === 'increase'
      ? 'Positive movement'
      : datum.kind === 'decrease'
        ? 'Negative movement'
        : 'Level'
  const formatted = valueLabelForDatum(datum)

  return (
    <div
      style={{
        background: '#0d0d1a',
        border: '1px solid #2a2a3e',
        borderRadius: 6,
        padding: '8px 10px',
        color: '#e8e8f0',
        fontSize: 12,
        fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
      }}
    >
      <div style={{ marginBottom: 2 }}>{label}</div>
      <div style={{ opacity: 0.9 }}>{formatted}</div>
      <div style={{ marginTop: 4, color: '#999' }}>{direction}</div>
    </div>
  )
}

export default function ARRBridge() {
  const { data, arrCurrent } = buildBridgeData()
  const { arr_start, new_business, expansion, contraction, churn } = RAW_DATA

  const netNew = new_business + expansion - contraction - churn
  const growthMoves = new_business + expansion
  const declineMoves = contraction + churn
  const netMovementPct = arr_start > 0 ? (netNew / arr_start) * 100 : 0

  const netNewPrefix = netNew > 0 ? '+' : netNew < 0 ? '-' : ''
  const netNewColor = netNew >= 0 ? '#00d4aa' : '#e8445a'
  const netNewLabel = `${netNewPrefix}${fmt(Math.abs(netNew))}`

  const growthLabel = fmt(growthMoves)
  const declineLabel = fmt(declineMoves)

  const netPctPrefix = netMovementPct > 0 ? '+' : netMovementPct < 0 ? '-' : ''
  const netPctColor = netMovementPct >= 0 ? '#00d4aa' : '#e8445a'
  const netPctLabel = `${netPctPrefix}${Math.abs(netMovementPct).toFixed(1)}%`

  return (
    <div
      style={{
        background: '#0a0a14',
        minHeight: '100vh',
        padding: 32,
        boxSizing: 'border-box',
        color: '#e8e8f0',
        fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
        }}
      >
        <h1
          style={{
            margin: '0 0 16px',
            fontSize: '1.5rem',
            fontWeight: 600,
            color: '#e8e8f0',
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
        >
          ARR Bridge
        </h1>
        <p
          style={{
            margin: '0 0 24px',
            fontSize: '0.9rem',
            color: '#9b9bb5',
            maxWidth: 640,
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
        >
          Waterfall from last month&apos;s ARR to current month-to-date, split into new business, expansion, contraction,
          and churn.
        </p>

        <div
          style={{
            background: '#111120',
            border: '1px solid #1e1e30',
            borderRadius: 8,
            padding: 24,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: '#555',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: 20,
              fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
            }}
          >
            ARR BRIDGE — MONTH TO DATE
          </div>

          <div style={{ height: 320, marginBottom: 24 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 24 }}>
                <CartesianGrid stroke="#1e1e30" vertical={false} />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: '#666' }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => fmt(v)}
                  tick={{ fontSize: 11, fill: '#666' }}
                />
                <Tooltip content={<BridgeTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />
                <Bar
                  dataKey="offset"
                  stackId="a"
                  fill="transparent"
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="value"
                  stackId="a"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                  label={<BarLabel data={data} />}
                >
                  {data.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: 12,
            }}
          >
            <div
              style={{
                background: '#0a0a14',
                border: '1px solid #1e1e30',
                borderRadius: 6,
                padding: '12px 16px',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: '#555',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: 4,
                  fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
                }}
              >
                Net New ARR MTD
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: netNewColor,
                  fontFamily: "'Syne', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                }}
              >
                {netNewLabel}
              </div>
            </div>

            <div
              style={{
                background: '#0a0a14',
                border: '1px solid #1e1e30',
                borderRadius: 6,
                padding: '12px 16px',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: '#555',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: 4,
                  fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
                }}
              >
                Growth Moves
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: '#00d4aa',
                  fontFamily: "'Syne', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                }}
              >
                {growthLabel}
              </div>
            </div>

            <div
              style={{
                background: '#0a0a14',
                border: '1px solid #1e1e30',
                borderRadius: 6,
                padding: '12px 16px',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: '#555',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: 4,
                  fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
                }}
              >
                Decline Moves
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: '#e8445a',
                  fontFamily: "'Syne', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                }}
              >
                {declineLabel}
              </div>
            </div>

            <div
              style={{
                background: '#0a0a14',
                border: '1px solid #1e1e30',
                borderRadius: 6,
                padding: '12px 16px',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: '#555',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: 4,
                  fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
                }}
              >
                Net Movement %
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: netPctColor,
                  fontFamily: "'Syne', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
                }}
              >
                {netPctLabel}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 16,
              fontSize: 11,
              color: '#777',
              fontFamily: "'DM Mono', 'Fira Code', SFMono-Regular, Menlo, monospace",
            }}
          >
            Current MTD ARR: {fmt(arrCurrent)} (starting from {fmt(arr_start)}).
          </div>
        </div>
      </div>
    </div>
  )
}

