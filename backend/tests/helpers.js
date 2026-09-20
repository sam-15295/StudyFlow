// Test helpers: boots the real Express app against a throwaway test database
// (never the dev database) and provides a tiny cookie-aware HTTP client.
process.env.MONGO_URI = 'mongodb://localhost:27017/StudyFlow_test';
require('dotenv').config(); // fills JWT_SECRET etc.; does not override MONGO_URI set above

const mongoose = require('mongoose');
const app = require('../app');

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

module.exports = { startTestServer, createClient, createLoggedInClient, dateFromToday };
