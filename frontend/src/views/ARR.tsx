import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getARRByAccountProduct, syncSalesforce, type ARRByAccountProductResponse } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

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

type SortKey = 'account_name' | 'segment' | 'subscription_end_date' | 'total_arr' | (string & {})
type SortDir = 'asc' | 'desc'
type ColumnFilterMode = 'zero' | 'nonzero'

export default function ARR() {
  const [data, setData] = useState<ARRByAccountProductResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('total_arr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [columnFilter, setColumnFilter] = useState<Record<string, ColumnFilterMode>>({})
  const [openFilterMenu, setOpenFilterMenu] = useState<SortKey | null>(null)
  const [filterMenuPosition, setFilterMenuPosition] = useState<{ left: number; top: number } | null>(null)

  const loadData = () => {
    getARRByAccountProduct()
      .then(setData)
      .catch((e) => setErr(e.message))
  }

  useEffect(() => {
    loadData()
  }, [])

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
  const products = Array.isArray(data?.products) ? data.products : []
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const total_by_product = data?.total_by_product ?? {}
  const grand_total = data?.grand_total ?? 0
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
      setSortDir(key === 'account_name' || key === 'segment' || key === 'subscription_end_date' ? 'asc' : 'desc')
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
      if (sortKey === 'segment') {
        aVal = (a.segment ?? 'SMB/ MM').trim().toLowerCase()
        bVal = (b.segment ?? 'SMB/ MM').trim().toLowerCase()
        return dir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0)
      }
      if (sortKey === 'subscription_end_date') {
        aVal = a.subscription_end_date ?? ''
        bVal = b.subscription_end_date ?? ''
        return dir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0)
      }
      if (sortKey === 'total_arr') {
        return dir * ((a.total_arr ?? 0) - (b.total_arr ?? 0))
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
        const val = col === 'total_arr' ? row.total_arr : row.by_product[col]
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

  const thSortable = (key: SortKey, label: string, align: 'left' | 'right' = 'left', extraStyle: React.CSSProperties = {}, filterable = false) => {
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
          ...extraStyle,
        }}
        title={`Sort by ${label} (${isActive && sortDir === 'asc' ? 'desc' : 'asc'})`}
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

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Customer overview</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Rows = accounts. Columns = contracted ARR (CARR) by product; includes customers with future start date. Last column = total CARR per account. iVerify Monthly Credits and Kipu API excluded.
      </p>
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
              {thSortable('segment', 'Segment')}
              {thSortable('subscription_end_date', 'Subscription end')}
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
              {thSortable('total_arr', 'Total CARR', 'right', { fontWeight: 600, position: 'sticky', right: 0, background: 'var(--surface)', zIndex: 1 }, true)}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 0 }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} />
              <td style={{ padding: '0.5rem 0.75rem' }} />
              {products.map((p) => (
                <td key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {fmtMoney(total_by_product[p] ?? 0)}
                </td>
              ))}
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', right: 0, background: 'var(--surface)', zIndex: 0 }}>{fmtMoney(grand_total)}</td>
            </tr>
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
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{row.segment?.trim() ? row.segment : 'SMB/ MM'}</td>
                <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>{row.subscription_end_date ?? '—'}</td>
                {products.map((p) => (
                  <td key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                    {fmtMoney(row.by_product[p] ?? 0)}
                  </td>
                ))}
                <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', fontWeight: 600, color: 'var(--text)', position: 'sticky', right: 0, background: 'var(--bg)', zIndex: 0 }}>{fmtMoney(row.total_arr)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} />
              <td style={{ padding: '0.5rem 0.75rem' }} />
              {products.map((p) => (
                <td key={p} style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>
                  {fmtMoney(total_by_product[p] ?? 0)}
                </td>
              ))}
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)', position: 'sticky', right: 0, background: 'var(--surface)', zIndex: 1 }}>{fmtMoney(grand_total)}</td>
            </tr>
          </tfoot>
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
