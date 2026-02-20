import { useState, useRef, useEffect } from 'react'
import { askCopilot } from '../api'

type Message = { role: 'user' | 'assistant'; text: string; sources?: string[] }

export default function Copilot() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const q = input.trim()
    if (!q || loading) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: q }])
    setLoading(true)
    try {
      const res = await askCopilot(q)
      setMessages((m) => [...m, { role: 'assistant', text: res.answer, sources: res.sources }])
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: `Error: ${(e as Error).message}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600 }}>Copilot</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', maxWidth: 560 }}>
        I only answer <strong>CARR-related questions</strong> (contracted ARR). You can ask about current data or past dates (e.g. &ldquo;Total CARR as of March 2025&rdquo; or &ldquo;Largest customer last month&rdquo;) when EOD snapshots exist.
      </p>
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          maxWidth: 720,
          minHeight: 400,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
          {messages.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              Try: &ldquo;What&rsquo;s our total CARR?&rdquo; or &ldquo;What&rsquo;s our largest customer?&rdquo; or &ldquo;What CARR is up for renewal in March &rsquo;26?&rdquo;
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                marginBottom: '1rem',
                padding: msg.role === 'user' ? '0.5rem 0' : '0.75rem',
                background: msg.role === 'assistant' ? 'var(--surface-hover)' : 'transparent',
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                {msg.role === 'user' ? 'You' : 'Copilot'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text.replace(/\*\*(.*?)\*\*/g, '$1')}</div>
              {msg.sources && msg.sources.length > 0 && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                  Sources: {msg.sources.join(', ')}
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              Thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
          style={{ padding: '1rem', borderTop: '1px solid var(--border)' }}
        >
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question…"
              disabled={loading}
              style={{
                flex: 1,
                padding: '0.6rem 1rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontFamily: 'inherit',
                fontSize: '0.95rem',
              }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              style={{
                padding: '0.6rem 1.25rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !input.trim() ? 0.6 : 1,
              }}
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
