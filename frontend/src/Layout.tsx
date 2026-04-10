import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { useJobs } from './App'

type NavLinkItem = { to: string; label: string }
type NavSection = { label: string; children: NavLinkItem[] }
type NavItem = NavLinkItem | NavSection

function isSection(item: NavItem): item is NavSection {
  return 'children' in item && Array.isArray((item as NavSection).children)
}

const nav: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/go-to-market', label: 'Go-To-Market' },
  { to: '/arr', label: 'ARR' },
  { to: '/analyses', label: 'Analyses' },
  { to: '/financials', label: 'Financials' },
]

const topLevelFontSize = '0.875rem'
const subLevelFontSize = '0.8rem'

const topLevelStyle = (isActive: boolean) => ({
  display: 'block' as const,
  padding: '0.6rem 1.25rem',
  fontSize: topLevelFontSize,
  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
  fontWeight: isActive ? 600 : 400,
  borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
  marginLeft: 0,
  textDecoration: 'none' as const,
})

const subLinkStyle = (isActive: boolean) => ({
  ...topLevelStyle(isActive),
  paddingLeft: '1.75rem',
  fontSize: subLevelFontSize,
})

export default function Layout() {
  const location = useLocation()
  const { runningJobs } = useJobs()
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
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>CFO Cockpit</div>
        </div>
        <nav style={{ flex: 1 }}>
          {nav.map((item, idx) => {
            if (isSection(item)) {
              const isSectionActive = item.children.some((c) =>
                location.pathname === c.to || (c.to !== '/dashboard' && location.pathname.startsWith(c.to + '/'))
              )
              const isExpanded = true
              return (
                <div key={idx} style={{ marginBottom: '0.25rem' }}>
                  <button
                    type="button"
                    onClick={() => {}}
                    style={{
                      width: '100%',
                      padding: '0.6rem 1.25rem',
                      fontSize: topLevelFontSize,
                      fontWeight: isSectionActive ? 600 : 400,
                      color: isSectionActive ? 'var(--accent)' : 'var(--text-muted)',
                      borderLeft: '3px solid transparent',
                      marginLeft: 0,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                    }}
                  >
                    <span style={{ fontSize: '0.65rem', lineHeight: 1 }}>{isExpanded ? '▼' : '▶'}</span>
                    {item.label}
                  </button>
                  {isExpanded &&
                    item.children.map((child) => (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        end
                        style={({ isActive }) => subLinkStyle(isActive)}
                      >
                        {child.label}
                      </NavLink>
                    ))}
                </div>
              )
            }
            return (
              <NavLink key={item.to} to={item.to} style={({ isActive }) => topLevelStyle(isActive)}>
                {item.label}
              </NavLink>
            )
          })}
        </nav>
        <div style={{ marginTop: 'auto', padding: '1rem 1.25rem', borderTop: '1px solid var(--border)' }}>
          {runningJobs.length > 0 && (
            <div style={{
              marginBottom: '0.75rem',
              padding: '0.5rem 0.65rem',
              borderRadius: 6,
              background: 'rgba(56,189,248,0.08)',
              border: '1px solid rgba(56,189,248,0.2)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}>
              <span style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#38bdf8',
                flexShrink: 0,
                animation: 'pulse 1.4s ease-in-out infinite',
              }} />
              <span style={{ fontSize: '0.72rem', color: '#38bdf8', lineHeight: 1.3 }}>
                {runningJobs.map((j) => j.label).join(', ')} in progress…
              </span>
            </div>
          )}
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
