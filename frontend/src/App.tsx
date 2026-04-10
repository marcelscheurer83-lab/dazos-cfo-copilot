import { Component, createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { getActiveJobs, type ActiveJob } from './api'
import Layout from './Layout'
import Login from './Login'
import DashboardLayout from './views/DashboardLayout'
import GoToMarketLayout from './views/GoToMarketLayout'
import DashboardCurrentSummary from './views/DashboardCurrentSummary'
import ARRNewSchedule from './views/ARRNewSchedule'
import ARRCohortChurn from './views/ARRCohortChurn'
import ARRBridge from './views/ARRBridge'
import ForecastView from './views/ForecastView'
import Analytics from './views/Analytics'
import AnalyticsCRMSeats from './views/AnalyticsCRMSeats'
import ChurnAnalysis from './views/ChurnAnalysis'
import Pipeline from './views/Pipeline'
import Closed from './views/Closed'
import Renewals from './views/Renewals'
import ARRLayout from './views/ARRLayout'
import AnalysesLayout from './views/AnalysesLayout'
import FinancialsLayout from './views/FinancialsLayout'
import PnL from './views/PnL'
import CashFlow from './views/CashFlow'
import BalanceSheet from './views/BalanceSheet'
import FinancialAnalysisView from './views/FinancialAnalysisView'
import FPAChat from './views/FPAChat'
import FinancialsDataSync from './views/FinancialsDataSync'

// ── Global background-jobs context ───────────────────────────────────────────
interface JobsContextValue {
  jobs: ActiveJob[]
  runningJobs: ActiveJob[]
}
export const JobsContext = createContext<JobsContextValue>({ jobs: [], runningJobs: [] })
export const useJobs = () => useContext(JobsContext)

function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ActiveJob[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poll = useCallback(async () => {
    try {
      const data = await getActiveJobs()
      setJobs(data.jobs)
    } catch {
      // silently ignore poll errors
    }
  }, [])

  useEffect(() => {
    poll()
    // Poll every 4s when any job is running, otherwise every 15s
    const running = jobs.some((j) => j.status === 'running')
    timerRef.current = setTimeout(poll, running ? 4000 : 15000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [jobs, poll])

  const runningJobs = jobs.filter((j) => j.status === 'running')
  return <JobsContext.Provider value={{ jobs, runningJobs }}>{children}</JobsContext.Provider>
}

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
    <JobsProvider>
    <ErrorBoundary>
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardLayout />}>
          <Route index element={<Navigate to="current-overview" replace />} />
          <Route path="current-overview" element={<DashboardCurrentSummary />} />
          <Route path="current-summary" element={<Navigate to="/dashboard/current-overview" replace />} />
          <Route path="forecast" element={<ForecastView />} />
          <Route path="q1-2026" element={<DashboardCurrentSummary title="Q1 2026" />} />
          <Route path="q2-2026" element={<DashboardCurrentSummary title="Q2 2026" />} />
        </Route>
        <Route path="go-to-market" element={<GoToMarketLayout />}>
          <Route index element={<Navigate to="/go-to-market/bookings" replace />} />
          <Route path="bookings" element={<Closed />} />
          <Route path="renewals" element={<Renewals />} />
          <Route path="pipeline" element={<Pipeline />} />
        </Route>
        {/* Legacy URL redirects */}
        <Route path="go-to-market/forecast" element={<Navigate to="/dashboard/forecast" replace />} />
        <Route path="bookings" element={<Navigate to="/go-to-market/bookings" replace />} />
        <Route path="renewals" element={<Navigate to="/go-to-market/renewals" replace />} />
        <Route path="pipeline-overview" element={<Navigate to="/go-to-market/pipeline" replace />} />
        {/* Legacy deep-links kept working */}
        <Route path="arr-schedule/active-arr" element={<Navigate to="/arr/schedule" replace />} />
        <Route path="arr-schedule/new-schedule" element={<Navigate to="/arr/schedule" replace />} />
        <Route path="arr-schedule/cohort-churn" element={<Navigate to="/arr/cohort-churn" replace />} />
        <Route path="arr-schedule/bridge" element={<Navigate to="/arr/bridge" replace />} />
        <Route path="arr" element={<ARRLayout />}>
          <Route index element={<Navigate to="/arr/bridge" replace />} />
          <Route path="bridge" element={<ARRBridge />} />
          <Route path="cohort-churn" element={<ARRCohortChurn />} />
          <Route path="schedule" element={<ARRNewSchedule />} />
        </Route>
        {/* Legacy deep-links kept working */}
        <Route path="analytics" element={<Navigate to="/analyses/product-penetration" replace />} />
        <Route path="analytics/crm-seats" element={<Navigate to="/analyses/crm-seats" replace />} />
        <Route path="analytics/churn" element={<Navigate to="/analyses/churn" replace />} />
        <Route path="analyses" element={<AnalysesLayout />}>
          <Route index element={<Navigate to="/analyses/product-penetration" replace />} />
          <Route path="product-penetration" element={<Analytics />} />
          <Route path="crm-seats" element={<AnalyticsCRMSeats />} />
          <Route path="churn" element={<ChurnAnalysis />} />
        </Route>
        <Route path="arr" element={<Navigate to="/products-purchased" replace />} />
        <Route path="closed-data" element={<Navigate to="/bookings" replace />} />
        <Route path="financials" element={<FinancialsLayout />}>
          <Route index element={<Navigate to="/financials/analysis" replace />} />
          <Route path="analysis" element={<FinancialAnalysisView />} />
          <Route path="pnl" element={<PnL />} />
          <Route path="cash-flow" element={<CashFlow />} />
          <Route path="balance-sheet" element={<BalanceSheet />} />
          <Route path="fpa-chat" element={<FPAChat />} />
          <Route path="data-sync" element={<FinancialsDataSync />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </ErrorBoundary>
    </JobsProvider>
  )
}
