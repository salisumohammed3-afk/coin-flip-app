'use strict';

// End-to-end API test: runs against a throwaway data directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-test-'));
delete process.env.SMTP_HOST;

const { PDFDocument, StandardFonts } = require('pdf-lib');
const app = require('../server');
const auth = require('../lib/auth');

// Capture sign-in codes instead of emailing them.
const codes = {};
auth.setCodeSender(async (email, code) => { codes[email] = code; });

const PNG_SIG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let server, base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function signIn(call, email) {
  let r = await call('POST', '/api/auth/code', { email });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('POST', '/api/auth/verify', { email, code: codes[email] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}

function client() {
  let cookie = '';
  return async function call(method, url, body, { form } = {}) {
    const headers = cookie ? { cookie } : {};
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = [cookie, set.split(';')[0]].filter(Boolean).join('; ');
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
}

async function samplePdf(pages = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Agreement page ${i + 1}`, { x: 72, y: 700, size: 18, font });
  // A rotated page exercises the coordinate mapping.
  doc.addPage([612, 792]).setRotation({ type: 'degrees', angle: 90 });
  return Buffer.from(await doc.save());
}

test('full envelope lifecycle', async () => {
  const sender = client();
  let r = await signIn(sender, 'sal@langsync.test');
  assert.equal(r.data.user.name, 'Sal');

  r = await sender('POST', '/api/envelopes', { title: 'Untitled envelope' });
  const id = r.data.id;

  const form = new FormData();
  form.append('files', new Blob([await samplePdf()], { type: 'application/pdf' }), 'Master Services Agreement.pdf');
  r = await sender('POST', `/api/envelopes/${id}/documents`, undefined, { form });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.title, 'Master Services Agreement');
  const doc = r.data.documents[0];
  assert.equal(doc.page_count, 3);

  r = await sender('PUT', `/api/envelopes/${id}/recipients`, [
    { name: 'Alex Signer', email: 'alex@client.test', role: 'signer', routing_order: 1, access_code: '4242' },
    { name: 'Blair Approver', email: 'blair@client.test', role: 'approver', routing_order: 2 },
    { name: 'Casey CC', email: 'casey@client.test', role: 'cc', routing_order: 1 },
  ]);
  const alex = r.data.recipients.find((x) => x.role === 'signer');
  const blair = r.data.recipients.find((x) => x.role === 'approver');

  // Sending without a signature field should be rejected.
  await sender('PATCH', `/api/envelopes/${id}`, { sequential: true, message: 'Please sign by Friday.' });
  r = await sender('POST', `/api/envelopes/${id}/send`);
  assert.equal(r.status, 400);

  r = await sender('PUT', `/api/envelopes/${id}/fields`, [
    { document_id: doc.id, recipient_id: alex.id, type: 'signature', page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.07 },
    { document_id: doc.id, recipient_id: alex.id, type: 'date_signed', page: 0, x: 0.5, y: 0.72, w: 0.2, h: 0.04 },
    { document_id: doc.id, recipient_id: alex.id, type: 'text', page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.04, label: 'Company number' },
    { document_id: doc.id, recipient_id: alex.id, type: 'checkbox', page: 1, x: 0.1, y: 0.3, w: 0.03, h: 0.03, required: false },
    { document_id: doc.id, recipient_id: alex.id, type: 'initials', page: 2, x: 0.8, y: 0.85, w: 0.1, h: 0.05 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.fields.length, 5);

  r = await sender('PUT', `/api/envelopes/${id}/annotations`, [
    { document_id: doc.id, page: 0, kind: 'highlight', data: { x: 0.1, y: 0.1, w: 0.4, h: 0.03, color: '#FFE14D' } },
    { document_id: doc.id, page: 0, kind: 'note', data: { x: 0.6, y: 0.1, text: 'Please check clause 4', color: '#FFD84D' } },
    { document_id: doc.id, page: 2, kind: 'text', data: { x: 0.1, y: 0.1, text: 'Rotated page note', color: '#49229D', size: 0.02 } },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  r = await sender('POST', `/api/envelopes/${id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  const alexLink = r.data.recipients.find((x) => x.id === alex.id).link;
  assert.equal(r.data.recipients.find((x) => x.id === blair.id).link, null, 'no link before their turn');
  assert.equal(r.data.recipients.find((x) => x.id === blair.id).status, 'created', 'approver waits for routing order 2');
  assert.equal(r.data.recipients.find((x) => x.role === 'cc').status, 'delivered');
  const alexToken = alexLink.split('/s/')[1];
  // Peek at the not-yet-active token directly to prove the server also enforces order.
  const blairToken = (await require('../lib/db').get('SELECT token FROM recipients WHERE id = ?', blair.id)).token;

  // Access code gate.
  const signer = client();
  r = await signer('GET', `/api/sign/${alexToken}`);
  assert.equal(r.data.needsCode, true);
  r = await signer('POST', `/api/sign/${alexToken}/access`, { code: 'nope' });
  assert.equal(r.status, 403);
  r = await signer('POST', `/api/sign/${alexToken}/access`, { code: '4242' });
  assert.equal(r.status, 200);
  r = await signer('GET', `/api/sign/${alexToken}`);
  assert.equal(r.data.mode, 'sign');
  assert.equal(r.data.fields.length, 5);

  // Blair can't act before Alex.
  const approver = client();
  r = await approver('GET', `/api/sign/${blairToken}`);
  assert.equal(r.data.mode, 'waiting');

  r = await signer('POST', `/api/sign/${alexToken}/complete`, { values: {}, signature: PNG_SIG });
  assert.equal(r.status, 400, 'consent required');
  await signer('POST', `/api/sign/${alexToken}/consent`);
  const textField = r && (await signer('GET', `/api/sign/${alexToken}`)).data.fields.find((f) => f.type === 'text');
  r = await signer('POST', `/api/sign/${alexToken}/complete`, { values: {}, signature: PNG_SIG, initials: PNG_SIG });
  assert.equal(r.status, 400, 'required text missing');
  r = await signer('POST', `/api/sign/${alexToken}/complete`, {
    values: { [textField.id]: 'LS-00981 — “Ünïcode” ✓' }, signature: PNG_SIG, initials: PNG_SIG,
    annotations: [{ document_id: doc.id, page: 1, kind: 'pen', data: { points: [[0.1, 0.5], [0.2, 0.55], [0.3, 0.5]], color: '#E5484D', width: 0.003 } }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  r = await sender('GET', `/api/envelopes/${id}`);
  assert.ok(r.data.recipients.find((x) => x.id === blair.id).link.endsWith(blairToken), 'link appears once active');
  r = await approver('GET', `/api/sign/${blairToken}`);
  assert.equal(r.data.mode, 'sign');
  assert.ok(r.data.fields.some((f) => f.readonly && f.type === 'signature' && f.image), 'sees Alex\'s signature');
  await approver('POST', `/api/sign/${blairToken}/consent`);
  r = await approver('POST', `/api/sign/${blairToken}/complete`, { values: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'completed');

  r = await sender('GET', `/api/envelopes/${id}`);
  assert.equal(r.data.status, 'completed');
  assert.ok(r.data.final_sha256);
  const types = r.data.events.map((e) => e.type);
  for (const t of ['created', 'sent', 'delivered', 'viewed', 'consented', 'signed', 'approved', 'completed']) assert.ok(types.includes(t), `event ${t}`);

  r = await sender('GET', `/api/envelopes/${id}/download`);
  assert.equal(r.status, 200);
  const final = await PDFDocument.load(r.data);
  assert.ok(final.getPageCount() >= 4, 'documents + certificate');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'final.pdf'), r.data);

  // Tamper-evidence check.
  const hash = require('crypto').createHash('sha256').update(r.data).digest('hex');
  r = await client()('POST', '/api/verify', { sha256: hash });
  assert.equal(r.data.match, true);
  r = await client()('POST', '/api/verify', { sha256: 'f'.repeat(64) });
  assert.equal(r.data.match, false);

  r = await sender('GET', '/api/outbox');
  const subjects = r.data.emails.map((m) => `${m.to_email}: ${m.subject}`);
  const has = (to, re) => assert.ok(subjects.some((s) => s.startsWith(to) && re.test(s)), `${to} should get ${re}\n${subjects.join('\n')}`);
  has('alex@client.test', /received a new legal document/);
  has('casey@client.test', /copied on/);
  has('alex@client.test', /^alex@client.test: You signed/);
  has('sal@langsync.test', /Alex Signer signed/);
  has('blair@client.test', /received a new legal document/);
  for (const to of ['alex@client.test', 'blair@client.test', 'casey@client.test', 'sal@langsync.test']) has(to, /Completed/);

  // Templates and duplicates.
  r = await sender('POST', `/api/envelopes/${id}/duplicate`, { template: true });
  assert.equal(r.data.is_template, true);
  assert.equal(r.data.fields.length, 5);
  r = await sender('POST', `/api/envelopes/${r.data.id}/duplicate`, {});
  assert.equal(r.data.status, 'draft');
  assert.equal(r.data.is_template, false);

  // Other users can't see this envelope.
  const other = client();
  await signIn(other, 'other@langsync.test');
  r = await other('GET', `/api/envelopes/${id}`);
  assert.equal(r.status, 404);
});

test('decline and void', async () => {
  const sender = client();
  await signIn(sender, 'dee@langsync.test');
  const make = async () => {
    const env = (await sender('POST', '/api/envelopes', {})).data;
    const form = new FormData();
    form.append('files', new Blob([await samplePdf(1)], { type: 'application/pdf' }), 'NDA.pdf');
    const doc = (await sender('POST', `/api/envelopes/${env.id}/documents`, undefined, { form })).data.documents[0];
    const [rec] = (await sender('PUT', `/api/envelopes/${env.id}/recipients`, [{ name: 'Eli', email: 'eli@x.test', role: 'signer' }])).data.recipients;
    await sender('PUT', `/api/envelopes/${env.id}/fields`, [{ document_id: doc.id, recipient_id: rec.id, type: 'signature', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }]);
    const sent = (await sender('POST', `/api/envelopes/${env.id}/send`)).data;
    return { id: env.id, token: sent.recipients[0].link.split('/s/')[1], rec };
  };

  const a = await make();
  const s = client();
  let r = await s('POST', `/api/sign/${a.token}/decline`, { reason: 'Wrong entity name' });
  assert.equal(r.status, 200);
  r = await sender('GET', `/api/envelopes/${a.id}`);
  assert.equal(r.data.status, 'declined');

  const b = await make();
  r = await sender('POST', `/api/envelopes/${b.id}/void`, { reason: 'Superseded' });
  assert.equal(r.data.status, 'voided');
  r = await s('GET', `/api/sign/${b.token}`);
  assert.equal(r.data.mode, 'closed');

  // Correcting a recipient issues a new link and kills the old one.
  const c = await make();
  r = await sender('PATCH', `/api/envelopes/${c.id}/recipients/${c.rec.id}`, { email: 'eli.correct@x.test' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s('GET', `/api/sign/${c.token}`);
  assert.equal(r.status, 404);
});

test('sign-in codes', async () => {
  const call = client();
  const email = 'codes@langsync.test';
  await call('POST', '/api/auth/code', { email });
  const wrong = codes[email] === '000000' ? '111111' : '000000';
  let r = await call('POST', '/api/auth/verify', { email, code: wrong });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /4 tries left/);
  // Asking again straight away is refused.
  r = await call('POST', '/api/auth/code', { email });
  assert.equal(r.status, 429);
  // A pasted code with spaces still works, and only once.
  r = await call('POST', '/api/auth/verify', { email, code: codes[email].split('').join(' ') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('POST', '/api/auth/verify', { email, code: codes[email] });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/auth/me')).data.user.email, email);
});
