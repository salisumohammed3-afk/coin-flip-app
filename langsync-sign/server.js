'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('./lib/config');
const { all, get, run, now, uid, token, transaction, logEvent } = require('./lib/db');
const auth = require('./lib/auth');
const { httpError } = auth;
const { normalizeUpload, sha256 } = require('./lib/pdf');
const wf = require('./lib/workflow');
const storage = require('./lib/storage');
const { smtpEnabled, provider } = require('./lib/mailer');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || (process.env.VERCEL ? true : 'loopback'));
app.disable('x-powered-by');

const connectSrc = ["'self'", config.supabase?.url].filter(Boolean).join(' ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Signing links carry secrets in the URL; never leak them via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      `font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${connectSrc}; frame-ancestors 'none'`
  );
  next();
});

app.use(express.json({ limit: '4mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });

// Express 4 doesn't catch rejected promises; route every async handler through this.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clientInfo = (req) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });

// Secret used to sign access-code cookies for recipients.
const SECRET = config.appSecret || (() => {
  const file = path.join(config.dataDir, 'secret.key');
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
})();

const FIELD_TYPES = ['signature', 'initials', 'date_signed', 'full_name', 'email', 'company', 'title', 'text', 'checkbox', 'date', 'dropdown', 'radio', 'approve', 'decline', 'stamp'];
// Fields that are filled automatically or are buttons, so "required" doesn't apply.
const NOT_REQUIRABLE = ['date_signed', 'email', 'approve', 'decline'];
const ANNOTATION_KINDS = ['pen', 'highlight', 'rect', 'line', 'text', 'note'];
const ROLES = ['signer', 'approver', 'cc'];
const EDITABLE = (e) => e.status === 'draft' || e.is_template;
const IMG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ----------------------------- serializers ----------------------------- */

function recipientSummary(r) {
  return {
    id: r.id, name: r.name, email: r.email, role: r.role, routing_order: r.routing_order, color: r.color, status: r.status,
    sent_at: r.sent_at, viewed_at: r.viewed_at, completed_at: r.completed_at, declined_at: r.declined_at, decline_reason: r.decline_reason,
  };
}

function senderView(full) {
  const { envelope: e, documents, recipients, fields, annotations, events, owner } = full;
  return {
    ...envelopeSummary(e),
    subject: e.subject, message: e.message, sequential: !!e.sequential, allow_markup: !!e.allow_markup,
    expires_days: e.expires_days, reminder_days: e.reminder_days, void_reason: e.void_reason, final_sha256: e.final_sha256,
    owner,
    documents: documents.map((d) => ({ id: d.id, name: d.name, page_count: d.page_count, size: d.size, sha256: d.sha256 })),
    recipients: recipients.map((r) => ({
      ...recipientSummary(r), sort: r.sort, access_code: r.access_code || '', private_message: r.private_message || '',
      // Only once it's the recipient's turn, so a sequential envelope can't be shared out of order.
      link: r.token && e.status === 'sent' && r.status !== 'created' ? `${config.baseUrl}/s/${r.token}` : null,
      ip: r.ip, signature_image: r.signature_image,
    })),
    fields: fields.map(fieldOut),
    annotations: annotations.map(annotationOut),
    events: events.map((ev) => ({ id: ev.id, actor: ev.actor, type: ev.type, detail: ev.detail, ip: ev.ip, created_at: ev.created_at, recipient_id: ev.recipient_id })),
  };
}

function envelopeSummary(e) {
  return {
    id: e.id, title: e.title, status: e.status, is_template: !!e.is_template, created_at: e.created_at, updated_at: e.updated_at,
    sent_at: e.sent_at, completed_at: e.completed_at, expires_at: e.expires_at, has_final: !!e.final_file,
  };
}

const fieldOut = (f) => ({
  id: f.id, document_id: f.document_id, recipient_id: f.recipient_id, type: f.type, page: f.page,
  x: f.x, y: f.y, w: f.w, h: f.h, required: !!f.required, label: f.label,
  options: Array.isArray(f.options) ? f.options : f.options ? JSON.parse(f.options) : null,
  value: f.value, filled_at: f.filled_at,
});
const annotationOut = (a) => ({
  id: a.id, document_id: a.document_id, author_type: a.author_type, author_id: a.author_id, author_name: a.author_name,
  kind: a.kind, page: a.page, data: a.data, created_at: a.created_at,
});

async function ownedEnvelope(req) {
  const e = await get('SELECT * FROM envelopes WHERE id = ? AND owner_id = ?', req.params.id, req.user.id);
  if (!e) throw httpError(404, 'Envelope not found.');
  return e;
}

const view = async (id) => senderView(await wf.loadEnvelope(id));
const touch = (id) => run('UPDATE envelopes SET updated_at = ? WHERE id = ?', now(), id);
const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

function cleanAnnotation(a, docs) {
  if (!ANNOTATION_KINDS.includes(a.kind)) throw httpError(400, 'Unknown markup type.');
  const doc = docs.find((d) => d.id === a.document_id);
  if (!doc) throw httpError(400, 'Markup refers to an unknown document.');
  const page = Math.trunc(Number(a.page));
  if (!(page >= 0 && page < doc.page_count)) throw httpError(400, 'Markup is on an invalid page.');
  const d = a.data && typeof a.data === 'object' ? a.data : {};
  // Rebuild the payload from known keys only, so stamping never sees junk.
  const f = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const color = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#0099FF';
  const width = Math.min(0.02, Math.max(0.0005, Number(d.width) || 0.003));
  const text = String(d.text ?? '').slice(0, 2000);
  let data;
  if (a.kind === 'pen') {
    const points = (Array.isArray(d.points) ? d.points : []).slice(0, 2000).filter((p) => Array.isArray(p)).map((p) => [f(p[0]), f(p[1])]);
    if (points.length < 2) throw httpError(400, 'A pen stroke needs at least two points.');
    data = { points, color, width };
  } else if (a.kind === 'line') data = { x1: f(d.x1), y1: f(d.y1), x2: f(d.x2), y2: f(d.y2), color, width };
  else if (a.kind === 'highlight' || a.kind === 'rect') data = { x: f(d.x), y: f(d.y), w: f(d.w), h: f(d.h), color, width };
  else if (a.kind === 'text') data = { x: f(d.x), y: f(d.y), text, color, size: Math.min(0.1, Math.max(0.005, Number(d.size) || 0.018)) };
  else data = { x: f(d.x), y: f(d.y), text, color };
  if ((a.kind === 'text' || a.kind === 'note') && !text.trim()) throw httpError(400, 'Text markup cannot be empty.');
  return { kind: a.kind, document_id: doc.id, page, data: JSON.stringify(data) };
}

function cleanOptions(type, options) {
  const list = (Array.isArray(options) ? options : []).map((o) => String(o).trim().slice(0, 100)).filter(Boolean);
  if (type === 'dropdown') {
    const unique = [...new Set(list)].slice(0, 50);
    if (!unique.length) throw httpError(400, 'Give every dropdown at least one option.');
    return JSON.stringify(unique);
  }
  if (type === 'radio') return JSON.stringify([list[0] || 'Option']);
  return null;
}

/** Sends a stored file: a short-lived signed URL in production, a local stream in development. */
async function sendStored(res, key, name, asAttachment) {
  const filename = String(name).replace(/[^\w\s.()-]/g, '_');
  if (storage.signedDownloadUrl) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.redirect(302, await storage.signedDownloadUrl(key, filename, asAttachment));
  }
  const file = storage.localPath(key);
  if (!fs.existsSync(file)) throw httpError(404, 'File missing from storage.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(file).pipe(res);
}

/* -------------------------------- auth -------------------------------- */

app.get('/api/config', wrap(async (req, res) => {
  res.json({
    appName: config.appName, smtpEnabled, emailProvider: provider, allowSignup: config.allowSignup,
    signupDomains: config.signupDomains, hasUsers: !!(await get('SELECT 1 AS x FROM users LIMIT 1')),
    directUploads: Boolean(storage.signedUploadUrl), maxUploadMb: config.maxUploadMb,
  });
}));

app.post('/api/auth/register', wrap(async (req, res) => {
  const user = await auth.register(req.body || {});
  await auth.createSession(res, user.id);
  res.json({ user });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const user = await auth.login(req.body || {});
  await auth.createSession(res, user.id);
  res.json({ user });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

app.get('/api/auth/me', wrap(async (req, res) => res.json({ user: await auth.currentUser(req) })));

/* ------------------------------ envelopes ------------------------------ */

const api = express.Router();
api.use(auth.requireUser);

api.get('/stats', wrap(async (req, res) => {
  const rows = await all(`SELECT status, CAST(COUNT(*) AS INTEGER) AS n FROM envelopes WHERE owner_id = ? AND is_template = 0 GROUP BY status`, req.user.id);
  const soon = new Date(Date.now() + 3 * 864e5).toISOString();
  const expiring = await get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM envelopes WHERE owner_id = ? AND status = 'sent' AND expires_at IS NOT NULL AND expires_at < ?`, req.user.id, soon);
  const templates = await get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM envelopes WHERE owner_id = ? AND is_template = 1`, req.user.id);
  res.json({ counts: Object.fromEntries(rows.map((r) => [r.status, r.n])), expiring: expiring.n, templates: templates.n });
}));

api.get('/envelopes', wrap(async (req, res) => {
  const { status, q, template } = req.query;
  const params = [req.user.id, template === '1' ? 1 : 0];
  let sql = 'SELECT * FROM envelopes WHERE owner_id = ? AND is_template = ?';
  if (status && status !== 'all') { sql += ' AND status = ?'; params.push(String(status)); }
  if (q) {
    sql += ` AND (title LIKE ? OR id IN (SELECT envelope_id FROM recipients WHERE name LIKE ? OR email LIKE ?))`;
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY updated_at DESC LIMIT 500';
  const envelopes = await all(sql, ...params);
  const recipients = envelopes.length
    ? await all(`SELECT * FROM recipients WHERE envelope_id IN (${envelopes.map(() => '?').join(',')}) ORDER BY routing_order, sort`, ...envelopes.map((e) => e.id))
    : [];
  res.json({
    envelopes: envelopes.map((e) => ({ ...envelopeSummary(e), recipients: recipients.filter((r) => r.envelope_id === e.id).map(recipientSummary) })),
  });
}));

api.post('/envelopes', wrap(async (req, res) => {
  const id = uid('env_');
  const ts = now();
  const isTemplate = req.body?.template ? 1 : 0;
  const title = String(req.body?.title || (isTemplate ? 'Untitled template' : 'Untitled envelope')).slice(0, 200);
  await run(`INSERT INTO envelopes (id, owner_id, title, is_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, id, req.user.id, title, isTemplate, ts, ts);
  await logEvent(id, { actor: req.user.name, type: 'created', detail: isTemplate ? 'Template created' : 'Draft created' });
  res.json(await view(id));
}));

api.get('/envelopes/:id', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  res.json(await view(e.id));
}));

api.patch('/envelopes/:id', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  const b = req.body || {};
  if (!EDITABLE(e) && Object.keys(b).some((k) => k !== 'title')) throw httpError(409, 'Only the title can change after sending.');
  const next = {
    title: b.title !== undefined ? String(b.title).slice(0, 200) || 'Untitled envelope' : e.title,
    subject: b.subject !== undefined ? String(b.subject).slice(0, 200) : e.subject,
    message: b.message !== undefined ? String(b.message).slice(0, 5000) : e.message,
    sequential: b.sequential !== undefined ? (b.sequential ? 1 : 0) : e.sequential,
    allow_markup: b.allow_markup !== undefined ? (b.allow_markup ? 1 : 0) : e.allow_markup,
    expires_days: b.expires_days !== undefined ? num(b.expires_days, 0, 365) : e.expires_days,
    reminder_days: b.reminder_days !== undefined ? num(b.reminder_days, 0, 60) : e.reminder_days,
  };
  await run(`UPDATE envelopes SET title=?, subject=?, message=?, sequential=?, allow_markup=?, expires_days=?, reminder_days=?, updated_at=? WHERE id=?`,
    next.title, next.subject, next.message, next.sequential, next.allow_markup, next.expires_days, next.reminder_days, now(), e.id);
  res.json(await view(e.id));
}));

api.delete('/envelopes/:id', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (e.status === 'sent') throw httpError(409, 'Void this envelope before deleting it.');
  await run('DELETE FROM envelopes WHERE id = ?', e.id);
  await storage.removePrefix(e.id).catch((err) => console.error('[storage] cleanup failed', err.message));
  res.json({ ok: true });
}));

async function addDocument(e, user, { bytes: raw, mimetype, originalname }, sort) {
  const { bytes, pageCount } = await normalizeUpload(raw, mimetype, originalname);
  const id = uid('doc_');
  const key = `${e.id}/${id}.pdf`;
  await storage.put(key, bytes);
  const name = String(originalname).replace(/\.(png|jpe?g)$/i, '.pdf').slice(0, 200);
  await run(`INSERT INTO documents (id, envelope_id, name, file, page_count, size, sha256, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, e.id, name, key, pageCount, bytes.length, sha256(bytes), sort, now());
  await logEvent(e.id, { actor: user.name, type: 'document_added', detail: name });
}

async function afterUpload(e, firstName) {
  if (e.title.startsWith('Untitled') && firstName) {
    await run('UPDATE envelopes SET title = ? WHERE id = ?', String(firstName).replace(/\.[^.]+$/, '').slice(0, 200), e.id);
  }
  await touch(e.id);
}

const nextSort = async (envelopeId) => (await get('SELECT COALESCE(MAX(sort), -1) AS s FROM documents WHERE envelope_id = ?', envelopeId)).s;

// Local/dev: multipart upload straight to the app.
api.post('/envelopes/:id/documents', upload.array('files', 10), wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Documents can only be added to drafts.');
  if (!req.files?.length) throw httpError(400, 'Choose at least one file.');
  let sort = await nextSort(e.id);
  for (const file of req.files) await addDocument(e, req.user, { bytes: file.buffer, mimetype: file.mimetype, originalname: file.originalname }, ++sort);
  await afterUpload(e, req.files[0].originalname);
  res.json(await view(e.id));
}));

// Production: the browser uploads straight to storage with signed URLs, then calls /documents/import.
api.post('/envelopes/:id/uploads', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Documents can only be added to drafts.');
  if (!storage.signedUploadUrl) return res.json({ direct: false });
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).slice(0, 10);
  for (const f of files) if (Number(f.size) > config.maxUploadMb * 1024 * 1024) throw httpError(400, `Files must be under ${config.maxUploadMb} MB.`);
  const uploads = [];
  for (const f of files) {
    const key = `${e.id}/uploads/${uid('up_')}`;
    uploads.push({ key, url: await storage.signedUploadUrl(key), name: String(f.name || 'document.pdf') });
  }
  res.json({ direct: true, uploads });
}));

api.post('/envelopes/:id/documents/import', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Documents can only be added to drafts.');
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).slice(0, 10);
  if (!files.length) throw httpError(400, 'Choose at least one file.');
  let sort = await nextSort(e.id);
  for (const f of files) {
    const key = String(f.key || '');
    if (!key.startsWith(`${e.id}/uploads/`) || key.includes('..')) throw httpError(400, 'Invalid upload.');
    const bytes = await storage.get(key);
    if (bytes.length > config.maxUploadMb * 1024 * 1024) throw httpError(400, `Files must be under ${config.maxUploadMb} MB.`);
    try {
      await addDocument(e, req.user, { bytes, mimetype: String(f.type || ''), originalname: String(f.name || 'document.pdf') }, ++sort);
    } finally {
      await storage.remove(key).catch(() => {});
    }
  }
  await afterUpload(e, files[0].name);
  res.json(await view(e.id));
}));

api.delete('/envelopes/:id/documents/:docId', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Documents can only be removed from drafts.');
  const doc = await get('SELECT * FROM documents WHERE id = ? AND envelope_id = ?', req.params.docId, e.id);
  if (!doc) throw httpError(404, 'Document not found.');
  await run('DELETE FROM documents WHERE id = ?', doc.id);
  await storage.remove(doc.file).catch(() => {});
  await logEvent(e.id, { actor: req.user.name, type: 'document_removed', detail: doc.name });
  await touch(e.id);
  res.json(await view(e.id));
}));

api.get('/envelopes/:id/documents/:docId/file', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  const doc = await get('SELECT * FROM documents WHERE id = ? AND envelope_id = ?', req.params.docId, e.id);
  if (!doc) throw httpError(404, 'Document not found.');
  await sendStored(res, doc.file, doc.name, req.query.download === '1');
}));

api.get('/envelopes/:id/download', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!e.final_file) throw httpError(404, 'The completed PDF is ready once everyone has signed.');
  await sendStored(res, e.final_file, `${wf.safeName(e.title)} - completed.pdf`, req.query.inline !== '1');
}));

api.put('/envelopes/:id/recipients', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Use "Correct" to change recipients after sending.');
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length > 50) throw httpError(400, 'Up to 50 recipients per envelope.');
  await transaction(async (t) => {
    const existing = (await t.all('SELECT id FROM recipients WHERE envelope_id = ?', e.id)).map((r) => r.id);
    const keep = new Set();
    for (const [i, r] of list.entries()) {
      const role = ROLES.includes(r.role) ? r.role : 'signer';
      const vals = [
        String(r.name || '').trim().slice(0, 120), String(r.email || '').trim().toLowerCase().slice(0, 200), role,
        num(r.routing_order || 1, 1, 99), /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#0099FF',
        String(r.access_code || '').trim().slice(0, 64) || null, String(r.private_message || '').slice(0, 2000) || null, i,
      ];
      if (r.id && existing.includes(r.id)) {
        await t.run(`UPDATE recipients SET name=?, email=?, role=?, routing_order=?, color=?, access_code=?, private_message=?, sort=? WHERE id=?`, ...vals, r.id);
        keep.add(r.id);
      } else {
        const id = uid('rcp_');
        await t.run(`INSERT INTO recipients (name, email, role, routing_order, color, access_code, private_message, sort, id, envelope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, id, e.id);
        keep.add(id);
      }
    }
    for (const id of existing) if (!keep.has(id)) await t.run('DELETE FROM recipients WHERE id = ?', id);
    // CCs never fill fields.
    await t.run(`DELETE FROM fields WHERE envelope_id = ? AND recipient_id IN (SELECT id FROM recipients WHERE role = 'cc')`, e.id);
  });
  await touch(e.id);
  res.json(await view(e.id));
}));

api.put('/envelopes/:id/fields', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Fields are locked once an envelope is sent.');
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length > 1000) throw httpError(400, 'Too many fields.');
  const docs = await all('SELECT id, page_count FROM documents WHERE envelope_id = ?', e.id);
  const recips = (await all(`SELECT id FROM recipients WHERE envelope_id = ? AND role != 'cc'`, e.id)).map((r) => r.id);
  const rows = list.map((f) => {
    if (!FIELD_TYPES.includes(f.type)) throw httpError(400, `Unknown field type "${f.type}".`);
    const doc = docs.find((d) => d.id === f.document_id);
    if (!doc || !recips.includes(f.recipient_id)) throw httpError(400, 'A field refers to a missing document or recipient.');
    const page = Math.trunc(Number(f.page));
    if (!(page >= 0 && page < doc.page_count)) throw httpError(400, 'A field is on an invalid page.');
    const w = num(f.w, 0.005, 1), h = num(f.h, 0.005, 1);
    const required = NOT_REQUIRABLE.includes(f.type) ? 0 : f.required === false ? 0 : 1;
    return [uid('fld_'), e.id, doc.id, f.recipient_id, f.type, page, num(f.x, 0, 1 - w), num(f.y, 0, 1 - h), w, h, required, String(f.label || '').slice(0, 120), cleanOptions(f.type, f.options)];
  });
  await transaction(async (t) => {
    await t.run('DELETE FROM fields WHERE envelope_id = ?', e.id);
    for (const row of rows) {
      await t.run(`INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...row);
    }
  });
  await touch(e.id);
  res.json(await view(e.id));
}));

api.put('/envelopes/:id/annotations', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Markup is locked once an envelope is sent.');
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length > 500) throw httpError(400, 'Too many markup items.');
  const docs = await all('SELECT id, page_count FROM documents WHERE envelope_id = ?', e.id);
  const rows = list.map((a) => ({ ...cleanAnnotation(a, docs), created_at: a.created_at && !isNaN(Date.parse(a.created_at)) ? a.created_at : now() }));
  await transaction(async (t) => {
    await t.run(`DELETE FROM annotations WHERE envelope_id = ? AND author_type = 'sender'`, e.id);
    for (const c of rows) {
      await t.run(`INSERT INTO annotations (id, envelope_id, document_id, author_type, author_id, author_name, kind, page, data, created_at) VALUES (?, ?, ?, 'sender', ?, ?, ?, ?, ?, ?)`,
        uid('ann_'), e.id, c.document_id, req.user.id, req.user.name, c.kind, c.page, c.data, c.created_at);
    }
  });
  await touch(e.id);
  res.json(await view(e.id));
}));

api.post('/envelopes/:id/send', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (e.is_template) throw httpError(409, 'Templates can\'t be sent. Use the template to create an envelope.');
  if (e.status !== 'draft') throw httpError(409, 'This envelope was already sent.');
  await wf.sendEnvelope(e.id, req.user);
  res.json(await view(e.id));
}));

api.post('/envelopes/:id/remind', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (e.status !== 'sent') throw httpError(409, 'Only in-progress envelopes can be reminded.');
  res.json({ reminded: await wf.remind(e.id, req.user.name) });
}));

api.post('/envelopes/:id/void', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (e.status !== 'sent') throw httpError(409, 'Only in-progress envelopes can be voided.');
  const reason = String(req.body?.reason || '').trim().slice(0, 500) || 'No reason given';
  const changed = await run(`UPDATE envelopes SET status = 'voided', void_reason = ?, updated_at = ? WHERE id = ? AND status = 'sent'`, reason, now(), e.id);
  if (!changed.changes) throw httpError(409, 'This envelope is no longer in progress.');
  await logEvent(e.id, { actor: req.user.name, type: 'voided', detail: reason });
  await wf.voidEnvelope(await wf.loadEnvelope(e.id), req.user, reason);
  res.json(await view(e.id));
}));

// "Correct" a recipient after sending: fix a typo'd email or name, or change the access code.
api.patch('/envelopes/:id/recipients/:rid', wrap(async (req, res) => {
  const e = await ownedEnvelope(req);
  if (e.status !== 'sent') throw httpError(409, 'Only in-progress envelopes can be corrected.');
  const r = await get('SELECT * FROM recipients WHERE id = ? AND envelope_id = ?', req.params.rid, e.id);
  if (!r) throw httpError(404, 'Recipient not found.');
  if (['completed', 'declined'].includes(r.status)) throw httpError(409, 'This recipient already finished.');
  const name = String(req.body?.name ?? r.name).trim().slice(0, 120);
  const email = String(req.body?.email ?? r.email).trim().toLowerCase().slice(0, 200);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a name and valid email.');
  const accessCode = req.body?.access_code !== undefined ? String(req.body.access_code).trim().slice(0, 64) || null : r.access_code;
  // A new token invalidates the old link, in case it went to the wrong person.
  const wasActive = r.status !== 'created';
  await run(`UPDATE recipients SET name = ?, email = ?, access_code = ?, token = ?, status = 'created', failed_codes = 0, locked_until = NULL WHERE id = ?`, name, email, accessCode, token(), r.id);
  await logEvent(e.id, { recipientId: r.id, actor: req.user.name, type: 'corrected', detail: `${r.name} <${r.email}> → ${name} <${email}>` });
  if (wasActive) await wf.advance(e.id);
  res.json(await view(e.id));
}));

api.post('/envelopes/:id/duplicate', wrap(async (req, res) => {
  const src = await ownedEnvelope(req);
  const full = await wf.loadEnvelope(src.id);
  const asTemplate = req.body?.template ? 1 : 0;
  const id = uid('env_');
  const ts = now();
  const title = req.body?.title ? String(req.body.title).slice(0, 200) : asTemplate || src.is_template ? src.title : `Copy of ${src.title}`;
  const docMap = {}, recMap = {};
  // Copy files first (outside the transaction); orphans are harmless if the insert fails.
  for (const d of full.documents) {
    const nid = uid('doc_');
    docMap[d.id] = { id: nid, key: `${id}/${nid}.pdf` };
    await storage.put(docMap[d.id].key, await storage.get(d.file));
  }
  await transaction(async (t) => {
    await t.run(`INSERT INTO envelopes (id, owner_id, title, subject, message, is_template, sequential, allow_markup, expires_days, reminder_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.user.id, title, src.subject, src.message, asTemplate, src.sequential, src.allow_markup, src.expires_days, src.reminder_days, ts, ts);
    for (const d of full.documents) {
      await t.run(`INSERT INTO documents (id, envelope_id, name, file, page_count, size, sha256, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        docMap[d.id].id, id, d.name, docMap[d.id].key, d.page_count, d.size, d.sha256, d.sort, ts);
    }
    for (const r of full.recipients) {
      recMap[r.id] = uid('rcp_');
      await t.run(`INSERT INTO recipients (id, envelope_id, name, email, role, routing_order, color, access_code, private_message, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        recMap[r.id], id, r.name, r.email, r.role, r.routing_order, r.color, r.access_code, r.private_message, r.sort);
    }
    for (const f of full.fields) {
      await t.run(`INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid('fld_'), id, docMap[f.document_id].id, recMap[f.recipient_id], f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label, f.options ? JSON.stringify(f.options) : null);
    }
    for (const a of full.annotations.filter((a) => a.author_type === 'sender')) {
      await t.run(`INSERT INTO annotations (id, envelope_id, document_id, author_type, author_id, author_name, kind, page, data, created_at) VALUES (?, ?, ?, 'sender', ?, ?, ?, ?, ?, ?)`,
        uid('ann_'), id, docMap[a.document_id].id, req.user.id, req.user.name, a.kind, a.page, JSON.stringify(a.data), ts);
    }
  });
  await logEvent(id, { actor: req.user.name, type: 'created', detail: `${asTemplate ? 'Template' : 'Draft'} created from "${src.title}"` });
  res.json(await view(id));
}));

api.get('/activity', wrap(async (req, res) => {
  const after = Number(req.query.after) || 0;
  const events = await all(
    `SELECT ev.id, ev.envelope_id, ev.actor, ev.type, ev.detail, ev.created_at, e.title
     FROM events ev JOIN envelopes e ON e.id = ev.envelope_id
     WHERE e.owner_id = ? AND ev.id > ? AND e.is_template = 0
     ORDER BY ev.id DESC LIMIT 60`, req.user.id, after);
  res.json({ events });
}));

api.get('/library', wrap(async (req, res) => {
  const like = `%${String(req.query.q || '')}%`;
  const docs = await all(
    `SELECT d.id, d.name, d.page_count, d.size, d.created_at, e.id AS envelope_id, e.title, e.status, e.is_template
     FROM documents d JOIN envelopes e ON e.id = d.envelope_id
     WHERE e.owner_id = ? AND (d.name LIKE ? OR e.title LIKE ?) ORDER BY d.created_at DESC LIMIT 500`, req.user.id, like, like);
  const completed = await all(
    `SELECT id AS envelope_id, title, completed_at, final_sha256 FROM envelopes
     WHERE owner_id = ? AND final_file IS NOT NULL AND title LIKE ? ORDER BY completed_at DESC LIMIT 500`, req.user.id, like);
  res.json({ documents: docs, completed });
}));

api.get('/outbox', wrap(async (req, res) => {
  res.json({
    smtpEnabled,
    emails: await all(`SELECT id, envelope_id, to_email, to_name, subject, link, status, error, created_at FROM emails WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200`, req.user.id),
  });
}));

/* ------------------------------- signing ------------------------------- */

const codeCookieName = (r) => `lss_ac_${r.id}`;
const codeCookieValue = (r) => crypto.createHmac('sha256', SECRET).update(`${r.token}:${r.access_code}`).digest('base64url');
function hasCodeAccess(req, r) {
  if (!r.access_code) return true;
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
  const got = Buffer.from(cookies[codeCookieName(r)] || '');
  const want = Buffer.from(codeCookieValue(r));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function recipientByToken(req) {
  const r = await get('SELECT * FROM recipients WHERE token = ?', String(req.params.token || ''));
  if (!r) throw httpError(404, 'This link is invalid or has been replaced by a newer one.');
  const e = await get('SELECT * FROM envelopes WHERE id = ?', r.envelope_id);
  // Expire lazily too, so nothing depends on the scheduled sweep having run.
  if (e.status === 'sent' && e.expires_at && e.expires_at < now()) {
    await wf.expireEnvelope(e.id);
    e.status = 'expired';
  }
  return { r, e };
}

function requireAccess(req, r) {
  if (!hasCodeAccess(req, r)) throw httpError(403, 'Enter your access code to continue.');
}

/** What the recipient is able to do right now. */
function signerMode(e, r) {
  if (e.status === 'completed') return 'completed';
  if (['voided', 'declined', 'expired'].includes(e.status)) return 'closed';
  if (r.role === 'cc') return 'view';
  if (r.status === 'completed') return 'done';
  if (r.status === 'declined') return 'closed';
  if (r.status === 'created') return 'waiting';
  return 'sign';
}

app.get('/api/sign/:token', wrap(async (req, res) => {
  const { r, e } = await recipientByToken(req);
  const owner = await get('SELECT name, email FROM users WHERE id = ?', e.owner_id);
  if (!hasCodeAccess(req, r)) {
    return res.json({ needsCode: true, envelope: { title: e.title }, owner: { name: owner.name }, recipient: { name: r.name } });
  }
  const mode = signerMode(e, r);
  const info = clientInfo(req);
  if (mode === 'sign' && r.status === 'sent') {
    await run(`UPDATE recipients SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'`, now(), r.id);
    await logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'viewed', detail: 'Opened the envelope', ...info });
    r.status = 'viewed';
  } else if (mode === 'view' && !r.viewed_at) {
    await run(`UPDATE recipients SET viewed_at = ? WHERE id = ?`, now(), r.id);
    await logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'viewed', detail: 'Opened the copy', ...info });
  }
  const full = await wf.loadEnvelope(e.id);
  const editable = mode === 'sign';
  res.json({
    mode,
    envelope: { id: e.id, title: e.title, message: r.private_message || e.message, status: e.status, allow_markup: !!e.allow_markup, completed_at: e.completed_at, void_reason: e.status === 'voided' ? e.void_reason : null, has_final: !!e.final_file },
    owner,
    recipient: {
      id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, color: r.color,
      consented: !!r.consented_at, signature_image: r.signature_image, initials_image: r.initials_image,
    },
    recipients: full.recipients.map((x) => ({ id: x.id, name: x.name, role: x.role, status: x.status, color: x.color, routing_order: x.routing_order })),
    documents: full.documents.map((d) => ({ id: d.id, name: d.name, page_count: d.page_count })),
    // Your own fields are editable; others' are shown only once filled in.
    fields: full.fields
      .filter((f) => (editable && f.recipient_id === r.id) || f.filled_at)
      .map((f) => {
        const out = fieldOut(f);
        if (f.recipient_id !== r.id || !editable) {
          out.readonly = true;
          const signer = full.recipients.find((x) => x.id === f.recipient_id);
          if (f.type === 'signature') out.image = signer?.signature_image;
          if (f.type === 'initials') out.image = signer?.initials_image;
          if (f.type === 'stamp') out.image = f.value;
        }
        return out;
      }),
    annotations: full.annotations.map(annotationOut),
  });
}));

app.post('/api/sign/:token/access', wrap(async (req, res) => {
  const { r } = await recipientByToken(req);
  if (!r.access_code) return res.json({ ok: true });
  if (r.locked_until && r.locked_until > now()) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const given = String(req.body?.code || '').trim();
  const a = Buffer.from(given), b = Buffer.from(r.access_code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const fails = (r.failed_codes || 0) + 1;
    await run('UPDATE recipients SET failed_codes = ?, locked_until = ? WHERE id = ?', fails >= 5 ? 0 : fails, fails >= 5 ? new Date(Date.now() + 15 * 60e3).toISOString() : null, r.id);
    await logEvent(r.envelope_id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'auth_failed', detail: 'Wrong access code', ...clientInfo(req) });
    throw httpError(403, 'That access code is not correct.');
  }
  await run('UPDATE recipients SET failed_codes = 0, locked_until = NULL WHERE id = ?', r.id);
  const parts = [`${codeCookieName(r)}=${codeCookieValue(r)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=86400'];
  if (config.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  await logEvent(r.envelope_id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'authenticated', detail: 'Access code verified', ...clientInfo(req) });
  res.json({ ok: true });
}));

app.get('/api/sign/:token/documents/:docId', wrap(async (req, res) => {
  const { r, e } = await recipientByToken(req);
  requireAccess(req, r);
  const doc = await get('SELECT * FROM documents WHERE id = ? AND envelope_id = ?', req.params.docId, e.id);
  if (!doc) throw httpError(404, 'Document not found.');
  await sendStored(res, doc.file, doc.name, req.query.download === '1');
}));

app.get('/api/sign/:token/download', wrap(async (req, res) => {
  const { r, e } = await recipientByToken(req);
  requireAccess(req, r);
  if (!e.final_file) throw httpError(404, 'The completed copy is available once everyone has signed.');
  await logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'downloaded', detail: 'Downloaded the completed copy', ...clientInfo(req) });
  await sendStored(res, e.final_file, `${wf.safeName(e.title)} - completed.pdf`, req.query.inline !== '1');
}));

app.post('/api/sign/:token/consent', wrap(async (req, res) => {
  const { r, e } = await recipientByToken(req);
  requireAccess(req, r);
  if (signerMode(e, r) !== 'sign') throw httpError(409, 'This envelope is not waiting on you.');
  if (!r.consented_at) {
    await run('UPDATE recipients SET consented_at = ? WHERE id = ?', now(), r.id);
    await logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'consented', detail: 'Agreed to use electronic records and signatures', ...clientInfo(req) });
  }
  res.json({ ok: true });
}));

/** Validates and normalises every field value a recipient submits. */
function resolveValues(myFields, values, r, { signature, initials, ts }) {
  const out = [];
  const label = (f) => (f.type === 'signature' ? 'signature' : f.type === 'initials' ? 'initials' : f.type === 'stamp' ? 'stamp' : `"${f.label || f.type.replace('_', ' ')}"`);
  for (const f of myFields) {
    const options = f.options ? JSON.parse(f.options) : [];
    let v = values[f.id];
    v = v === undefined || v === null ? '' : String(v);
    if (f.type !== 'stamp') v = v.slice(0, 1000);
    switch (f.type) {
      case 'signature': v = signature ? 'signed' : ''; break;
      case 'initials': v = initials ? 'initialed' : ''; break;
      case 'date_signed': v = fmtDate(new Date(ts)); break;
      case 'full_name': if (!v.trim()) v = r.name; break;
      case 'email': v = r.email; break;
      case 'checkbox': case 'radio': v = v === 'true' ? 'true' : 'false'; break;
      case 'date': v = /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? fmtDate(new Date(`${v}T00:00:00Z`)) : ''; break;
      case 'dropdown': if (!options.includes(v)) v = ''; break;
      case 'approve': v = 'Approved'; break;
      case 'decline': v = ''; break;
      case 'stamp':
        if (v && (!IMG_RE.test(v) || v.length > 700000)) throw httpError(400, 'Stamp image is invalid or too large.');
        break;
    }
    const empty = ['checkbox', 'radio'].includes(f.type) ? v !== 'true' : !v.trim();
    // Radio requirements apply to the whole group and are checked below.
    if (f.required && empty && f.type !== 'radio') throw httpError(400, `Please complete the required ${label(f)} field.`);
    out.push({ f, v, empty });
  }
  const groups = {};
  for (const x of out.filter((x) => x.f.type === 'radio')) (groups[x.f.label || x.f.id] ||= []).push(x);
  for (const [name, members] of Object.entries(groups)) {
    const chosen = members.filter((m) => m.v === 'true');
    if (chosen.length > 1) throw httpError(400, `Choose only one option for "${name}".`);
    if (!chosen.length && members.some((m) => m.f.required)) throw httpError(400, `Please choose an option for "${name}".`);
  }
  return out;
}

app.post('/api/sign/:token/complete', wrap(async (req, res) => {
  const { r, e } = await recipientByToken(req);
  requireAccess(req, r);
  if (signerMode(e, r) !== 'sign') throw httpError(409, 'This envelope is not waiting on you.');
  if (!r.consented_at) throw httpError(400, 'Please agree to use electronic signatures first.');
  const b = req.body || {};
  const values = b.values && typeof b.values === 'object' ? b.values : {};
  for (const img of [b.signature, b.initials]) {
    if (img && (!IMG_RE.test(img) || img.length > 700000)) throw httpError(400, 'Signature image is invalid or too large.');
  }
  const signature = b.signature || r.signature_image;
  const initials = b.initials || r.initials_image;
  const ts = now();
  const myFields = await all('SELECT * FROM fields WHERE envelope_id = ? AND recipient_id = ?', e.id, r.id);
  const resolved = resolveValues(myFields, values, r, { signature, initials, ts });
  const docs = await all('SELECT id, page_count FROM documents WHERE envelope_id = ?', e.id);
  const marks = e.allow_markup && Array.isArray(b.annotations) ? b.annotations.slice(0, 200).map((a) => cleanAnnotation(a, docs)) : [];
  const info = clientInfo(req);

  const claimed = await transaction(async (t) => {
    // The status guard makes a double-click or retry a no-op instead of a double signature.
    const upd = await t.run(`UPDATE recipients SET status = 'completed', completed_at = ?, signature_image = ?, initials_image = ?, ip = ?, user_agent = ? WHERE id = ? AND status IN ('sent','viewed')`,
      ts, signature || null, initials || null, info.ip, info.userAgent, r.id);
    if (!upd.changes) return false;
    for (const { f, v, empty } of resolved) await t.run('UPDATE fields SET value = ?, filled_at = ? WHERE id = ?', v, empty ? null : ts, f.id);
    for (const m of marks) {
      await t.run(`INSERT INTO annotations (id, envelope_id, document_id, author_type, author_id, author_name, kind, page, data, created_at) VALUES (?, ?, ?, 'recipient', ?, ?, ?, ?, ?, ?)`,
        uid('ann_'), e.id, m.document_id, r.id, r.name, m.kind, m.page, m.data, ts);
    }
    return true;
  });
  if (!claimed) throw httpError(409, 'You have already completed this document.');
  const verb = r.role === 'approver' ? 'approved' : 'signed';
  await logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: verb, detail: `${r.name} ${verb}${marks.length ? ` and added ${marks.length} markup item(s)` : ''}`, ...info });
  await wf.recipientFinished(e.id, r.id, { marks: marks.length });
  res.json({ ok: true, status: (await get('SELECT status FROM envelopes WHERE id = ?', e.id)).status });
}));

app.post('/api/sign/:token/decline', wrap(async (req, res) => {
  const { r, e } = await recipientByToken(req);
  requireAccess(req, r);
  if (signerMode(e, r) !== 'sign') throw httpError(409, 'This envelope is not waiting on you.');
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw httpError(400, 'Please tell the sender why you are declining.');
  const ts = now();
  const info = clientInfo(req);
  const changed = await run(`UPDATE envelopes SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'sent'`, ts, e.id);
  if (!changed.changes) throw httpError(409, 'This envelope is no longer in progress.');
  await run(`UPDATE recipients SET status = 'declined', declined_at = ?, decline_reason = ?, ip = ?, user_agent = ? WHERE id = ?`, ts, reason, info.ip, info.userAgent, r.id);
  await logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'declined', detail: reason, ...info });
  const full = await wf.loadEnvelope(e.id);
  await wf.declineEnvelope(full, full.recipients.find((x) => x.id === r.id), reason);
  res.json({ ok: true });
}));

/* ------------------------------- verify -------------------------------- */

// The browser hashes the PDF locally and sends only the SHA-256, so the file never leaves the device.
app.post('/api/verify', wrap(async (req, res) => {
  const hash = String(req.body?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw httpError(400, 'Choose a PDF to verify.');
  const e = await get('SELECT id, title, completed_at FROM envelopes WHERE final_sha256 = ?', hash);
  if (!e) return res.json({ match: false, sha256: hash });
  const signers = await all(`SELECT name, role, completed_at FROM recipients WHERE envelope_id = ? AND role != 'cc' ORDER BY routing_order, sort`, e.id);
  res.json({ match: true, sha256: hash, envelope: e, signers });
}));

/* -------------------------------- cron --------------------------------- */

// Vercel Cron calls this; it is idempotent, so it is safe to run more often.
app.get('/api/cron/sweep', wrap(async (req, res) => {
  if (config.cronSecret && req.headers.authorization !== `Bearer ${config.cronSecret}`) throw httpError(401, 'Unauthorized');
  await wf.sweep();
  res.json({ ok: true });
}));

// Mounted after the public signing routes so those don't require a sender login.
app.use('/api', api);

/* ------------------------------- static -------------------------------- */

app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sign.html')));
app.get('/verify', (req, res) => res.sendFile(path.join(__dirname, 'public', 'verify.html')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    err.status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') err.message = `Files must be under ${config.maxUploadMb} MB.`;
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`${config.appName} running at ${config.baseUrl}`);
    if (!smtpEnabled) console.log('No email provider configured: emails are logged to the Outbox page instead of being sent.');
  });
  setInterval(() => wf.sweep().catch((err) => console.error('[sweep]', err)), 60 * 60e3).unref();
  setTimeout(() => wf.sweep().catch((err) => console.error('[sweep]', err)), 5e3).unref();
}

module.exports = app;
