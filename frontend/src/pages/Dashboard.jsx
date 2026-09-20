import { useEffect, useState } from 'react'
import * as api from '../api.js'
import { navigate } from '../router.js'
import { daysUntil, formatDay } from '../dates.js'
import Button from '../components/Button.jsx'
import Card from '../components/Card.jsx'

export default function Dashboard() {
  const [plans, setPlans] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .listPlans()
      .then((data) => !cancelled && setPlans(data.plans))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  async function handleDelete(plan) {
    if (!window.confirm('Delete this plan and its schedule? This cannot be undone.')) return
    setError('')
    try {
      await api.deletePlan(plan._id)
      setPlans((current) => current.filter((p) => p._id !== plan._id))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Your plans</h1>
        <Button onClick={() => navigate('/new')}>+ New Plan</Button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {plans === null && !error && <p className="muted">Loading…</p>}
      {plans && plans.length === 0 && (
        <Card>
          <p>No plans yet. Paste a syllabus and set your exam date to get a day-by-day study schedule.</p>
        </Card>
      )}
      {plans && plans.map((plan) => {
        const left = daysUntil(plan.examDate)
        return (
          <Card key={plan._id} className="plan-card">
            <div className="plan-card-main">
              <a className="plan-link" href={`#/plan/${plan._id}`}>
                {plan.syllabusPreview || 'Untitled plan'}
              </a>
              <p className="muted">
                Exam {formatDay(plan.examDate)} ·{' '}
                {left > 0 ? `${left} day${left === 1 ? '' : 's'} left` : left === 0 ? 'today' : 'passed'} ·{' '}
                {plan.dailyHours}h/day
              </p>
            </div>
            <span className={`pill pill-${plan.status}`}>{plan.status}</span>
            <Button variant="danger" onClick={() => handleDelete(plan)}>Delete</Button>
          </Card>
        )
      })}
    </>
  )
}
