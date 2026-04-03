import { useState, FormEvent } from 'react'
import { checkAppPassword, checkBackendHealthDetailed } from './api'

type Props = { onSuccess: () => void }

const SERVER_UNREACHABLE_INTRO =
  'Backend not reachable. Open this app from http://localhost:5173 (same URL as the dev server). Ensure exactly one backend is running on port 8008 (see backend/start-backend.ps1).'

export default function Login({ onSuccess }: Props) {
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
        setLoading(false)
        return
      }
      const ok = await checkAppPassword(password.trim())
      if (ok) {
        sessionStorage.setItem('app_password', password.trim())
        onSuccess()
      } else {
        setError('Invalid password.')
      }
    } catch {
      setError(SERVER_UNREACHABLE_INTRO)
    } finally {
      setLoading(false)
    }
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
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>Dazos</div>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>CFO Cockpit</div>
        </div>
        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            App password
          </label>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            Set APP_PASSWORD in backend/.env; enter it here to sign in.
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={loading}
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '0.6rem 0.75rem',
              marginBottom: '1rem',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              fontSize: '1rem',
            }}
          />
          {error && (
            <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: 'var(--negative)' }}>{error}</div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.6rem 1rem',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              color: 'white',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
