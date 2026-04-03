import { useEffect, useState } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'

type NavLinkItem = { to: string; label: string }
type NavSection = { label: string; children: NavLinkItem[] }
type NavItem = NavLinkItem | NavSection

function isSection(item: NavItem): item is NavSection {
  return 'children' in item && Array.isArray((item as NavSection).children)
}

const nav: NavItem[] = [
  {
    label: 'Dashboard',
    children: [
      { to: '/dashboard/current-overview', label: 'Current Overview' },
      { to: '/dashboard/q2-2026', label: 'Q2 2026' },
      { to: '/dashboard/q1-2026', label: 'Q1 2026' },
    ],
  },
  {
    label: 'Go-To-Market',
    children: [
      { to: '/bookings', label: 'Bookings' },
      { to: '/renewals', label: 'Renewals' },
      { to: '/pipeline-overview', label: 'Pipeline' },
    ],
  },
  {
    label: 'ARR',
    children: [
      { to: '/arr-schedule/new-schedule', label: 'Schedule' },
    ],
  },
  {
    label: 'Analyses',
    children: [
      { to: '/analytics', label: 'Product penetration' },
      { to: '/analytics/crm-seats', label: 'CRM seat pricing' },
    ],
  },
  {
    label: 'Exports',
    children: [
      { to: '/products-purchased', label: 'Products purchased' },
    ],
  },
  { to: '/financials', label: 'Financials' },
  { to: '/admin', label: 'Admin' },
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

const GTM_PATHS = ['/bookings', '/renewals', '/pipeline-overview']
const ARR_SCHEDULE_PATHS = ['/arr-schedule/new-schedule']
const EXPORTS_PATHS = ['/products-purchased', '/customer-overview']
const ANALYTICS_PATHS = ['/analytics', '/analytics/crm-seats']

export default function Layout() {
  const location = useLocation()
  const [dashboardExpanded, setDashboardExpanded] = useState(true)
  const [gtmExpanded, setGtmExpanded] = useState(true)
  const [arrScheduleExpanded, setArrScheduleExpanded] = useState(true)
  const [exportsExpanded, setExportsExpanded] = useState(true)
  const [analyticsExpanded, setAnalyticsExpanded] = useState(true)

  useEffect(() => {
    if (GTM_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))) {
      setGtmExpanded(true)
    }
  }, [location.pathname])
  useEffect(() => {
    if (ARR_SCHEDULE_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))) {
      setArrScheduleExpanded(true)
    }
  }, [location.pathname])
  useEffect(() => {
    if (EXPORTS_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))) {
      setExportsExpanded(true)
    }
  }, [location.pathname])
  useEffect(() => {
    if (ANALYTICS_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(p + '/'))) {
      setAnalyticsExpanded(true)
    }
  }, [location.pathname])

  return (
    <div style={{ display: 'flex', minHeight: '100vh', zoom: 0.8 }}>
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
              const isExpanded =
                item.label === 'Dashboard'
                  ? dashboardExpanded
                  : item.label === 'Go-To-Market'
                  ? gtmExpanded
                  : item.label === 'ARR'
                    ? arrScheduleExpanded
                    : item.label === 'Exports'
                      ? exportsExpanded
                    : item.label === 'Analyses'
                      ? analyticsExpanded
                      : true
              const setExpanded =
                item.label === 'Dashboard'
                  ? (v: boolean) => setDashboardExpanded(v)
                  : item.label === 'Go-To-Market'
                  ? (v: boolean) => setGtmExpanded(v)
                  : item.label === 'ARR'
                    ? (v: boolean) => setArrScheduleExpanded(v)
                    : item.label === 'Exports'
                      ? (v: boolean) => setExportsExpanded(v)
                      : item.label === 'Analyses'
                      ? (v: boolean) => setAnalyticsExpanded(v)
                      : () => {}
              return (
                <div key={idx} style={{ marginBottom: '0.25rem' }}>
                  <button
                    type="button"
                    onClick={() => setExpanded(!isExpanded)}
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
