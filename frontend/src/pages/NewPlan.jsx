import { useState } from 'react'
import * as api from '../api.js'
import { navigate } from '../router.js'
import { tomorrowKey } from '../dates.js'
import Button from '../components/Button.jsx'
import Card from '../components/Card.jsx'
import Input from '../components/Input.jsx'

export default function NewPlan() {
  const [syllabus, setSyllabus] = useState('')
  const [examDate, setExamDate] = useState('')
  const [dailyHours, setDailyHours] = useState('3')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { plan } = await api.createPlan({
        syllabusRaw: syllabus,
        examDate, // the date input's value is already "YYYY-MM-DD", which is what the API expects
        dailyHours: Number(dailyHours),
      })
      navigate(`/plan/${plan._id}`)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>New plan</h1>
      </div>
      <Card>
        <form onSubmit={handleSubmit}>
          <Input
            as="textarea"
            label="Syllabus"
            rows={12}
            required
            maxLength={20000}
            placeholder="Paste your syllabus or topic list here…"
            hint="Plain text, up to 20,000 characters."
            value={syllabus}
            onChange={(e) => setSyllabus(e.target.value)}
          />
          <div className="field-row">
            <Input
              label="Exam date"
              type="date"
              required
              min={tomorrowKey()}
              value={examDate}
              onChange={(e) => setExamDate(e.target.value)}
            />
            <Input
              label="Study hours per day"
              type="number"
              required
              min="0.25"
              max="24"
              step="0.25"
              value={dailyHours}
              onChange={(e) => setDailyHours(e.target.value)}
            />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create plan'}</Button>
            <Button variant="secondary" onClick={() => navigate('/')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </>
  )
}
