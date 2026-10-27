'use strict';

// Async data layer with two backends:
//  - Postgres (DATABASE_URL set): production on Supabase, tables in the `sign` schema.
//  - SQLite via node:sqlite: local development and tests, zero setup.
// Queries are written once with `?` placeholders; the Postgres adapter rewrites them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const now = () => new Date().toISOString();
const uid = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
const token = () => crypto.randomBytes(32).toString('base64url');

const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');

function makeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, 'langsync-sign.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // The shared schema is Postgres-flavoured; adapt the few differences.
  db.exec(
    fs.readFileSync(SCHEMA_FILE, 'utf8')
      .replace(/CREATE SCHEMA[^;]*;/gi, '')
      .replace(/SET search_path[^;]*;/gi, '')
      .replace(/INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
      .replace(/DOUBLE PRECISION/gi, 'REAL')
  );
  const q = {
    all: async (sql, ...p) => db.prepare(sql).all(...p),
    get: async (sql, ...p) => db.prepare(sql).get(...p),
    run: async (sql, ...p) => ({ changes: Number(db.prepare(sql).run(...p).changes) }),
  };
  let chain = Promise.resolve();
  return {
    ...q,
    kind: 'sqlite',
    // Serialise transactions: node:sqlite is a single connection.
    transaction(fn) {
      const job = chain.then(async () => {
        db.exec('BEGIN');
        try {
          const out = await fn(q);
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
      chain = job.catch(() => {});
      return job;
    },
  };
}

function makePostgres() {
  const postgres = require('postgres');
  const sql = postgres(config.databaseUrl, {
    max: 3,
    ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : 'require',
    prepare: false, // required by Supabase's transaction pooler
    idle_timeout: 20,
    connection: { search_path: 'sign' },
  });
  const toPg = (text) => {
    let i = 0;
    return text.replace(/\?/g, () => `$${++i}`).replace(/\bLIKE\b/g, 'ILIKE');
  };
  const wrap = (conn) => ({
    all: async (text, ...p) => [...(await conn.unsafe(toPg(text), p))],
    get: async (text, ...p) => (await conn.unsafe(toPg(text), p))[0],
    run: async (text, ...p) => ({ changes: (await conn.unsafe(toPg(text), p)).count }),
  });
  return {
    ...wrap(sql),
    kind: 'postgres',
    transaction: (fn) => sql.begin((tx) => fn(wrap(tx))),
  };
}

const db = config.databaseUrl ? makePostgres() : makeSqlite();

function logEvent(envelopeId, { recipientId = null, actor, type, detail = '', ip = null, userAgent = null }, q = db) {
  return q.run(
    `INSERT INTO events (envelope_id, recipient_id, actor, type, detail, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    envelopeId, recipientId, actor, type, detail, ip, userAgent, now()
  );
}

module.exports = {
  db,
  all: db.all,
  get: db.get,
  run: db.run,
  transaction: db.transaction,
  now, uid, token, logEvent,
};
