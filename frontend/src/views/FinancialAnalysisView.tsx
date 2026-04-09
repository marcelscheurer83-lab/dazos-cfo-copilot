import { useEffect, useState } from 'react'
import { getFinancialAnalyses, triggerMonthlyClose, type FinancialAnalysis } from '../api'

function fmtPeriod(s: string) {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    done: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
    running: { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
    error: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    pending: { bg: 'rgba(148,163,184,0.1)', text: 'var(--text-muted)' },
  }
  const c = colors[status] ?? colors.pending
  return (
    <span style={{
      background: c.bg, color: c.text, borderRadius: 4,
      padding: '0.15rem 0.5rem', fontSize: '0.72rem', fontWeight: 600, textTransform: 'capitalize',
    }}>
      {status}
    </span>
  )
}

function MarkdownSection({ title, content }: { title: string; content: string | null }) {
  if (!content) return null
  const paras = content.split('\n').filter((l) => l.trim())
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{title}</h3>
      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '1.25rem 1.5rem',
          fontSize: '0.875rem', lineHeight: 1.7, color: 'var(--text)',
        }}
      >
        {paras.map((para, i) => {
          if (para.startsWith('- ') || para.startsWith('• ')) {
            return (
              <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem' }}>
                <span style={{ color: 'var(--accent)', flexShrink: 0 }}>•</span>
                <span>{para.replace(/^[-•]\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')}</span>
              </div>
            )
          }
          if (para.startsWith('###') || para.startsWith('##')) {
            return <p key={i} style={{ fontWeight: 600, margin: '0.75rem 0 0.25rem', color: 'var(--text-muted)' }}>{para.replace(/^#+\s*/, '')}</p>
          }
          return <p key={i} style={{ margin: '0 0 0.6rem' }}>{para.replace(/\*\*(.*?)\*\*/g, '$1')}</p>
        })}
      </div>
    </div>
  )
}

export default function FinancialAnalysisView() {
  const [analyses, setAnalyses] = useState<FinancialAnalysis[]>([])
  const [selected, setSelected] = useState<FinancialAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [triggerPeriod, setTriggerPeriod] = useState('')
  const [triggering, setTriggering] = useState(false)
  const [triggerMsg, setTriggerMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const load = () => {
    setLoading(true)
    getFinancialAnalyses()
      .then((a) => {
        setAnalyses(a)
        if (a.length > 0) setSelected(a[0])
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function handleTrigger() {
    if (!triggerPeriod) return
    setTriggering(true)
    setTriggerMsg(null)
    try {
      await triggerMonthlyClose(triggerPeriod)
      setTriggerMsg({ type: 'ok', text: `Analysis for ${fmtPeriod(triggerPeriod)} generated successfully.` })
      load()
    } catch (e) {
      setTriggerMsg({ type: 'err', text: (e as Error).message })
    } finally {
      setTriggering(false)
    }
  }

  return (
    <>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>Monthly Close Analysis</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
        AI-generated variance analysis by the FP&A Agent — P&L, cash flow, balance sheet, and exec summary.
      </p>

      {/* Trigger panel */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '1rem 1.25rem', marginBottom: '1.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-muted)', flexShrink: 0 }}>
          Run close analysis for:
        </span>
        <input
          type="month"
          value={triggerPeriod.slice(0, 7)}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-')
            if (!y || !m) return
            const lastDay = new Date(+y, +m, 0).getDate()
            setTriggerPeriod(`${y}-${m}-${String(lastDay).padStart(2, '0')}`)
          }}
          style={{
            padding: '0.4rem 0.75rem', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text)', fontFamily: 'inherit', fontSize: '0.875rem',
          }}
        />
        <button
          onClick={handleTrigger}
          disabled={!triggerPeriod || triggering}
          style={{
            padding: '0.4rem 1rem', background: 'var(--accent)', color: 'white',
            border: 'none', borderRadius: 6, fontWeight: 600, cursor: triggering || !triggerPeriod ? 'not-allowed' : 'pointer',
            opacity: triggering || !triggerPeriod ? 0.6 : 1, fontSize: '0.875rem',
          }}
        >
          {triggering ? 'Running…' : 'Run Analysis'}
        </button>
        {triggerMsg && (
          <span style={{ fontSize: '0.82rem', color: triggerMsg.type === 'ok' ? '#22c55e' : 'var(--negative)' }}>
            {triggerMsg.text}
          </span>
        )}
      </div>

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
      {err && <p style={{ color: 'var(--negative)' }}>{err}</p>}

      {!loading && analyses.length === 0 && !err && (
        <p style={{ color: 'var(--text-muted)' }}>No analyses yet. Pick a month above and click Run Analysis.</p>
      )}

      {analyses.length > 0 && (
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
          {/* Sidebar */}
          <div style={{ width: 200, flexShrink: 0 }}>
            <p style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', margin: '0 0 0.5rem' }}>
              Close periods
            </p>
            {analyses.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelected(a)}
                style={{
                  display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.5rem 0.75rem', borderRadius: 6, border: 'none', cursor: 'pointer', marginBottom: '0.25rem',
                  background: selected?.id === a.id ? 'var(--surface-hover, rgba(255,255,255,0.08))' : 'transparent',
                  color: selected?.id === a.id ? 'var(--text)' : 'var(--text-muted)',
                  textAlign: 'left', fontSize: '0.875rem', fontWeight: selected?.id === a.id ? 600 : 400,
                }}
              >
                <span>{fmtPeriod(a.period_end)}</span>
                <StatusBadge status={a.status} />
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                  <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>{fmtPeriod(selected.period_end)}</h2>
                  <StatusBadge status={selected.status} />
                  {selected.generated_at && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Generated {new Date(selected.generated_at).toLocaleString()}
                    </span>
                  )}
                </div>

                {selected.status === 'error' && (
                  <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--negative)' }}>
                    Analysis failed. Check that your ANTHROPIC_API_KEY is set in backend/.env and financial data is loaded.
                  </div>
                )}

                {selected.status === 'running' && (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                    Analysis is running… refresh in a few seconds.
                  </div>
                )}

                {selected.status === 'done' && (
                  <>
                    <MarkdownSection title="Executive Summary" content={selected.executive_summary} />
                    <MarkdownSection title="P&L Analysis" content={selected.pnl_analysis} />
                    <MarkdownSection title="Cash Flow Analysis" content={selected.cashflow_analysis} />
                    <MarkdownSection title="Balance Sheet Analysis" content={selected.balance_sheet_analysis} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
