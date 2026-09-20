// Test helpers: boots the real Express app against a throwaway test database
// (never the dev database) and provides a tiny cookie-aware HTTP client.
process.env.MONGO_URI = 'mongodb://localhost:27017/StudyFlow_test';
// Tests must never spend the real OpenRouter key/model: dotenv below does not override these.
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test/model:free';
require('dotenv').config({ quiet: true }); // fills JWT_SECRET etc.

const mongoose = require('mongoose');
const app = require('../app');
const llm = require('../service/llm');

llm.config.retryDelayMs = 0; // don't wait between LLM retries in tests

async function startTestServer() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // build unique indexes

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    },
  };
}

// Minimal client that remembers the `token` cookie like a browser would.
function createClient(baseUrl) {
  let cookie = null;
  return {
    setCookie(value) {
      cookie = value;
    },
    getCookie() {
      return cookie;
    },
    async request(method, path, body, { rawBody } = {}) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      let payload;
      if (rawBody !== undefined) {
        headers['content-type'] = 'application/json';
        payload = rawBody;
      } else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(baseUrl + path, { method, headers, body: payload });
      const setCookies = res.headers.getSetCookie();
      const tokenCookie = setCookies.find((c) => c.startsWith('token='));
      if (tokenCookie) {
        const value = tokenCookie.split(';')[0];
        cookie = value === 'token=' ? null : value; // cleared cookie -> logged out
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // non-JSON response
      }
      return { status: res.status, body: json, setCookies };
    },
  };
}

// A client that is already signed up and logged in.
async function createLoggedInClient(baseUrl, email) {
  const client = createClient(baseUrl);
  const res = await client.request('POST', '/auth/signup', { email, password: 'password123' });
  if (res.status !== 201) throw new Error(`test signup failed: ${res.status}`);
  return client;
}

// "YYYY-MM-DD" for N days from today (UTC), matching how the API reads dates.
function dateFromToday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Replaces fetch for OpenRouter calls only (requests to the test server pass through).
 * Each step answers one LLM call; the last step repeats if more calls are made:
 *   'text'                 -> 200 with that message content
 *   { status: 429 }        -> that HTTP status with an empty body (or { status, text } for a body)
 *   { body: {...} }        -> 200 with that raw JSON body
 *   new Error('...')       -> fetch itself throws (network failure)
 * Returns { calls, restore } where calls holds every parsed request body.
 */
function mockLlm(steps) {
  const realFetch = global.fetch;
  const calls = [];
  let i = 0;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://openrouter.ai')) return realFetch(url, opts);
    calls.push(JSON.parse(opts.body));
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'string') {
      return new Response(JSON.stringify({ choices: [{ message: { content: step } }] }), { status: 200 });
    }
    if (step.body) return new Response(JSON.stringify(step.body), { status: 200 });
    return new Response(step.text || '{}', { status: step.status });
  };
  return { calls, restore: () => (global.fetch = realFetch) };
}

module.exports = { startTestServer, createClient, createLoggedInClient, dateFromToday, mockLlm };
