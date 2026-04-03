import { Component, type ReactNode, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './Layout'
import Login from './Login'
import Dashboard from './views/Dashboard'
import DashboardCurrentSummary from './views/DashboardCurrentSummary'
import ARR from './views/ARR'
import ARRScheduleActiveArr from './views/ARRScheduleActiveArr'
import ARRNewSchedule from './views/ARRNewSchedule'
import Analytics from './views/Analytics'
import AnalyticsCRMSeats from './views/AnalyticsCRMSeats'
import Pipeline from './views/Pipeline'
import Closed from './views/Closed'
import Renewals from './views/Renewals'
import Placeholder from './views/Placeholder'
import Admin from './views/Admin'

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
        <Route path="dashboard" element={<Dashboard />}>
          <Route index element={<Navigate to="current-overview" replace />} />
          <Route path="current-overview" element={<DashboardCurrentSummary />} />
          <Route path="current-summary" element={<Navigate to="/dashboard/current-overview" replace />} />
          <Route path="q1-2026" element={<DashboardCurrentSummary title="Q1 2026" />} />
          <Route path="q2-2026" element={<DashboardCurrentSummary title="Q2 2026" />} />
        </Route>
        <Route path="bookings" element={<Closed />} />
        <Route path="renewals" element={<Renewals />} />
        <Route path="pipeline-overview" element={<Pipeline />} />
        <Route path="products-purchased" element={<ARR />} />
        <Route path="customer-overview" element={<Navigate to="/products-purchased" replace />} />
        <Route path="arr-schedule/active-arr" element={<ARRScheduleActiveArr />} />
        <Route path="arr-schedule/new-schedule" element={<ARRNewSchedule />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="analytics/crm-seats" element={<AnalyticsCRMSeats />} />
        <Route path="arr" element={<Navigate to="/products-purchased" replace />} />
        <Route path="closed-data" element={<Navigate to="/bookings" replace />} />
        <Route path="financials" element={<Placeholder title="Financials" />} />
        <Route path="admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </ErrorBoundary>
  )
}
