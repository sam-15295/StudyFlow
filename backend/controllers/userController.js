const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../model/userSchema');

const COOKIE_NAME = 'token';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // Frontend and API are on different sites in production, so the cookie must be SameSite=None.
    sameSite: isProd ? 'none' : 'lax',
    maxAge: SEVEN_DAYS_MS,
  };
}

function issueToken(res, user) {
  const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

// Only accept real strings (blocks objects like { "$gt": "" } from reaching MongoDB queries).
function readCredentials(body) {
  const { email, password } = body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  return { email: email.trim().toLowerCase(), password };
}

async function signup(req, res) {
  const creds = readCredentials(req.body);
  if (!creds || !EMAIL_RE.test(creds.email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (creds.password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const passwordHash = await bcrypt.hash(creds.password, 10);
  try {
    const user = await User.create({ email: creds.email, passwordHash });
    issueToken(res, user);
    return res.status(201).json({ user: { id: user._id, email: user.email } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    throw err;
  }
}

async function login(req, res) {
  const creds = readCredentials(req.body);
  if (!creds) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await User.findOne({ email: creds.email });
  const ok = user && (await bcrypt.compare(creds.password, user.passwordHash));
  if (!ok) {
    // Same message for unknown email and wrong password, so accounts can't be enumerated.
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  issueToken(res, user);
  return res.json({ user: { id: user._id, email: user.email } });
}

function logout(req, res) {
  const { maxAge, ...clearOptions } = cookieOptions();
  res.clearCookie(COOKIE_NAME, clearOptions);
  return res.json({ message: 'Logged out' });
}

function me(req, res) {
  return res.json({ user: req.user });
}

module.exports = { signup, login, logout, me, COOKIE_NAME };
