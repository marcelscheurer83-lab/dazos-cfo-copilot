import { useEffect, useState } from 'react'
import { getSyncStatus, syncFromSheet, getTabSnapshots, type SyncStatus, type SyncStatementResult, type TabSnapshot } from '../api'

type Statement = 'pnl' | 'bs' | 'cf'

const STATEMENTS: { key: Statement; label: string; actuals: string; plan: string; desc: string }[] = [
  { key: 'pnl', label: 'P&L', actuals: 'P&L', plan: 'P&L_2026P', desc: 'Income statement — revenue, COGS, opex, EBITDA' },
  { key: 'bs',  label: 'Balance Sheet', actuals: 'BS', plan: 'BS_2026P', desc: 'Assets, liabilities, equity' },
  { key: 'cf',  label: 'Cash Flow', actuals: 'CF', plan: 'CF_2026P', desc: 'Operating, investing, financing cash flows' },
]

function SyncCard({
  stmt,
  status,
  syncing,
  result,
  onSync,
}: {
  stmt: typeof STATEMENTS[0]
  status: SyncStatus
  syncing: boolean
  result: SyncStatementResult | null
  onSync: () => void
}) {
  const hasSynced = !!status?.synced_at
  const syncedAt = status?.synced_at ? new Date(status.synced_at).toLocaleString() : null

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '0.2rem' }}>{stmt.label}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{stmt.desc}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          {hasSynced ? (
            <span style={{ fontSize: '0.72rem', background: 'rgba(34,197,94,0.12)', color: '#86efac', borderRadius: 4, padding: '0.15rem 0.5rem', fontWeight: 600 }}>
              Synced
            </span>
          ) : (
            <span style={{ fontSize: '0.72rem', background: 'rgba(234,179,8,0.12)', color: '#fde68a', borderRadius: 4, padding: '0.15rem 0.5rem', fontWeight: 600 }}>
              No data
            </span>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            style={{
              padding: '0.35rem 0.9rem', background: syncing ? 'var(--surface-hover)' : 'var(--accent)',
              color: syncing ? 'var(--text-muted)' : 'white', border: 'none', borderRadius: 6,
              fontWeight: 600, fontSize: '0.8rem', cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>

      {/* Tab info */}
      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.78rem' }}>
        <div style={{ background: 'var(--bg)', borderRadius: 5, padding: '0.3rem 0.65rem', border: '1px solid var(--border)' }}>
          Actuals: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{stmt.actuals}</span>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 5, padding: '0.3rem 0.65rem', border: '1px solid var(--border)' }}>
          Plan: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{stmt.plan}</span>
        </div>
      </div>

      {/* Last sync info */}
      {hasSynced && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          Last synced {syncedAt}
          {status?.rows_synced != null && ` · ${status.rows_synced} line items`}
          {status?.periods_synced != null && ` · ${status.periods_synced} periods`}
        </div>
      )}

      {/* Result message */}
      {result && (
        <div style={{
          fontSize: '0.8rem', padding: '0.4rem 0.75rem', borderRadius: 6,
          background: result.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${result.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
          color: result.ok ? '#86efac' : 'var(--negative)',
        }}>
          {result.ok
            ? `✓ Synced ${result.rows_synced} line items across ${result.periods_synced} periods`
            : `Error: ${result.error}`}
        </div>
      )}
    </div>
  )
}

export default function FinancialsDataSync() {
  const [status, setStatus] = useState<Record<Statement, SyncStatus>>({ pnl: null, bs: null, cf: null })
  const [syncing, setSyncing] = useState<Record<Statement | 'all', boolean>>({ pnl: false, bs: false, cf: false, all: false })
  const [results, setResults] = useState<Record<Statement, SyncStatementResult | null>>({ pnl: null, bs: null, cf: null })
  const [tabSnaps, setTabSnaps] = useState<TabSnapshot[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const load = () => {
    getSyncStatus()
      .then((s) => setStatus(s as Record<Statement, SyncStatus>))
      .catch((e) => setLoadErr(e.message))
    getTabSnapshots().then(setTabSnaps).catch(() => {})
  }

  useEffect(() => { load() }, [])

  async function handleSync(stmt: Statement | 'all') {
    setSyncing((s) => ({ ...s, [stmt]: true }))
    if (stmt !== 'all') setResults((r) => ({ ...r, [stmt]: null }))
    else setResults({ pnl: null, bs: null, cf: null })

    try {
      const res = await syncFromSheet(stmt)
      if (stmt === 'all') {
        setResults({
          pnl: res.results.pnl ?? null,
          bs: res.results.bs ?? null,
          cf: res.results.cf ?? null,
        })
      } else {
        setResults((r) => ({ ...r, [stmt]: res.results[stmt] ?? null }))
      }
      load()
    } catch (e) {
      const errResult: SyncStatementResult = { ok: false, error: (e as Error).message }
      if (stmt === 'all') setResults({ pnl: errResult, bs: errResult, cf: errResult })
      else setResults((r) => ({ ...r, [stmt]: errResult }))
    } finally {
      setSyncing((s) => ({ ...s, [stmt]: false }))
    }
  }

  return (
    <>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>Data Sync</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
        Reads actuals and plan tabs from your Google Sheet, uses Claude to parse the structure, and populates the P&L, Balance Sheet, and Cash Flow tables.
        Run this after each monthly close to refresh the numbers.
      </p>

      {loadErr && (
        <div style={{ color: 'var(--negative)', fontSize: '0.85rem', marginBottom: '1rem' }}>{loadErr}</div>
      )}

      {/* Sync all */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '1rem 1.5rem', marginBottom: '1.25rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Sync all statements</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>P&L + Balance Sheet + Cash Flow in one go</div>
        </div>
        <button
          onClick={() => handleSync('all')}
          disabled={syncing.all || syncing.pnl || syncing.bs || syncing.cf}
          style={{
            padding: '0.5rem 1.25rem', background: 'var(--accent)', color: 'white',
            border: 'none', borderRadius: 6, fontWeight: 600, fontSize: '0.875rem',
            cursor: (syncing.all || syncing.pnl || syncing.bs || syncing.cf) ? 'not-allowed' : 'pointer',
            opacity: (syncing.all || syncing.pnl || syncing.bs || syncing.cf) ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {syncing.all ? 'Syncing all…' : 'Sync all'}
        </button>
      </div>

      {/* Individual statements */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {STATEMENTS.map((stmt) => (
          <SyncCard
            key={stmt.key}
            stmt={stmt}
            status={status[stmt.key]}
            syncing={syncing[stmt.key] || syncing.all}
            result={results[stmt.key]}
            onSync={() => handleSync(stmt.key)}
          />
        ))}
      </div>

      {/* Agent context: tab snapshots */}
      {tabSnaps.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.25rem' }}>Agent context — tabs loaded</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: '0.85rem' }}>
            These tabs are stored and injected into every FP&A Agent chat. Run <strong>Scan model</strong> in the FP&A Agent page to refresh.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.5rem' }}>
            {tabSnaps.map((t) => (
              <div key={t.title} style={{
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7,
                padding: '0.6rem 0.85rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem',
              }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', fontWeight: 500, color: 'var(--text)' }}>{t.title}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    {t.non_empty_rows} rows · {t.synced_at ? new Date(t.synced_at).toLocaleDateString() : 'unknown'}
                  </div>
                </div>
                <span style={{
                  fontSize: '0.68rem', background: 'rgba(34,197,94,0.12)', color: '#86efac',
                  borderRadius: 4, padding: '0.1rem 0.4rem', fontWeight: 600, flexShrink: 0,
                }}>
                  loaded
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: '2rem', padding: '1rem 1.25rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.5rem', color: 'var(--text-muted)' }}>How it works</div>
        <ol style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.8 }}>
          <li><strong>Scan model</strong> (FP&A Agent page) — reads all tabs, stores raw data, and builds a structural map</li>
          <li><strong>Sync statements</strong> (below) — parses P&L, BS, CF into structured DB rows for the financial views</li>
          <li>Every FP&A Agent chat automatically includes all stored tab data + the structural map</li>
          <li>Re-scan after each monthly close to keep the agent current</li>
        </ol>
      </div>
    </>
  )
}
