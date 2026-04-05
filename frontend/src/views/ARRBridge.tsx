import { useEffect, useState } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, LineChart, ReferenceLine,
} from 'recharts'
import { getArrBridge, getBridgeAccounts, ArrBridgeResponse, ArrBridgeMonth, ArrRetentionMonth, ArrYoyMonth, BridgeAccountRow } from '../api'

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(m) - 1]} '${y.slice(2)}`
}

function fmtK(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n)}`
}

function fmtFull(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

// ── colours ───────────────────────────────────────────────────────────────────
const C_NEW_BIZ    = '#3b82f6'   // blue
const C_EXPANSION  = '#22c55e'   // green
const C_CONTRACTION = '#f97316'  // orange
const C_CHURN      = '#ef4444'   // red
const C_ENDING_ARR = '#a78bfa'   // purple (line)
const C_NRR        = '#22c55e'
const C_GRR        = '#f59e0b'

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '1rem 1.25rem',
      flex: '1 1 0',
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '0.2rem',
    }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', textAlign: 'center' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color: color ?? 'var(--text)', textAlign: 'center', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>{sub}</div>}
    </div>
  )
}

// ── custom tooltip ────────────────────────────────────────────────────────────

function BridgeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const labels: Record<string, string> = {
    new_business: 'New Business',
    expansion: 'Expansion',
    contraction_neg: 'Contraction',
    churn_neg: 'Churn',
    ending_arr: 'Ending ARR',
  }
  return (
    <div style={{ background: '#1e1e2e', border: '1px solid var(--border)', borderRadius: 6, padding: '0.6rem 0.8rem', fontSize: '0.78rem' }}>
      <div style={{ fontWeight: 700, marginBottom: '0.4rem', color: 'var(--text)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {labels[p.dataKey] ?? p.dataKey}: {fmtFull(Math.abs(p.value))}
        </div>
      ))}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

type DrillSelection = { month: string; component: string; label: string; color: string }

export default function ARRBridge() {
  const [data, setData] = useState<ArrBridgeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Drill-down state
  const [drill, setDrill] = useState<DrillSelection | null>(null)
  const [drillAccounts, setDrillAccounts] = useState<BridgeAccountRow[]>([])
  const [drillSfBase, setDrillSfBase] = useState<string | null>(null)
  const [drillLoading, setDrillLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    getArrBridge()
      .then((res) => { setData(res); setLoading(false) })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false) })
  }, [])

  function handleBarClick(barData: any, component: string, label: string, color: string) {
    // barData is the full row object from recharts; month is the display label
    // We need the raw YYYY-MM key — find it from bridge by matching display label
    if (!data) return
    const entry = data.bridge.find((b) => fmtMonth(b.month) === barData.month)
    if (!entry) return
    const sel: DrillSelection = { month: entry.month, component, label, color }
    setDrill(sel)
    setDrillLoading(true)
    getBridgeAccounts(entry.month, component)
      .then((res) => { setDrillAccounts(res.accounts); setDrillSfBase(res.salesforce_base_url); setDrillLoading(false) })
      .catch(() => setDrillLoading(false))
  }

  function sfHref(base: string | null, id: string | null): string | null {
    if (!base || !id) return null
    return base.includes('lightning.force.com')
      ? `${base}/lightning/r/Account/${id}/view`
      : `${base}/${id}`
  }

  if (loading) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading bridge data…</div>
  if (error)   return <div style={{ padding: '2rem', color: 'var(--negative)' }}>Error: {error}</div>
  if (!data || data.bridge.length === 0) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>
        {data?.message ?? 'No data. Run Refresh app data to populate the monthly ARR snapshot.'}
      </div>
    )
  }

  const bridge: ArrBridgeMonth[] = data.bridge
  const retention: ArrRetentionMonth[] = data.retention
  const yoy: ArrYoyMonth[] = data.yoy ?? []
  const latest = bridge[bridge.length - 1]
  const latestRet = retention[retention.length - 1]
  const latestYoy = yoy.find((y) => y.month === latest.month)

  // Chart data — contraction & churn as negative values for the bar chart
  const chartData = bridge.map((b) => ({
    month: fmtMonth(b.month),
    new_business: b.new_business,
    expansion: b.expansion,
    contraction_neg: -b.contraction,
    churn_neg: -b.churn,
    ending_arr: b.ending_arr,
  }))

  const retChartData = retention.map((r) => ({
    month: fmtMonth(r.month),
    nrr: r.nrr_trailing_12m,
    grr: r.grr_trailing_12m,
  }))

  const displaySet = new Set(data.display_months)
  const yoyChartData = yoy
    .filter((y) => displaySet.has(y.month))
    .map((y) => ({
      month: fmtMonth(y.month),
      yoy_pct: y.yoy_pct,
      net_new_arr: y.net_new_arr,
    }))

  // Compute arr domain: round out to nearest 100K with a bit of padding
  const arrDomain: [number, number] = (() => {
    const vals = yoyChartData.map((d) => d.net_new_arr).filter((v) => v != null) as number[]
    if (!vals.length) return [-100_000, 500_000]
    const step = 100_000
    const lo = Math.floor(Math.min(0, ...vals) / step) * step
    const hi = Math.ceil(Math.max(0, ...vals) / step) * step
    return [lo, hi || step]
  })()

  // Map month_key → yoy_pct for the table row
  const yoyByMonth = Object.fromEntries(yoy.map((y) => [y.month, y.yoy_pct]))

  return (
    <div style={{ padding: '1.5rem 2rem' }}>

      {/* ── header ── */}
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)' }}>
        ARR Bridge
      </h1>
      {data.message && (
        <p style={{ color: 'var(--warning, #d4a010)', fontSize: '0.85rem', marginBottom: '1rem' }}>{data.message}</p>
      )}

      {/* ── KPI cards ── */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <KpiCard label="Ending ARR" value={fmtFull(latest.ending_arr)} sub={fmtMonth(latest.month)} />
        <KpiCard
          label="ARR Growth YoY"
          value={latestYoy?.yoy_pct != null ? `${latestYoy.yoy_pct}%` : '—'}
          sub={fmtMonth(latest.month)}
          color={
            latestYoy?.yoy_pct == null ? undefined
            : latestYoy.yoy_pct >= 20 ? C_NRR
            : latestYoy.yoy_pct >= 0  ? C_GRR
            : C_CHURN
          }
        />
        <KpiCard
          label="Net New ARR"
          value={`${latest.net_change >= 0 ? '+' : ''}${fmtFull(latest.net_change)}`}
          sub={fmtMonth(latest.month)}
          color={latest.net_change >= 0 ? C_EXPANSION : C_CHURN}
        />
        <KpiCard
          label="Gross Revenue Retention"
          value={latestRet?.grr_trailing_12m != null ? `${latestRet.grr_trailing_12m}%` : '—'}
          sub="Trailing 12M"
          color={
            latestRet?.grr_trailing_12m == null ? undefined
            : latestRet.grr_trailing_12m >= 90 ? C_NRR
            : latestRet.grr_trailing_12m >= 75 ? C_GRR
            : C_CHURN
          }
        />
        <KpiCard
          label="Net Revenue Retention"
          value={latestRet?.nrr_trailing_12m != null ? `${latestRet.nrr_trailing_12m}%` : '—'}
          sub="Trailing 12M"
          color={
            latestRet?.nrr_trailing_12m == null ? undefined
            : latestRet.nrr_trailing_12m >= 100 ? C_NRR
            : latestRet.nrr_trailing_12m >= 85 ? C_GRR
            : C_CHURN
          }
        />
      </div>

      {/* ── bridge chart ── */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
          Monthly ARR Movement
        </h2>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis
              yAxisId="bar"
              tickFormatter={fmtK}
              tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              width={64}
            />
            <YAxis
              yAxisId="line"
              orientation="right"
              tickFormatter={fmtK}
              tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              width={64}
            />
            <Tooltip content={<BridgeTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine yAxisId="bar" y={0} stroke="var(--border)" />
            <Bar yAxisId="bar" dataKey="new_business"    name="New Business" stackId="pos" fill={C_NEW_BIZ}     cursor="pointer" onClick={(d) => handleBarClick(d, 'new_business',  'New Business', C_NEW_BIZ)} />
            <Bar yAxisId="bar" dataKey="expansion"       name="Expansion"    stackId="pos" fill={C_EXPANSION}   cursor="pointer" onClick={(d) => handleBarClick(d, 'expansion',     'Expansion',    C_EXPANSION)} />
            <Bar yAxisId="bar" dataKey="contraction_neg" name="Contraction"  stackId="neg" fill={C_CONTRACTION} cursor="pointer" onClick={(d) => handleBarClick(d, 'contraction',   'Contraction',  C_CONTRACTION)} />
            <Bar yAxisId="bar" dataKey="churn_neg"       name="Churn"        stackId="neg" fill={C_CHURN}       cursor="pointer" onClick={(d) => handleBarClick(d, 'churn',         'Churn',        C_CHURN)} />
            <Line
              yAxisId="line"
              type="monotone"
              dataKey="ending_arr"
              name="Ending ARR"
              stroke={C_ENDING_ARR}
              strokeWidth={2}
              dot={{ r: 3, fill: C_ENDING_ARR }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── drill-down panel ── */}
      {drill && (
        <div style={{ marginBottom: '2rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem 1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: drill.color }}>
              {drill.label} · {fmtMonth(drill.month)}
            </h3>
            <button
              onClick={() => setDrill(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
            >✕</button>
          </div>
          {drillLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading…</div>
          ) : drillAccounts.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No accounts found.</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)' }}>
                  <th style={{ ...TH, textAlign: 'left' }}>Account</th>
                  <th style={{ ...TH, textAlign: 'right' }}>ARR</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Change</th>
                </tr>
              </thead>
              <tbody>
                {drillAccounts.map((a) => {
                  const href = sfHref(drillSfBase, a.sf_account_id)
                  return (
                    <tr key={a.account_name} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={TD}>
                        {href
                          ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent, #60a5fa)', textDecoration: 'none' }}>{a.account_name}</a>
                          : a.account_name}
                      </td>
                      <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtFull(a.arr)}</td>
                      <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: a.arr_change >= 0 ? C_EXPANSION : C_CHURN }}>
                        {a.arr_change >= 0 ? '+' : ''}{fmtFull(a.arr_change)}
                      </td>
                    </tr>
                  )
                })}
                <tr>
                  <td style={{ ...TD, fontWeight: 700 }}>Total</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtFull(drillAccounts.reduce((s, a) => s + a.arr, 0))}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: drill.component === 'churn' || drill.component === 'contraction' ? C_CHURN : C_EXPANSION }}>
                    {drillAccounts.reduce((s, a) => s + a.arr_change, 0) >= 0 ? '+' : ''}
                    {fmtFull(drillAccounts.reduce((s, a) => s + a.arr_change, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── NRR / GRR chart ── */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
          Trailing 12-Month NRR &amp; GRR
        </h2>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={retChartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              width={64}
            />
            <YAxis yAxisId="right" orientation="right" width={64} tick={false} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ background: '#1e1e2e', border: '1px solid var(--border)', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={100} stroke="#555" strokeDasharray="4 4" label={{ value: '100%', fill: '#888', fontSize: 10 }} />
            <Line type="monotone" dataKey="nrr" name="NRR" stroke={C_NRR} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            <Line type="monotone" dataKey="grr" name="GRR" stroke={C_GRR} strokeWidth={2} dot={{ r: 3 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── YoY ARR growth chart ── */}
      {yoyChartData.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
            Year-over-Year ARR Growth
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={yoyChartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis
                yAxisId="arr"
                domain={arrDomain}
                tickFormatter={fmtK}
                tickCount={6}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                width={64}
              />
              <YAxis
                yAxisId="pct"
                orientation="right"
                domain={[0, 120]}
                tickFormatter={(v) => `${v}%`}
                tickCount={7}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                width={64}
              />
              <Tooltip
                contentStyle={{ background: '#1e1e2e', border: '1px solid var(--border)', fontSize: 12 }}
                formatter={(v: any, name: string) =>
                  name === 'YoY Growth (%, right)' ? `${(+v).toFixed(1)}%` : fmtFull(v)
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine yAxisId="arr" y={0} stroke="#555" strokeWidth={1.5} />
              <Bar
                yAxisId="arr"
                dataKey="net_new_arr"
                name="Net New ARR ($, left)"
                fill={C_NEW_BIZ}
                opacity={0.8}
                radius={[2, 2, 0, 0]}
              />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="yoy_pct"
                name="YoY Growth (%, right)"
                stroke={C_ENDING_ARR}
                strokeWidth={2}
                dot={{ r: 3, fill: C_ENDING_ARR }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── bridge table ── */}
      <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
        Bridge Detail
      </h2>
      <div style={{ overflowX: 'auto', paddingLeft: 64, paddingRight: 64 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)', background: 'var(--surface)' }}>
              <th style={TH}>Component</th>
              {bridge.map((b) => <th key={b.month} style={{ ...TH, textAlign: 'right' }}>{fmtMonth(b.month)}</th>)}
            </tr>
          </thead>
          <tbody>
            {[
              { key: 'beginning_arr', label: 'Beginning ARR', color: 'var(--text-muted)', bold: false },
              { key: 'new_business',   label: '+ New Business', color: C_NEW_BIZ,     bold: false },
              { key: 'expansion',      label: '+ Expansion',    color: C_EXPANSION,   bold: false },
              { key: 'contraction',    label: '− Contraction',  color: C_CONTRACTION, bold: false },
              { key: 'churn',          label: '− Churn',        color: C_CHURN,       bold: false },
              { key: 'ending_arr',     label: 'Ending ARR',     color: 'var(--text)', bold: true  },
            ].map(({ key, label, color, bold }) => (
              <tr key={key} style={{ borderBottom: key === 'ending_arr' ? '2px solid var(--border)' : '1px solid var(--border)' }}>
                <td style={{ ...TD, color, fontWeight: bold ? 700 : 400 }}>{label}</td>
                {bridge.map((b) => {
                  const raw = (b as any)[key] as number
                  return (
                    <td key={b.month} style={{ ...TD, textAlign: 'right', color, fontWeight: bold ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>
                      {raw === 0 ? '—' : fmtFull(raw)}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ ...TD, color: 'var(--text-muted)' }}>YoY Growth</td>
              {bridge.map((b) => {
                const pct = yoyByMonth[b.month]
                return (
                  <td key={b.month} style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    color: pct == null ? 'var(--text-muted)' : pct >= 20 ? C_NRR : pct >= 0 ? C_GRR : C_CHURN }}>
                    {pct != null ? `${pct.toFixed(1)}%` : '—'}
                  </td>
                )
              })}
            </tr>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ ...TD, color: 'var(--text-muted)' }}>NRR (T12M)</td>
              {retention.map((r) => (
                <td key={r.month} style={{ ...TD, textAlign: 'right', color: r.nrr_trailing_12m == null ? 'var(--text-muted)' : r.nrr_trailing_12m >= 100 ? C_NRR : r.nrr_trailing_12m >= 85 ? C_GRR : C_CHURN, fontVariantNumeric: 'tabular-nums' }}>
                  {r.nrr_trailing_12m != null ? `${r.nrr_trailing_12m.toFixed(1)}%` : '—'}
                </td>
              ))}
            </tr>
            <tr>
              <td style={{ ...TD, color: 'var(--text-muted)' }}>GRR (T12M)</td>
              {retention.map((r) => (
                <td key={r.month} style={{ ...TD, textAlign: 'right', color: r.grr_trailing_12m == null ? 'var(--text-muted)' : r.grr_trailing_12m >= 90 ? C_NRR : r.grr_trailing_12m >= 75 ? C_GRR : C_CHURN, fontVariantNumeric: 'tabular-nums' }}>
                  {r.grr_trailing_12m != null ? `${r.grr_trailing_12m.toFixed(1)}%` : '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

const TH: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  fontWeight: 600,
  fontSize: '0.75rem',
  color: 'var(--text-muted)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
}

const TD: React.CSSProperties = {
  padding: '0.35rem 0.6rem',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
}
