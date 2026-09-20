const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scheduleTopics } = require('../service/agents/scheduler');

const DAY_MS = 86400000;
const START = new Date('2030-01-01T00:00:00.000Z');
const examAfter = (days) => new Date(START.getTime() + days * DAY_MS);
const t = (id, difficulty, estHours) => ({ id, difficulty, estHours });
const iso = (d) => d.toISOString().slice(0, 10);

test('hardest topics land on the earliest days', () => {
  const r = scheduleTopics([t('easy', 1, 2), t('hard', 5, 2), t('mid', 3, 2)], examAfter(10), 4, START);
  assert.deepEqual(r.days.map((d) => d.topicIds), [['hard', 'mid'], ['easy']]);
  assert.equal(r.warning, null);
  assert.deepEqual(r.unscheduled, []);
});

test('difficulty ties keep the given (syllabus) order', () => {
  const r = scheduleTopics([t('a', 3, 1), t('b', 3, 1), t('c', 3, 1)], examAfter(5), 1, START);
  assert.deepEqual(r.days.map((d) => d.topicIds[0]), ['a', 'b', 'c']);
});

test('days are consecutive from the start date and the exam day is not a study day', () => {
  const r = scheduleTopics([t('a', 3, 1), t('b', 3, 1), t('c', 3, 1)], examAfter(3), 1, START);
  assert.deepEqual(r.days.map((d) => iso(d.date)), ['2030-01-01', '2030-01-02', '2030-01-03']);
  assert.equal(r.availableDays, 3);
  assert.ok(r.days.every((d) => iso(d.date) < '2030-01-04'));
});

test('an exam tomorrow leaves exactly one study day (today)', () => {
  const r = scheduleTopics([t('a', 3, 2)], examAfter(1), 3, START);
  assert.equal(r.availableDays, 1);
  assert.equal(r.days.length, 1);
});

test('a topic longer than a day is split into chunks over consecutive days', () => {
  const r = scheduleTopics([t('big', 5, 5)], examAfter(10), 2, START);
  assert.deepEqual(r.days.map((d) => d.slots), [
    [{ topicId: 'big', hours: 2 }],
    [{ topicId: 'big', hours: 2 }],
    [{ topicId: 'big', hours: 1 }],
  ]);
  assert.equal(r.warning, null);
});

test('a small easy topic fills the leftover hour after a split topic', () => {
  const r = scheduleTopics([t('big', 5, 5), t('small', 1, 1)], examAfter(10), 2, START);
  assert.deepEqual(r.days[2].slots, [
    { topicId: 'big', hours: 1 },
    { topicId: 'small', hours: 1 },
  ]);
});

test('fragmentation fallback: topics that fit in total are split rather than reported as overflow', () => {
  // 3 x 2h in 2 days x 3h: whole placement fills days 1 and 2 to 2h each; the third splits 1h + 1h.
  const r = scheduleTopics([t('a', 3, 2), t('b', 3, 2), t('c', 3, 2)], examAfter(2), 3, START);
  assert.equal(r.warning, null);
  assert.deepEqual(r.unscheduled, []);
  const hoursFor = (id) =>
    r.days.flatMap((d) => d.slots).filter((s) => s.topicId === id).reduce((n, s) => n + s.hours, 0);
  assert.equal(hoursFor('c'), 2);
  assert.equal(r.days.length, 2);
});

test('overflow is flagged, never silently dropped', () => {
  // 10h of work, 2 days x 3h = 6h available.
  const r = scheduleTopics([t('a', 5, 4), t('b', 3, 3), t('c', 1, 3)], examAfter(2), 3, START);
  assert.ok(r.warning, 'warning set');
  assert.match(r.warning, /10h/);
  assert.match(r.warning, /6h/);
  assert.equal(r.totalHours, 10);
  assert.equal(r.availableHours, 6);

  const scheduled = r.days.flatMap((d) => d.slots).reduce((n, s) => n + s.hours, 0);
  const missing = r.unscheduled.reduce((n, u) => n + u.hours, 0);
  assert.equal(scheduled, 6);
  assert.equal(missing, 4);
  // the hardest topic is the one that is kept
  assert.ok(r.days[0].topicIds.includes('a'));
});

test('exactly filling the available time gives no warning', () => {
  const r = scheduleTopics([t('a', 4, 3), t('b', 2, 3)], examAfter(2), 3, START);
  assert.equal(r.warning, null);
  assert.deepEqual(r.unscheduled, []);
});

test('no topics -> no days, no warning', () => {
  const r = scheduleTopics([], examAfter(5), 3, START);
  assert.deepEqual(r.days, []);
  assert.equal(r.warning, null);
});

test('exam date today or in the past throws', () => {
  assert.throws(() => scheduleTopics([t('a', 1, 1)], START, 2, START), RangeError);
  assert.throws(() => scheduleTopics([t('a', 1, 1)], examAfter(-3), 2, START), RangeError);
});

test('bad input throws instead of scheduling garbage', () => {
  assert.throws(() => scheduleTopics([t('a', null, 1)], examAfter(5), 2, START), TypeError);
  assert.throws(() => scheduleTopics([t('a', 3, null)], examAfter(5), 2, START), TypeError);
  assert.throws(() => scheduleTopics([t('a', 3, 0)], examAfter(5), 2, START), TypeError);
  assert.throws(() => scheduleTopics([t('a', 3, 1)], examAfter(5), 0, START), RangeError);
});

test('the input topics are not mutated or reordered', () => {
  const input = [t('easy', 1, 2), t('hard', 5, 2)];
  const copy = JSON.parse(JSON.stringify(input));
  scheduleTopics(input, examAfter(5), 3, START);
  assert.deepEqual(input, copy);
});

test('fractional hours do not drift (0.1 + 0.2 style errors)', () => {
  const r = scheduleTopics([t('a', 3, 0.4), t('b', 3, 0.3), t('c', 3, 0.3)], examAfter(2), 1, START);
  assert.equal(r.warning, null);
  assert.equal(r.days.length, 1);
  assert.ok(r.days[0].slots.every((s) => Number.isInteger(s.hours * 1000)));
});

test('invariants hold for many random inputs: hours conserved, no day overfilled, dates in range', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let run = 0; run < 300; run++) {
    const dailyHours = [0.5, 1, 1.5, 2, 3, 4.25][Math.floor(rand() * 6)];
    const days = 1 + Math.floor(rand() * 12);
    const topics = Array.from({ length: Math.floor(rand() * 15) }, (_, i) =>
      t(`t${i}`, 1 + Math.floor(rand() * 5), Math.max(0.25, Math.round(rand() * 8 * 4) / 4))
    );
    const r = scheduleTopics(topics, examAfter(days), dailyHours, START);

    const placed = {};
    for (const d of r.days) {
      const dayTotal = d.slots.reduce((n, s) => n + s.hours, 0);
      assert.ok(dayTotal <= dailyHours + 1e-6, `run ${run}: day over capacity`);
      assert.ok(d.date >= START && d.date < examAfter(days), `run ${run}: date outside window`);
      assert.deepEqual(d.topicIds, d.slots.map((s) => s.topicId));
      assert.equal(new Set(d.topicIds).size, d.topicIds.length, `run ${run}: topic twice in a day`);
      for (const s of d.slots) placed[s.topicId] = (placed[s.topicId] || 0) + s.hours;
    }
    for (const u of r.unscheduled) placed[u.topicId] = (placed[u.topicId] || 0) + u.hours;
    for (const topic of topics) {
      assert.ok(Math.abs((placed[topic.id] || 0) - topic.estHours) < 1e-6, `run ${run}: hours lost for ${topic.id}`);
    }
    // warning if and only if something did not fit; and it must be truthful about capacity
    assert.equal(r.warning !== null, r.unscheduled.length > 0);
    if (r.totalHours <= r.availableHours + 1e-9) assert.deepEqual(r.unscheduled, [], `run ${run}: false overflow`);
  }
});
