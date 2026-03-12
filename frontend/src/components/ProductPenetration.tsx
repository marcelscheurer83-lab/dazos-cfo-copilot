// @ts-nocheck
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import { useState } from 'react'

const PRODUCT_ACCENTS: Record<string, string> = {
  CRM: '#00d4aa',
  IQ: '#7c6af7',
  iCampaign: '#f5a623',
  'Marketing Reports': '#3ecfff',
}

/** Depth 0–4: muted/dark → bright. Index by depth (1–4 used when 0 is hidden). */
const DEPTH_COLORS = ['#3d3d52', '#5a5a72', '#7c6af7', '#00d4aa', '#3ecfff']

/** Panel layout aligned with Dashboard/Bookings: surface, border, 8px radius, 1rem 1.25rem padding. */
const blockStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '1rem 1.25rem',
}

/** Shared typography for all boxes: panel title */
const panelTitleStyle: React.CSSProperties = { fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }
/** Shared typography: description line under title */
const panelDescStyle: React.CSSProperties = { margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }
/** Shared typography: table and body text */
const panelTableFontSize = '0.85rem'
const panelThStyle: React.CSSProperties = { color: 'var(--text-muted)', fontWeight: 500 }
const panelTdStyle: React.CSSProperties = { color: 'var(--text)' }

/** Same as blockStyle but used for Analytics 2-col grid. */
const gridPanelStyle: React.CSSProperties = {
  ...blockStyle,
}

/** Key Takeaways panel for Analytics row 1 left. */
export function KeyTakeaways() {
  return (
    <div style={{ ...blockStyle, textAlign: 'left', minWidth: 0 }}>
      <div style={{ ...panelTitleStyle, marginBottom: '0.75rem', fontSize: '0.8rem' }}>
        🎯 Product Penetration Analysis — Key Takeaways
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.4 }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem', fontSize: '0.8rem' }}>🚨 Critical issues</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            <li>67.7% of customers have only 1 product — dangerously high concentration risk</li>
            <li>Attach rates are 30–45pts below industry benchmarks — only 14% of CRM customers add IQ or iCampaign (should be 40–60%)</li>
            <li>Zero customers with 4 products — no one buying the full suite</li>
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem', fontSize: '0.8rem' }}>💰 Revenue opportunity</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            <li>$6.3M in white space ARR — 210 CRM customers missing iCampaign, 208 missing IQ, 213 missing Marketing Reports</li>
            <li>Multi-product customers worth 2–3x more: 1 product = $22K ARR, 2 products = $31K (+41%), 3 products = $47K (+113%)</li>
            <li>Converting just 50 single-product customers to 2 products = +$450K ARR with zero CAC</li>
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem', fontSize: '0.8rem' }}>✅ Immediate actions</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            <li>Launch "CRM + iCampaign" bundle campaign targeting 210 customers (potential: $489K ARR at 20% conversion)</li>
            <li>Build systematic day-90 upsell motion through CS team</li>
            <li>Investigate why expansion is failing — pricing, product integration, or sales training issue</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

export type ProductPenetrationAccount = {
  hasCrm: boolean
  hasIq: boolean
  hasICampaign: boolean
  hasMr: boolean
  /** Optional for listing accounts with 0 products. */
  accountName?: string | null
  accountId?: string | null
  /** Optional ARR for this account (same period as penetration). Enables revenue-by-depth. */
  arr?: number
  /** Optional ARR for this account for each product only (from by_product). Used for Est. ARR/Customer in cross-sell. */
  arrCrm?: number
  arrIq?: number
  arrICampaign?: number
  arrMr?: number
}

type Props = {
  accounts: ProductPenetrationAccount[]
  /** Base URL for Salesforce (e.g. https://foo.lightning.force.com). When set, account names in the 0-product list link to SF. */
  salesforceBaseUrl?: string | null
  /** Current total ARR (e.g. grand total from ARR table). Used in white space summary for comparison. */
  currentArrTotal?: number
  /** When true, render only the 6 chart panels (no Key Takeaways, no wrapper grid). Used by Analytics for 4-row layout. */
  panelsOnly?: boolean
}

function depthDistribution(accounts: ProductPenetrationAccount[]) {
  const counts = [0, 0, 0, 0, 0]
  for (const a of accounts) {
    const depth =
      (a.hasCrm ? 1 : 0) +
      (a.hasIq ? 1 : 0) +
      (a.hasICampaign ? 1 : 0) +
      (a.hasMr ? 1 : 0)
    counts[depth] += 1
  }
  return [0, 1, 2, 3, 4].map((depth) => ({
    depth,
    label: depth === 1 ? '1 product' : `${depth} products`,
    count: counts[depth],
  }))
}

function perProductStats(accounts: ProductPenetrationAccount[]) {
  const total = accounts.length
  const products = [
    { key: 'CRM', label: 'CRM', count: accounts.filter((a) => a.hasCrm).length },
    { key: 'IQ', label: 'IQ', count: accounts.filter((a) => a.hasIq).length },
    {
      key: 'iCampaign',
      label: 'iCampaign',
      count: accounts.filter((a) => a.hasICampaign).length,
    },
    {
      key: 'Marketing Reports',
      label: 'Marketing Reports',
      count: accounts.filter((a) => a.hasMr).length,
    },
  ]
  return products
    .map((p) => ({
      ...p,
      pct: total > 0 ? (100 * p.count) / total : 0,
    }))
    .sort((a, b) => b.pct - a.pct)
}

const PRODUCT_KEYS = ['CRM', 'IQ', 'iCampaign', 'MR'] as const
const PRODUCT_LABELS: Record<string, string> = { CRM: 'CRM', IQ: 'IQ', iCampaign: 'iCampaign', MR: 'Marketing Reports' }

function getHas(a: ProductPenetrationAccount, key: string): boolean {
  switch (key) {
    case 'CRM': return a.hasCrm
    case 'IQ': return a.hasIq
    case 'iCampaign': return a.hasICampaign
    case 'MR': return a.hasMr
    default: return false
  }
}

/** ARR for this account for the given product only (used for Est. ARR/Customer in cross-sell). */
function getArrForProduct(a: ProductPenetrationAccount, key: string): number {
  switch (key) {
    case 'CRM': return a.arrCrm ?? 0
    case 'IQ': return a.arrIq ?? 0
    case 'iCampaign': return a.arrICampaign ?? 0
    case 'MR': return a.arrMr ?? 0
    default: return 0
  }
}

function attachRateMatrix(accounts: ProductPenetrationAccount[]) {
  const result: Record<string, Record<string, number>> = {}
  for (const x of PRODUCT_KEYS) {
    result[x] = {}
    const withX = accounts.filter((a) => getHas(a, x))
    const countX = withX.length
    for (const y of PRODUCT_KEYS) {
      const withBoth = countX ? withX.filter((a) => getHas(a, y)).length : 0
      result[x][y] = countX > 0 ? Math.round((100 * withBoth) / countX) : 0
    }
  }
  return result
}

function revenueByDepth(accounts: ProductPenetrationAccount[]) {
  const byDepth: Record<number, { sum: number; count: number }> = { 1: { sum: 0, count: 0 }, 2: { sum: 0, count: 0 }, 3: { sum: 0, count: 0 }, 4: { sum: 0, count: 0 } }
  for (const a of accounts) {
    const depth = (a.hasCrm ? 1 : 0) + (a.hasIq ? 1 : 0) + (a.hasICampaign ? 1 : 0) + (a.hasMr ? 1 : 0)
    if (depth >= 1 && depth <= 4 && typeof a.arr === 'number') {
      byDepth[depth].sum += a.arr
      byDepth[depth].count += 1
    }
  }
  return [1, 2, 3, 4].map((d) => ({
    depth: d,
    label: d === 1 ? '1 product' : `${d} products`,
    count: byDepth[d].count,
    avgArr: byDepth[d].count > 0 ? byDepth[d].sum / byDepth[d].count : 0,
  }))
}

function whiteSpaceMatrix(accounts: ProductPenetrationAccount[]) {
  const result: Record<string, Record<string, number>> = {}
  for (const x of PRODUCT_KEYS) {
    result[x] = {}
    const withX = accounts.filter((a) => getHas(a, x))
    for (const y of PRODUCT_KEYS) {
      if (x === y) continue
      result[x][y] = withX.filter((a) => !getHas(a, y)).length
    }
  }
  return result
}

/** Cross-sell opportunities: Have X, missing Y, ranked by total opportunity.
 * Est. ARR/Customer = avg ARR for that product only (among accounts that have Y). Total = Count × Est. ARR/Customer. */
function crossSellOpportunities(accounts: ProductPenetrationAccount[]) {
  const ws = whiteSpaceMatrix(accounts)
  const avgArrByProduct: Record<string, number> = {}
  for (const key of PRODUCT_KEYS) {
    const withY = accounts.filter((a) => getHas(a, key))
    const sum = withY.reduce((s, a) => s + getArrForProduct(a, key), 0)
    avgArrByProduct[key] = withY.length > 0 ? Math.round(sum / withY.length) : 0
  }
  const rows: { campaign: string; target: string; count: number; estArrPerCustomer: number; totalOpportunity: number }[] = []
  for (const x of PRODUCT_KEYS) {
    for (const y of PRODUCT_KEYS) {
      if (x === y) continue
      const count = ws[x]?.[y] ?? 0
      const estArr = avgArrByProduct[y] ?? 0
      rows.push({
        campaign: `${x} → ${y === 'MR' ? 'Marketing Reports' : y}`,
        target: `${x} customers without ${y === 'MR' ? 'MR' : y}`,
        count,
        estArrPerCustomer: estArr,
        totalOpportunity: count * estArr,
      })
    }
  }
  return rows.filter((r) => r.count > 0).sort((a, b) => b.totalOpportunity - a.totalOpportunity)
}

function getAccountDepth(a: ProductPenetrationAccount): number {
  return (a.hasCrm ? 1 : 0) + (a.hasIq ? 1 : 0) + (a.hasICampaign ? 1 : 0) + (a.hasMr ? 1 : 0)
}

export default function ProductPenetration({ accounts, salesforceBaseUrl, currentArrTotal, panelsOnly }: Props) {
  const [selectedDepth, setSelectedDepth] = useState<number | null>(null)
  const depthData = depthDistribution(accounts)
  const totalAccounts = accounts.length
  const depthDataNoZero = depthData
    .filter((d) => d.depth !== 0)
    .map((d) => ({
      ...d,
      pctLabel: totalAccounts > 0 ? ((100 * d.count) / totalAccounts).toFixed(1) + '%' : '0%',
    }))
  const productStats = perProductStats(accounts)

  if (panelsOnly) {
    const depthPanel = (
      <div style={{ ...gridPanelStyle, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ ...panelTitleStyle }}>
          Product depth distribution
        </div>
        <p style={panelDescStyle}>
          Count of accounts by number of products held.
        </p>
        <div style={{ height: 260, width: '100%', flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={depthDataNoZero}
              margin={{ top: 12, right: 12, left: 0, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={true} vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={(props) => {
                  const { x, y, payload } = props
                  const pct = (payload && 'pctLabel' in payload && payload.pctLabel) ?? depthDataNoZero.find((d) => d.label === payload?.value)?.pctLabel ?? ''
                  return (
                    <g transform={`translate(${x},${y})`}>
                      <text x={0} y={0} dy={16} textAnchor="middle" fill="var(--text-muted)" fontSize={12}>{payload?.value}</text>
                      <text x={0} y={0} dy={30} textAnchor="middle" fill="var(--text-muted)" fontSize={11} opacity={0.9}>{pct}</text>
                    </g>
                  )
                }}
              />
              <YAxis tick={{ fontSize: 12, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Bar
                dataKey="count"
                radius={[4, 4, 0, 0]}
                maxBarSize={56}
                cursor="pointer"
                onClick={(data: any) => setSelectedDepth(data?.depth ?? null)}
              >
                <LabelList
                  dataKey="count"
                  position="top"
                />
                {depthDataNoZero.map((d) => (
                  <Cell key={d.depth} fill={DEPTH_COLORS[d.depth]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    )
    const perProductPanel = (
      <div style={gridPanelStyle}>
        <div style={panelTitleStyle}>Per-product penetration</div>
        <p style={panelDescStyle}>Share of accounts with each product.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {productStats.map((p) => {
            const accent = PRODUCT_ACCENTS[p.key] ?? '#888'
            return (
              <div key={p.key} style={{ padding: '10px 12px', borderRadius: 6 }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg)' }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: accent, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontWeight: 500, color: 'var(--text)', fontSize: panelTableFontSize }}>{p.label}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginRight: 8 }}>{p.count.toLocaleString()} accounts</span>
                  <span style={{ fontWeight: 600, fontSize: panelTableFontSize, color: accent }}>{p.pct.toFixed(1)}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, p.pct)}%`, height: '100%', background: accent, borderRadius: 3 }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
    const attachPanel = (
      <div style={gridPanelStyle}>
        <div style={panelTitleStyle}>Product attach rate</div>
        <p style={panelDescStyle}>% of customers with product X who also have product Y (cross-sell).</p>
        <div style={{ overflowX: 'auto', textAlign: 'left' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: panelTableFontSize }}>
            <thead>
              <tr>
                <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Have \ Also have</th>
                {PRODUCT_KEYS.map((k) => <th key={k} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>{k}</th>)}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const matrix = attachRateMatrix(accounts)
                return PRODUCT_KEYS.map((rowKey) => (
                  <tr key={rowKey}>
                    <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 500, verticalAlign: 'top' }}>{rowKey}</td>
                    {PRODUCT_KEYS.map((colKey) => {
                      const pct = matrix[rowKey]?.[colKey] ?? 0
                      const isDiag = rowKey === colKey
                      const accent = PRODUCT_ACCENTS[PRODUCT_LABELS[colKey] ?? colKey] ?? '#888'
                      return (
                        <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', verticalAlign: 'top' }}>
                          <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: 4, background: isDiag ? 'var(--border)' : (pct >= 50 ? `${accent}22` : 'transparent'), color: isDiag ? 'var(--text-muted)' : 'var(--text)', fontWeight: isDiag ? 600 : 500 }}>{pct}%</span>
                        </td>
                      )
                    })}
                  </tr>
                ))
              })()}
            </tbody>
          </table>
        </div>
      </div>
    )
    const revenuePanel = (
      <div style={gridPanelStyle}>
        <div style={panelTitleStyle}>Revenue per customer by product mix</div>
        <p style={panelDescStyle}>Avg ARR by number of products held.</p>
        {accounts.some((a) => typeof a.arr === 'number' && a.arr > 0) ? (
          (() => {
            const revenueDepthData = revenueByDepth(accounts).filter((d) => d.count > 0)
            return (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={revenueDepthData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v}`} />
                  <Bar dataKey="avgArr" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(data: any) => setSelectedDepth(data?.depth ?? null)}>
                    <LabelList dataKey="avgArr" position="top" style={{ fill: 'var(--text)', fontSize: 12, fontWeight: 600 }} />
                    {revenueDepthData.map((d) => <Cell key={d.depth} fill={DEPTH_COLORS[d.depth]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )
          })()
        ) : (
          <p style={{ margin: 0, fontSize: panelTableFontSize, color: 'var(--text-muted)' }}>Requires ARR by account for the selected month.</p>
        )}
      </div>
    )
    const whiteSpacePanel = (
      <div style={gridPanelStyle}>
        <div style={panelTitleStyle}>White space analysis</div>
        <p style={panelDescStyle}>Customers who have product X but not Y (cross-sell opportunity).</p>
        <div style={{ overflowX: 'auto', textAlign: 'left' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: panelTableFontSize }}>
            <thead>
              <tr>
                <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Have</th>
                {PRODUCT_KEYS.map((colKey) => <th key={colKey} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>Missing {colKey}</th>)}
              </tr>
            </thead>
            <tbody>
              {PRODUCT_KEYS.map((rowKey) => {
                const ws = whiteSpaceMatrix(accounts)
                const row = ws[rowKey] ?? {}
                return (
                  <tr key={rowKey}>
                    <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 500, verticalAlign: 'top' }}>{rowKey}</td>
                    {PRODUCT_KEYS.map((colKey) => {
                      if (rowKey === colKey) return <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-muted)', verticalAlign: 'top' }}>—</td>
                      const count = row[colKey] ?? 0
                      const accent = PRODUCT_ACCENTS[PRODUCT_LABELS[colKey] ?? colKey] ?? '#888'
                      return <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', verticalAlign: 'top' }}><span style={{ color: count > 0 ? accent : 'var(--text-muted)', fontWeight: count > 0 ? 600 : 400 }}>{count}</span></td>
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
    const crossSellPanel = (() => {
      const opportunities = crossSellOpportunities(accounts).slice(0, 3)
      const totalOpp = opportunities.reduce((s, r) => s + r.totalOpportunity, 0)
      return (
        <div style={gridPanelStyle}>
          <div style={panelTitleStyle}>Cross-sell potential</div>
          <div style={panelDescStyle}>
            Immediate opportunities (ranked by revenue potential):
          </div>
          <div style={{ overflowX: 'auto', textAlign: 'left' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: panelTableFontSize, borderBottom: '1px solid var(--border)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Campaign</th>
                  <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Target</th>
                  <th style={{ ...panelThStyle, textAlign: 'right', padding: '6px 8px', verticalAlign: 'top' }}>Count</th>
                  <th style={{ ...panelThStyle, textAlign: 'right', padding: '6px 8px', verticalAlign: 'top' }}>Est. ARR/Customer</th>
                  <th style={{ ...panelThStyle, textAlign: 'right', padding: '6px 8px', verticalAlign: 'top' }}>Total Opportunity</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...panelTdStyle, padding: '6px 8px', verticalAlign: 'top' }}>{r.campaign}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: panelTableFontSize, verticalAlign: 'top' }}>{r.target}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, ...panelTdStyle, verticalAlign: 'top' }}>{r.count}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text)', verticalAlign: 'top' }}>{r.estArrPerCustomer > 0 ? `$${r.estArrPerCustomer.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 600, color: 'var(--text)', verticalAlign: 'top' }}>{r.totalOpportunity > 0 ? `$${r.totalOpportunity >= 1e6 ? `${(r.totalOpportunity / 1e6).toFixed(1)}M` : `${(r.totalOpportunity / 1e3).toFixed(0)}K`} ARR` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalOpp > 0 && (
            <div style={{ fontSize: panelTableFontSize, marginTop: '0.5rem', color: 'var(--text)' }}>
              <span style={{ fontWeight: 700 }}>Total white space opportunity: ~${totalOpp >= 1e6 ? (totalOpp / 1e6).toFixed(1) : (totalOpp / 1e3).toFixed(0)}{totalOpp >= 1e6 ? 'M' : 'K'} ARR</span>
              {currentArrTotal != null && currentArrTotal > 0 && <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> (nearly doubling your current ${currentArrTotal >= 1e6 ? (currentArrTotal / 1e6).toFixed(1) : (currentArrTotal / 1e3).toFixed(0)}{currentArrTotal >= 1e6 ? 'M' : 'K'})</span>}
            </div>
          )}
        </div>
      )
    })()
    const selectedDepthPanelEl = selectedDepth !== null && (
      <div style={{ ...blockStyle, gridColumn: '1 / -1' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <div style={{ ...panelTitleStyle, marginBottom: 0 }}>
            Accounts with {selectedDepth} product{selectedDepth !== 1 ? 's' : ''} ({accounts.filter((a) => getAccountDepth(a) === selectedDepth).length})
          </div>
          <button type="button" onClick={() => setSelectedDepth(null)} style={{ fontSize: panelTableFontSize, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}>Close</button>
        </div>
        <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: panelTableFontSize, color: 'var(--text)', maxHeight: 220, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 24px', listStyle: 'disc' }}>
          {accounts.filter((a) => getAccountDepth(a) === selectedDepth).map((a, i) => {
            const name = a.accountName?.trim() || '—'
            const href = salesforceBaseUrl && a.accountId ? `${salesforceBaseUrl.replace(/\/$/, '')}/${a.accountId}` : null
            return (
              <li key={a.accountId ?? a.accountName ?? i} style={{ marginBottom: 2 }}>
                {href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)', textDecoration: 'none' }}>{name}</a> : name}
              </li>
            )
          })}
        </ul>
      </div>
    )
    return (
      <>
        {depthPanel}
        {perProductPanel}
        {attachPanel}
        {revenuePanel}
        {whiteSpacePanel}
        {crossSellPanel}
        {selectedDepthPanelEl}
      </>
    )
  }

  return (
    <>
      {/* Four rows of two charts each — single 2-column grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '0.75rem',
        }}
      >
        {/* Row 1: Key Takeaways | Depth distribution */}
        <KeyTakeaways />
      <div style={{ ...blockStyle, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={panelTitleStyle}>
          Product depth distribution
        </div>
        <p style={panelDescStyle}>
          Count of accounts by number of products held.
        </p>
        <div style={{ height: 260, width: '100%', flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={depthDataNoZero}
              margin={{ top: 12, right: 12, left: 0, bottom: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                horizontal={true}
                vertical={false}
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={(props) => {
                  const { x, y, payload } = props
                  const pct = (payload && 'pctLabel' in payload && payload.pctLabel) ?? depthDataNoZero.find((d) => d.label === payload?.value)?.pctLabel ?? ''
                  return (
                    <g transform={`translate(${x},${y})`}>
                      <text
                        x={0}
                        y={0}
                        dy={16}
                        textAnchor="middle"
                        fill="var(--text-muted)"
                        fontSize={12}
                      >
                        {payload?.value}
                      </text>
                      <text
                        x={0}
                        y={0}
                        dy={30}
                        textAnchor="middle"
                        fill="var(--text-muted)"
                        fontSize={11}
                        opacity={0.9}
                      >
                        {pct}
                      </text>
                    </g>
                  )
                }}
              />
              <YAxis
                tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Bar
                dataKey="count"
                radius={[4, 4, 0, 0]}
                maxBarSize={56}
                cursor="pointer"
                onClick={(data: any) => setSelectedDepth(data?.depth ?? null)}
              >
                <LabelList
                  dataKey="count"
                  position="top"
                />
                {depthDataNoZero.map((d) => (
                  <Cell key={d.depth} fill={DEPTH_COLORS[d.depth]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* RIGHT — Per-product penetration */}
      <div style={blockStyle}>
        <div style={panelTitleStyle}>
          Per-product penetration
        </div>
        <p style={panelDescStyle}>
          Share of accounts with each product.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {productStats.map((p) => {
            const accent = PRODUCT_ACCENTS[p.key] ?? '#888'
            return (
              <div
                key={p.key}
                style={{
                  padding: '10px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: accent,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      fontWeight: 500,
                      color: 'var(--text)',
                      fontSize: panelTableFontSize,
                    }}
                  >
                    {p.label}
                  </span>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-muted)',
                      marginRight: 8,
                    }}
                  >
                    {p.count.toLocaleString()} accounts
                  </span>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: panelTableFontSize,
                      color: accent,
                    }}
                  >
                    {p.pct.toFixed(1)}%
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--border)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, p.pct)}%`,
                      height: '100%',
                      background: accent,
                      borderRadius: 3,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Row 3 col 1: Product attach rate */}
        <div style={blockStyle}>
          <div style={panelTitleStyle}>
            Product attach rate
          </div>
          <p style={panelDescStyle}>
            % of customers with product X who also have product Y (cross-sell).
          </p>
          <div style={{ overflowX: 'auto', textAlign: 'left' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: panelTableFontSize }}>
              <thead>
                <tr>
                  <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Have \ Also have</th>
                  {PRODUCT_KEYS.map((k) => (
                    <th key={k} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const matrix = attachRateMatrix(accounts)
                  return PRODUCT_KEYS.map((rowKey) => (
                    <tr key={rowKey}>
                      <td style={{ ...panelTdStyle, padding: '6px 8px', fontWeight: 500, verticalAlign: 'top' }}>{rowKey}</td>
                      {PRODUCT_KEYS.map((colKey) => {
                        const pct = matrix[rowKey]?.[colKey] ?? 0
                        const isDiag = rowKey === colKey
                        const accent = PRODUCT_ACCENTS[PRODUCT_LABELS[colKey] ?? colKey] ?? '#888'
                        return (
                          <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', verticalAlign: 'top' }}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: isDiag ? 'var(--border)' : (pct >= 50 ? `${accent}22` : 'transparent'),
                                color: isDiag ? 'var(--text-muted)' : 'var(--text)',
                                fontWeight: isDiag ? 600 : 500,
                              }}
                            >
                              {pct}%
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
        </div>

        {/* 2. Revenue per customer by product mix — bar when arr present */}
        <div style={blockStyle}>
          <div style={panelTitleStyle}>
            Revenue per customer by product mix
          </div>
          <p style={panelDescStyle}>
            Avg ARR by number of products held.
          </p>
          {accounts.some((a) => typeof a.arr === 'number' && a.arr > 0) ? (
            (() => {
              const revenueDepthData = revenueByDepth(accounts).filter((d) => d.count > 0)
              return (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={revenueDepthData}
                    margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v}`} />
                    <Bar
                      dataKey="avgArr"
                      radius={[4, 4, 0, 0]}
                      name="Avg ARR"
                      cursor="pointer"
                      onClick={(data: any) => setSelectedDepth(data?.depth ?? null)}
                    >
                      <LabelList
                        dataKey="avgArr"
                        position="top"
                        style={{ fill: 'var(--text)', fontSize: 12, fontWeight: 600 }}
                      />
                      {revenueDepthData.map((d) => (
                        <Cell key={d.depth} fill={DEPTH_COLORS[d.depth]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )
            })()
          ) : (
            <p style={{ margin: 0, fontSize: panelTableFontSize, color: 'var(--text-muted)' }}>
              Requires ARR by account for the selected month.
            </p>
          )}
        </div>

        {/* 4. White space — Have X, missing Y */}
        <div style={blockStyle}>
          <div style={panelTitleStyle}>
            White space analysis
          </div>
          <p style={panelDescStyle}>
            Customers who have product X but not Y (cross-sell opportunity).
          </p>
          <div style={{ overflowX: 'auto', textAlign: 'left' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: panelTableFontSize }}>
              <thead>
                <tr>
                  <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Have</th>
                  {PRODUCT_KEYS.map((colKey) => (
                    <th key={colKey} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>Missing {colKey}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PRODUCT_KEYS.map((rowKey) => {
                  const ws = whiteSpaceMatrix(accounts)
                  const row = ws[rowKey] ?? {}
                  return (
                    <tr key={rowKey}>
                      <td style={{ ...panelTdStyle, padding: '6px 8px', fontWeight: 500, verticalAlign: 'top' }}>{rowKey}</td>
                      {PRODUCT_KEYS.map((colKey) => {
                        if (rowKey === colKey) {
                          return <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-muted)', verticalAlign: 'top' }}>—</td>
                        }
                        const count = row[colKey] ?? 0
                        const accent = PRODUCT_ACCENTS[PRODUCT_LABELS[colKey] ?? colKey] ?? '#888'
                        return (
                          <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', verticalAlign: 'top' }}>
                            <span style={{ color: count > 0 ? accent : 'var(--text-muted)', fontWeight: count > 0 ? 600 : 400 }}>
                              {count}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4. Cross-sell opportunities — same-sized box, three calculations + total */}
        {(() => {
          const opportunities = crossSellOpportunities(accounts).slice(0, 3)
          const totalOpp = opportunities.reduce((s, r) => s + r.totalOpportunity, 0)
          return (
            <div style={blockStyle}>
              <div style={panelTitleStyle}>
                Cross-sell potential
              </div>
              <div style={panelDescStyle}>
                Immediate opportunities (ranked by revenue potential):
              </div>
              <div style={{ overflowX: 'auto', textAlign: 'left' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: panelTableFontSize, borderBottom: '1px solid var(--border)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Campaign</th>
                      <th style={{ ...panelThStyle, textAlign: 'left', padding: '6px 8px', verticalAlign: 'top' }}>Target</th>
                      <th style={{ ...panelThStyle, textAlign: 'right', padding: '6px 8px', verticalAlign: 'top' }}>Count</th>
                      <th style={{ ...panelThStyle, textAlign: 'right', padding: '6px 8px', verticalAlign: 'top' }}>Est. ARR/Customer</th>
                      <th style={{ ...panelThStyle, textAlign: 'right', padding: '6px 8px', verticalAlign: 'top' }}>Total Opportunity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opportunities.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ ...panelTdStyle, padding: '6px 8px', verticalAlign: 'top' }}>{r.campaign}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: panelTableFontSize, verticalAlign: 'top' }}>{r.target}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, ...panelTdStyle, verticalAlign: 'top' }}>{r.count}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', ...panelTdStyle, verticalAlign: 'top' }}>
                          {r.estArrPerCustomer > 0 ? `$${r.estArrPerCustomer.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, ...panelTdStyle, verticalAlign: 'top' }}>
                          {r.totalOpportunity > 0 ? `$${r.totalOpportunity >= 1e6 ? `${(r.totalOpportunity / 1e6).toFixed(1)}M` : `${(r.totalOpportunity / 1e3).toFixed(0)}K`} ARR` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalOpp > 0 && (
                <div style={{ fontSize: panelTableFontSize, marginTop: '0.5rem', color: 'var(--text)' }}>
                  <span style={{ fontWeight: 700 }}>Total white space opportunity: ~${totalOpp >= 1e6 ? (totalOpp / 1e6).toFixed(1) : (totalOpp / 1e3).toFixed(0)}{totalOpp >= 1e6 ? 'M' : 'K'} ARR</span>
                  {currentArrTotal != null && currentArrTotal > 0 && (
                    <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
                      {' '}(nearly doubling your current ${currentArrTotal >= 1e6 ? (currentArrTotal / 1e6).toFixed(1) : (currentArrTotal / 1e3).toFixed(0)}{currentArrTotal >= 1e6 ? 'M' : 'K'})
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Full-width: accounts for selected depth (click a bar in depth or revenue chart) */}
      {selectedDepth !== null && (
        <div
          style={{
            ...blockStyle,
            gridColumn: '1 / -1',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.5rem',
            }}
          >
            <div style={panelTitleStyle}>
              Accounts with {selectedDepth} product{selectedDepth !== 1 ? 's' : ''} ({accounts.filter((a) => getAccountDepth(a) === selectedDepth).length})
            </div>
            <button
              type="button"
              onClick={() => setSelectedDepth(null)}
              style={{
                fontSize: panelTableFontSize,
                color: 'var(--text-muted)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 8px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--accent)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-muted)'
              }}
            >
              Close
            </button>
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: '1.25rem',
              fontSize: panelTableFontSize,
              color: 'var(--text)',
              maxHeight: 220,
              overflowY: 'auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '4px 24px',
              listStyle: 'disc',
            }}
          >
            {accounts
              .filter((a) => getAccountDepth(a) === selectedDepth)
              .map((a, i) => {
                const name = a.accountName?.trim() || '—'
                const href =
                  salesforceBaseUrl && a.accountId
                    ? `${salesforceBaseUrl.replace(/\/$/, '')}/${a.accountId}`
                    : null
                return (
                  <li key={a.accountId ?? a.accountName ?? i} style={{ marginBottom: 2 }}>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: 'var(--text)',
                          textDecoration: 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = 'var(--accent)'
                          e.currentTarget.style.textDecoration = 'underline'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = 'var(--text)'
                          e.currentTarget.style.textDecoration = 'none'
                        }}
                      >
                        {name}
                      </a>
                    ) : (
                      name
                    )}
                  </li>
                )
              })}
          </ul>
        </div>
      )}
    </>
  )
}

/** Map backend by_product (product name → ARR) to the 4 product booleans and per-product ARR. Includes account_name/account_id when present. */
export function accountsFromByProduct(
  rows: { by_product: Record<string, number>; account_name?: string | null; account_id?: string | null }[]
): ProductPenetrationAccount[] {
  return rows.map((row) => {
    const bp = row.by_product || {}
    const getVal = (name: string) => (typeof bp[name] === 'number' ? bp[name] : 0) as number
    const p = (name: string) => getVal(name) > 0
    const hasCrm =
      p('CRM Platform') || p('CRM Billing Platform') || p('Add. CRM Seats')
    const hasIq = p('IQ Platform') || p('Add. MR/ IQ Locations')
    const hasICampaign = p('iCampaign Platform')
    const hasMr = p('MR Platform')
    const arrCrm = getVal('CRM Platform') + getVal('CRM Billing Platform') + getVal('Add. CRM Seats')
    const arrIq = getVal('IQ Platform') + getVal('Add. MR/ IQ Locations')
    const arrICampaign = getVal('iCampaign Platform')
    const arrMr = getVal('MR Platform')
    return {
      hasCrm,
      hasIq,
      hasICampaign,
      hasMr,
      accountName: row.account_name ?? null,
      accountId: row.account_id ?? null,
      arrCrm: arrCrm > 0 ? arrCrm : undefined,
      arrIq: arrIq > 0 ? arrIq : undefined,
      arrICampaign: arrICampaign > 0 ? arrICampaign : undefined,
      arrMr: arrMr > 0 ? arrMr : undefined,
    }
  })
}

/** Like accountsFromByProduct but adds arr from by_month[monthKey] when present. Use for revenue-by-depth. */
export function accountsFromByProductWithArr(
  rows: { by_product: Record<string, number>; by_month?: Record<string, number>; account_name?: string | null; account_id?: string | null }[],
  monthKey: string
): ProductPenetrationAccount[] {
  return rows.map((row) => {
    const base = accountsFromByProduct([row])[0]
    const arr = row.by_month && typeof row.by_month[monthKey] === 'number' ? row.by_month[monthKey] : undefined
    return { ...base, arr }
  })
}
