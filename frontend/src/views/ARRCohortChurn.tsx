import { useEffect, useState, useMemo } from 'react'
import { getArrCohortChurn, ArrCohortChurnResponse, CohortRow } from '../api'

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

// ── column visibility ─────────────────────────────────────────────────────────

const SHOW_EVERY_N = [0, 1, 2, 3, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47]

// ── component ─────────────────────────────────────────────────────────────────

export default function ARRCohortChurn() {
  const [data, setData] = useState<ArrCohortChurnResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setLoading(true)
    getArrCohortChurn()
      .then((res) => { setData(res); setLoading(false) })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false) })
  }, [])

  const visibleOffsets = useMemo(() => {
    if (!data) return []
    const max = data.max_offset
    if (showAll || max <= 24) {
      return Array.from({ length: max + 1 }, (_, i) => i)
    }
    return SHOW_EVERY_N.filter((n) => n <= max)
  }, [data, showAll])

  if (loading) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading cohort data…</div>
  if (error)   return <div style={{ padding: '2rem', color: 'var(--negative)' }}>Error: {error}</div>
  if (!data || data.cohorts.length === 0)
    return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>No cohort data found. Run Refresh app data first.</div>

  const cohorts: CohortRow[] = data.cohorts

  return (
    <div style={{ padding: '1.5rem 2rem', minWidth: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)' }}>
          ARR Cohort Retention
        </h1>
        {data.sheet_snapshot_as_of && (
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Sheet as of {new Date(data.sheet_snapshot_as_of).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        )}
        {data.message && (
          <span style={{ fontSize: '0.8rem', color: 'var(--warning, #d4a010)' }}>{data.message}</span>
        )}
      </div>

      <p style={{ margin: '0 0 1.25rem', fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 640 }}>
        Each row = accounts whose first ARR month is the cohort month. Values show % of Month 0 ARR still active
        (NRR — can exceed 100% with expansions). Jan 2022 – Nov 2025 from Google Sheet; Dec 2025+ from Salesforce.
      </p>

      {/* toggle */}
      {data.max_offset > 24 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          style={{
            marginBottom: '1rem',
            padding: '0.3rem 0.75rem',
            fontSize: '0.8rem',
            background: 'var(--surface-2, #2a2a3a)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          {showAll ? 'Show fewer columns' : `Show all ${data.max_offset + 1} months`}
        </button>
      )}

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
      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.78rem', minWidth: '100%', tableLayout: 'fixed' }}>
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
      </div>

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
