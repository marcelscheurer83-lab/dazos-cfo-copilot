import { useCallback, useEffect, useMemo, useState } from 'react'
import { getClosedOverview, type ClosedOverviewResponse } from '../api'

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

type SortKey = 'account_name' | 'segment' | 'opportunity_name' | 'stage_name' | 'record_type_name' | 'close_date' | 'arr'
type SortDir = 'asc' | 'desc'

export default function Closed() {
  const [data, setData] = useState<ClosedOverviewResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('close_date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const loadData = useCallback(() => {
    getClosedOverview()
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const rows = Array.isArray(data?.rows) ? data.rows : []
  const grand_total = data?.grand_total ?? 0
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

  const linkStyle = { color: 'var(--accent)', textDecoration: 'none' }

  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>
  if (!data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--text)' }}>Bookings overview</h1>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
        Closed Won and Closed Lost: New Business and Expansion only. ARR = MRR × 12 from Opportunity Finance Details.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 600, borderCollapse: 'collapse', fontSize: '0.9rem', color: 'var(--text)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {th('account_name', 'Account', 'left')}
              {th('segment', 'Segment', 'left')}
              {th('opportunity_name', 'Opportunity', 'left')}
              {th('stage_name', 'Stage', 'left')}
              {th('record_type_name', 'Record type', 'left')}
              {th('close_date', 'Close date', 'left')}
              {th('arr', 'ARR', 'right')}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid var(--border)', fontWeight: 600, background: 'var(--surface)' }}>
              <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>Total</td>
              <td style={{ padding: '0.5rem 0.75rem' }} colSpan={5} />
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grand_total)}</td>
            </tr>
            {sortedRows.map((row) => (
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
              <td style={{ textAlign: 'right', padding: '0.5rem 0.75rem', color: 'var(--text)' }}>{fmtMoney(grand_total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          No closed opportunities. Sync from Salesforce on Pipeline overview to load data.
        </p>
      )}
    </>
  )
}
