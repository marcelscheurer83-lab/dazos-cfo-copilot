import { useState, useRef, useEffect } from 'react'
import { fpaChat, getModelMap, scanFinancialModel, type FPAChatMessage, type ModelMap } from '../api'

type Message = { role: 'user' | 'assistant'; content: string }

const SUGGESTIONS = [
  'What is our current burn multiple?',
  'How does March gross margin compare to plan?',
  'What is our runway at current burn?',
  'Summarize YTD P&L performance vs plan.',
  'What is our LTV:CAC ratio?',
  'Which opex line is most over plan YTD?',
]

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'
  const paras = msg.content.split('\n').filter((l) => l.trim())

  return (
    <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: isUser ? '0.6rem 1rem' : '0.85rem 1.1rem',
          background: isUser ? 'var(--accent)' : 'var(--surface)',
          border: isUser ? 'none' : '1px solid var(--border)',
          borderRadius: isUser ? '12px 12px 2px 12px' : '2px 12px 12px 12px',
          fontSize: '0.875rem',
          lineHeight: 1.65,
          color: isUser ? 'white' : 'var(--text)',
        }}
      >
        {!isUser && (
          <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '0.4rem' }}>
            FP&A Agent
          </div>
        )}
        {paras.map((para, i) => {
          if (para.startsWith('- ') || para.startsWith('• ')) {
            return (
              <div key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.25rem' }}>
                <span style={{ color: isUser ? 'rgba(255,255,255,0.7)' : 'var(--accent)', flexShrink: 0 }}>•</span>
                <span>{para.replace(/^[-•]\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')}</span>
              </div>
            )
          }
          if (para.startsWith('|')) {
            return (
              <pre key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', overflowX: 'auto', margin: '0.5rem 0', lineHeight: 1.5 }}>
                {para}
              </pre>
            )
          }
          if (para.startsWith('#')) {
            const level = (para.match(/^#+/) ?? [''])[0].length
            const text = para.replace(/^#+\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')
            return (
              <p key={i} style={{ fontWeight: 600, fontSize: level === 1 ? '1rem' : '0.9rem', margin: '0.6rem 0 0.2rem', color: 'var(--text)' }}>
                {text}
              </p>
            )
          }
          return (
            <p key={i} style={{ margin: i === paras.length - 1 ? 0 : '0 0 0.4rem' }}>
              {para.replace(/\*\*(.*?)\*\*/g, '$1')}
            </p>
          )
        })}
      </div>
    </div>
  )
}

export default function FPAChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [modelMap, setModelMap] = useState<ModelMap | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    getModelMap().then(setModelMap).catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleScan() {
    setScanning(true)
    setScanMsg(null)
    try {
      const res = await scanFinancialModel()
      setScanMsg(`✓ Scanned ${res.tabs_scanned} tabs — agent now knows your model structure.`)
      const updated = await getModelMap()
      setModelMap(updated)
    } catch (e) {
      setScanMsg(`Error: ${(e as Error).message}`)
    } finally {
      setScanning(false)
    }
  }

  async function send(text?: string) {
    const q = (text ?? input).trim()
    if (!q || loading) return
    setInput('')
    setErr(null)
    const newMessages: Message[] = [...messages, { role: 'user', content: q }]
    setMessages(newMessages)
    setLoading(true)
    try {
      const apiMessages: FPAChatMessage[] = newMessages.map((m) => ({ role: m.role, content: m.content }))
      const res = await fpaChat(apiMessages)
      setMessages([...newMessages, { role: 'assistant', content: res.answer }])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)', minHeight: 500 }}>
      <div style={{ marginBottom: '1rem', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem', fontWeight: 600 }}>FP&A Agent</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
              Powered by Claude · Full access to your financial model, ARR, pipeline, and historical analyses.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            <button
              onClick={handleScan}
              disabled={scanning}
              title="Scan your Google Sheet model so the agent understands its structure"
              style={{
                padding: '0.4rem 0.9rem', background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-muted)', fontSize: '0.8rem', cursor: scanning ? 'not-allowed' : 'pointer',
                opacity: scanning ? 0.6 : 1, whiteSpace: 'nowrap',
              }}
            >
              {scanning ? 'Scanning…' : '🔍 Scan model'}
            </button>
          </div>
        </div>

        {/* Model map status bar */}
        <div style={{
          marginTop: '0.6rem', padding: '0.5rem 0.85rem',
          background: modelMap?.map ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.08)',
          border: `1px solid ${modelMap?.map ? 'rgba(34,197,94,0.2)' : 'rgba(234,179,8,0.2)'}`,
          borderRadius: 6, fontSize: '0.78rem',
          color: modelMap?.map ? '#86efac' : '#fde68a',
          display: 'flex', alignItems: 'center', gap: '0.5rem',
        }}>
          {modelMap?.map ? (
            <>
              <span>✓ Model map loaded</span>
              <span style={{ opacity: 0.6 }}>·</span>
              <span style={{ opacity: 0.7 }}>
                {modelMap.map.tabs?.length} tabs indexed
                {modelMap.as_of ? ` · last scanned ${new Date(modelMap.as_of).toLocaleString()}` : ''}
              </span>
            </>
          ) : (
            <span>
              ⚠ No model map yet — click <strong>Scan model</strong> to let the agent explore your Google Sheet structure.
              Responses will still work but won't reference specific tabs or cell locations.
            </span>
          )}
          {scanMsg && <span style={{ marginLeft: 'auto', color: scanMsg.startsWith('Error') ? 'var(--negative)' : '#86efac' }}>{scanMsg}</span>}
        </div>
      </div>

      {/* Chat area */}
      <div
        style={{
          flex: 1, overflowY: 'auto', padding: '1rem',
          background: 'var(--bg)', borderRadius: 10,
          border: '1px solid var(--border)', marginBottom: '0.75rem',
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', paddingTop: '2rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📊</div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
              Ask me anything about your financials — P&L, cash flow, burn, runway, unit economics, or pipeline.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center', maxWidth: 600, margin: '0 auto' }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  style={{
                    padding: '0.4rem 0.85rem', background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 20, color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'var(--text)'; (e.target as HTMLElement).style.borderColor = 'var(--accent)' }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'var(--text-muted)'; (e.target as HTMLElement).style.borderColor = 'var(--border)' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '1rem' }}>
            <div style={{ padding: '0.75rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '2px 12px 12px 12px' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '0.4rem' }}>
                FP&A Agent
              </div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)',
                      animation: 'pulse 1.2s ease-in-out infinite',
                      animationDelay: `${i * 0.2}s`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {err && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '0.6rem 0.85rem', marginBottom: '0.75rem', fontSize: '0.82rem', color: 'var(--negative)' }}>
            {err}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <form
        onSubmit={(e) => { e.preventDefault(); send() }}
        style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your financials… (Enter to send, Shift+Enter for new line)"
          disabled={loading}
          rows={2}
          style={{
            flex: 1, padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 8, color: 'var(--text)', fontFamily: 'inherit', fontSize: '0.9rem',
            resize: 'none', lineHeight: 1.5,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: '0 1.25rem', background: 'var(--accent)', color: 'white',
            border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem',
            cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            opacity: loading || !input.trim() ? 0.6 : 1, flexShrink: 0,
          }}
        >
          Send
        </button>
      </form>

      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
