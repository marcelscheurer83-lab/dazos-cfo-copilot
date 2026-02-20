import { Component, type ReactNode, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './Layout'
import Login from './Login'
import Dashboard from './views/Dashboard'
import ARR from './views/ARR'
import Copilot from './views/Copilot'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; key: number }> {
  state = { error: null as Error | null, key: 0 }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', maxWidth: 600, color: 'var(--text)' }}>
          <h2 style={{ color: 'var(--negative)', marginTop: 0 }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-muted)' }}>{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null, key: this.state.key + 1 })}
            style={{
              padding: '0.5rem 1rem',
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )
    }
    return <div key={this.state.key}>{this.props.children}</div>
  }
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(
    () => sessionStorage.getItem('app_password') !== null
  )

  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />
  }

  return (
    <ErrorBoundary>
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="customer-overview" element={<ARR />} />
        <Route path="arr" element={<Navigate to="/customer-overview" replace />} />
        <Route path="copilot" element={<Copilot />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </ErrorBoundary>
  )
}
