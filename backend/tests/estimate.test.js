const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createLoggedInClient, createClient, dateFromToday, mockLlm } = require('./helpers');
const { BadOutputError } = require('../service/llm');
const { buildValidator, normalizeName } = require('../service/agents/estimatorAgent');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');
const Plan = require('../model/planSchema');

let srv, alice, bob, mock;

async function planWithTopics(client, names = ['Arrays', 'Linked Lists', 'Trees']) {
  const res = await client.request('POST', '/plans', {
    syllabusRaw: 'anything',
    examDate: dateFromToday(10),
    dailyHours: 2,
  });
  const planId = res.body.plan._id;
  for (const name of names) await Topic.create({ planId, name }); // sequential => stable _id order
  return planId;
}
const est = (name, difficulty, estHours) => ({ name, difficulty, estHours });

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

// ---------- validator (pure) ----------

test('normalizeName ignores case, punctuation and spacing', () => {
  assert.equal(normalizeName('  Big-O   Notation! '), normalizeName('big o notation'));
  assert.equal(normalizeName('Graphs (BFS/DFS)'), normalizeName('graphs bfs dfs'));
});

test('validator matches by name, so a reordered reply still maps correctly', () => {
  const validate = buildValidator(['A', 'B', 'C']);
  const out = validate([est('C', 5, 6), est('A', 1, 1), est('B', 3, 3)]);
  assert.deepEqual(out, [
    { name: 'A', difficulty: 1, estHours: 1 },
    { name: 'B', difficulty: 3, estHours: 3 },
    { name: 'C', difficulty: 5, estHours: 6 },
  ]);
});

test('validator tolerates case/punctuation differences, extra entries and duplicates (first wins)', () => {
  const validate = buildValidator(['Big-O Notation', 'Trees']);
  const out = validate([est('big o notation', 2, 1), est('TREES', 4, 3), est('Trees', 1, 9), est('Not asked for', 5, 5)]);
  assert.deepEqual(out, [
    { name: 'Big-O Notation', difficulty: 2, estHours: 1 },
    { name: 'Trees', difficulty: 4, estHours: 3 },
  ]);
});

test('validator clamps and rounds out-of-range values and accepts numeric strings', () => {
  const validate = buildValidator(['A', 'B', 'C', 'D']);
  const out = validate([est('A', 9, 100), est('B', 0, 0.1), est('C', 2.6, 2.4), est('D', '4', '2.5')]);
  assert.deepEqual(
    out.map((o) => [o.difficulty, o.estHours]),
    [[5, 40], [1, 0.25], [3, 2.5], [4, 2.5]]
  );
});

test('validator rejects (BadOutputError) missing topics, bad numbers, and non-arrays', () => {
  const validate = buildValidator(['A', 'B']);
  assert.throws(() => validate([est('A', 2, 1)]), /missing "B"/);
  assert.throws(() => validate([est('A', 2, 1), est('B', 'hard', 2)]), BadOutputError);
  assert.throws(() => validate([est('A', 2, 1), est('B', 2, 0)]), BadOutputError);
  assert.throws(() => validate([est('A', 2, 1), est('B', 2, -3)]), BadOutputError);
  assert.throws(() => validate([est('A', 2, 1), est('B', null, 2)]), BadOutputError);
  assert.throws(() => validate({ estimates: [] }), BadOutputError);
  assert.throws(() => validate([null, 5, 'x']), BadOutputError);
});

// ---------- POST /plans/:id/estimate ----------

test('estimate stores difficulty and hours in one batched LLM call', async () => {
  const planId = await planWithTopics(alice);
  mock = mockLlm([JSON.stringify([est('Arrays', 2, 2), est('Linked Lists', 3, 3.5), est('Trees', 4, 5)])]);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.topics.map((t) => [t.name, t.difficulty, t.estHours]), [
    ['Arrays', 2, 2],
    ['Linked Lists', 3, 3.5],
    ['Trees', 4, 5],
  ]);
  assert.equal(mock.calls.length, 1); // ONE call for all topics, not one per topic
  assert.match(JSON.stringify(mock.calls[0].messages), /Linked Lists/);
  const stored = await Topic.find({ planId }).sort({ _id: 1 });
  assert.deepEqual(stored.map((t) => t.difficulty), [2, 3, 4]);
});

test('estimate handles a reordered reply by name', async () => {
  const planId = await planWithTopics(alice);
  mock = mockLlm([JSON.stringify([est('Trees', 5, 6), est('Arrays', 1, 1), est('Linked Lists', 3, 3)])]);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 200);
  const byName = Object.fromEntries(res.body.topics.map((t) => [t.name, t.difficulty]));
  assert.deepEqual(byName, { Arrays: 1, 'Linked Lists': 3, Trees: 5 });
});

test('estimate strips code fences from the reply', async () => {
  const planId = await planWithTopics(alice, ['Arrays']);
  mock = mockLlm(['```json\n[{"name":"Arrays","difficulty":2,"estHours":1.5}]\n```']);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 200);
  assert.equal(res.body.topics[0].estHours, 1.5);
});

test('estimate retries once when a topic is missing from the first reply', async () => {
  const planId = await planWithTopics(alice);
  mock = mockLlm([
    JSON.stringify([est('Arrays', 2, 2)]), // count mismatch
    JSON.stringify([est('Arrays', 2, 2), est('Linked Lists', 3, 3), est('Trees', 4, 4)]),
  ]);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 200);
  assert.equal(mock.calls.length, 2);
  assert.match(mock.calls[1].messages[3].content, /missing "Linked Lists"/);
});

test('if the model still omits topics after the retry: 502, and topics stay un-estimated', async () => {
  const planId = await planWithTopics(alice);
  mock = mockLlm([JSON.stringify([est('Arrays', 2, 2)])]);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 502);
  assert.equal(mock.calls.length, 2);
  const stored = await Topic.find({ planId });
  assert.ok(stored.every((t) => t.difficulty === null && t.estHours === null));
});

test('estimate with no topics returns 400 without calling the LLM', async () => {
  const planId = await planWithTopics(alice, []);
  mock = mockLlm(['[]']);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /extract/i);
  assert.equal(mock.calls.length, 0);
});

test('re-estimating clears a stale schedule and returns the plan to draft', async () => {
  const planId = await planWithTopics(alice, ['Arrays']);
  await Plan.updateOne({ _id: planId }, { status: 'active' });
  await ScheduleDay.create({ planId, date: new Date(), topicIds: [] });
  mock = mockLlm(['[{"name":"Arrays","difficulty":2,"estHours":1}]']);
  const res = await alice.request('POST', `/plans/${planId}/estimate`);
  assert.equal(res.status, 200);
  assert.equal(await ScheduleDay.countDocuments({ planId }), 0);
  assert.equal((await Plan.findById(planId)).status, 'draft');
});

test('estimate is protected: 401 logged out, 404 for another user\'s plan (no LLM call)', async () => {
  const planId = await planWithTopics(alice);
  mock = mockLlm(['[]']);
  assert.equal((await createClient(srv.baseUrl).request('POST', `/plans/${planId}/estimate`)).status, 401);
  assert.equal((await bob.request('POST', `/plans/${planId}/estimate`)).status, 404);
  assert.equal(mock.calls.length, 0);
});
