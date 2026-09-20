import { useState } from 'react'
import * as api from '../api.js'
import { navigate } from '../router.js'
import Button from '../components/Button.jsx'
import Card from '../components/Card.jsx'
import Input from '../components/Input.jsx'

// One combined login / signup form with a toggle.
export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const isSignup = mode === 'signup'

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { user } = await (isSignup ? api.signup : api.login)(email, password)
      navigate('/')
      onAuth(user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-wrap">
      <Card className="auth-card">
        <h1 className="brand-title">StudyFlow</h1>
        <p className="muted">{isSignup ? 'Create an account to plan your exam prep.' : 'Log in to your study plans.'}</p>
        <form onSubmit={handleSubmit}>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            required
            minLength={isSignup ? 8 : undefined}
            hint={isSignup ? 'At least 8 characters.' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="error" role="alert">{error}</p>}
          <Button type="submit" className="full" disabled={loading}>
            {loading ? 'Please wait…' : isSignup ? 'Sign up' : 'Log in'}
          </Button>
        </form>
        <p className="muted toggle-line">
          {isSignup ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(isSignup ? 'login' : 'signup')
              setError('')
            }}
          >
            {isSignup ? 'Log in' : 'Sign up'}
          </button>
        </p>
      </Card>
    </div>
  )
}
