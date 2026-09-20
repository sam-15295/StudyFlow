const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient, createLoggedInClient, dateFromToday } = require('./helpers');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');

let srv, alice, bob;
const validPlan = () => ({
  syllabusRaw: 'Unit 1: Arrays\nUnit 2: Linked lists',
  examDate: dateFromToday(14),
  dailyHours: 3,
});

before(async () => {
  srv = await startTestServer();
  alice = await createLoggedInClient(srv.baseUrl, 'alice@example.com');
  bob = await createLoggedInClient(srv.baseUrl, 'bob@example.com');
});
after(async () => {
  await srv.close();
});

test('all /plans routes require authentication', async () => {
  const anon = createClient(srv.baseUrl);
  assert.equal((await anon.request('GET', '/plans')).status, 401);
  assert.equal((await anon.request('POST', '/plans', validPlan())).status, 401);
  assert.equal((await anon.request('GET', '/plans/507f1f77bcf86cd799439011')).status, 401);
  assert.equal((await anon.request('DELETE', '/plans/507f1f77bcf86cd799439011')).status, 401);
});

test('create plan: success returns draft plan owned by the user', async () => {
  const res = await alice.request('POST', '/plans', validPlan());
  assert.equal(res.status, 201);
  assert.equal(res.body.plan.status, 'draft');
  assert.equal(res.body.plan.dailyHours, 3);
  assert.equal(res.body.plan.examDate.slice(0, 10), dateFromToday(14));
});

test('create plan: validation failures return 400', async () => {
  const bad = [
    { ...validPlan(), syllabusRaw: '   ' },
    { ...validPlan(), syllabusRaw: 'x'.repeat(20001) },
    { ...validPlan(), examDate: 'tomorrow' },
    { ...validPlan(), examDate: '2026-02-31' }, // impossible calendar date
    { ...validPlan(), examDate: dateFromToday(0) }, // today is not "in the future"
    { ...validPlan(), examDate: dateFromToday(-3) },
    { ...validPlan(), dailyHours: 0 },
    { ...validPlan(), dailyHours: 25 },
    { ...validPlan(), dailyHours: '3' },
    {},
  ];
  for (const body of bad) {
    const res = await alice.request('POST', '/plans', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 80)}`);
  }
});

test('list returns only the current user\'s plans, newest first, with a preview', async () => {
  await bob.request('POST', '/plans', { ...validPlan(), syllabusRaw: 'Bob only syllabus' });
  const aliceList = await alice.request('GET', '/plans');
  assert.equal(aliceList.status, 200);
  assert.ok(aliceList.body.plans.length >= 1);
  assert.ok(aliceList.body.plans.every((p) => p.syllabusPreview !== 'Bob only syllabus'));
  assert.ok(aliceList.body.plans.every((p) => !('syllabusRaw' in p)));
  const dates = aliceList.body.plans.map((p) => p.createdAt);
  assert.deepEqual(dates, [...dates].sort().reverse());

  const bobList = await bob.request('GET', '/plans');
  assert.equal(bobList.body.plans.length, 1);
});

test('get one plan includes its topics and schedule days', async () => {
  const created = await alice.request('POST', '/plans', validPlan());
  const planId = created.body.plan._id;
  await Topic.create([
    { planId, name: 'Arrays' },
    { planId, name: 'Linked lists' },
  ]);
  await ScheduleDay.create({ planId, date: new Date(), topicIds: [] });

  const res = await alice.request('GET', `/plans/${planId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.plan.syllabusRaw, validPlan().syllabusRaw);
  assert.deepEqual(res.body.plan.topics.map((t) => t.name), ['Arrays', 'Linked lists']);
  assert.equal(res.body.plan.topics[0].status, 'pending');
  assert.equal(res.body.plan.topics[0].difficulty, null);
  assert.equal(res.body.plan.scheduleDays.length, 1);
});

test('another user gets 404 (not 403/200) for get and delete, and the plan survives', async () => {
  const created = await alice.request('POST', '/plans', validPlan());
  const planId = created.body.plan._id;
  assert.equal((await bob.request('GET', `/plans/${planId}`)).status, 404);
  assert.equal((await bob.request('DELETE', `/plans/${planId}`)).status, 404);
  assert.equal((await alice.request('GET', `/plans/${planId}`)).status, 200);
});

test('malformed or unknown plan ids return 404', async () => {
  assert.equal((await alice.request('GET', '/plans/not-an-id')).status, 404);
  assert.equal((await alice.request('GET', '/plans/507f1f77bcf86cd799439011')).status, 404);
  assert.equal((await alice.request('DELETE', '/plans/507f1f77bcf86cd799439011')).status, 404);
});

test('delete removes the plan and cascades to its topics and schedule days', async () => {
  const created = await alice.request('POST', '/plans', validPlan());
  const planId = created.body.plan._id;
  await Topic.create({ planId, name: 'Trees' });
  await ScheduleDay.create({ planId, date: new Date(), topicIds: [] });

  const del = await alice.request('DELETE', `/plans/${planId}`);
  assert.equal(del.status, 200);
  assert.equal((await alice.request('GET', `/plans/${planId}`)).status, 404);
  assert.equal(await Topic.countDocuments({ planId }), 0);
  assert.equal(await ScheduleDay.countDocuments({ planId }), 0);
});
