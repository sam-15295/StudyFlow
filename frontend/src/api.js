// Thin fetch wrapper for the StudyFlow API.
// Dev: '/api' is proxied to Express by vite.config.js. Production: set VITE_API_URL at build time.
// Auth is an httpOnly cookie, so requests must include credentials and nothing is stored client-side.
const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(method, path, body) {
  let res
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Cannot reach the server. Is the backend running?', 0)
  }

  let data = null
  try {
    data = await res.json()
  } catch {
    // empty or non-JSON body
  }

  if (!res.ok) {
    // A 401 on a data request means the session expired: let the app send the user to login.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('auth:expired'))
    }
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status)
  }
  return data
}

export const signup = (email, password) => request('POST', '/auth/signup', { email, password })
export const login = (email, password) => request('POST', '/auth/login', { email, password })
export const logout = () => request('POST', '/auth/logout')
export const me = () => request('GET', '/auth/me')

export const listPlans = () => request('GET', '/plans')
export const createPlan = (plan) => request('POST', '/plans', plan)
export const getPlan = (id) => request('GET', `/plans/${id}`)
export const deletePlan = (id) => request('DELETE', `/plans/${id}`)

export const extractTopics = (id) => request('POST', `/plans/${id}/extract`)
export const estimateTopics = (id) => request('POST', `/plans/${id}/estimate`)
export const generateSchedule = (id) => request('POST', `/plans/${id}/generate`)
export const setTopicStatus = (planId, topicId, status) =>
  request('PATCH', `/plans/${planId}/topics/${topicId}/status`, { status })
