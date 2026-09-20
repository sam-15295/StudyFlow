// A tiny hash router (#/, #/new, #/plan/:id). With only four pages a routing library isn't needed,
// and hash URLs work on any static host without server rewrite rules.
import { useEffect, useState } from 'react'

function parse(hash) {
  const path = hash.replace(/^#/, '') || '/'
  const plan = path.match(/^\/plan\/([^/]+)$/)
  if (plan) return { name: 'plan', id: plan[1] }
  if (path === '/new') return { name: 'new' }
  return { name: 'dashboard' }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function navigate(path) {
  window.location.hash = path
}
