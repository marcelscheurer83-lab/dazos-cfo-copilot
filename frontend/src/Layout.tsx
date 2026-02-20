import { Outlet, NavLink } from 'react-router-dom'

const nav = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/customer-overview', label: 'Customer overview' },
  { to: '/copilot', label: 'Copilot' },
]

export default function Layout() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 220,
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
          padding: '1.5rem 0',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '0 1.25rem 1.25rem', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>Dazos</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>CFO Copilot</div>
        </div>
        <nav style={{ flex: 1 }}>
          {nav.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              style={({ isActive }) => ({
                display: 'block',
                padding: '0.6rem 1.25rem',
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: isActive ? 600 : 400,
                borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                marginLeft: 0,
              })}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '1rem 1.25rem', borderTop: '1px solid var(--border)' }}>
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem('app_password')
              window.location.reload()
            }}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              fontSize: '0.875rem',
              color: 'var(--text-muted)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, padding: '2rem', overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  )
}
