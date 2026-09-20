const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient } = require('./helpers');

let srv;
const creds = { email: 'Student@Example.com', password: 'password123' };

before(async () => {
  srv = await startTestServer();
});
after(async () => {
  await srv.close();
});

test('signup creates a user and sets an httpOnly cookie', async () => {
  const c = createClient(srv.baseUrl);
  const res = await c.request('POST', '/auth/signup', creds);
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'student@example.com'); // normalised to lowercase
  assert.ok(!('passwordHash' in res.body.user));
  const cookie = res.setCookies.find((s) => s.startsWith('token='));
  assert.ok(cookie, 'token cookie set');
  assert.match(cookie, /HttpOnly/i);
});

test('signup rejects duplicate email (409), even with different case', async () => {
  const c = createClient(srv.baseUrl);
  const res = await c.request('POST', '/auth/signup', { ...creds, email: 'STUDENT@example.com' });
  assert.equal(res.status, 409);
});

test('signup rejects bad email, short password, missing fields', async () => {
  const c = createClient(srv.baseUrl);
  assert.equal((await c.request('POST', '/auth/signup', { email: 'nope', password: 'password123' })).status, 400);
  assert.equal((await c.request('POST', '/auth/signup', { email: 'a@b.com', password: 'short' })).status, 400);
  assert.equal((await c.request('POST', '/auth/signup', {})).status, 400);
});

test('non-string credentials (NoSQL injection attempt) are rejected', async () => {
  const c = createClient(srv.baseUrl);
  const res = await c.request('POST', '/auth/login', { email: { $gt: '' }, password: { $gt: '' } });
  assert.equal(res.status, 400);
});

test('malformed JSON body returns 400', async () => {
  const c = createClient(srv.baseUrl);
  const res = await c.request('POST', '/auth/login', undefined, { rawBody: '{bad json' });
  assert.equal(res.status, 400);
});

test('login succeeds with correct credentials and /auth/me returns the user', async () => {
  const c = createClient(srv.baseUrl);
  const login = await c.request('POST', '/auth/login', creds);
  assert.equal(login.status, 200);
  const me = await c.request('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'student@example.com');
});

test('login fails with wrong password and unknown email (same 401 message)', async () => {
  const c = createClient(srv.baseUrl);
  const wrongPw = await c.request('POST', '/auth/login', { ...creds, password: 'wrongpassword' });
  const unknown = await c.request('POST', '/auth/login', { email: 'nobody@example.com', password: 'password123' });
  assert.equal(wrongPw.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrongPw.body.error, unknown.body.error);
});

test('/auth/me without a cookie, or with a tampered cookie, is 401', async () => {
  const c = createClient(srv.baseUrl);
  assert.equal((await c.request('GET', '/auth/me')).status, 401);
  c.setCookie('token=not.a.real.jwt');
  assert.equal((await c.request('GET', '/auth/me')).status, 401);
});

test('logout clears the cookie so /auth/me is 401 again', async () => {
  const c = createClient(srv.baseUrl);
  await c.request('POST', '/auth/login', creds);
  assert.equal((await c.request('GET', '/auth/me')).status, 200);
  const out = await c.request('POST', '/auth/logout');
  assert.equal(out.status, 200);
  assert.equal(c.getCookie(), null);
  assert.equal((await c.request('GET', '/auth/me')).status, 401);
});
