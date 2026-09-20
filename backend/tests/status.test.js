const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createLoggedInClient, createClient, dateFromToday, mockLlm } = require('./helpers');
const { decideReplan } = require('../service/replan');
const { fallbackExplanation } = require('../service/agents/replanExplainer');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');
const Plan = require('../model/planSchema');

let srv, alice, bob, mock;
const AI = (text) => JSON.stringify({ explanation: text });

// 5 topics of 2h at 3h/day => one topic per day: A today, B +1, C +2, D +3, E +4.
async function scheduledPlan(client = alice, { examInDays = 10, dailyHours = 3 } = {}) {
  const res = await client.request('POST', '/plans', { syllabusRaw: 'x', examDate: dateFromToday(examInDays), dailyHours });
  const planId = res.body.plan._id;
  const spec = [['A', 5], ['B', 4], ['C', 3], ['D', 2], ['E', 1]];
  for (const [name, difficulty] of spec) await Topic.create({ planId, name, difficulty, estHours: 2 });
  const gen = await client.request('POST', `/plans/${planId}/generate`);
  assert.equal(gen.status, 200);
  return planId;
}

async function idOf(planId, name) {
  return (await Topic.findOne({ planId, name }))._id.toString();
}

// { schedule: { 'YYYY-MM-DD': ['A', ...] }, topics: { A: 'pending' }, unscheduled: ['Z'], plan }
async function view(planId, client = alice) {
  const { plan } = (await client.request('GET', `/plans/${planId}`)).body;
  const nameById = Object.fromEntries(plan.topics.map((t) => [t._id, t.name]));
  return {
    plan,
    schedule: Object.fromEntries(plan.scheduleDays.map((d) => [d.date.slice(0, 10), d.topicIds.map((id) => nameById[id])])),
    days: plan.scheduleDays,
    topics: Object.fromEntries(plan.topics.map((t) => [t.name, t.status])),
    unscheduled: plan.unscheduledTopicIds.map((id) => nameById[id]),
  };
}

const setStatus = async (planId, name, status, client = alice) =>
  client.request('PATCH', `/plans/${planId}/topics/${await idOf(planId, name)}/status`, { status });

before(async () => {
  srv = await startTestServer();
  alice = await createLoggedInClient(srv.baseUrl, 'alice@example.com');
  bob = await createLoggedInClient(srv.baseUrl, 'bob@example.com');
});
afterEach(() => {
  if (mock) mock.restore();
  mock = null;
});
after(async () => {
  await srv.close();
});

// ---------- decideReplan (pure) ----------

test('decideReplan: the trigger rules', () => {
  const today = new Date('2030-03-10T00:00:00.000Z');
  const at = (iso) => [new Date(`${iso}T00:00:00.000Z`)];
  const base = { hasSchedule: true, today, slotDates: at('2030-03-10') };

  assert.deepEqual(decideReplan({ ...base, oldStatus: 'pending', newStatus: 'missed' }), { trigger: 'missed', daysOffset: null });
  assert.deepEqual(decideReplan({ ...base, oldStatus: 'done', newStatus: 'missed' }), { trigger: 'missed', daysOffset: null });
  // done: on time or within 1 day -> no replan
  assert.equal(decideReplan({ ...base, oldStatus: 'pending', newStatus: 'done' }), null);
  assert.equal(decideReplan({ ...base, slotDates: at('2030-03-11'), oldStatus: 'pending', newStatus: 'done' }), null);
  assert.equal(decideReplan({ ...base, slotDates: at('2030-03-09'), oldStatus: 'pending', newStatus: 'done' }), null);
  // done more than 1 day away -> replan
  assert.deepEqual(decideReplan({ ...base, slotDates: at('2030-03-13'), oldStatus: 'pending', newStatus: 'done' }), { trigger: 'done_early', daysOffset: 3 });
  assert.deepEqual(decideReplan({ ...base, slotDates: at('2030-03-07'), oldStatus: 'missed', newStatus: 'done' }), { trigger: 'done_late', daysOffset: 3 });
  // a split topic is judged by its LAST day
  const split = [new Date('2030-03-10T00:00:00.000Z'), new Date('2030-03-11T00:00:00.000Z')];
  assert.equal(decideReplan({ ...base, slotDates: split, oldStatus: 'pending', newStatus: 'done' }), null);
  // reopening a done topic replans; missed -> pending does not
  assert.deepEqual(decideReplan({ ...base, oldStatus: 'done', newStatus: 'pending' }), { trigger: 'reopened', daysOffset: null });
  assert.equal(decideReplan({ ...base, oldStatus: 'missed', newStatus: 'pending' }), null);
  // no schedule, no change, or never scheduled -> no replan
  assert.equal(decideReplan({ ...base, hasSchedule: false, oldStatus: 'pending', newStatus: 'missed' }), null);
  assert.equal(decideReplan({ ...base, oldStatus: 'missed', newStatus: 'missed' }), null);
  assert.equal(decideReplan({ ...base, slotDates: [], oldStatus: 'pending', newStatus: 'done' }), null);
});

test('fallbackExplanation is a single readable sentence for every trigger', () => {
  const change = { topic: 'Graphs', daysLeft: 6, rescheduledTopics: 4, unscheduledTopics: 0, daysOffset: 2 };
  for (const trigger of ['missed', 'done_early', 'done_late', 'reopened']) {
    const text = fallbackExplanation({ ...change, trigger });
    assert.match(text, /Graphs/);
    assert.match(text, /4 remaining topics were re-spread over the 6 study days/);
  }
  assert.match(fallbackExplanation({ ...change, trigger: 'done_early' }), /2 days early/);
  assert.match(fallbackExplanation({ ...change, trigger: 'missed', unscheduledTopics: 1 }), /1 topic no longer fits/);
});

// ---------- PATCH /plans/:id/topics/:topicId/status ----------

test('missed: the topic is removed from today, everything remaining is re-spread from tomorrow, LLM explains', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('Because A was missed, 5 topics were re-spread over the next 9 days.')]);

  const res = await setStatus(planId, 'A', 'missed');
  assert.equal(res.status, 200);
  assert.equal(res.body.topic.status, 'missed');
  assert.equal(res.body.replanned, true);
  assert.equal(res.body.explanation, 'Because A was missed, 5 topics were re-spread over the next 9 days.');
  assert.equal(res.body.explanationSource, 'ai');
  assert.equal(res.body.warning, null);

  const v = await view(planId);
  // today's day is empty (A was its only topic) so it is gone; A is back at the front of tomorrow
  assert.equal(v.schedule[dateFromToday(0)], undefined);
  assert.deepEqual(v.schedule, {
    [dateFromToday(1)]: ['A'],
    [dateFromToday(2)]: ['B'],
    [dateFromToday(3)]: ['C'],
    [dateFromToday(4)]: ['D'],
    [dateFromToday(5)]: ['E'],
  });
  assert.equal(v.topics.A, 'missed'); // status stays visible even though it is rescheduled
  assert.deepEqual(v.unscheduled, []);

  // one explainer call, carrying computed facts (not raw schedule dumps)
  assert.equal(mock.calls.length, 1);
  const prompt = JSON.stringify(mock.calls[0].messages);
  assert.match(prompt, /\\"trigger\\":\\"missed\\"/);
  assert.match(prompt, /\\"topic\\":\\"A\\"/);
  assert.match(prompt, /\\"rescheduledTopics\\":5/);
});

test('done on its scheduled day: no replan, no LLM call, day marked completed', async () => {
  const planId = await scheduledPlan();
  const before = await view(planId);
  mock = mockLlm([AI('should not be used')]);

  const res = await setStatus(planId, 'A', 'done');
  assert.equal(res.status, 200);
  assert.equal(res.body.replanned, false);
  assert.equal(res.body.explanation, null);
  assert.equal(mock.calls.length, 0);

  const after = await view(planId);
  assert.deepEqual(after.schedule, before.schedule);
  const today = after.days.find((d) => d.date.slice(0, 10) === dateFromToday(0));
  assert.equal(today.completed, true);
  assert.equal(after.days.filter((d) => d.completed).length, 1);
});

test('done more than 1 day early: replan pulls the remaining topics forward', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('E was finished early, so the rest moved up.')]);

  const res = await setStatus(planId, 'E', 'done'); // due in 4 days
  assert.equal(res.body.replanned, true);
  assert.equal(res.body.explanationSource, 'ai');
  assert.match(mock.calls[0].messages[1].content, /done_early/);
  assert.match(mock.calls[0].messages[1].content, /"daysOffset":4/);

  const v = await view(planId);
  // A stays today; B, C, D are re-placed from tomorrow; E's old day is gone
  assert.deepEqual(v.schedule, {
    [dateFromToday(0)]: ['A'],
    [dateFromToday(1)]: ['B'],
    [dateFromToday(2)]: ['C'],
    [dateFromToday(3)]: ['D'],
  });
  assert.equal(v.topics.E, 'done');
});

test('done 1 day early is within tolerance: no replan', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('nope')]);
  const res = await setStatus(planId, 'B', 'done'); // due tomorrow
  assert.equal(res.body.replanned, false);
  assert.equal(mock.calls.length, 0);
});

test('done more than 1 day late: overdue work is re-spread from tomorrow and past days keep only done work', async () => {
  const planId = await scheduledPlan();
  // Pretend the student has been away for 3 days: shift the whole schedule 3 days into the past,
  // so A was due 3 days ago, B -2, C -1, D is due today and E tomorrow.
  for (const day of await ScheduleDay.find({ planId })) {
    day.date = new Date(day.date.getTime() - 3 * 86400000);
    await day.save();
  }
  mock = mockLlm([AI('A was finished late, so the remaining topics were re-spread.')]);

  const res = await setStatus(planId, 'A', 'done'); // was due 3 days ago
  assert.equal(res.body.replanned, true);
  assert.match(mock.calls[0].messages[1].content, /done_late/);

  const v = await view(planId);
  assert.deepEqual(v.schedule, {
    [dateFromToday(-3)]: ['A'], // history: the done topic stays on its day
    [dateFromToday(0)]: ['D'], // planned for today, so it stays
    [dateFromToday(1)]: ['B'], // overdue B, C and upcoming E: re-spread from tomorrow, hardest first
    [dateFromToday(2)]: ['C'],
    [dateFromToday(3)]: ['E'],
  });
  assert.equal(v.days.find((d) => d.date.slice(0, 10) === dateFromToday(-3)).completed, true);
  assert.deepEqual(v.unscheduled, []);
});

test('missing an overdue topic (never marked) re-spreads it from today onward, not into the past', async () => {
  const planId = await scheduledPlan();
  for (const day of await ScheduleDay.find({ planId })) {
    day.date = new Date(day.date.getTime() - 2 * 86400000); // A -2, B -1, C 0(today), D +1, E +2
    await day.save();
  }
  mock = mockLlm([AI('ok')]);
  const res = await setStatus(planId, 'A', 'missed');
  assert.equal(res.body.replanned, true);
  const v = await view(planId);
  // C keeps today; A, B, D, E are placed from tomorrow by difficulty (A5, B4, D2, E1)
  assert.deepEqual(v.schedule, {
    [dateFromToday(0)]: ['C'],
    [dateFromToday(1)]: ['A'],
    [dateFromToday(2)]: ['B'],
    [dateFromToday(3)]: ['D'],
    [dateFromToday(4)]: ['E'],
  });
});

test('reopening a done topic puts it back on the calendar', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('first'), AI('second')]);
  await setStatus(planId, 'E', 'done'); // early -> replan removes E's slot
  assert.ok(!Object.values((await view(planId)).schedule).flat().includes('E'));

  const res = await setStatus(planId, 'E', 'pending');
  assert.equal(res.body.replanned, true);
  assert.match(mock.calls[1].messages[1].content, /reopened/);
  const v = await view(planId);
  assert.ok(Object.values(v.schedule).flat().includes('E'), 'E is scheduled again');
  assert.equal(v.topics.E, 'pending');
  assert.deepEqual(v.unscheduled, []);
});

test('missed -> pending is just a label change: no replan', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('replan explanation')]);
  await setStatus(planId, 'B', 'missed');
  const res = await setStatus(planId, 'B', 'pending');
  assert.equal(res.body.replanned, false);
  assert.equal(mock.calls.length, 1); // only the first (missed) change called the LLM
});

test('setting the same status again is a harmless no-op', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('x')]);
  const res = await setStatus(planId, 'A', 'pending');
  assert.equal(res.status, 200);
  assert.equal(res.body.replanned, false);
  assert.equal(mock.calls.length, 0);
});

test('if the LLM is unavailable the replan still succeeds with a deterministic explanation', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([{ status: 429 }]);
  const res = await setStatus(planId, 'A', 'missed');
  assert.equal(res.status, 200);
  assert.equal(res.body.replanned, true);
  assert.equal(res.body.explanationSource, 'fallback');
  assert.match(res.body.explanation, /"A" was marked missed, so 5 remaining topics were re-spread over the 9 study days/);
  assert.equal(mock.calls.length, 2); // one retry, then fallback
  const v = await view(planId);
  assert.deepEqual(v.schedule[dateFromToday(1)], ['A']);
});

test('if the LLM returns junk twice the replan still succeeds with the fallback', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm(['not json', '{"wrong":"shape"}']);
  const res = await setStatus(planId, 'A', 'missed');
  assert.equal(res.status, 200);
  assert.equal(res.body.explanationSource, 'fallback');
});

test('replan that cannot fit everything reports a warning and the unscheduled topics', async () => {
  // exam in 3 days, 2h/day: study days are today, +1, +2 (one 2h topic each)
  const planId = await scheduledPlan(alice, { examInDays: 3, dailyHours: 2 });
  mock = mockLlm([AI('too tight now')]);
  const res = await setStatus(planId, 'A', 'missed'); // A leaves today; only +1,+2 remain => 4h for 10h of topics
  assert.equal(res.status, 200);
  assert.ok(res.body.warning);
  const v = await view(planId);
  assert.ok(v.unscheduled.length > 0);
  assert.ok(v.unscheduled.includes('E')); // easiest topics are the ones dropped
  assert.deepEqual(v.schedule[dateFromToday(1)], ['A']);
});

test('exam tomorrow: no study days remain, so nothing crashes and topics are flagged unscheduled', async () => {
  const planId = await scheduledPlan(alice, { examInDays: 2, dailyHours: 3 }); // today, +1 => A today, B +1
  mock = mockLlm([AI('exam is imminent')]);
  await Plan.updateOne({ _id: planId }, { examDate: new Date(`${dateFromToday(1)}T00:00:00.000Z`) }); // exam moved to tomorrow
  const res = await setStatus(planId, 'A', 'missed');
  assert.equal(res.status, 200);
  assert.match(res.body.warning, /no study days left/i);
  const v = await view(planId);
  assert.ok(v.unscheduled.includes('A'));
});

test('no schedule generated yet: status updates work without any replan', async () => {
  const res = await alice.request('POST', '/plans', { syllabusRaw: 'x', examDate: dateFromToday(5), dailyHours: 2 });
  const planId = res.body.plan._id;
  await Topic.create({ planId, name: 'Solo', difficulty: 3, estHours: 1 });
  mock = mockLlm([AI('x')]);
  const r = await setStatus(planId, 'Solo', 'missed');
  assert.equal(r.status, 200);
  assert.equal(r.body.replanned, false);
  assert.equal(r.body.topic.status, 'missed');
  assert.equal(mock.calls.length, 0);
});

test('plan becomes completed when every topic is done, and active again when one is reopened', async () => {
  const planId = await scheduledPlan();
  mock = mockLlm([AI('ok')]);
  for (const name of ['A', 'B', 'C', 'D', 'E']) await setStatus(planId, name, 'done');
  assert.equal((await Plan.findById(planId)).status, 'completed');
  await setStatus(planId, 'C', 'pending');
  assert.equal((await Plan.findById(planId)).status, 'active');
});

test('validation: bad status 400, unknown/malformed topic 404, topic of another plan 404', async () => {
  const planId = await scheduledPlan();
  const otherPlan = await scheduledPlan();
  const topicId = await idOf(planId, 'A');
  assert.equal((await alice.request('PATCH', `/plans/${planId}/topics/${topicId}/status`, { status: 'finished' })).status, 400);
  assert.equal((await alice.request('PATCH', `/plans/${planId}/topics/${topicId}/status`, {})).status, 400);
  assert.equal((await alice.request('PATCH', `/plans/${planId}/topics/not-an-id/status`, { status: 'done' })).status, 404);
  assert.equal((await alice.request('PATCH', `/plans/${planId}/topics/507f1f77bcf86cd799439011/status`, { status: 'done' })).status, 404);
  const foreignTopic = await idOf(otherPlan, 'A');
  assert.equal((await alice.request('PATCH', `/plans/${planId}/topics/${foreignTopic}/status`, { status: 'done' })).status, 404);
  assert.equal((await Topic.findById(foreignTopic)).status, 'pending'); // untouched
});

test('protected: 401 logged out; 404 for another user\'s plan and the topic is unchanged', async () => {
  const planId = await scheduledPlan();
  const topicId = await idOf(planId, 'A');
  mock = mockLlm([AI('x')]);
  assert.equal((await createClient(srv.baseUrl).request('PATCH', `/plans/${planId}/topics/${topicId}/status`, { status: 'missed' })).status, 401);
  assert.equal((await bob.request('PATCH', `/plans/${planId}/topics/${topicId}/status`, { status: 'missed' })).status, 404);
  assert.equal((await Topic.findById(topicId)).status, 'pending');
  assert.equal(mock.calls.length, 0);
});
