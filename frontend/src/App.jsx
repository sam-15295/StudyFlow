import { useEffect, useState } from 'react'
import * as api from './api.js'
import { navigate, useRoute } from './router.js'
import Button from './components/Button.jsx'
import AuthPage from './pages/AuthPage.jsx'
import Dashboard from './pages/Dashboard.jsx'
import NewPlan from './pages/NewPlan.jsx'
import PlanView from './pages/PlanView.jsx'

export default function App() {
  const route = useRoute()
  const [user, setUser] = useState(undefined) // undefined = still checking the session, null = logged out

  // Restore the session from the httpOnly cookie; nothing about the user is stored client-side.
  useEffect(() => {
    api
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
  }, [])

  // api.js fires this when a data request comes back 401 (session expired).
  useEffect(() => {
    const onExpired = () => setUser(null)
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])

  async function handleLogout() {
    await api.logout().catch(() => {})
    setUser(null)
    navigate('/')
  }

  if (user === undefined) return <p className="muted centered">Loading…</p>
  if (user === null) return <AuthPage onAuth={setUser} />

  return (
    <>
      <nav className="nav">
        <a className="brand" href="#/">StudyFlow</a>
        <span className="muted nav-email">{user.email}</span>
        <Button variant="secondary" onClick={handleLogout}>Log out</Button>
      </nav>
      <main className="container">
        {route.name === 'new' && <NewPlan />}
        {route.name === 'plan' && <PlanView key={route.id} id={route.id} />}
        {route.name === 'dashboard' && <Dashboard />}
      </main>
    </>
  )
}
