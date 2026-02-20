import { useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './Layout'
import Login from './Login'
import Dashboard from './views/Dashboard'
import ARR from './views/ARR'
import Copilot from './views/Copilot'

export default function App() {
  const [authenticated, setAuthenticated] = useState(
    () => sessionStorage.getItem('app_password') !== null
  )

  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />
  }

  return (
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
  )
}
