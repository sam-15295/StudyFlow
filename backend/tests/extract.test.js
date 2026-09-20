const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createLoggedInClient, createClient, dateFromToday, mockLlm } = require('./helpers');
const { parseJsonLoose, BadOutputError } = require('../service/llm');
const { cleanTopics } = require('../service/agents/extractorAgent');
const Topic = require('../model/topicSchema');
const ScheduleDay = require('../model/scheduleDaySchema');

let srv, alice, bob, mock;

async function newPlan(client, syllabusRaw = 'Unit 1: Arrays\nUnit 2: Linked lists\nUnit 3: Trees') {
  const res = await client.request('POST', '/plans', { syllabusRaw, examDate: dateFromToday(10), dailyHours: 2 });
  return res.body.plan._id;
}

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

// ---------- defensive parsing (pure functions) ----------

test('parseJsonLoose handles plain JSON, code fences, and prose around the JSON', () => {
  assert.deepEqual(parseJsonLoose('["A","B"]', 'array'), ['A', 'B']);
  assert.deepEqual(parseJsonLoose('```json\n["A","B"]\n```', 'array'), ['A', 'B']);
  assert.deepEqual(parseJsonLoose('```\n["A"]\n```', 'array'), ['A']);
  assert.deepEqual(parseJsonLoose('Sure! Here you go:\n["A","B"]\nHope that helps.', 'array'), ['A', 'B']);
  assert.deepEqual(parseJsonLoose('Result: {"a":1} done', 'object'), { a: 1 });
});

test('parseJsonLoose throws BadOutputError on garbage or empty input', () => {
  for (const bad of ['', '   ', 'no json here', '[unclosed', null, undefined]) {
    assert.throws(() => parseJsonLoose(bad, 'array'), BadOutputError);
  }
});

test('cleanTopics trims, dedupes case-insensitively, accepts {name} objects, and caps the count', () => {
  assert.deepEqual(cleanTopics(['  Arrays  ', 'arrays', 'Linked   Lists', { name: 'Trees' }, '', 5, null]), [
    'Arrays',
    'Linked Lists',
    'Trees',
  ]);
  assert.equal(cleanTopics(Array.from({ length: 100 }, (_, i) => `Topic ${i}`)).length, 40);
  assert.deepEqual(cleanTopics([]), []); // "no topics" is a valid answer
  assert.throws(() => cleanTopics({ topics: [] }), BadOutputError);
  assert.throws(() => cleanTopics([1, 2, null]), BadOutputError);
});

// ---------- POST /plans/:id/extract ----------

test('extract saves topics in order and returns them', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm(['["Arrays","Linked Lists","Trees"]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.topics.map((t) => t.name), ['Arrays', 'Linked Lists', 'Trees']);
  assert.equal(res.body.topics[0].status, 'pending');
  assert.equal(res.body.topics[0].difficulty, null);

  const stored = await Topic.find({ planId }).sort({ _id: 1 });
  assert.deepEqual(stored.map((t) => t.name), ['Arrays', 'Linked Lists', 'Trees']);

  // The request carried the syllabus and used the model from env, not a hardcoded one.
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].model, 'test/model:free');
  assert.deepEqual(mock.calls[0].reasoning, { enabled: false });
  assert.match(JSON.stringify(mock.calls[0].messages), /Unit 2: Linked lists/);
});

test('extract copes with JSON wrapped in markdown fences and chatter', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm(['Here are the topics:\n```json\n["Sorting","Searching"]\n```']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.topics.map((t) => t.name), ['Sorting', 'Searching']);
  assert.equal(mock.calls.length, 1);
});

test('extract retries once when the first reply is not valid JSON, telling the model what was wrong', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm(['I could not do that, sorry', '["Graphs"]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.topics.map((t) => t.name), ['Graphs']);
  assert.equal(mock.calls.length, 2);
  const retryMessages = mock.calls[1].messages;
  assert.equal(retryMessages.length, 4); // system, user, bad assistant reply, correction
  assert.equal(retryMessages[2].content, 'I could not do that, sorry');
});

test('extract retries when the reply is JSON of the wrong shape', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm(['{"topics":["A"]}', '["A"]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.equal(mock.calls.length, 2);
});

test('extract retries when the model returns empty content', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm([{ body: { choices: [{ message: { content: null } }] } }, '["Recursion"]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.equal(mock.calls.length, 2);
});

test('after two invalid replies extract returns 502 and existing topics are kept', async () => {
  const planId = await newPlan(alice);
  await Topic.create({ planId, name: 'Existing topic' });
  mock = mockLlm(['nope', 'still nope']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /invalid response/i);
  assert.equal(mock.calls.length, 2); // exactly one retry, never more
  assert.deepEqual((await Topic.find({ planId })).map((t) => t.name), ['Existing topic']);
});

test('a rate limit (429) is retried once, then succeeds', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm([{ status: 429 }, '["Hashing"]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.equal(mock.calls.length, 2);
});

test('a persistent rate limit returns 503 with a friendly message', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm([{ status: 429 }]);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /busy|rate/i);
  assert.equal(mock.calls.length, 2);
});

test('a daily-limit 429 is not retried and says so clearly', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm([{ status: 429, text: '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}' }]);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /daily request limit/i);
  assert.equal(mock.calls.length, 1); // waiting a moment won't help, so no retry
});

test('a network failure is retried once, then reported as 502', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm([new Error('socket hang up')]);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 502);
  assert.equal(mock.calls.length, 2);
  assert.ok(!JSON.stringify(res.body).includes('socket hang up')); // internals not leaked
});

test('a rejected key (401) is not retried and never leaks the key', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm([{ status: 401 }]);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 502);
  assert.equal(mock.calls.length, 1);
  assert.ok(!JSON.stringify(res.body).includes('test-key'));
});

test('missing LLM configuration returns 500 without calling the network', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm(['["X"]']);
  const saved = process.env.LLM_MODEL;
  process.env.LLM_MODEL = '';
  try {
    const res = await alice.request('POST', `/plans/${planId}/extract`);
    assert.equal(res.status, 500);
    assert.equal(mock.calls.length, 0);
  } finally {
    process.env.LLM_MODEL = saved;
  }
});

test('an empty topic list gives 422 and keeps existing topics', async () => {
  const planId = await newPlan(alice, 'hello');
  await Topic.create({ planId, name: 'Existing topic' });
  mock = mockLlm(['[]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 422);
  assert.equal(mock.calls.length, 1); // an empty list is a valid answer, not retried
  assert.equal(await Topic.countDocuments({ planId }), 1);
});

test('re-extracting replaces old topics and clears the stale schedule', async () => {
  const planId = await newPlan(alice);
  const [old] = await Topic.create([{ planId, name: 'Old topic' }]);
  await ScheduleDay.create({ planId, date: new Date(), topicIds: [old._id] });
  mock = mockLlm(['["New A","New B"]']);
  const res = await alice.request('POST', `/plans/${planId}/extract`);
  assert.equal(res.status, 200);
  assert.deepEqual((await Topic.find({ planId }).sort({ _id: 1 })).map((t) => t.name), ['New A', 'New B']);
  assert.equal(await ScheduleDay.countDocuments({ planId }), 0);
});

test('extract is protected: 401 when logged out, 404 for someone else\'s plan (no LLM call made)', async () => {
  const planId = await newPlan(alice);
  mock = mockLlm(['["X"]']);
  assert.equal((await createClient(srv.baseUrl).request('POST', `/plans/${planId}/extract`)).status, 401);
  assert.equal((await bob.request('POST', `/plans/${planId}/extract`)).status, 404);
  assert.equal(mock.calls.length, 0);
});
