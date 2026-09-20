import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api.js'
import { daysUntil, dayKey, formatDay, formatHours, todayKey } from '../dates.js'
import Button from '../components/Button.jsx'
import Card from '../components/Card.jsx'
import DayCard from '../components/DayCard.jsx'
import TopicRow from '../components/TopicRow.jsx'

const STEPS = [
  { key: 'extract', label: 'Extracting topics…', doneLabel: 'Topics extracted', run: api.extractTopics },
  { key: 'estimate', label: 'Estimating difficulty…', doneLabel: 'Difficulty estimated', run: api.estimateTopics },
  { key: 'generate', label: 'Building schedule…', doneLabel: 'Schedule built', run: api.generateSchedule },
]

export default function PlanView({ id }) {
  const [plan, setPlan] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [steps, setSteps] = useState(null) // null, or { extract|estimate|generate: 'pending'|'active'|'done'|'error' }
  const [busyTopic, setBusyTopic] = useState(null)
  const [notice, setNotice] = useState(null) // replan explanation after a status change

  const reload = useCallback(async () => {
    const data = await api.getPlan(id)
    setPlan(data.plan)
  }, [id])

  useEffect(() => {
    let cancelled = false
    api
      .getPlan(id)
      .then((data) => !cancelled && setPlan(data.plan))
      .catch((err) => !cancelled && setLoadError(err.message))
    return () => {
      cancelled = true
    }
  }, [id])

  const topicsById = useMemo(
    () => Object.fromEntries((plan ? plan.topics : []).map((t) => [t._id, t])),
    [plan],
  )

  if (loadError) {
    return (
      <Card tone="warning">
        <p className="error">{loadError}</p>
        <a href="#/">Back to your plans</a>
      </Card>
    )
  }
  if (!plan) return <p className="muted">Loading…</p>

  const building = steps !== null && Object.values(steps).includes('active')
  const busy = building || busyTopic !== null
  const finished = steps !== null && Object.values(steps).every((state) => state === 'done')
  const hasSchedule = plan.scheduleDays.length > 0
  const needsBuild =
    plan.status !== 'completed' &&
    (plan.topics.length === 0 || plan.topics.some((t) => t.difficulty == null) || !hasSchedule)
  const totalHours = plan.topics.reduce((sum, t) => sum + (t.estHours ?? 0), 0)
  const left = daysUntil(plan.examDate)
  const today = todayKey()
  const unscheduled = plan.unscheduledTopicIds.map((topicId) => topicsById[topicId]).filter(Boolean)

  // Extract -> estimate -> generate, one visible step at a time. Steps that are already done
  // are skipped, so after a failure ("Resume") we continue where it stopped instead of
  // repeating (and paying LLM quota for) the earlier steps.
  async function buildPlan() {
    setActionError('')
    setNotice(null)
    const needExtract = plan.topics.length === 0
    const needEstimate = needExtract || plan.topics.some((t) => t.difficulty == null)
    const needGenerate = needExtract || needEstimate || !hasSchedule
    const needed = { extract: needExtract, estimate: needEstimate, generate: needGenerate }
    setSteps(Object.fromEntries(STEPS.map((s) => [s.key, needed[s.key] ? 'pending' : 'done'])))

    for (const step of STEPS.filter((s) => needed[s.key])) {
      setSteps((current) => ({ ...current, [step.key]: 'active' }))
      try {
        await step.run(plan._id)
      } catch (err) {
        setSteps((current) => ({ ...current, [step.key]: 'error' }))
        setActionError(err.message)
        await reload().catch(() => {}) // earlier steps may have saved data
        return
      }
      setSteps((current) => ({ ...current, [step.key]: 'done' }))
    }
    await reload().catch((err) => setActionError(err.message))
    setTimeout(() => setSteps(null), 1500) // leave the finished tracker on screen for a moment
  }

  async function changeStatus(topic, status) {
    setActionError('')
    setNotice(null)
    setBusyTopic(topic._id)
    try {
      const result = await api.setTopicStatus(plan._id, topic._id, status)
      if (result.replanned) {
        setNotice({ text: result.explanation, generated: result.explanationSource === 'ai' })
      }
      await reload()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setBusyTopic(null)
    }
  }

  const toggleDone = (topic) => changeStatus(topic, topic.status === 'done' ? 'pending' : 'done')
  const toggleMissed = (topic) => changeStatus(topic, topic.status === 'missed' ? 'pending' : 'missed')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Study plan</h1>
          <p className="muted">
            Exam {formatDay(plan.examDate)} ·{' '}
            {left > 0 ? `${left} day${left === 1 ? '' : 's'} left` : left === 0 ? 'today' : 'date passed'} ·{' '}
            {plan.dailyHours}h/day
          </p>
        </div>
        <span className={`pill pill-${plan.status}`}>{plan.status}</span>
      </div>

      {actionError && <p className="error" role="alert">{actionError}</p>}

      {(needsBuild || steps) && (
        <Card>
          <h2>
            {finished ? 'Your plan is ready' : plan.topics.length === 0 ? 'Build your plan' : 'Finish building your plan'}
          </h2>
          <p className="muted">
            Three steps run in order: an AI agent extracts the topics, another estimates difficulty and hours, then
            the scheduler lays them out day by day.
          </p>
          <ol className="steps">
            {STEPS.map((step) => {
              const state = steps ? steps[step.key] : 'pending'
              return (
                <li key={step.key} className={`step step-${state}`}>
                  <span className="step-mark" aria-hidden="true">
                    {state === 'done' ? '✓' : state === 'error' ? '!' : state === 'active' ? '…' : '○'}
                  </span>
                  {state === 'active' ? step.label : state === 'done' ? step.doneLabel : step.label.replace('…', '')}
                </li>
              )
            })}
          </ol>
          {!finished && (
            <Button onClick={buildPlan} disabled={busy}>
              {building ? 'Working…' : steps && actionError ? 'Resume' : 'Build my plan'}
            </Button>
          )}
        </Card>
      )}

      {plan.status === 'completed' && (
        <Card tone="success">
          <strong>All topics are done — great work!</strong>
        </Card>
      )}

      {notice && (
        <Card className="notice">
          <strong>Schedule adjusted.</strong> {notice.text}
          {!notice.generated && <span className="muted"> (automatic summary — AI explanation unavailable)</span>}
        </Card>
      )}

      {unscheduled.length > 0 && (
        <Card tone="warning">
          <strong>
            {unscheduled.length} topic{unscheduled.length === 1 ? '' : 's'} won’t fit before the exam:
          </strong>{' '}
          {unscheduled.map((t) => t.name).join(', ')}. Increase your daily hours or study these first.
        </Card>
      )}

      {plan.topics.length > 0 && (
        <section>
          <h2>Topics</h2>
          <Card>
            {plan.topics.map((topic) => (
              <TopicRow key={topic._id} topic={topic} />
            ))}
            {totalHours > 0 && <p className="muted total-line">Total estimated: {formatHours(totalHours)}</p>}
          </Card>
        </section>
      )}

      {hasSchedule && (
        <section>
          <h2>Schedule</h2>
          {plan.scheduleDays.map((day) => {
            const key = dayKey(day.date)
            return (
              <DayCard
                key={day._id}
                day={day}
                topicsById={topicsById}
                when={key < today ? 'past' : key === today ? 'today' : 'future'}
                disabled={busy}
                savingTopicId={busyTopic}
                onToggleDone={toggleDone}
                onToggleMissed={toggleMissed}
              />
            )
          })}
        </section>
      )}
    </>
  )
}
