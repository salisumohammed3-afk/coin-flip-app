'use strict';

const crypto = require('crypto');
const { get, run, now, uid, token } = require('./db');
const config = require('./config');

const SESSION_COOKIE = 'lss_session';
const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

async function createSession(res, userId) {
  const raw = token();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(raw), userId, expires);
  res.setHeader('Set-Cookie', cookieString(raw, SESSION_DAYS * 86400));
}

async function destroySession(req, res) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (raw) await run('DELETE FROM sessions WHERE token_hash = ?', sha256(raw));
  res.setHeader('Set-Cookie', cookieString('', 0));
}

async function currentUser(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const row = await get(
    `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(raw)
  );
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

function requireUser(req, res, next) {
  currentUser(req)
    .then((user) => {
      if (!user) return res.status(401).json({ error: 'Please sign in.' });
      req.user = user;
      next();
    })
    .catch(next);
}

async function register({ name, email, password }) {
  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!config.allowSignup) throw httpError(403, 'Sign-ups are disabled. Ask an admin for an account.');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter your name and a valid email.');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  if (config.signupDomains.length && !config.signupDomains.includes(email.split('@')[1])) {
    throw httpError(403, `Sign-ups are limited to: ${config.signupDomains.join(', ')}`);
  }
  if (await get('SELECT id FROM users WHERE email = ?', email)) throw httpError(409, 'An account with that email already exists.');
  const id = uid('u_');
  await run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, email, name, hashPassword(password), now());
  return { id, email, name };
}

async function login({ email, password }) {
  const user = await get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) throw httpError(401, 'Incorrect email or password.');
  return { id: user.id, email: user.email, name: user.name };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createSession, destroySession, currentUser, requireUser, register, login, httpError, hashPassword };
