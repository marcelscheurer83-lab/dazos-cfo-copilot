import { useState, FormEvent } from 'react'
import { checkAppPassword } from './api'

type Props = { onSuccess: () => void }

export default function Login({ onSuccess }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!password.trim()) {
      setError('Enter the app password.')
      return
    }
    setLoading(true)
    try {
      const ok = await checkAppPassword(password.trim())
      if (ok) {
        sessionStorage.setItem('app_password', password.trim())
        onSuccess()
      } else {
        setError('Invalid password.')
      }
    } catch {
      setError('Could not reach the server. Try again.')
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
          <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>CFO Copilot</div>
        </div>
        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            App password
          </label>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            Leave blank if no password is configured.
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
