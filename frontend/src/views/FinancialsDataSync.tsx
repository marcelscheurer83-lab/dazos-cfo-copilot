import { useEffect, useState } from 'react'
import {
  getSyncStatus, syncFromSheet, syncModelTabs, getModelTabsStatus,
  type SyncStatus, type SyncStatementResult, type ModelTabStatus,
} from '../api'

type Statement = 'pnl' | 'bs' | 'cf'

const STATEMENTS: { key: Statement; label: string; actuals: string; plan: string }[] = [
  { key: 'pnl', label: 'P&L', actuals: 'P&L', plan: 'P&L_2026P' },
  { key: 'bs',  label: 'Balance Sheet', actuals: 'BS', plan: 'BS_2026P' },
  { key: 'cf',  label: 'Cash Flow', actuals: 'CF', plan: 'CF_2026P' },
]

const ALL_MODEL_TABS = [
  'OVERVIEW', 'ASSUMPTIONS',
  'P&L', 'BS', 'CF',
  'Sales and CS capacity', 'Headcount',
  'ARR_Calculations', 'ARR_Actuals', 'ARR_Schedule',
  'CoGS', 'Sales & Marketing', 'Product & Engineering', 'General & Administrative',
  'OVERVIEW_2026P', 'P&L_2026P', 'BS_2026P', 'CF_2026P',
  'Sales and CS capacity_2026P', 'Headcount_2026P', 'Hiring plan_2026P',
  'ARR_Calculations_2026P', 'CoGS_2026P', 'Sales & Marketing_2026P',
  'Product & Engineering_2026P', 'General & Administrative_2026P',
]

function badge(color: string, bg: string, text: string) {
  return (
    <span style={{
      fontSize: '0.68rem', background: bg, color, borderRadius: 4,
      padding: '0.1rem 0.45rem', fontWeight: 600, flexShrink: 0,
    }}>{text}</span>
  )
}

export default function FinancialsDataSync() {
  const [status, setStatus] = useState<Record<Statement, SyncStatus>>({ pnl: null, bs: null, cf: null })
  const [syncing, setSyncing] = useState<Record<Statement | 'all', boolean>>({ pnl: false, bs: false, cf: false, all: false })
  const [stmtResults, setStmtResults] = useState<Record<Statement, SyncStatementResult | null>>({ pnl: null, bs: null, cf: null })

  const [tabStatus, setTabStatus] = useState<ModelTabStatus[]>([])
  const [tabSyncing, setTabSyncing] = useState(false)
  const [tabResult, setTabResult] = useState<{ synced: number; failed: number } | null>(null)
  /** Set when the HTTP request fails (timeout, network); do not confuse with per-tab failures in tabResult. */
  const [tabSyncRequestError, setTabSyncRequestError] = useState<string | null>(null)
  const [tabDetails, setTabDetails] = useState<Record<string, { ok: boolean; rows?: number; error?: string }>>({})

  const [loadErr, setLoadErr] = useState<string | null>(null)

  const loadAll = () => {
    getSyncStatus()
      .then((s) => setStatus(s as Record<Statement, SyncStatus>))
      .catch((e) => setLoadErr(e.message))
    getModelTabsStatus()
      .then((d) => setTabStatus(d.tabs))
      .catch(() => {})
  }

  useEffect(() => { loadAll() }, [])

  async function handleStmtSync(stmt: Statement | 'all') {
    setSyncing((s) => ({ ...s, [stmt]: true }))
    if (stmt !== 'all') setStmtResults((r) => ({ ...r, [stmt]: null }))
    else setStmtResults({ pnl: null, bs: null, cf: null })
    try {
      const res = await syncFromSheet(stmt)
      if (stmt === 'all') {
        setStmtResults({ pnl: res.results.pnl ?? null, bs: res.results.bs ?? null, cf: res.results.cf ?? null })
      } else {
        setStmtResults((r) => ({ ...r, [stmt]: res.results[stmt] ?? null }))
      }
      loadAll()
    } catch (e) {
      const err: SyncStatementResult = { ok: false, error: (e as Error).message }
      if (stmt === 'all') setStmtResults({ pnl: err, bs: err, cf: err })
      else setStmtResults((r) => ({ ...r, [stmt]: err }))
    } finally {
      setSyncing((s) => ({ ...s, [stmt]: false }))
    }
  }

  async function handleTabSync() {
    setTabSyncing(true)
    setTabResult(null)
    setTabSyncRequestError(null)
    setTabDetails({})
    const controller = new AbortController()
    const timeoutMs = 6 * 60 * 1000
    const tid = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await syncModelTabs(controller.signal)
      setTabResult({ synced: res.synced, failed: res.failed })
      const det: Record<string, { ok: boolean; rows?: number; error?: string }> = {}
      for (const d of res.details) det[d.tab] = { ok: d.ok, rows: d.rows, error: d.error }
      setTabDetails(det)
    } catch (e) {
      const msg =
        e instanceof Error && e.name === 'AbortError'
          ? `Request timed out after ${timeoutMs / 60000} minutes. The server may still be syncing — refresh this page in a moment.`
          : e instanceof Error
            ? e.message
            : 'Sync failed'
      setTabSyncRequestError(msg)
    } finally {
      window.clearTimeout(tid)
      setTabSyncing(false)
      loadAll()
    }
  }

  const tabMap: Record<string, ModelTabStatus> = {}
  for (const t of tabStatus) tabMap[t.tab] = t

  const anySyncing = syncing.all || syncing.pnl || syncing.bs || syncing.cf

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 860 }}>
      <div>
        <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.3rem', fontWeight: 600 }}>Data Sync</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.83rem', margin: 0 }}>
          Sync your Google Sheets financial model into the app. Step 1 loads all tabs as raw context for the agents. Step 2 parses P&L, Balance Sheet, and Cash Flow into structured DB rows for the financial views.
        </p>
      </div>

      {loadErr && <div style={{ color: 'var(--negative)', fontSize: '0.85rem' }}>{loadErr}</div>}

      {/* ── Step 1: Sync all model tabs ─────────────────────────────── */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Step 1 — Sync all model tabs</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
              Reads all {ALL_MODEL_TABS.length} tabs from Google Sheets and stores them for agent context. Run this first.
            </div>
          </div>
          <button
            onClick={handleTabSync}
            disabled={tabSyncing}
            style={{
              padding: '0.5rem 1.25rem', background: tabSyncing ? 'var(--surface-hover)' : 'var(--accent)',
              color: tabSyncing ? 'var(--text-muted)' : 'white', border: 'none', borderRadius: 6,
              fontWeight: 600, fontSize: '0.875rem', cursor: tabSyncing ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {tabSyncing ? 'Syncing tabs…' : 'Sync all model tabs'}
          </button>
        </div>

        {tabSyncRequestError && (
          <div style={{
            fontSize: '0.8rem', padding: '0.4rem 0.85rem', borderRadius: 6, marginBottom: '0.75rem',
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#fecaca',
          }}>
            Sync did not finish: {tabSyncRequestError}
            <span style={{ display: 'block', marginTop: '0.35rem', color: 'var(--text-muted)', fontSize: '0.76rem' }}>
              The cards below show the last saved sync from the server, not this run.
            </span>
          </div>
        )}
        {tabResult && (
          <div style={{
            fontSize: '0.8rem', padding: '0.4rem 0.85rem', borderRadius: 6, marginBottom: '0.75rem',
            background: tabResult.failed === 0 ? 'rgba(34,197,94,0.1)' : 'rgba(234,179,8,0.1)',
            border: `1px solid ${tabResult.failed === 0 ? 'rgba(34,197,94,0.2)' : 'rgba(234,179,8,0.2)'}`,
            color: tabResult.failed === 0 ? '#86efac' : '#fde68a',
          }}>
            {tabResult.failed === 0
              ? `✓ All ${tabResult.synced} tabs synced successfully`
              : `✓ ${tabResult.synced} tabs synced · ${tabResult.failed} failed`}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.4rem' }}>
          {ALL_MODEL_TABS.map((tab) => {
            const s = tabMap[tab]
            const det = tabDetails[tab]
            const isSyncing = tabSyncing
            const synced = det ? det.ok : s?.synced
            const failed = det && !det.ok
            return (
              <div key={tab} style={{
                background: 'var(--surface)', border: `1px solid ${failed ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                borderRadius: 6, padding: '0.45rem 0.7rem',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tab}
                </span>
                <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexShrink: 0 }}>
                  {isSyncing
                    ? badge('#94a3b8', 'rgba(148,163,184,0.1)', '…')
                    : failed
                      ? badge('#f87171', 'rgba(239,68,68,0.12)', 'error')
                      : synced
                        ? badge('#86efac', 'rgba(34,197,94,0.12)', `${det?.rows ?? s?.rows ?? '?'} rows`)
                        : badge('#fde68a', 'rgba(234,179,8,0.12)', 'not synced')}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Step 2: Parse structured statements ─────────────────────── */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Step 2 — Parse financial statements</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
              Uses Claude to extract structured Actual vs Plan rows from P&L, Balance Sheet, and Cash Flow tabs.
            </div>
          </div>
          <button
            onClick={() => handleStmtSync('all')}
            disabled={anySyncing}
            style={{
              padding: '0.5rem 1.25rem', background: anySyncing ? 'var(--surface-hover)' : 'var(--accent-dim)',
              color: anySyncing ? 'var(--text-muted)' : 'white', border: 'none', borderRadius: 6,
              fontWeight: 600, fontSize: '0.875rem', cursor: anySyncing ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {syncing.all ? 'Parsing all…' : 'Parse all statements'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {STATEMENTS.map((stmt) => {
            const s = status[stmt.key]
            const res = stmtResults[stmt.key]
            const isSyncing = syncing[stmt.key] || syncing.all
            const hasSynced = !!s?.synced_at
            return (
              <div key={stmt.key} style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '0.85rem 1.1rem',
                display: 'flex', alignItems: 'center', gap: '1rem',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{stmt.label}</span>
                    {hasSynced
                      ? badge('#86efac', 'rgba(34,197,94,0.12)', 'Synced')
                      : badge('#fde68a', 'rgba(234,179,8,0.12)', 'No data')}
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                    Actuals: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{stmt.actuals}</span>
                    &nbsp;·&nbsp;
                    Plan: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{stmt.plan}</span>
                    {hasSynced && ` · Last parsed ${new Date(s!.synced_at!).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`}
                    {s?.rows_synced != null && ` · ${s.rows_synced} rows`}
                  </div>
                  {res && (
                    <div style={{
                      marginTop: '0.4rem', fontSize: '0.77rem', padding: '0.3rem 0.6rem', borderRadius: 5,
                      background: res.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                      color: res.ok ? '#86efac' : 'var(--negative)',
                    }}>
                      {res.ok
                        ? `✓ ${res.rows_synced} rows across ${res.periods_synced} periods`
                        : `Error: ${res.error}`}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleStmtSync(stmt.key)}
                  disabled={isSyncing}
                  style={{
                    padding: '0.35rem 0.85rem', background: isSyncing ? 'var(--surface-hover)' : 'var(--surface)',
                    color: isSyncing ? 'var(--text-muted)' : 'var(--text)', border: '1px solid var(--border)',
                    borderRadius: 6, fontWeight: 500, fontSize: '0.8rem',
                    cursor: isSyncing ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  {isSyncing ? 'Parsing…' : 'Parse'}
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <div style={{ padding: '0.9rem 1.1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{ fontWeight: 600, fontSize: '0.82rem', marginBottom: '0.4rem', color: 'var(--text-muted)' }}>Recommended workflow</div>
        <ol style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.9 }}>
          <li>Click <strong>Sync all model tabs</strong> — reads all sheets and makes them available to agents (fast)</li>
          <li>Click <strong>Parse all statements</strong> — uses Claude to extract structured P&L, BS, CF rows (slower, ~1 min)</li>
          <li>Repeat after each monthly close to keep everything current</li>
        </ol>
      </div>
    </div>
  )
}
