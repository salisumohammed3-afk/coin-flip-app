'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.filesDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'langsync-sign.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  is_template INTEGER NOT NULL DEFAULT 0,
  sequential INTEGER NOT NULL DEFAULT 0,
  allow_markup INTEGER NOT NULL DEFAULT 1,
  expires_days INTEGER NOT NULL DEFAULT 30,
  reminder_days INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  final_file TEXT,
  final_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'signer',
  routing_order INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#8B36FE',
  access_code TEXT,
  private_message TEXT,
  token TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created',
  sent_at TEXT,
  viewed_at TEXT,
  consented_at TEXT,
  completed_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  last_reminded_at TEXT,
  signature_image TEXT,
  initials_image TEXT,
  ip TEXT,
  user_agent TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  page INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  value TEXT,
  filled_at TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  page INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  envelope_id TEXT REFERENCES envelopes(id) ON DELETE CASCADE,
  owner_id TEXT,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_env_owner ON envelopes(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_docs_env ON documents(envelope_id);
CREATE INDEX IF NOT EXISTS idx_rec_env ON recipients(envelope_id);
CREATE INDEX IF NOT EXISTS idx_fields_env ON fields(envelope_id);
CREATE INDEX IF NOT EXISTS idx_ann_env ON annotations(envelope_id);
CREATE INDEX IF NOT EXISTS idx_events_env ON events(envelope_id, id);
CREATE INDEX IF NOT EXISTS idx_emails_owner ON emails(owner_id, created_at);
`);

const now = () => new Date().toISOString();
const uid = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
const token = () => crypto.randomBytes(32).toString('base64url');

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function logEvent(envelopeId, { recipientId = null, actor, type, detail = '', ip = null, userAgent = null }) {
  run(
    `INSERT INTO events (envelope_id, recipient_id, actor, type, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    envelopeId, recipientId, actor, type, detail, ip, userAgent, now()
  );
}

module.exports = { db, all, get, run, transaction, now, uid, token, logEvent };
