import { NavLink, Outlet } from 'react-router-dom'

const tabs = [
  { to: '/financials/analysis', label: 'Monthly Close' },
  { to: '/financials/pnl', label: 'P&L' },
  { to: '/financials/cash-flow', label: 'Cash Flow' },
  { to: '/financials/balance-sheet', label: 'Balance Sheet' },
  { to: '/financials/fpa-chat', label: 'FP&A Agent' },
  { to: '/financials/data-sync', label: 'Data Sync' },
]

export default function FinancialsLayout() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          gap: '0.25rem',
          borderBottom: '1px solid var(--border)',
          marginBottom: '1.75rem',
          paddingBottom: 0,
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            style={({ isActive }) => ({
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              marginBottom: -1,
              transition: 'color 0.15s',
            })}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Outlet />
      </div>
    </div>
  )
}
