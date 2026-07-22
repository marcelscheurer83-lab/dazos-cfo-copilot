import { useState, FormEvent } from 'react'
import { loginWithEmail, checkBackendHealthDetailed } from './api'

type Props = { onSuccess: () => void }

const IS_DEV = import.meta.env.DEV
const SERVER_UNREACHABLE_INTRO = IS_DEV
  ? 'Backend not reachable. Open this app from http://localhost:5173 (same URL as the dev server). Ensure exactly one backend is running on port 8008 (see backend/start-backend.ps1).'
  : 'Backend not reachable. In Railway, set the VITE_API_URL environment variable on the frontend service to the backend service URL (e.g. https://your-backend.railway.app).'

export default function Login({ onSuccess }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const health = await checkBackendHealthDetailed()
      if (!health.ok) {
        setError(`${SERVER_UNREACHABLE_INTRO} — ${health.reason}`)
        return
      }
      const result = await loginWithEmail(email.trim(), password)
      if (result.ok) {
        onSuccess()
      } else {
        setError(result.error)
      }
    } catch {
      setError(SERVER_UNREACHABLE_INTRO)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.6rem 0.75rem',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text)',
    fontSize: '1rem',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '0.35rem',
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
    fontWeight: 500,
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          padding: '2rem',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <div style={{ marginBottom: '1.75rem' }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text)' }}>Dazos</div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>CFO Cockpit</div>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              disabled={loading}
              autoComplete="email"
              placeholder="you@dazos.com"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              autoComplete="current-password"
              style={inputStyle}
            />
          </div>
          {error && (
            <div style={{ fontSize: '0.8rem', color: 'var(--negative)', lineHeight: 1.4 }}>{error}</div>
          )}
          <button
            type="submit"
            disabled={loading || !email.trim() || !password}
            style={{
              marginTop: '0.25rem',
              width: '100%',
              padding: '0.65rem 1rem',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              color: 'white',
              fontWeight: 600,
              fontSize: '0.95rem',
              cursor: loading || !email.trim() || !password ? 'not-allowed' : 'pointer',
              opacity: loading || !email.trim() || !password ? 0.7 : 1,
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
