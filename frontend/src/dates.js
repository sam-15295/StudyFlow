// The API works in whole UTC calendar days ("YYYY-MM-DD"); these helpers do the same so the
// UI's idea of "today" always matches the server's.
const DAY_MS = 24 * 60 * 60 * 1000

export const todayKey = () => new Date().toISOString().slice(0, 10)

// Accepts an ISO string from the API ("2030-01-05T00:00:00.000Z") or a plain "YYYY-MM-DD".
export const dayKey = (iso) => String(iso).slice(0, 10)

export function formatDay(iso) {
  return new Date(`${dayKey(iso)}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function daysUntil(iso) {
  const target = Date.parse(`${dayKey(iso)}T00:00:00.000Z`)
  const today = Date.parse(`${todayKey()}T00:00:00.000Z`)
  return Math.round((target - today) / DAY_MS)
}

// Tomorrow as "YYYY-MM-DD" (the earliest exam date the API accepts).
export function tomorrowKey() {
  return new Date(Date.now() + DAY_MS).toISOString().slice(0, 10)
}

export const formatHours = (h) => `${Math.round(h * 100) / 100}h`
