import { formatHours } from '../dates.js'

// One topic. Read-only (topic list) or interactive (inside a schedule day):
// the checkbox toggles done <-> pending, the "Missed" button toggles missed <-> pending.
export default function TopicRow({
  topic,
  hours,
  interactive = false,
  disabled = false,
  saving = false,
  onToggleDone,
  onToggleMissed,
}) {
  const { name, difficulty, estHours, status } = topic
  const shownHours = hours ?? estHours

  return (
    <div className={`topic-row status-${status}`}>
      {interactive && (
        <input
          type="checkbox"
          className="checkbox"
          checked={status === 'done'}
          disabled={disabled}
          onChange={() => onToggleDone(topic)}
          aria-label={`Mark "${name}" as done`}
        />
      )}
      <span className="topic-name">{name}</span>
      {difficulty != null && (
        <span className={`badge badge-d${difficulty}`} title={`Difficulty ${difficulty} of 5`}>
          D{difficulty}
        </span>
      )}
      {shownHours != null && <span className="muted topic-hours">{formatHours(shownHours)}</span>}
      {!interactive && status !== 'pending' && <span className={`pill pill-${status}`}>{status}</span>}
      {interactive && saving && <span className="muted saving">Updating…</span>}
      {interactive && !saving && (
        <button
          type="button"
          className={`missed-btn ${status === 'missed' ? 'is-missed' : ''}`}
          disabled={disabled}
          onClick={() => onToggleMissed(topic)}
          aria-pressed={status === 'missed'}
        >
          {status === 'missed' ? 'Missed' : 'Mark missed'}
        </button>
      )}
    </div>
  )
}
