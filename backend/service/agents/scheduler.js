// Deterministic scheduler (no LLM): spreads topics over the days between today and the exam.
//
//   scheduleTopics(topics, examDate, dailyHours, startDate?) -> {
//     days:        [{ date, topicIds, slots: [{ topicId, hours }] }]   (only days that have work)
//     unscheduled: [{ topicId, hours }]        hours that did NOT fit before the exam
//     warning:     string | null               set when the topics need more time than is available
//     totalHours, availableHours, availableDays
//   }
//
// `topics` are plain objects { id, difficulty, estHours }. Pure function: no DB, no clock
// (unless startDate is omitted), and the input is never mutated.
//
// Rules:
//  - Study days are startDate .. (examDate - 1); the exam day itself is not a study day.
//  - Hardest topics first (difficulty desc, ties keep the given order), so they get the earliest days.
//  - A topic that fits in one day goes, whole, into the EARLIEST day that still has room.
//  - A topic longer than a day, or one that no single day has room for any more, is split into
//    chunks over the earliest free capacity (consecutive days), so no capacity is wasted.
//  - Nothing is silently dropped: whatever cannot fit is returned in `unscheduled` + `warning`.

const DAY_MS = 24 * 60 * 60 * 1000;
const EPS = 1e-9;

const round = (hours) => Math.round(hours * 1000) / 1000; // kills 0.1+0.2 style float noise

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function validateTopic(topic) {
  const ok =
    topic &&
    topic.id !== undefined &&
    typeof topic.difficulty === 'number' &&
    Number.isFinite(topic.difficulty) &&
    typeof topic.estHours === 'number' &&
    Number.isFinite(topic.estHours) &&
    topic.estHours > 0;
  if (!ok) {
    throw new TypeError(`Topic ${topic && topic.id} needs a numeric difficulty and estHours > 0 to be scheduled`);
  }
}

function scheduleTopics(topics, examDate, dailyHours, startDate = new Date()) {
  if (typeof dailyHours !== 'number' || !Number.isFinite(dailyHours) || dailyHours <= 0) {
    throw new RangeError('dailyHours must be a positive number');
  }
  topics.forEach(validateTopic);

  const start = startOfUtcDay(startDate);
  const exam = startOfUtcDay(examDate);
  const availableDays = Math.round((exam - start) / DAY_MS);
  if (availableDays < 1) {
    throw new RangeError('The exam date leaves no study days (it must be after the start date)');
  }

  const days = Array.from({ length: availableDays }, (_, i) => ({
    date: new Date(start.getTime() + i * DAY_MS),
    remaining: dailyHours,
    slots: [],
  }));

  const place = (day, topicId, hours) => {
    day.slots.push({ topicId, hours: round(hours) });
    day.remaining = round(day.remaining - hours);
  };

  const ordered = topics
    .map((topic, index) => ({ topic, index }))
    .sort((a, b) => b.topic.difficulty - a.topic.difficulty || a.index - b.index);

  const unscheduled = [];
  for (const { topic } of ordered) {
    let left = topic.estHours;

    if (left <= dailyHours + EPS) {
      const day = days.find((d) => d.remaining + EPS >= left);
      if (day) {
        place(day, topic.id, left);
        continue;
      }
    }

    // Too long for one day, or no single day has room: use up free capacity, earliest first.
    for (const day of days) {
      if (left <= EPS) break;
      if (day.remaining <= EPS) continue;
      const chunk = Math.min(left, day.remaining);
      place(day, topic.id, chunk);
      left = round(left - chunk);
    }
    if (left > EPS) unscheduled.push({ topicId: topic.id, hours: round(left) });
  }

  const totalHours = round(topics.reduce((sum, t) => sum + t.estHours, 0));
  const availableHours = round(availableDays * dailyHours);
  const missingHours = round(unscheduled.reduce((sum, u) => sum + u.hours, 0));

  let warning = null;
  if (unscheduled.length > 0) {
    warning =
      `Your topics need about ${totalHours}h but only ${availableHours}h are available before the exam ` +
      `(${availableDays} day${availableDays === 1 ? '' : 's'} x ${dailyHours}h). ` +
      `${missingHours}h across ${unscheduled.length} topic${unscheduled.length === 1 ? '' : 's'} could not be scheduled. ` +
      `Study more hours per day or drop some topics.`;
  }

  return {
    days: days
      .filter((d) => d.slots.length > 0)
      .map((d) => ({ date: d.date, topicIds: d.slots.map((s) => s.topicId), slots: d.slots })),
    unscheduled,
    warning,
    totalHours,
    availableHours,
    availableDays,
  };
}

module.exports = { scheduleTopics, startOfUtcDay };
