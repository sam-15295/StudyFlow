const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createLoggedInClient, createClient, dateFromToday } = require('./helpers');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');
const Plan = require('../model/planSchema');

let srv, alice, bob;

// topics: [name, difficulty, estHours, status?]  (difficulty/estHours null = not estimated yet)
async function planWith(client, topics, { examInDays = 10, dailyHours = 3 } = {}) {
  const res = await client.request('POST', '/plans', {
    syllabusRaw: 'anything',
    examDate: dateFromToday(examInDays),
    dailyHours,
  });
  const planId = res.body.plan._id;
  for (const [name, difficulty, estHours, status] of topics) {
    await Topic.create({ planId, name, difficulty, estHours, status: status || 'pending' });
  }
  return planId;
}

before(async () => {
  srv = await startTestServer();
  alice = await createLoggedInClient(srv.baseUrl, 'alice@example.com');
  bob = await createLoggedInClient(srv.baseUrl, 'bob@example.com');
});
after(async () => {
  await srv.close();
});

test('generate saves a schedule with the hardest topic first and activates the plan', async () => {
  const planId = await planWith(alice, [['Easy', 1, 2], ['Hard', 5, 2], ['Mid', 3, 2]]);
  const res = await alice.request('POST', `/plans/${planId}/generate`);
  assert.equal(res.status, 200);
  assert.equal(res.body.warning, null);
  assert.deepEqual(res.body.unscheduledTopicIds, []);

  const names = Object.fromEntries((await Topic.find({ planId })).map((t) => [t._id.toString(), t.name]));
  const days = res.body.scheduleDays;
  // 3h/day: each 2h topic needs its own day, so order shows the difficulty ranking
  assert.deepEqual(days.map((d) => d.topicIds.map((id) => names[id])), [['Hard'], ['Mid'], ['Easy']]);
  assert.equal(days[0].date.slice(0, 10), dateFromToday(0)); // starts today
  assert.equal(days[0].completed, false);
  assert.equal((await Plan.findById(planId)).status, 'active');
  assert.equal(await ScheduleDay.countDocuments({ planId }), days.length);
});

test('generate splits a topic longer than a day and records hours per day', async () => {
  const planId = await planWith(alice, [['Marathon', 4, 5]], { dailyHours: 2 });
  const res = await alice.request('POST', `/plans/${planId}/generate`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.scheduleDays.map((d) => d.slots[0].hours), [2, 2, 1]);
});

test('generate flags overflow with a warning and the unscheduled topics (nothing silently dropped)', async () => {
  const planId = await planWith(alice, [['A', 5, 3], ['B', 3, 3]], { examInDays: 1, dailyHours: 3 });
  const res = await alice.request('POST', `/plans/${planId}/generate`);
  assert.equal(res.status, 200);
  assert.match(res.body.warning, /6h/);
  assert.match(res.body.warning, /3h/);
  const b = await Topic.findOne({ planId, name: 'B' });
  assert.deepEqual(res.body.unscheduledTopicIds, [b._id.toString()]);

  // ...and the plan view still reports it after a reload
  const view = await alice.request('GET', `/plans/${planId}`);
  assert.deepEqual(view.body.plan.unscheduledTopicIds, [b._id.toString()]);
});

test('plan view reports no unscheduled topics when everything fits or nothing is generated yet', async () => {
  const noSchedule = await planWith(alice, [['A', 3, 2]]);
  assert.deepEqual((await alice.request('GET', `/plans/${noSchedule}`)).body.plan.unscheduledTopicIds, []);
  await alice.request('POST', `/plans/${noSchedule}/generate`);
  assert.deepEqual((await alice.request('GET', `/plans/${noSchedule}`)).body.plan.unscheduledTopicIds, []);
});

test('generate only schedules topics that are not done', async () => {
  const planId = await planWith(alice, [['Finished', 5, 2, 'done'], ['Todo', 3, 2], ['Missed', 4, 2, 'missed']]);
  const res = await alice.request('POST', `/plans/${planId}/generate`);
  assert.equal(res.status, 200);
  const finished = await Topic.findOne({ planId, name: 'Finished' });
  const scheduledIds = res.body.scheduleDays.flatMap((d) => d.topicIds);
  assert.equal(scheduledIds.length, 2);
  assert.ok(!scheduledIds.includes(finished._id.toString()));
});

test('generating again replaces the old schedule instead of duplicating it', async () => {
  const planId = await planWith(alice, [['A', 3, 2], ['B', 2, 2]]);
  await alice.request('POST', `/plans/${planId}/generate`);
  const first = await ScheduleDay.countDocuments({ planId });
  await alice.request('POST', `/plans/${planId}/generate`);
  assert.equal(await ScheduleDay.countDocuments({ planId }), first);
});

test('generate rejects: no topics, un-estimated topics, everything done, exam already passed', async () => {
  const empty = await planWith(alice, []);
  assert.equal((await alice.request('POST', `/plans/${empty}/generate`)).status, 400);

  const unestimated = await planWith(alice, [['A', 3, 2], ['B', null, null]]);
  const r = await alice.request('POST', `/plans/${unestimated}/generate`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /estimate/i);
  assert.equal(await ScheduleDay.countDocuments({ planId: unestimated }), 0);

  const allDone = await planWith(alice, [['A', 3, 2, 'done']]);
  assert.equal((await alice.request('POST', `/plans/${allDone}/generate`)).status, 400);

  const expired = await planWith(alice, [['A', 3, 2]]);
  await Plan.updateOne({ _id: expired }, { examDate: new Date(Date.now() - 3 * 86400000) });
  const e = await alice.request('POST', `/plans/${expired}/generate`);
  assert.equal(e.status, 400);
  assert.match(e.body.error, /exam date/i);
});

test('generate is protected: 401 logged out, 404 for another user\'s plan', async () => {
  const planId = await planWith(alice, [['A', 3, 2]]);
  assert.equal((await createClient(srv.baseUrl).request('POST', `/plans/${planId}/generate`)).status, 401);
  assert.equal((await bob.request('POST', `/plans/${planId}/generate`)).status, 404);
  assert.equal(await ScheduleDay.countDocuments({ planId }), 0);
});
