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
  iCampaign: '#f5a623',
  IQMR: '#7c6af7',
  RVK: '#3ecfff',
}

/** Depth 0–MAX: muted/dark → bright. Index by depth (1–MAX used when 0 is hidden). */
const DEPTH_COLORS = ['#3d3d52', '#5a5a72', '#7c6af7', '#00d4aa', '#3ecfff', '#f5a623']

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


export type ProductPenetrationAccount = {
  hasCrm: boolean
  hasICampaign: boolean
  hasIqMr: boolean
  hasRvk: boolean
  /** Optional for listing accounts with 0 products. */
  accountName?: string | null
  accountId?: string | null
  /** Optional ARR for this account (same period as penetration). Enables revenue-by-depth. */
  arr?: number
  /** Optional ARR for this account for each product family only. Used for Est. ARR/Customer in cross-sell. */
  arrCrm?: number
  arrICampaign?: number
  arrIqMr?: number
  arrRvk?: number
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

const PRODUCT_KEYS = ['CRM', 'iCampaign', 'IQMR', 'RVK'] as const
const PRODUCT_LABELS: Record<string, string> = {
  CRM: 'CRM',
  iCampaign: 'iCampaign',
  IQMR: 'IQ & Marketing Reports',
  RVK: 'RVK Agents',
}
const MAX_PRODUCT_DEPTH = PRODUCT_KEYS.length

function fmtMoneyShort(n: number) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n).toLocaleString()}`
}

/** Y-axis ceiling with headroom so bar-top labels (e.g. $80K) aren't clipped. */
function revenueChartYMax(data: { avgArr: number }[]): number {
  const max = Math.max(0, ...data.map((d) => d.avgArr || 0))
  if (max <= 0) return 20000
  const padded = max * 1.2
  const step = padded <= 30000 ? 10000 : 20000
  return Math.ceil(padded / step) * step
}

function formatAvgArrLabel(value: number) {
  if (typeof value !== 'number') return ''
  return value >= 1000 ? `$${Math.round(value / 1000)}K` : `$${value}`
}

function getHas(a: ProductPenetrationAccount, key: string): boolean {
  switch (key) {
    case 'CRM': return a.hasCrm
    case 'iCampaign': return a.hasICampaign
    case 'IQMR': return a.hasIqMr
    case 'RVK': return a.hasRvk
    default: return false
  }
}

/** ARR for this account for the given product family only (used for Est. ARR/Customer in cross-sell). */
function getArrForProduct(a: ProductPenetrationAccount, key: string): number {
  switch (key) {
    case 'CRM': return a.arrCrm ?? 0
    case 'iCampaign': return a.arrICampaign ?? 0
    case 'IQMR': return a.arrIqMr ?? 0
    case 'RVK': return a.arrRvk ?? 0
    default: return 0
  }
}

function getAccountDepth(a: ProductPenetrationAccount): number {
  return PRODUCT_KEYS.reduce((n, k) => n + (getHas(a, k) ? 1 : 0), 0)
}

function depthDistribution(accounts: ProductPenetrationAccount[]) {
  const counts = Array.from({ length: MAX_PRODUCT_DEPTH + 1 }, () => 0)
  for (const a of accounts) {
    counts[getAccountDepth(a)] += 1
  }
  return Array.from({ length: MAX_PRODUCT_DEPTH }, (_, i) => i + 1).map((depth) => ({
    depth,
    label: depth === 1 ? '1 product' : `${depth} products`,
    count: counts[depth],
  }))
}

function perProductStats(accounts: ProductPenetrationAccount[]) {
  const total = accounts.length
  return PRODUCT_KEYS.map((key) => ({
    key,
    label: PRODUCT_LABELS[key],
    count: accounts.filter((a) => getHas(a, key)).length,
  }))
    .map((p) => ({
      ...p,
      pct: total > 0 ? (100 * p.count) / total : 0,
    }))
    .sort((a, b) => b.pct - a.pct)
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
  const byDepth: Record<number, { sum: number; count: number }> = Object.fromEntries(
    Array.from({ length: MAX_PRODUCT_DEPTH }, (_, i) => [i + 1, { sum: 0, count: 0 }])
  )
  for (const a of accounts) {
    const depth = getAccountDepth(a)
    if (depth >= 1 && depth <= MAX_PRODUCT_DEPTH && typeof a.arr === 'number') {
      byDepth[depth].sum += a.arr
      byDepth[depth].count += 1
    }
  }
  return Array.from({ length: MAX_PRODUCT_DEPTH }, (_, i) => i + 1).map((d) => ({
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
        campaign: `${PRODUCT_LABELS[x] ?? x} → ${PRODUCT_LABELS[y] ?? y}`,
        target: `${PRODUCT_LABELS[x] ?? x} customers without ${PRODUCT_LABELS[y] ?? y}`,
        count,
        estArrPerCustomer: estArr,
        totalOpportunity: count * estArr,
      })
    }
  }
  return rows.filter((r) => r.count > 0).sort((a, b) => b.totalOpportunity - a.totalOpportunity)
}

/** Key Takeaways panel — computed live from the same account set as the charts below. */
export function KeyTakeaways({
  accounts,
  currentArrTotal,
  asOfLabel,
}: {
  accounts: ProductPenetrationAccount[]
  currentArrTotal?: number
  asOfLabel?: string | null
}) {
  const total = accounts.length
  const depthData = depthDistribution(accounts)
  const single = depthData.find((d) => d.depth === 1)?.count ?? 0
  const singlePct = total > 0 ? ((100 * single) / total).toFixed(1) : '0'
  const fullSuite = depthData.find((d) => d.depth === MAX_PRODUCT_DEPTH)?.count ?? 0

  const attach = attachRateMatrix(accounts)
  const crmToIcampaign = attach.CRM?.iCampaign ?? 0
  const crmToIqMr = attach.CRM?.IQMR ?? 0
  const crmToRvk = attach.CRM?.RVK ?? 0

  const ws = whiteSpaceMatrix(accounts)
  const crmMissingIcampaign = ws.CRM?.iCampaign ?? 0
  const crmMissingIqMr = ws.CRM?.IQMR ?? 0
  const crmMissingRvk = ws.CRM?.RVK ?? 0
  const rvkAccounts = accounts.filter((a) => a.hasRvk).length

  const revByDepth = revenueByDepth(accounts).filter((d) => d.count > 0)
  const avg1 = revByDepth.find((d) => d.depth === 1)?.avgArr ?? 0
  const avg2 = revByDepth.find((d) => d.depth === 2)?.avgArr ?? 0
  const avg3 = revByDepth.find((d) => d.depth === 3)?.avgArr ?? 0
  const uplift2 = avg1 > 0 ? Math.round(((avg2 - avg1) / avg1) * 100) : 0
  const uplift3 = avg1 > 0 ? Math.round(((avg3 - avg1) / avg1) * 100) : 0

  const topOpps = crossSellOpportunities(accounts).slice(0, 3)
  const topOppTotal = topOpps.reduce((s, r) => s + r.totalOpportunity, 0)
  const topCampaign = topOpps[0]

  if (total === 0) {
    return (
      <div style={{ ...blockStyle, textAlign: 'left', minWidth: 0 }}>
        <div style={{ ...panelTitleStyle, marginBottom: '0.75rem', fontSize: '0.8rem' }}>
          Product Penetration Analysis — Key Takeaways
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading account data…</p>
      </div>
    )
  }

  return (
    <div style={{ ...blockStyle, textAlign: 'left', minWidth: 0 }}>
      <div style={{ ...panelTitleStyle, marginBottom: '0.75rem', fontSize: '0.8rem' }}>
        Product Penetration Analysis — Key Takeaways
        {asOfLabel ? ` (${asOfLabel})` : ''}
      </div>
      <p style={{ ...panelDescStyle, marginTop: 0 }}>
        CRM, iCampaign, IQ &amp; Marketing Reports, and RVK Agents — reconciled to the ARR bridge.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.4 }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem', fontSize: '0.8rem' }}>Critical issues</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            <li>{singlePct}% of customers ({single.toLocaleString()} accounts) hold only 1 product family</li>
            <li>CRM attach: {crmToIcampaign}% iCampaign, {crmToIqMr}% IQ &amp; MR, {crmToRvk}% RVK Agents</li>
            <li>{fullSuite === 0 ? 'No' : fullSuite} customer{fullSuite === 1 ? '' : 's'} with all {MAX_PRODUCT_DEPTH} product families</li>
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem', fontSize: '0.8rem' }}>Revenue opportunity</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            <li>
              CRM white space: {crmMissingIcampaign} missing iCampaign, {crmMissingIqMr} missing IQ &amp; MR, {crmMissingRvk} missing RVK Agents
            </li>
            {avg1 > 0 && avg2 > 0 && (
              <li>
                Multi-product lift: 1 product = {fmtMoneyShort(avg1)} avg ARR
                {avg2 > 0 ? `, 2 products = ${fmtMoneyShort(avg2)} (+${uplift2}%)` : ''}
                {avg3 > 0 ? `, 3 products = ${fmtMoneyShort(avg3)} (+${uplift3}%)` : ''}
              </li>
            )}
            {topOppTotal > 0 && (
              <li>Top-3 cross-sell paths: {fmtMoneyShort(topOppTotal)} ARR opportunity</li>
            )}
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem', fontSize: '0.8rem' }}>Immediate actions</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {topCampaign && (
              <li>
                Prioritize {topCampaign.campaign}: {topCampaign.count} accounts, {fmtMoneyShort(topCampaign.totalOpportunity)} ARR potential
              </li>
            )}
            {crmMissingRvk > 0 && (
              <li>RVK Agents attach is early — {crmMissingRvk} CRM accounts have no RVK ({rvkAccounts} accounts live today)</li>
            )}
            <li>Run bundle campaigns against CRM-only accounts with highest ARR first</li>
          </ul>
        </div>
        {currentArrTotal != null && currentArrTotal > 0 && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            {total.toLocaleString()} accounts · {fmtMoneyShort(currentArrTotal)} total ARR
          </div>
        )}
      </div>
    </div>
  )
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
          Count of accounts by number of product families held (CRM, iCampaign, IQ &amp; MR, RVK Agents).
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
        <p style={panelDescStyle}>Share of accounts with each product family.</p>
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
                {PRODUCT_KEYS.map((k) => <th key={k} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>{PRODUCT_LABELS[k]}</th>)}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const matrix = attachRateMatrix(accounts)
                return PRODUCT_KEYS.map((rowKey) => (
                  <tr key={rowKey}>
                    <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 500, verticalAlign: 'top' }}>{PRODUCT_LABELS[rowKey]}</td>
                    {PRODUCT_KEYS.map((colKey) => {
                      const pct = matrix[rowKey]?.[colKey] ?? 0
                      const isDiag = rowKey === colKey
                      const accent = PRODUCT_ACCENTS[colKey] ?? '#888'
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
            const yMax = revenueChartYMax(revenueDepthData)
            return (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={revenueDepthData} margin={{ top: 28, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} />
                  <YAxis domain={[0, yMax]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v}`} />
                  <Bar dataKey="avgArr" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(data: any) => setSelectedDepth(data?.depth ?? null)}>
                    <LabelList
                      dataKey="avgArr"
                      position="top"
                      formatter={formatAvgArrLabel}
                      style={{ fill: 'var(--text)', fontSize: 12, fontWeight: 600 }}
                    />
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
                {PRODUCT_KEYS.map((colKey) => <th key={colKey} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>Missing {PRODUCT_LABELS[colKey]}</th>)}
              </tr>
            </thead>
            <tbody>
              {PRODUCT_KEYS.map((rowKey) => {
                const ws = whiteSpaceMatrix(accounts)
                const row = ws[rowKey] ?? {}
                return (
                  <tr key={rowKey}>
                    <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 500, verticalAlign: 'top' }}>{PRODUCT_LABELS[rowKey]}</td>
                    {PRODUCT_KEYS.map((colKey) => {
                      if (rowKey === colKey) return <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-muted)', verticalAlign: 'top' }}>—</td>
                      const count = row[colKey] ?? 0
                      const accent = PRODUCT_ACCENTS[colKey] ?? '#888'
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
          Count of accounts by number of product families held (CRM, iCampaign, IQ &amp; MR, RVK Agents).
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
                    <th key={k} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>{PRODUCT_LABELS[k]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const matrix = attachRateMatrix(accounts)
                  return PRODUCT_KEYS.map((rowKey) => (
                    <tr key={rowKey}>
                      <td style={{ ...panelTdStyle, padding: '6px 8px', fontWeight: 500, verticalAlign: 'top' }}>{PRODUCT_LABELS[rowKey]}</td>
                      {PRODUCT_KEYS.map((colKey) => {
                        const pct = matrix[rowKey]?.[colKey] ?? 0
                        const isDiag = rowKey === colKey
                        const accent = PRODUCT_ACCENTS[colKey] ?? '#888'
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
              const yMax = revenueChartYMax(revenueDepthData)
              return (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={revenueDepthData}
                    margin={{ top: 28, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} />
                    <YAxis domain={[0, yMax]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v}`} />
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
                        formatter={formatAvgArrLabel}
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
                    <th key={colKey} style={{ ...panelThStyle, padding: '6px 8px', verticalAlign: 'top' }}>Missing {PRODUCT_LABELS[colKey]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PRODUCT_KEYS.map((rowKey) => {
                  const ws = whiteSpaceMatrix(accounts)
                  const row = ws[rowKey] ?? {}
                  return (
                    <tr key={rowKey}>
                      <td style={{ ...panelTdStyle, padding: '6px 8px', fontWeight: 500, verticalAlign: 'top' }}>{PRODUCT_LABELS[rowKey]}</td>
                      {PRODUCT_KEYS.map((colKey) => {
                        if (rowKey === colKey) {
                          return <td key={colKey} style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-muted)', verticalAlign: 'top' }}>—</td>
                        }
                        const count = row[colKey] ?? 0
                        const accent = PRODUCT_ACCENTS[colKey] ?? '#888'
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

/** Map the analytics per-account reconciled family ARR (by_group: crm | icampaign | iq_mr | rvk | other)
 *  to the product-penetration booleans + per-family ARR. Mirrors the ARR bridges, so the same accounts
 *  and ARR appear here as in the bridges (Alleva included). `arr` is the account's total month-end ARR. */
export function accountsFromByGroup(
  rows: { by_group: Record<string, number>; arr?: number; account_name?: string | null; account_id?: string | null }[]
): ProductPenetrationAccount[] {
  return rows.map((row) => {
    const g = row.by_group || {}
    const val = (key: string) => (typeof g[key] === 'number' ? (g[key] as number) : 0)
    const arrCrm = val('crm')
    const arrICampaign = val('icampaign')
    const arrIqMr = val('iq_mr')
    const arrRvk = val('rvk')
    return {
      hasCrm: arrCrm > 0,
      hasICampaign: arrICampaign > 0,
      hasIqMr: arrIqMr > 0,
      hasRvk: arrRvk > 0,
      accountName: row.account_name ?? null,
      accountId: row.account_id ?? null,
      arr: typeof row.arr === 'number' ? row.arr : undefined,
      arrCrm: arrCrm > 0 ? arrCrm : undefined,
      arrICampaign: arrICampaign > 0 ? arrICampaign : undefined,
      arrIqMr: arrIqMr > 0 ? arrIqMr : undefined,
      arrRvk: arrRvk > 0 ? arrRvk : undefined,
    }
  })
}
