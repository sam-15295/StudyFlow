import Card from './Card.jsx'
import TopicRow from './TopicRow.jsx'
import { formatDay, formatHours } from '../dates.js'

// One day of the schedule. `when` is 'past' | 'today' | 'future'.
// A past day that still has undone topics is flagged as behind.
export default function DayCard({ day, topicsById, when, disabled, savingTopicId, onToggleDone, onToggleMissed }) {
  const slots = day.slots.filter((slot) => topicsById[slot.topicId])
  const totalHours = slots.reduce((sum, slot) => sum + slot.hours, 0)
  const behind = when === 'past' && !day.completed

  return (
    <Card tone={day.completed ? 'success' : behind ? 'warning' : undefined} className="day-card">
      <div className="day-head">
        <h3>{formatDay(day.date)}</h3>
        {when === 'today' && <span className="pill pill-today">Today</span>}
        {day.completed && <span className="pill pill-done">Complete</span>}
        {behind && <span className="pill pill-missed">Behind</span>}
        <span className="muted day-hours">{formatHours(totalHours)}</span>
      </div>
      {slots.map((slot) => (
        <TopicRow
          key={slot.topicId}
          topic={topicsById[slot.topicId]}
          hours={slot.hours}
          interactive
          disabled={disabled}
          saving={savingTopicId === slot.topicId}
          onToggleDone={onToggleDone}
          onToggleMissed={onToggleMissed}
        />
      ))}
    </Card>
  )
}
