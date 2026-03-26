import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getARRByAccountProduct, getSalesforceUserNamesByIds, syncSalesforce, type ARRByAccountProductResponse } from '../api'

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.4rem 12px',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: '0.9rem',
}

type SortKey = 'account_name' | 'csm' | 'subscription_end_date' | 'contracted_arr' | (string & {})
type SortDir = 'asc' | 'desc'
type ColumnFilterMode = 'zero' | 'nonzero'

const KNOWN_CSM_NAME_BY_ID: Record<string, string> = {
  '005Vq000006cPI9IAM': 'Anna Kelley',
  '005Vq000007P4qnIAC': 'Roberto Lagos',
  '005Vq000007P4yrIAC': 'Sabrina Cummings',
  '005Vq000007VZruIAG': 'Johnny Lin',
  '005Vq000007VdaXIAS': 'Emily Abreu',
}

/**
 * Products purchased grid columns — must match backend `PRODUCTS_PURCHASED_COLUMNS` + Other.
 * We always render this order so the layout is correct even when `VITE_API_URL` points at an older
 * API that still returns the legacy `products` list in JSON.
 */
const PRODUCTS_PURCHASED_TABLE_COLUMNS: string[] = [
  'CRM Platform',
  'CRM Billing Platform',
  'MR Platform',
  'IQ Platform',
  'iCampaign Platform',
  'Other',
]

export default function ARR() {
  const [data, setData] = useState<ARRByAccountProductResponse | null>(null)
  const [csmNameById, setCsmNameById] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('account_name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [columnFilter, setColumnFilter] = useState<Record<string, ColumnFilterMode>>({})
  const [openFilterMenu, setOpenFilterMenu] = useState<SortKey | null>(null)
  const [filterMenuPosition, setFilterMenuPosition] = useState<{ left: number; top: number } | null>(null)

  const loadData = () => {
    setErr(null)
    getARRByAccountProduct()
      .then(setData)
      .catch((e) => setErr(e.message))
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    const rows = Array.isArray(data?.rows) ? data.rows : []
    const sfUserIdRe = /^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/
    const ids = Array.from(
      new Set(
        rows
          .map((r) => (r.csm ?? '').trim())
          .filter((v) => sfUserIdRe.test(v))
      )
    )
    if (ids.length === 0) {
      setCsmNameById({})
      return
    }
    getSalesforceUserNamesByIds(ids)
      .then((map) => setCsmNameById(map))
      .catch(() => setCsmNameById({}))
  }, [data])

  const handleSyncSalesforce = () => {
    setSyncStatus('loading')
    setSyncMessage(null)
    syncSalesforce()
      .then((res) => {
        if (res.ok) {
          setSyncStatus('ok')
          setSyncMessage(
            `Synced ${res.synced_opportunities ?? 0} opportunities, ${res.synced_line_items ?? 0} product lines. ${res.renewal_opportunities_count ?? 0} open renewal(s) for CARR.`
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

  // Derive data for table (safe when data is null) — must be before any early return so hooks below run every time
  const apiProducts = Array.isArray(data?.products) ? data.products : []
  /** Always canonical columns; cells use row.by_product[key] (missing keys => 0). */
  const products = PRODUCTS_PURCHASED_TABLE_COLUMNS
  const rows = Array.isArray(data?.rows) ? data.rows : []
  // Legacy payload still includes add-on columns. We only warn in production builds.
  const apiReturnsLegacyProductColumns = apiProducts.includes('Add. CRM Seats')
  const showLegacyApiBanner = import.meta.env.PROD && apiReturnsLegacyProductColumns
  const apiBaseHint =
    (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '(same origin /api)'
  const salesforce_base_url =
    data?.salesforce_base_url &&
    (data.salesforce_base_url.includes("salesforce.com") || data.salesforce_base_url.includes("lightning.force.com"))
      ? data.salesforce_base_url
      : undefined
  const productLabels = products.map((p) => (p === '—' ? 'Product' : String(p)))

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'account_name' || key === 'csm' || key === 'subscription_end_date' ? 'asc' : 'desc')
    }
  }

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      let aVal: string | number, bVal: string | number
      if (sortKey === 'account_name') {
        aVal = (a.account_name ?? '').toLowerCase()
        bVal = (b.account_name ?? '').toLowerCase()
        return dir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0)
      }
      if (sortKey === 'csm') {
        aVal = (a.csm ?? '—').trim().toLowerCase()
        bVal = (b.csm ?? '—').trim().toLowerCase()
        return dir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0)
      }
      if (sortKey === 'subscription_end_date') {
        aVal = a.subscription_end_date ?? ''
        bVal = b.subscription_end_date ?? ''
        return dir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0)
      }
      if (sortKey === 'contracted_arr') {
        aVal = a.contracted_arr ?? a.total_arr ?? 0
        bVal = b.contracted_arr ?? b.total_arr ?? 0
        return dir * ((aVal as number) - (bVal as number))
      }
      // product column
      aVal = a.by_product[sortKey] ?? 0
      bVal = b.by_product[sortKey] ?? 0
      return dir * ((aVal as number) - (bVal as number))
    })
  }, [rows, sortKey, sortDir])

  const openFilterFor = (colKey: SortKey, e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setFilterMenuPosition({ left: rect.left, top: rect.bottom + 4 })
    setOpenFilterMenu(colKey)
  }

  const setFilterMode = (colKey: SortKey, mode: ColumnFilterMode) => {
    setColumnFilter((prev) => {
      const next = { ...prev }
      if (prev[colKey] === mode) delete next[colKey]
      else next[colKey] = mode
      return next
    })
    setOpenFilterMenu(null)
  }

  const displayRows = useMemo(() => {
    const keys = Object.keys(columnFilter) as SortKey[]
    if (keys.length === 0) return sortedRows
    return sortedRows.filter((row) => {
      for (const col of keys) {
        const val =
          col === 'total_arr'
            ? row.total_arr
            : col === 'contracted_arr'
              ? row.contracted_arr ?? row.total_arr
              : row.by_product[col]
        const v = val ?? 0
        const mode = columnFilter[col]
        if (mode === 'zero' && v !== 0) return false
        if (mode === 'nonzero' && v === 0) return false
      }
      return true
    })
  }, [sortedRows, columnFilter])

  const hasActiveFilter = (colKey: SortKey) => columnFilter[colKey] != null

  const filterMenuDropdown = openFilterMenu != null && filterMenuPosition && typeof document !== 'undefined' && (
    <>
      <div
        role="presentation"
        style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
        onClick={() => setOpenFilterMenu(null)}
      />
      <div
        role="menu"
        className="arr-filter-menu"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: filterMenuPosition.left,
          top: filterMenuPosition.top,
          zIndex: 1001,
          minWidth: 200,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          padding: '4px 0',
          fontSize: '0.9rem',
          color: 'var(--text)',
        }}
      >
        <button
          type="button"
          role="menuitem"
          style={menuItemStyle}
          onClick={() => {
            handleSort(openFilterMenu)
            setSortDir('asc')
            setOpenFilterMenu(null)
          }}
        >
          Sort lowest to highest
        </button>
        <button
          type="button"
          role="menuitem"
          style={menuItemStyle}
          onClick={() => {
            handleSort(openFilterMenu)
            setSortDir('desc')
            setOpenFilterMenu(null)
          }}
        >
          Sort highest to lowest
        </button>
        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
        <button
          type="button"
          role="menuitem"
          style={menuItemStyle}
          onClick={() => setFilterMode(openFilterMenu, 'zero')}
        >
          Select all 0
          {columnFilter[openFilterMenu] === 'zero' && ' ✓'}
        </button>
        <button
          type="button"
          role="menuitem"
          style={menuItemStyle}
          onClick={() => setFilterMode(openFilterMenu, 'nonzero')}
        >
          Select all &lt;&gt;0
          {columnFilter[openFilterMenu] === 'nonzero' && ' ✓'}
        </button>
      </div>
    </>
  )

  const thSortable = (
    key: SortKey,
    label: string,
    align: 'left' | 'right' = 'left',
    extraStyle: React.CSSProperties = {},
    filterable = false,
    /** If set, prepended to the sort hint in the native tooltip */
    detailTitle?: string
  ) => {
    const isActive = sortKey === key
    const sortHint = `Sort by ${label} (${isActive && sortDir === 'asc' ? 'desc' : 'asc'})`
    const title = detailTitle ? `${detailTitle} ${sortHint}` : sortHint
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
          ...extraStyle,
        }}
        title={title}
      >
        {label}
        {isActive && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
        {filterable && (
          <button
            type="button"
            onClick={(e) => openFilterFor(key, e)}
            title="Filter and sort"
            style={{
              marginLeft: 4,
              padding: 2,
              background: hasActiveFilter(key) ? 'var(--accent)' : 'transparent',
              color: hasActiveFilter(key) ? '#fff' : 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ⋮
          </button>
        )}
      </th>
    )
  }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  const yesNo = (n: number | null | undefined) => (n != null && n !== 0 ? 'Yes' : '-')
  const fmtMoney = (n: number | null | undefined) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n ?? 0)

  return (
    <>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Products purchased</h1>
      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 960, lineHeight: 1.5 }}>
        <strong>Contracted ARR (CARR)</strong> (column) = <strong>Live ARR</strong> (same schedule as the Schedule view) plus ARR from{' '}
        <strong>Closed Won</strong> New Business and Expansion opportunities whose <strong>service start</strong> (earliest included line, else contract start) is{' '}
        <strong>after today</strong> (America/New_York). Product columns still reflect <strong>open renewal</strong> line items only (unchanged).
      </p>
      {showLegacyApiBanner && (
        <p
          style={{
            margin: '0 0 1rem',
            padding: '0.65rem 0.85rem',
            fontSize: '0.875rem',
            lineHeight: 1.45,
            color: 'var(--text)',
            background: 'rgba(234, 179, 8, 0.12)',
            border: '1px solid rgba(234, 179, 8, 0.45)',
            borderRadius: 8,
            maxWidth: 920,
          }}
        >
          <strong>Older API detected.</strong> The server is still returning the legacy <code>products</code> list (e.g. &quot;Add. CRM Seats&quot;).
          This page shows the updated column layout anyway — <strong>redeploy the backend</strong> so the API matches. API base:{' '}
          <code style={{ wordBreak: 'break-all' }}>{apiBaseHint}</code>
        </p>
      )}
      <p style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => loadData()}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: 'pointer',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          Refresh data
        </button>
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
        {Object.keys(columnFilter).length > 0 && (
          <>
            <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
              Showing {displayRows.length} of {sortedRows.length} rows
            </span>
            <button
              type="button"
              onClick={() => setColumnFilter({})}
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.875rem',
                cursor: 'pointer',
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              Reset filter
            </button>
          </>
        )}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 400, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {thSortable('account_name', 'Account', 'left', { position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 })}
              {thSortable('csm', 'CSM')}
              {thSortable('subscription_end_date', 'Subscription end')}
              {thSortable(
                'contracted_arr',
                'Contracted ARR',
                'right',
                {},
                false,
                'Schedule Active ARR evaluated 12 months after today (EST).'
              )}
              {products.map((p, i) => (
                <th
                  key={p}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSort(p)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleSort(p)}
                  style={{
                    textAlign: 'right',
                    padding: '0.5rem 0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  title={`Sort by ${productLabels[i]} (${sortKey === p && sortDir === 'asc' ? 'desc' : 'asc'})`}
                >
                  {productLabels[i]}
                  {sortKey === p && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  <button
                    type="button"
                    onClick={(e) => openFilterFor(p, e)}
                    title="Filter and sort"
                    style={{
                      marginLeft: 4,
                      padding: 2,
                      background: hasActiveFilter(p) ? 'var(--accent)' : 'transparent',
                      color: hasActiveFilter(p) ? '#fff' : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      cursor: 'pointer',
                      lineHeight: 1,
                    }}
                  >
                    ⋮
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={row.account_id ?? row.account_name} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', left: 0, background: 'var(--bg)', zIndex: 0 }}>
                  {row.account_id && salesforce_base_url ? (
                    <a
                      href={salesforce_base_url.includes('lightning.force.com')
                        ? `${salesforce_base_url}/lightning/r/Account/${row.account_id}/view`
                        : `${salesforce_base_url}/${row.account_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent)', textDecoration: 'none' }}
                      title="Open in Salesforce"
                    >
                      {row.account_name}
                    </a>
                  ) : (
                    row.account_name
                  )}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {(() => {
                    const raw = row.csm?.trim() ?? ''
                    return raw ? (csmNameById[raw] ?? KNOWN_CSM_NAME_BY_ID[raw] ?? raw) : '—'
                  })()}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>{row.subscription_end_date ?? '—'}</td>
                <td
                  style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}
                  title={
                    row.contracted_arr != null
                      ? 'CARR = Live ARR + future Closed Won NB/Exp (service start after today).'
                      : 'Renewal line total (API did not send contracted_arr).'
                  }
                >
                  {fmtMoney(row.contracted_arr ?? row.total_arr)}
                </td>
                {products.map((p) => (
                  <td key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {yesNo(row.by_product[p] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>No accounts with open renewal opportunities.</p>
      )}
      {typeof document !== 'undefined' &&
        createPortal(
          openFilterMenu != null && filterMenuPosition ? filterMenuDropdown : null,
          document.body
        )}
    </>
  )
}
