import { useEffect, useState, useMemo } from 'react'
import { getArrCohortChurn, getDatasetStatus, refreshAppDataset, formatLastUpdated, exportCohortRetentionToSheet, ArrCohortChurnResponse, CohortRow, type DatasetStatus } from '../api'

// ── colour helpers ────────────────────────────────────────────────────────────

function retentionBg(pct: number | null, isMonth0: boolean): string {
  if (isMonth0) return 'var(--surface-2, #2a2a3a)'
  if (pct === null) return 'transparent'
  if (pct >= 110) return '#1a4a2a'   // strong expansion — deep green
  if (pct >= 100) return '#1e5c30'   // expansion
  if (pct >= 90)  return '#1a4020'   // healthy retention
  if (pct >= 75)  return '#3a3a10'   // moderate churn
  if (pct >= 50)  return '#4a2a08'   // significant churn
  return '#4a1010'                    // severe churn / churned
}

function retentionColor(pct: number | null, isMonth0: boolean): string {
  if (isMonth0) return 'var(--text)'
  if (pct === null) return 'transparent'
  if (pct >= 90) return '#7ee8a0'
  if (pct >= 75) return '#d4d46a'
  if (pct >= 50) return '#e0a060'
  return '#e07070'
}

// ── formatting helpers ────────────────────────────────────────────────────────

function fmtMonth(ym: string): string {
  // "2022-01" → "Jan '22"
  const [y, m] = ym.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(m) - 1]} '${y.slice(2)}`
}

function fmtArr(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n)}`
}

// ── component ─────────────────────────────────────────────────────────────────

export default function ARRCohortChurn() {
  const [data, setData] = useState<ArrCohortChurnResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus | null>(null)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportUrl, setExportUrl] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    getArrCohortChurn()
      .then((res) => { setData(res); setLoading(false) })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false) })
    getDatasetStatus().then(setDatasetStatus).catch(() => {})
  }, [])

  const handleRefreshAppData = async () => {
    setRefreshMessage(null)
    setRefreshLoading(true)
    try {
      const res = await refreshAppDataset()
      setRefreshLoading(false)
      setRefreshMessage(res.ok ? 'Refresh started — it will complete in the background.' : (res.error ?? 'Refresh failed to start.'))
    } catch (e) {
      setRefreshLoading(false)
      setRefreshMessage(e instanceof Error ? e.message : 'Refresh failed')
    }
  }

  const handleExportToSheet = () => {
    setExportStatus('loading')
    setExportMessage(null)
    setExportUrl(null)
    exportCohortRetentionToSheet()
      .then((res) => {
        if (res.ok) {
          setExportStatus('ok')
          setExportUrl(res.spreadsheet_url ?? null)
          setExportMessage(res.message ?? `Exported ${res.rows_written ?? ''} rows to "ARR_Cohort retention export" sheet.`)
        } else {
          setExportStatus('error')
          setExportMessage(res.error ?? 'Export failed')
        }
      })
      .catch((e: unknown) => {
        setExportStatus('error')
        setExportMessage(e instanceof Error ? e.message : 'Export failed')
      })
  }

  const visibleOffsets = useMemo(() => {
    if (!data) return []
    return Array.from({ length: data.max_offset + 1 }, (_, i) => i)
  }, [data])

  if (loading) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading cohort data…</div>
  if (error)   return <div style={{ padding: '2rem', color: 'var(--negative)' }}>Error: {error}</div>
  if (!data || data.cohorts.length === 0)
    return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>No cohort data found. Run Refresh app data first.</div>

  const cohorts: CohortRow[] = data.cohorts

  return (
    <div style={{ padding: '1.5rem 2rem', minWidth: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)' }}>ARR Cohort Retention</h1>
        <button type="button" onClick={handleRefreshAppData} disabled={refreshLoading} style={{ padding: '0.5rem 1rem', fontSize: '0.9rem', fontWeight: 600, cursor: refreshLoading ? 'wait' : 'pointer', background: 'var(--accent)', color: 'var(--accent-contrast, #fff)', border: 'none', borderRadius: 6 }}>
          {refreshLoading ? 'Refreshing…' : 'Refresh app data'}
        </button>
        <button
          type="button"
          onClick={handleExportToSheet}
          disabled={exportStatus === 'loading'}
          style={{ padding: '0.5rem 1rem', fontSize: '0.9rem', fontWeight: 600, cursor: exportStatus === 'loading' ? 'wait' : 'pointer', background: 'var(--surface-2, #2a2a3a)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}
        >
          {exportStatus === 'loading' ? 'Exporting…' : 'Export to Google Sheet'}
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {datasetStatus?.updated_at ? `Last updated: ${formatLastUpdated(datasetStatus.updated_at)}` : 'Click Refresh app data to load latest data.'}
        </span>
        {data.message && (
          <span style={{ fontSize: '0.8rem', color: 'var(--warning, #d4a010)' }}>{data.message}</span>
        )}
      </div>
      {refreshMessage && <p style={{ fontSize: '0.9rem', color: refreshMessage.includes('failed') || refreshMessage.includes('error') ? 'var(--negative)' : 'var(--text-muted)', margin: '0 0 0.75rem' }}>{refreshMessage}</p>}
      {exportMessage && (
        <p style={{ fontSize: '0.9rem', color: exportStatus === 'error' ? 'var(--negative)' : 'var(--text-muted)', margin: '0 0 0.75rem' }}>
          {exportMessage}
          {exportUrl && exportStatus === 'ok' && (
            <> — <a href={exportUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Open sheet</a></>
          )}
        </p>
      )}

      <p style={{ margin: '0 0 1.25rem', fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 640 }}>
        Each row = accounts whose first ARR month is the cohort month. Values show % of Month 0 ARR still active
        (NRR — can exceed 100% with expansions). Jan 2022 – Nov 2025 from Google Sheet; Dec 2025+ from Salesforce.
      </p>

      {/* legend */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.75rem' }}>
        {[
          { bg: '#1a4a2a', label: '≥ 110%' },
          { bg: '#1e5c30', label: '100–110%' },
          { bg: '#1a4020', label: '90–100%' },
          { bg: '#3a3a10', label: '75–90%' },
          { bg: '#4a2a08', label: '50–75%' },
          { bg: '#4a1010', label: '< 50%' },
        ].map(({ bg, label }) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 14, height: 14, background: bg, borderRadius: 2, display: 'inline-block' }} />
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
          </span>
        ))}
      </div>

      {/* table */}
      <table style={{ borderCollapse: 'collapse', fontSize: '0.78rem', width: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 90 }} />
            <col style={{ width: 56 }} />
            <col style={{ width: 72 }} />
            {visibleOffsets.map((offset) => (
              <col key={offset} style={{ width: 54 }} />
            ))}
          </colgroup>
          <thead>
            <tr style={{ background: 'var(--surface-2, #1e1e2e)', borderBottom: '2px solid var(--border)' }}>
              <th style={thStyle}>Cohort</th>
              <th style={thStyle}>#</th>
              <th style={thStyle}>Start ARR</th>
              {visibleOffsets.map((offset) => (
                <th key={offset} style={{ ...thStyle, color: offset === 0 ? 'var(--text)' : 'var(--text-muted)' }}>
                  M{offset}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => {
              const monthMap: Record<number, { arr: number; pct: number | null }> = {}
              cohort.months.forEach((m) => { monthMap[m.offset] = { arr: m.arr, pct: m.pct } })

              return (
                <tr
                  key={cohort.cohort_month}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                    {fmtMonth(cohort.cohort_month)}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--text-muted)', textAlign: 'right' }}>
                    {cohort.account_count}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtArr(cohort.starting_arr)}
                  </td>
                  {visibleOffsets.map((offset) => {
                    const cell = monthMap[offset]
                    const isMonth0 = offset === 0
                    if (!cell) {
                      return <td key={offset} style={{ ...tdStyle, background: 'transparent' }} />
                    }
                    return (
                      <td
                        key={offset}
                        title={`${fmtMonth(cohort.cohort_month)} → M${offset}: ${fmtArr(cell.arr)} (${cell.pct ?? '—'}%)`}
                        style={{
                          ...tdStyle,
                          background: retentionBg(cell.pct, isMonth0),
                          color: retentionColor(cell.pct, isMonth0),
                          textAlign: 'center',
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: isMonth0 ? 600 : 400,
                        }}
                      >
                        {isMonth0 ? '100%' : cell.pct !== null ? `${cell.pct}%` : '—'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>

      <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        {cohorts.length} cohorts · {data.max_offset + 1} months of history ·{' '}
        {cohorts.reduce((s, c) => s + c.account_count, 0)} total account–cohort assignments
      </p>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '0.5rem 0.4rem',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '0.75rem',
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
}

const tdStyle: React.CSSProperties = {
  padding: '0.3rem 0.4rem',
  color: 'var(--text)',
  verticalAlign: 'middle',
}
