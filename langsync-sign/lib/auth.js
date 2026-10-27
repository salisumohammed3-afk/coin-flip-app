'use strict';

const crypto = require('crypto');
const { get, run, now, uid, token } = require('./db');
const config = require('./config');

const SESSION_COOKIE = 'lss_session';
const SESSION_DAYS = 14;

const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 30;

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

// Emails the code. Swappable so tests can read the code without a mail provider.
let codeSender = async (email, code) => require('./mailer').sendCode(email, code);
function setCodeSender(fn) { codeSender = fn; }

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/** Who may sign in: anyone who already has an account, or a new address on an allowed domain. */
async function mayEnter(email) {
  if (await get('SELECT id FROM users WHERE email = ?', email)) return true;
  if (!config.allowSignup) return false;
  return !config.signupDomains.length || config.signupDomains.includes(email.split('@')[1]);
}

/**
 * Step one: email a six-digit sign-in code. Answers the same way whether or not the
 * address may sign in, so it never reveals who has an account.
 */
async function requestCode({ email }) {
  email = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email.');
  if (!(await mayEnter(email))) return;
  const pending = await get('SELECT created_at FROM login_codes WHERE email = ?', email);
  if (pending && Date.now() - Date.parse(pending.created_at) < CODE_RESEND_SECONDS * 1000) {
    throw httpError(429, 'A code was just sent. Wait a few seconds before asking for another.');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expires = new Date(Date.now() + CODE_MINUTES * 60e3).toISOString();
  await run('DELETE FROM login_codes WHERE email = ?', email);
  await run('INSERT INTO login_codes (email, code_hash, attempts, created_at, expires_at) VALUES (?, ?, 0, ?, ?)', email, sha256(code), now(), expires);
  await codeSender(email, code);
}

/** Step two: check the code. A first sign-in creates the account. */
async function verifyCode({ email, code }) {
  email = normalizeEmail(email);
  code = String(code || '').replace(/\D/g, '');
  const row = await get('SELECT * FROM login_codes WHERE email = ?', email);
  if (!row || row.expires_at < now()) throw httpError(400, 'Your code expired. Request a new one.');
  if (code.length !== 6 || sha256(code) !== row.code_hash) {
    const attempts = row.attempts + 1;
    if (attempts >= CODE_MAX_ATTEMPTS) {
      await run('DELETE FROM login_codes WHERE email = ?', email);
      throw httpError(400, 'Too many attempts. Request a new code.');
    }
    await run('UPDATE login_codes SET attempts = ? WHERE email = ?', attempts, email);
    const left = CODE_MAX_ATTEMPTS - attempts;
    throw httpError(400, `Incorrect code. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }
  await run('DELETE FROM login_codes WHERE email = ?', email);
  const user = await get('SELECT id, email, name FROM users WHERE email = ?', email);
  if (user) return user;
  if (!(await mayEnter(email))) throw httpError(403, 'This email cannot sign in to LangSync Sign.');
  const id = uid('u_');
  const name = email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || email;
  await run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', id, email, name, now());
  return { id, email, name };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createSession, destroySession, currentUser, requireUser, requestCode, verifyCode, setCodeSender, httpError };
