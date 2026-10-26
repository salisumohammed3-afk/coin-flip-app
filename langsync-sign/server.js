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
const { smtpEnabled, sendMail } = require('./lib/mailer');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Signing links carry secrets in the URL; never leak them via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: '4mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clientInfo = (req) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });

// Secret used to sign access-code cookies for recipients.
const secretFile = path.join(config.dataDir, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const FIELD_TYPES = ['signature', 'initials', 'date_signed', 'full_name', 'email', 'company', 'title', 'text', 'checkbox'];
const ANNOTATION_KINDS = ['pen', 'highlight', 'rect', 'line', 'text', 'note'];
const ROLES = ['signer', 'approver', 'cc'];
const EDITABLE = (e) => e.status === 'draft' || e.is_template;

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
  x: f.x, y: f.y, w: f.w, h: f.h, required: !!f.required, label: f.label, value: f.value, filled_at: f.filled_at,
});
const annotationOut = (a) => ({
  id: a.id, document_id: a.document_id, author_type: a.author_type, author_id: a.author_id, author_name: a.author_name,
  kind: a.kind, page: a.page, data: a.data, created_at: a.created_at,
});

function ownedEnvelope(req) {
  const e = get('SELECT * FROM envelopes WHERE id = ? AND owner_id = ?', req.params.id, req.user.id);
  if (!e) throw httpError(404, 'Envelope not found.');
  return e;
}

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
  const color = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#8B36FE';
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

/* -------------------------------- auth -------------------------------- */

app.get('/api/config', (req, res) => {
  res.json({ appName: config.appName, smtpEnabled, allowSignup: config.allowSignup, hasUsers: !!get('SELECT 1 AS x FROM users LIMIT 1') });
});

app.post('/api/auth/register', wrap(async (req, res) => {
  const user = auth.register(req.body || {});
  auth.createSession(res, user.id);
  res.json({ user });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const user = auth.login(req.body || {});
  auth.createSession(res, user.id);
  res.json({ user });
}));

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ user: auth.currentUser(req) }));

/* ------------------------------ envelopes ------------------------------ */

const api = express.Router();
api.use(auth.requireUser);

api.get('/stats', (req, res) => {
  const counts = Object.fromEntries(
    all(`SELECT status, COUNT(*) AS n FROM envelopes WHERE owner_id = ? AND is_template = 0 GROUP BY status`, req.user.id).map((r) => [r.status, r.n])
  );
  const soon = new Date(Date.now() + 3 * 864e5).toISOString();
  const expiring = get(`SELECT COUNT(*) AS n FROM envelopes WHERE owner_id = ? AND status = 'sent' AND expires_at IS NOT NULL AND expires_at < ?`, req.user.id, soon).n;
  const templates = get(`SELECT COUNT(*) AS n FROM envelopes WHERE owner_id = ? AND is_template = 1`, req.user.id).n;
  res.json({ counts, expiring, templates });
});

api.get('/envelopes', (req, res) => {
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
  const envelopes = all(sql, ...params);
  const recipients = envelopes.length
    ? all(`SELECT * FROM recipients WHERE envelope_id IN (${envelopes.map(() => '?').join(',')}) ORDER BY routing_order, sort`, ...envelopes.map((e) => e.id))
    : [];
  res.json({
    envelopes: envelopes.map((e) => ({ ...envelopeSummary(e), recipients: recipients.filter((r) => r.envelope_id === e.id).map(recipientSummary) })),
  });
});

api.post('/envelopes', (req, res) => {
  const id = uid('env_');
  const ts = now();
  const isTemplate = req.body?.template ? 1 : 0;
  const title = String(req.body?.title || (isTemplate ? 'Untitled template' : 'Untitled envelope')).slice(0, 200);
  run(`INSERT INTO envelopes (id, owner_id, title, is_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, id, req.user.id, title, isTemplate, ts, ts);
  logEvent(id, { actor: req.user.name, type: 'created', detail: isTemplate ? 'Template created' : 'Draft created' });
  res.json(senderView(wf.loadEnvelope(id)));
});

api.get('/envelopes/:id', (req, res) => {
  const e = ownedEnvelope(req);
  res.json(senderView(wf.loadEnvelope(e.id)));
});

api.patch('/envelopes/:id', (req, res) => {
  const e = ownedEnvelope(req);
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
  run(`UPDATE envelopes SET title=?, subject=?, message=?, sequential=?, allow_markup=?, expires_days=?, reminder_days=?, updated_at=? WHERE id=?`,
    next.title, next.subject, next.message, next.sequential, next.allow_markup, next.expires_days, next.reminder_days, now(), e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
});

api.delete('/envelopes/:id', (req, res) => {
  const e = ownedEnvelope(req);
  if (e.status === 'sent') throw httpError(409, 'Void this envelope before deleting it.');
  run('DELETE FROM envelopes WHERE id = ?', e.id);
  fs.rmSync(path.join(config.filesDir, e.id), { recursive: true, force: true });
  res.json({ ok: true });
});

api.post('/envelopes/:id/documents', upload.array('files', 10), wrap(async (req, res) => {
  const e = ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Documents can only be added to drafts.');
  if (!req.files?.length) throw httpError(400, 'Choose at least one file.');
  let sort = get('SELECT COALESCE(MAX(sort), -1) AS s FROM documents WHERE envelope_id = ?', e.id).s;
  for (const file of req.files) {
    const { bytes, pageCount } = await normalizeUpload(file.buffer, file.mimetype, file.originalname);
    const id = uid('doc_');
    const rel = path.join(e.id, `${id}.pdf`);
    fs.mkdirSync(path.join(config.filesDir, e.id), { recursive: true });
    fs.writeFileSync(wf.filePath(rel), bytes);
    const name = file.originalname.replace(/\.(png|jpe?g)$/i, '.pdf').slice(0, 200);
    run(`INSERT INTO documents (id, envelope_id, name, file, page_count, size, sha256, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, e.id, name, rel, pageCount, bytes.length, sha256(bytes), ++sort, now());
    logEvent(e.id, { actor: req.user.name, type: 'document_added', detail: name });
  }
  if (e.title.startsWith('Untitled')) {
    run('UPDATE envelopes SET title = ? WHERE id = ?', req.files[0].originalname.replace(/\.[^.]+$/, '').slice(0, 200), e.id);
  }
  touch(e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
}));

api.delete('/envelopes/:id/documents/:docId', (req, res) => {
  const e = ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Documents can only be removed from drafts.');
  const doc = get('SELECT * FROM documents WHERE id = ? AND envelope_id = ?', req.params.docId, e.id);
  if (!doc) throw httpError(404, 'Document not found.');
  run('DELETE FROM documents WHERE id = ?', doc.id);
  fs.rmSync(wf.filePath(doc.file), { force: true });
  logEvent(e.id, { actor: req.user.name, type: 'document_removed', detail: doc.name });
  touch(e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
});

api.get('/envelopes/:id/documents/:docId/file', (req, res) => {
  const e = ownedEnvelope(req);
  const doc = get('SELECT * FROM documents WHERE id = ? AND envelope_id = ?', req.params.docId, e.id);
  if (!doc) throw httpError(404, 'Document not found.');
  sendPdf(res, wf.filePath(doc.file), doc.name, req.query.download === '1');
});

api.get('/envelopes/:id/download', (req, res) => {
  const e = ownedEnvelope(req);
  if (!e.final_file) throw httpError(404, 'The completed PDF is ready once everyone has signed.');
  sendPdf(res, wf.filePath(e.final_file), `${wf.safeName(e.title)} - completed.pdf`, req.query.inline !== '1');
});

api.put('/envelopes/:id/recipients', (req, res) => {
  const e = ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Use "Correct" to change recipients after sending.');
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length > 50) throw httpError(400, 'Up to 50 recipients per envelope.');
  transaction(() => {
    const existing = all('SELECT id FROM recipients WHERE envelope_id = ?', e.id).map((r) => r.id);
    const keep = new Set();
    list.forEach((r, i) => {
      const role = ROLES.includes(r.role) ? r.role : 'signer';
      const vals = [
        String(r.name || '').trim().slice(0, 120), String(r.email || '').trim().toLowerCase().slice(0, 200), role,
        num(r.routing_order || 1, 1, 99), /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#8B36FE',
        String(r.access_code || '').trim().slice(0, 64) || null, String(r.private_message || '').slice(0, 2000) || null, i,
      ];
      if (r.id && existing.includes(r.id)) {
        run(`UPDATE recipients SET name=?, email=?, role=?, routing_order=?, color=?, access_code=?, private_message=?, sort=? WHERE id=?`, ...vals, r.id);
        keep.add(r.id);
      } else {
        const id = uid('rcp_');
        run(`INSERT INTO recipients (name, email, role, routing_order, color, access_code, private_message, sort, id, envelope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, id, e.id);
        keep.add(id);
      }
    });
    for (const id of existing) if (!keep.has(id)) run('DELETE FROM recipients WHERE id = ?', id);
    // CCs never fill fields.
    run(`DELETE FROM fields WHERE envelope_id = ? AND recipient_id IN (SELECT id FROM recipients WHERE role = 'cc')`, e.id);
  });
  touch(e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
});

api.put('/envelopes/:id/fields', (req, res) => {
  const e = ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Fields are locked once an envelope is sent.');
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length > 1000) throw httpError(400, 'Too many fields.');
  const docs = all('SELECT id, page_count FROM documents WHERE envelope_id = ?', e.id);
  const recips = all(`SELECT id FROM recipients WHERE envelope_id = ? AND role != 'cc'`, e.id).map((r) => r.id);
  transaction(() => {
    run('DELETE FROM fields WHERE envelope_id = ?', e.id);
    for (const f of list) {
      if (!FIELD_TYPES.includes(f.type)) throw httpError(400, `Unknown field type "${f.type}".`);
      const doc = docs.find((d) => d.id === f.document_id);
      if (!doc || !recips.includes(f.recipient_id)) throw httpError(400, 'A field refers to a missing document or recipient.');
      const page = Math.trunc(Number(f.page));
      if (!(page >= 0 && page < doc.page_count)) throw httpError(400, 'A field is on an invalid page.');
      const w = num(f.w, 0.005, 1), h = num(f.h, 0.005, 1);
      run(`INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid('fld_'), e.id, doc.id, f.recipient_id, f.type, page, num(f.x, 0, 1 - w), num(f.y, 0, 1 - h), w, h, f.required === false ? 0 : 1, String(f.label || '').slice(0, 120));
    }
  });
  touch(e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
});

api.put('/envelopes/:id/annotations', (req, res) => {
  const e = ownedEnvelope(req);
  if (!EDITABLE(e)) throw httpError(409, 'Markup is locked once an envelope is sent.');
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length > 500) throw httpError(400, 'Too many markup items.');
  const docs = all('SELECT id, page_count FROM documents WHERE envelope_id = ?', e.id);
  transaction(() => {
    run(`DELETE FROM annotations WHERE envelope_id = ? AND author_type = 'sender'`, e.id);
    for (const a of list) {
      const c = cleanAnnotation(a, docs);
      run(`INSERT INTO annotations (id, envelope_id, document_id, author_type, author_id, author_name, kind, page, data, created_at) VALUES (?, ?, ?, 'sender', ?, ?, ?, ?, ?, ?)`,
        uid('ann_'), e.id, c.document_id, req.user.id, req.user.name, c.kind, c.page, c.data, a.created_at && !isNaN(Date.parse(a.created_at)) ? a.created_at : now());
    }
  });
  touch(e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
});

api.post('/envelopes/:id/send', wrap(async (req, res) => {
  const e = ownedEnvelope(req);
  if (e.is_template) throw httpError(409, 'Templates can\'t be sent. Use the template to create an envelope.');
  if (e.status !== 'draft') throw httpError(409, 'This envelope was already sent.');
  await wf.sendEnvelope(e.id, req.user);
  res.json(senderView(wf.loadEnvelope(e.id)));
}));

api.post('/envelopes/:id/remind', wrap(async (req, res) => {
  const e = ownedEnvelope(req);
  if (e.status !== 'sent') throw httpError(409, 'Only in-progress envelopes can be reminded.');
  const count = await wf.remind(e.id, req.user.name);
  res.json({ reminded: count });
}));

api.post('/envelopes/:id/void', wrap(async (req, res) => {
  const e = ownedEnvelope(req);
  if (e.status !== 'sent') throw httpError(409, 'Only in-progress envelopes can be voided.');
  const reason = String(req.body?.reason || '').trim().slice(0, 500) || 'No reason given';
  run(`UPDATE envelopes SET status = 'voided', void_reason = ?, updated_at = ? WHERE id = ?`, reason, now(), e.id);
  logEvent(e.id, { actor: req.user.name, type: 'voided', detail: reason });
  const { recipients } = wf.loadEnvelope(e.id);
  for (const r of recipients.filter((r) => r.status !== 'created')) {
    await sendMail({
      envelopeId: e.id, ownerId: req.user.id, to: r.email, toName: r.name, subject: `Voided: ${e.title}`,
      heading: 'This envelope was voided', intro: `${req.user.name} voided "${e.title}". No further action is needed.`, message: reason,
    });
  }
  res.json(senderView(wf.loadEnvelope(e.id)));
}));

// "Correct" a recipient after sending: fix a typo'd email or name, or change the access code.
api.patch('/envelopes/:id/recipients/:rid', wrap(async (req, res) => {
  const e = ownedEnvelope(req);
  if (e.status !== 'sent') throw httpError(409, 'Only in-progress envelopes can be corrected.');
  const r = get('SELECT * FROM recipients WHERE id = ? AND envelope_id = ?', req.params.rid, e.id);
  if (!r) throw httpError(404, 'Recipient not found.');
  if (['completed', 'declined'].includes(r.status)) throw httpError(409, 'This recipient already finished.');
  const name = String(req.body?.name ?? r.name).trim().slice(0, 120);
  const email = String(req.body?.email ?? r.email).trim().toLowerCase().slice(0, 200);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a name and valid email.');
  const accessCode = req.body?.access_code !== undefined ? String(req.body.access_code).trim().slice(0, 64) || null : r.access_code;
  // A new token invalidates the old link, in case it went to the wrong person.
  const wasActive = r.status !== 'created';
  run(`UPDATE recipients SET name = ?, email = ?, access_code = ?, token = ?, status = 'created' WHERE id = ?`, name, email, accessCode, token(), r.id);
  logEvent(e.id, { recipientId: r.id, actor: req.user.name, type: 'corrected', detail: `${r.name} <${r.email}> → ${name} <${email}>` });
  if (wasActive) await wf.advance(e.id);
  res.json(senderView(wf.loadEnvelope(e.id)));
}));

api.post('/envelopes/:id/duplicate', wrap(async (req, res) => {
  const src = ownedEnvelope(req);
  const full = wf.loadEnvelope(src.id);
  const asTemplate = req.body?.template ? 1 : 0;
  const id = uid('env_');
  const ts = now();
  const title = req.body?.title ? String(req.body.title).slice(0, 200) : asTemplate || src.is_template ? src.title : `Copy of ${src.title}`;
  transaction(() => {
    run(`INSERT INTO envelopes (id, owner_id, title, subject, message, is_template, sequential, allow_markup, expires_days, reminder_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.user.id, title, src.subject, src.message, asTemplate, src.sequential, src.allow_markup, src.expires_days, src.reminder_days, ts, ts);
    fs.mkdirSync(path.join(config.filesDir, id), { recursive: true });
    const docMap = {}, recMap = {};
    for (const d of full.documents) {
      const nid = uid('doc_');
      const rel = path.join(id, `${nid}.pdf`);
      fs.copyFileSync(wf.filePath(d.file), wf.filePath(rel));
      docMap[d.id] = nid;
      run(`INSERT INTO documents (id, envelope_id, name, file, page_count, size, sha256, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nid, id, d.name, rel, d.page_count, d.size, d.sha256, d.sort, ts);
    }
    for (const r of full.recipients) {
      const nid = uid('rcp_');
      recMap[r.id] = nid;
      run(`INSERT INTO recipients (id, envelope_id, name, email, role, routing_order, color, access_code, private_message, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nid, id, r.name, r.email, r.role, r.routing_order, r.color, r.access_code, r.private_message, r.sort);
    }
    for (const f of full.fields) {
      run(`INSERT INTO fields (id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid('fld_'), id, docMap[f.document_id], recMap[f.recipient_id], f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label);
    }
    for (const a of full.annotations.filter((a) => a.author_type === 'sender')) {
      run(`INSERT INTO annotations (id, envelope_id, document_id, author_type, author_id, author_name, kind, page, data, created_at) VALUES (?, ?, ?, 'sender', ?, ?, ?, ?, ?, ?)`,
        uid('ann_'), id, docMap[a.document_id], req.user.id, req.user.name, a.kind, a.page, JSON.stringify(a.data), ts);
    }
  });
  logEvent(id, { actor: req.user.name, type: 'created', detail: `${asTemplate ? 'Template' : 'Draft'} created from "${src.title}"` });
  res.json(senderView(wf.loadEnvelope(id)));
}));

api.get('/activity', (req, res) => {
  const after = Number(req.query.after) || 0;
  const events = all(
    `SELECT ev.id, ev.envelope_id, ev.actor, ev.type, ev.detail, ev.created_at, e.title
     FROM events ev JOIN envelopes e ON e.id = ev.envelope_id
     WHERE e.owner_id = ? AND ev.id > ? AND e.is_template = 0
     ORDER BY ev.id DESC LIMIT 60`, req.user.id, after);
  res.json({ events });
});

api.get('/library', (req, res) => {
  const like = `%${String(req.query.q || '')}%`;
  const docs = all(
    `SELECT d.id, d.name, d.page_count, d.size, d.created_at, e.id AS envelope_id, e.title, e.status, e.is_template
     FROM documents d JOIN envelopes e ON e.id = d.envelope_id
     WHERE e.owner_id = ? AND (d.name LIKE ? OR e.title LIKE ?) ORDER BY d.created_at DESC LIMIT 500`, req.user.id, like, like);
  const completed = all(
    `SELECT id AS envelope_id, title, completed_at, final_sha256, final_file FROM envelopes
     WHERE owner_id = ? AND final_file IS NOT NULL AND title LIKE ? ORDER BY completed_at DESC LIMIT 500`, req.user.id, like);
  const withSize = completed.map((c) => {
    let size = 0;
    try { size = fs.statSync(wf.filePath(c.final_file)).size; } catch {}
    const { final_file, ...rest } = c;
    return { ...rest, size };
  });
  res.json({ documents: docs, completed: withSize });
});

api.get('/outbox', (req, res) => {
  res.json({
    smtpEnabled,
    emails: all(`SELECT id, envelope_id, to_email, to_name, subject, link, status, error, created_at FROM emails WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200`, req.user.id),
  });
});

/* ------------------------------- signing ------------------------------- */

const failedCodes = new Map();

function codeCookieName(r) {
  return `lss_ac_${r.id}`;
}
function codeCookieValue(r) {
  return crypto.createHmac('sha256', SECRET).update(`${r.token}:${r.access_code}`).digest('base64url');
}
function hasCodeAccess(req, r) {
  if (!r.access_code) return true;
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
  const got = Buffer.from(cookies[codeCookieName(r)] || '');
  const want = Buffer.from(codeCookieValue(r));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function recipientByToken(req) {
  const r = get('SELECT * FROM recipients WHERE token = ?', String(req.params.token || ''));
  if (!r) throw httpError(404, 'This link is invalid or has been replaced by a newer one.');
  const e = get('SELECT * FROM envelopes WHERE id = ?', r.envelope_id);
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

app.get('/api/sign/:token', (req, res) => {
  const { r, e } = recipientByToken(req);
  const owner = get('SELECT name, email FROM users WHERE id = ?', e.owner_id);
  if (!hasCodeAccess(req, r)) {
    return res.json({ needsCode: true, envelope: { title: e.title }, owner: { name: owner.name }, recipient: { name: r.name } });
  }
  const mode = signerMode(e, r);
  const info = clientInfo(req);
  if (mode === 'sign' && r.status === 'sent') {
    run(`UPDATE recipients SET status = 'viewed', viewed_at = ? WHERE id = ?`, now(), r.id);
    logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'viewed', detail: 'Opened the envelope', ...info });
    r.status = 'viewed';
  } else if (mode === 'view' && !r.viewed_at) {
    run(`UPDATE recipients SET viewed_at = ? WHERE id = ?`, now(), r.id);
    logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'viewed', detail: 'Opened the copy', ...info });
  }
  const full = wf.loadEnvelope(e.id);
  const editable = mode === 'sign';
  res.json({
    mode,
    envelope: { id: e.id, title: e.title, message: r.private_message || e.message, status: e.status, allow_markup: !!e.allow_markup, completed_at: e.completed_at, void_reason: e.status === 'voided' ? e.void_reason : null },
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
          const owner = full.recipients.find((x) => x.id === f.recipient_id);
          if (f.type === 'signature') out.image = owner?.signature_image;
          if (f.type === 'initials') out.image = owner?.initials_image;
        }
        return out;
      }),
    annotations: full.annotations.map(annotationOut),
  });
});

app.post('/api/sign/:token/access', (req, res) => {
  const { r } = recipientByToken(req);
  if (!r.access_code) return res.json({ ok: true });
  const key = r.id;
  const fails = failedCodes.get(key) || { n: 0, until: 0 };
  if (fails.until > Date.now()) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const given = String(req.body?.code || '').trim();
  if (given !== r.access_code) {
    fails.n += 1;
    if (fails.n >= 5) { fails.until = Date.now() + 15 * 60e3; fails.n = 0; }
    failedCodes.set(key, fails);
    logEvent(r.envelope_id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'auth_failed', detail: 'Wrong access code', ...clientInfo(req) });
    throw httpError(403, 'That access code is not correct.');
  }
  failedCodes.delete(key);
  const parts = [`${codeCookieName(r)}=${codeCookieValue(r)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=86400'];
  if (config.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  logEvent(r.envelope_id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'authenticated', detail: 'Access code verified', ...clientInfo(req) });
  res.json({ ok: true });
});

app.get('/api/sign/:token/documents/:docId', (req, res) => {
  const { r, e } = recipientByToken(req);
  requireAccess(req, r);
  const doc = get('SELECT * FROM documents WHERE id = ? AND envelope_id = ?', req.params.docId, e.id);
  if (!doc) throw httpError(404, 'Document not found.');
  sendPdf(res, wf.filePath(doc.file), doc.name, false);
});

app.get('/api/sign/:token/download', (req, res) => {
  const { r, e } = recipientByToken(req);
  requireAccess(req, r);
  if (!e.final_file) throw httpError(404, 'The completed copy is available once everyone has signed.');
  logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'downloaded', detail: 'Downloaded the completed copy', ...clientInfo(req) });
  sendPdf(res, wf.filePath(e.final_file), `${wf.safeName(e.title)} - completed.pdf`, req.query.inline !== '1');
});

app.post('/api/sign/:token/consent', (req, res) => {
  const { r, e } = recipientByToken(req);
  requireAccess(req, r);
  if (signerMode(e, r) !== 'sign') throw httpError(409, 'This envelope is not waiting on you.');
  if (!r.consented_at) {
    run('UPDATE recipients SET consented_at = ? WHERE id = ?', now(), r.id);
    logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'consented', detail: 'Agreed to use electronic records and signatures', ...clientInfo(req) });
  }
  res.json({ ok: true });
});

const IMG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

app.post('/api/sign/:token/complete', wrap(async (req, res) => {
  const { r, e } = recipientByToken(req);
  requireAccess(req, r);
  if (signerMode(e, r) !== 'sign') throw httpError(409, 'This envelope is not waiting on you.');
  if (!r.consented_at) throw httpError(400, 'Please agree to use electronic signatures first.');
  const b = req.body || {};
  const values = b.values && typeof b.values === 'object' ? b.values : {};
  const signature = b.signature || r.signature_image;
  const initials = b.initials || r.initials_image;
  for (const img of [b.signature, b.initials]) {
    if (img && (!IMG_RE.test(img) || img.length > 700000)) throw httpError(400, 'Signature image is invalid or too large.');
  }
  const myFields = all('SELECT * FROM fields WHERE envelope_id = ? AND recipient_id = ?', e.id, r.id);
  const ts = now();
  const updates = [];
  for (const f of myFields) {
    let v = values[f.id];
    v = v === undefined || v === null ? '' : String(v).slice(0, 1000);
    if (f.type === 'signature') v = signature ? 'signed' : '';
    if (f.type === 'initials') v = initials ? 'initialed' : '';
    if (f.type === 'date_signed') v = new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    if (f.type === 'full_name' && !v.trim()) v = r.name;
    if (f.type === 'email') v = r.email;
    if (f.type === 'checkbox') v = v === 'true' ? 'true' : 'false';
    const empty = f.type === 'checkbox' ? v !== 'true' : !v.trim();
    if (f.required && empty) {
      throw httpError(400, `Please complete the required ${f.type === 'signature' ? 'signature' : f.type === 'initials' ? 'initials' : `"${f.label || f.type.replace('_', ' ')}"`} field.`);
    }
    updates.push([v, empty ? null : ts, f.id]);
  }
  const docs = all('SELECT id, page_count FROM documents WHERE envelope_id = ?', e.id);
  const marks = e.allow_markup && Array.isArray(b.annotations) ? b.annotations.slice(0, 200).map((a) => cleanAnnotation(a, docs)) : [];
  const info = clientInfo(req);

  transaction(() => {
    for (const u of updates) run('UPDATE fields SET value = ?, filled_at = ? WHERE id = ?', ...u);
    for (const m of marks) {
      run(`INSERT INTO annotations (id, envelope_id, document_id, author_type, author_id, author_name, kind, page, data, created_at) VALUES (?, ?, ?, 'recipient', ?, ?, ?, ?, ?, ?)`,
        uid('ann_'), e.id, m.document_id, r.id, r.name, m.kind, m.page, m.data, ts);
    }
    run(`UPDATE recipients SET status = 'completed', completed_at = ?, signature_image = ?, initials_image = ?, ip = ?, user_agent = ? WHERE id = ?`,
      ts, signature || null, initials || null, info.ip, info.userAgent, r.id);
  });
  const verb = r.role === 'approver' ? 'approved' : 'signed';
  logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: verb, detail: `${r.name} ${verb}${marks.length ? ` and added ${marks.length} markup item(s)` : ''}`, ...info });
  await wf.notifyOwner(e.id, {
    subject: `${r.name} ${verb} "${e.title}"`,
    heading: `${r.name} ${verb} your document`,
    intro: `${r.name} (${r.email}) ${verb} "${e.title}".${marks.length ? ` They also left ${marks.length} markup item(s).` : ''}`,
  });
  await wf.advance(e.id);
  res.json({ ok: true, status: get('SELECT status FROM envelopes WHERE id = ?', e.id).status });
}));

app.post('/api/sign/:token/decline', wrap(async (req, res) => {
  const { r, e } = recipientByToken(req);
  requireAccess(req, r);
  if (signerMode(e, r) !== 'sign') throw httpError(409, 'This envelope is not waiting on you.');
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw httpError(400, 'Please tell the sender why you are declining.');
  const ts = now();
  run(`UPDATE recipients SET status = 'declined', declined_at = ?, decline_reason = ?, ip = ?, user_agent = ? WHERE id = ?`, ts, reason, req.ip, clientInfo(req).userAgent, r.id);
  run(`UPDATE envelopes SET status = 'declined', updated_at = ? WHERE id = ?`, ts, e.id);
  logEvent(e.id, { recipientId: r.id, actor: `${r.name} <${r.email}>`, type: 'declined', detail: reason, ...clientInfo(req) });
  await wf.notifyOwner(e.id, { subject: `${r.name} declined "${e.title}"`, heading: `${r.name} declined to sign`, intro: `Reason: ${reason}` });
  res.json({ ok: true });
}));

/* ------------------------------- verify -------------------------------- */

app.post('/api/verify', upload.single('file'), (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a PDF to verify.');
  const hash = sha256(req.file.buffer);
  const e = get('SELECT id, title, completed_at FROM envelopes WHERE final_sha256 = ?', hash);
  if (!e) return res.json({ match: false, sha256: hash });
  const signers = all(`SELECT name, role, completed_at FROM recipients WHERE envelope_id = ? AND role != 'cc' ORDER BY routing_order, sort`, e.id);
  res.json({ match: true, sha256: hash, envelope: e, signers });
});

// Mounted after the public signing routes so those don't require a sender login.
app.use('/api', api);

/* ------------------------------- static -------------------------------- */

function sendPdf(res, file, name, asAttachment) {
  if (!fs.existsSync(file)) throw httpError(404, 'File missing from storage.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename="${String(name).replace(/[^\w\s.()-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(file).pipe(res);
}

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
    if (!smtpEnabled) console.log('No SMTP configured: emails are logged to the Outbox page instead of being sent.');
  });
  setInterval(() => wf.sweep().catch((err) => console.error('[sweep]', err)), 60 * 60e3).unref();
  setTimeout(() => wf.sweep().catch((err) => console.error('[sweep]', err)), 5e3).unref();
}

module.exports = app;
