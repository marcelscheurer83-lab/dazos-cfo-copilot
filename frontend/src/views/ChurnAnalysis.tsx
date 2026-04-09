import { useEffect, useState } from 'react'
import {
  getChurnSummary, getChurnRecords, getChurnObservations,
  syncChurnData, runChurnAIAnalysis,
  type ChurnSummary, type ChurnRecord, type ChurnObservations,
} from '../api'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const fmtNum = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

// ── Small reusable components ─────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '1rem 1.25rem', flex: '1 1 160px',
    }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.3rem', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{sub}</div>}
    </div>
  )
}

function BucketTable({ title, data }: { title: string; data: Record<string, { count: number; arr: number }> }) {
  const totalArr = Object.values(data).reduce((s, v) => s + v.arr, 0)
  const entries = Object.entries(data).sort((a, b) => b[1].arr - a[1].arr)
  if (entries.length === 0) return null
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '1rem 1.25rem', flex: '1 1 280px' }}>
      <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.75rem' }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>Segment</th>
            <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>#</th>
            <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>ARR lost</th>
            <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>%</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, val]) => {
            const pct = totalArr > 0 ? (val.arr / totalArr) * 100 : 0
            return (
              <tr key={key}>
                <td style={{ padding: '0.3rem 0', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>{key}</td>
                <td style={{ textAlign: 'right', padding: '0.3rem 0', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{val.count}</td>
                <td style={{ textAlign: 'right', padding: '0.3rem 0', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>{fmt(val.arr)}</td>
                <td style={{ textAlign: 'right', padding: '0.3rem 0', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{pct.toFixed(0)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ChurnTimeline({ byMonth }: { byMonth: Record<string, { count: number; arr: number }> }) {
  const entries = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]))
  if (entries.length === 0) return null
  const maxArr = Math.max(...entries.map(([, v]) => v.arr), 1)

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '1rem 1.25rem' }}>
      <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '1rem' }}>Churn by month</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: 80 }}>
        {entries.map(([month, val]) => {
          const h = Math.max(4, (val.arr / maxArr) * 80)
          return (
            <div key={month} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0 }} title={`${month}: ${fmt(val.arr)} (${val.count} accounts)`}>
              <div style={{ width: '100%', height: h, background: 'var(--negative, #ef4444)', borderRadius: '3px 3px 0 0', opacity: 0.8 }} />
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 3, writingMode: 'vertical-rl', transform: 'rotate(180deg)', maxHeight: 36, overflow: 'hidden' }}>
                {month.slice(2)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

type ActionState = { loading: boolean; msg: string | null; error: boolean }

export default function ChurnAnalysis() {
  const [summary, setSummary] = useState<ChurnSummary | null>(null)
  const [records, setRecords] = useState<ChurnRecord[]>([])
  const [obs, setObs] = useState<ChurnObservations | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [syncState, setSyncState] = useState<ActionState>({ loading: false, msg: null, error: false })
  const [aiState, setAiState] = useState<ActionState>({ loading: false, msg: null, error: false })
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<'patterns' | 'accounts' | 'ai'>('patterns')

  const load = async () => {
    try {
      const [s, r, o] = await Promise.all([getChurnSummary(), getChurnRecords(), getChurnObservations()])
      setSummary(s)
      setRecords(r)
      setObs(o)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleSync() {
    setSyncState({ loading: true, msg: null, error: false })
    try {
      const res = await syncChurnData()
      setSyncState({ loading: false, msg: `✓ ${res.message}`, error: false })
      load()
    } catch (e) {
      setSyncState({ loading: false, msg: (e as Error).message, error: true })
    }
  }

  async function handleAIAnalyze() {
    setAiState({ loading: true, msg: null, error: false })
    try {
      const res = await runChurnAIAnalysis()
      setAiState({ loading: false, msg: `✓ Generated ${res.observations} observations`, error: false })
      const o = await getChurnObservations()
      setObs(o)
      setActiveTab('ai')
    } catch (e) {
      setAiState({ loading: false, msg: (e as Error).message, error: true })
    }
  }

  const filteredRecords = records.filter((r) =>
    !search || r.account_name.toLowerCase().includes(search.toLowerCase()) ||
    (r.industry || '').toLowerCase().includes(search.toLowerCase()) ||
    (r.segment || '').toLowerCase().includes(search.toLowerCase())
  )

  const avgTenure = records.length > 0
    ? Math.round(records.filter(r => r.tenure_months).reduce((s, r) => s + (r.tenure_months ?? 0), 0) / records.filter(r => r.tenure_months).length)
    : null

  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
  if (err) return <p style={{ color: 'var(--negative)' }}>{err}</p>

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>Churn Analysis</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
            Churned accounts from ARR schedule, enriched with Salesforce attributes.
            {summary?.synced_at && <span style={{ marginLeft: '0.5rem', opacity: 0.6 }}>Last synced {new Date(summary.synced_at).toLocaleDateString()}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
            <button onClick={handleSync} disabled={syncState.loading} style={btnStyle(syncState.loading, 'secondary')}>
              {syncState.loading ? 'Syncing…' : '↻ Sync data'}
            </button>
            {syncState.msg && <span style={{ fontSize: '0.72rem', color: syncState.error ? 'var(--negative)' : '#86efac' }}>{syncState.msg}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
            <button onClick={handleAIAnalyze} disabled={aiState.loading || records.length === 0} style={btnStyle(aiState.loading || records.length === 0, 'primary')}>
              {aiState.loading ? 'Analyzing…' : '✦ AI Analysis'}
            </button>
            {aiState.msg && <span style={{ fontSize: '0.72rem', color: aiState.error ? 'var(--negative)' : '#86efac' }}>{aiState.msg}</span>}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      {summary && summary.total > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
          <KpiCard label="Churned accounts" value={fmtNum(summary.total)} />
          <KpiCard label="Total ARR lost" value={fmt(summary.total_arr)} />
          <KpiCard label="Avg ARR per account" value={summary.total > 0 ? fmt(summary.total_arr / summary.total) : '—'} />
          <KpiCard label="Avg tenure" value={avgTenure != null ? `${avgTenure} mo` : '—'} sub={avgTenure != null ? `${(avgTenure / 12).toFixed(1)} years` : undefined} />
        </div>
      )}

      {summary && summary.total === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: '2rem', textAlign: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
          No churn data yet. Click <strong>Sync data</strong> to identify churned accounts from your ARR schedule and pull Salesforce attributes.
        </div>
      )}

      {summary && summary.total > 0 && (
        <>
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem', gap: '0.25rem' }}>
            {(['patterns', 'accounts', 'ai'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '0.5rem 1rem', border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: '0.875rem', fontWeight: activeTab === tab ? 600 : 400,
                  color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {tab === 'patterns' ? 'Patterns' : tab === 'accounts' ? `Accounts (${records.length})` : 'AI Observations'}
                {tab === 'ai' && obs?.generated_at && <span style={{ marginLeft: '0.4rem', fontSize: '0.68rem', background: 'rgba(34,197,94,0.15)', color: '#86efac', borderRadius: 4, padding: '0.1rem 0.35rem' }}>●</span>}
              </button>
            ))}
          </div>

          {/* Patterns tab */}
          {activeTab === 'patterns' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <ChurnTimeline byMonth={summary.by_month} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                <BucketTable title="By industry" data={summary.by_industry} />
                <BucketTable title="By segment" data={summary.by_segment} />
                <BucketTable title="By tenure" data={summary.by_tenure_bucket} />
                <BucketTable title="By ARR size" data={summary.by_arr_bucket} />
              </div>
            </div>
          )}

          {/* Accounts tab */}
          {activeTab === 'accounts' && (
            <>
              <input
                type="text"
                placeholder="Search accounts, industry, segment…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: '100%', maxWidth: 380, padding: '0.5rem 0.85rem', marginBottom: '1rem',
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7,
                  color: 'var(--text)', fontFamily: 'inherit', fontSize: '0.875rem',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr>
                      {['Account', 'Churn month', 'ARR lost', 'Tenure', 'Industry', 'Segment', 'Region', 'Type', 'Reason'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '0.4rem 0.65rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map((rec) => (
                      <tr key={rec.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.4rem 0.65rem', fontWeight: 500 }}>{rec.account_name}</td>
                        <td style={{ padding: '0.4rem 0.65rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{rec.churn_month}</td>
                        <td style={{ padding: '0.4rem 0.65rem', fontFamily: 'var(--font-mono)', color: 'var(--negative)' }}>{fmt(rec.churn_arr)}</td>
                        <td style={{ padding: '0.4rem 0.65rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{rec.tenure_months != null ? `${rec.tenure_months}mo` : '—'}</td>
                        <td style={{ padding: '0.4rem 0.65rem' }}>{rec.industry || '—'}</td>
                        <td style={{ padding: '0.4rem 0.65rem' }}>{rec.segment || '—'}</td>
                        <td style={{ padding: '0.4rem 0.65rem' }}>{rec.region || '—'}</td>
                        <td style={{ padding: '0.4rem 0.65rem' }}>{rec.account_type || '—'}</td>
                        <td style={{ padding: '0.4rem 0.65rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rec.churn_reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* AI Observations tab */}
          {activeTab === 'ai' && (
            <div style={{ maxWidth: 800 }}>
              {!obs?.generated_at ? (
                <div style={{ color: 'var(--text-muted)', padding: '2rem', textAlign: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
                  No AI analysis yet. Click <strong>✦ AI Analysis</strong> to generate insights.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                    Generated {new Date(obs.generated_at).toLocaleString()} · {obs.total_churned} accounts · {fmt(obs.total_churn_arr)} ARR
                  </div>

                  {obs.summary && (
                    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '1.25rem 1.5rem', marginBottom: '1rem', lineHeight: 1.7, fontSize: '0.875rem' }}>
                      {obs.summary.split('\n').filter(l => l.trim()).map((para, i) => {
                        if (para.startsWith('#')) return <h3 key={i} style={{ fontWeight: 600, margin: '0.5rem 0 0.25rem', fontSize: '0.95rem' }}>{para.replace(/^#+\s*/, '')}</h3>
                        if (para.startsWith('-') || para.startsWith('•')) return (
                          <div key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.35rem' }}>
                            <span style={{ color: 'var(--accent)', flexShrink: 0 }}>•</span>
                            <span>{para.replace(/^[-•]\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')}</span>
                          </div>
                        )
                        return <p key={i} style={{ margin: '0 0 0.5rem' }}>{para.replace(/\*\*(.*?)\*\*/g, '$1')}</p>
                      })}
                    </div>
                  )}

                  {obs.observations.length > 0 && (
                    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '1.25rem 1.5rem' }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.75rem' }}>Key signals</div>
                      {obs.observations.map((bullet, i) => (
                        <div key={i} style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.5rem', fontSize: '0.875rem', lineHeight: 1.6 }}>
                          <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '0.1rem' }}>•</span>
                          <span>{bullet.replace(/\*\*(.*?)\*\*/g, '$1')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}

function btnStyle(disabled: boolean, variant: 'primary' | 'secondary'): React.CSSProperties {
  return {
    padding: '0.4rem 0.9rem',
    background: disabled ? 'var(--surface)' : variant === 'primary' ? 'var(--accent)' : 'var(--surface)',
    color: disabled ? 'var(--text-muted)' : variant === 'primary' ? 'white' : 'var(--text)',
    border: variant === 'secondary' ? '1px solid var(--border)' : 'none',
    borderRadius: 6, fontWeight: 600, fontSize: '0.825rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1, whiteSpace: 'nowrap',
  }
}
