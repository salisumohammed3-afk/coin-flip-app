'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { all, get, run, now, token, logEvent } = require('./db');
const { sendMail } = require('./mailer');
const { buildFinalPdf } = require('./pdf');

const ACTIONABLE = ['signer', 'approver'];
const DONE = ['completed', 'declined'];

const signLink = (r) => `${config.baseUrl}/s/${r.token}`;
const filePath = (rel) => path.join(config.filesDir, rel);
const readFile = (rel) => fs.readFileSync(filePath(rel));

function loadEnvelope(id) {
  const envelope = get('SELECT * FROM envelopes WHERE id = ?', id);
  if (!envelope) return null;
  const documents = all('SELECT * FROM documents WHERE envelope_id = ? ORDER BY sort, created_at', id);
  const recipients = all('SELECT * FROM recipients WHERE envelope_id = ? ORDER BY routing_order, sort', id);
  const fields = all('SELECT * FROM fields WHERE envelope_id = ?', id);
  const annotations = all('SELECT * FROM annotations WHERE envelope_id = ? ORDER BY created_at', id).map((a) => ({ ...a, data: JSON.parse(a.data) }));
  const events = all('SELECT * FROM events WHERE envelope_id = ? ORDER BY id', id);
  const owner = get('SELECT id, name, email FROM users WHERE id = ?', envelope.owner_id);
  return { envelope, documents, recipients, fields, annotations, events, owner };
}

function validateForSend(full) {
  const { documents, recipients, fields } = full;
  const problems = [];
  if (!documents.length) problems.push('Add at least one document.');
  const actionable = recipients.filter((r) => ACTIONABLE.includes(r.role));
  if (!actionable.length) problems.push('Add at least one recipient who needs to sign or approve.');
  for (const r of recipients) {
    if (!r.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) problems.push(`Recipient "${r.name || r.email || 'unnamed'}" needs a name and valid email.`);
  }
  for (const r of recipients.filter((r) => r.role === 'signer')) {
    if (!fields.some((f) => f.recipient_id === r.id && f.type === 'signature')) {
      problems.push(`${r.name || r.email} has no signature field. Place at least one on the document.`);
    }
  }
  return problems;
}

async function sendEnvelope(envelopeId, actor) {
  const full = loadEnvelope(envelopeId);
  const problems = validateForSend(full);
  if (problems.length) {
    const err = new Error(problems.join(' '));
    err.status = 400;
    throw err;
  }
  const ts = now();
  const expires = full.envelope.expires_days > 0 ? new Date(Date.now() + full.envelope.expires_days * 864e5).toISOString() : null;
  run(`UPDATE envelopes SET status = 'sent', sent_at = ?, updated_at = ?, expires_at = ? WHERE id = ?`, ts, ts, expires, envelopeId);
  for (const r of full.recipients) run(`UPDATE recipients SET token = ?, status = 'created' WHERE id = ?`, token(), r.id);
  logEvent(envelopeId, { actor: actor.name, type: 'sent', detail: `Sent to ${full.recipients.map((r) => r.email).join(', ')}` });
  await advance(envelopeId);
}

/**
 * Routing: everyone at the lowest routing order that still has an
 * unfinished signer/approver is active. CCs are delivered when their
 * routing order is reached. When nobody is left, the envelope completes.
 */
async function advance(envelopeId) {
  const full = loadEnvelope(envelopeId);
  const { envelope, recipients, owner } = full;
  if (envelope.status !== 'sent') return;
  const pending = recipients.filter((r) => ACTIONABLE.includes(r.role) && !DONE.includes(r.status));
  if (!pending.length) return completeEnvelope(envelopeId);
  const currentOrder = envelope.sequential ? Math.min(...pending.map((r) => r.routing_order)) : Infinity;
  for (const r of recipients) {
    if (r.status !== 'created' || r.routing_order > currentOrder) continue;
    const ts = now();
    if (r.role === 'cc') {
      run(`UPDATE recipients SET status = 'delivered', sent_at = ? WHERE id = ?`, ts, r.id);
      await sendMail({
        envelopeId, ownerId: owner.id, to: r.email, toName: r.name,
        subject: `${owner.name} shared "${envelope.title}" with you`,
        heading: `You've been copied on "${envelope.title}"`,
        intro: `${owner.name} (${owner.email}) added you as a CC. You'll get the completed copy once everyone has signed.`,
        message: r.private_message || envelope.message,
        buttonLabel: 'View document', link: signLink(r),
      });
    } else {
      run(`UPDATE recipients SET status = 'sent', sent_at = ? WHERE id = ?`, ts, r.id);
      const verb = r.role === 'approver' ? 'approve' : 'sign';
      await sendMail({
        envelopeId, ownerId: owner.id, to: r.email, toName: r.name,
        subject: envelope.subject || `Please ${verb}: ${envelope.title}`,
        heading: `${owner.name} sent you a document to ${verb}`,
        intro: `"${envelope.title}" is waiting for you.${r.access_code ? ' You will need the access code the sender shares with you separately.' : ''}`,
        message: r.private_message || envelope.message,
        buttonLabel: r.role === 'approver' ? 'Review document' : 'Review & sign', link: signLink(r),
        footer: envelope.expires_at ? `This request expires on ${new Date(envelope.expires_at).toDateString()}.` : '',
      });
    }
    logEvent(envelopeId, { recipientId: r.id, actor: 'system', type: 'delivered', detail: `Email sent to ${r.name} <${r.email}>` });
  }
}

async function completeEnvelope(envelopeId) {
  const ts = now();
  // Guarded so two signers finishing at once can't complete the envelope twice.
  const res = run(`UPDATE envelopes SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`, ts, ts, envelopeId);
  if (!res.changes) return;
  logEvent(envelopeId, { actor: 'system', type: 'completed', detail: 'All recipients finished' });
  const refreshed = loadEnvelope(envelopeId);
  let built;
  try {
    built = await buildFinalPdf({ ...refreshed, readFile });
  } catch (err) {
    // Signatures are already recorded; leave the envelope completed and surface the problem.
    console.error(`[complete] could not build final PDF for ${envelopeId}:`, err);
    logEvent(envelopeId, { actor: 'system', type: 'error', detail: 'Could not generate the completed PDF. Contact your admin.' });
    return;
  }
  const { bytes, sha256 } = built;
  const rel = path.join(envelopeId, 'completed.pdf');
  fs.mkdirSync(path.dirname(filePath(rel)), { recursive: true });
  fs.writeFileSync(filePath(rel), bytes);
  run(`UPDATE envelopes SET final_file = ?, final_sha256 = ? WHERE id = ?`, rel, sha256, envelopeId);

  const { envelope, owner, recipients } = refreshed;
  const fileName = `${safeName(envelope.title)} - completed.pdf`;
  const attach = bytes.length < 10 * 1024 * 1024 ? [{ filename: fileName, content: bytes }] : undefined;
  for (const r of recipients) {
    if (r.status === 'created' && r.role === 'cc') run(`UPDATE recipients SET status = 'delivered', sent_at = ? WHERE id = ?`, ts, r.id);
    if (r.role === 'cc') run(`UPDATE recipients SET completed_at = ? WHERE id = ?`, ts, r.id);
    await sendMail({
      envelopeId, ownerId: owner.id, to: r.email, toName: r.name,
      subject: `Completed: ${envelope.title}`,
      heading: 'All parties have completed the document',
      intro: `"${envelope.title}" is fully executed. Download your copy below.`,
      buttonLabel: 'Download completed copy', link: `${signLink(r)}?download=1`, attachments: attach,
    });
  }
  await sendMail({
    envelopeId, ownerId: owner.id, to: owner.email, toName: owner.name,
    subject: `Completed: ${envelope.title}`,
    heading: 'Your envelope is complete',
    intro: `Everyone has finished "${envelope.title}". The completed PDF and certificate are stored in ${config.appName}.`,
    buttonLabel: 'Open envelope', link: `${config.baseUrl}/#/envelopes/${envelopeId}`, attachments: attach,
  });
}

async function notifyOwner(envelopeId, { subject, heading, intro }) {
  const { envelope, owner } = loadEnvelope(envelopeId);
  await sendMail({
    envelopeId, ownerId: owner.id, to: owner.email, toName: owner.name, subject, heading, intro,
    buttonLabel: 'Open envelope', link: `${config.baseUrl}/#/envelopes/${envelope.id}`,
  });
}

async function remind(envelopeId, actorName) {
  const { envelope, recipients, owner } = loadEnvelope(envelopeId);
  if (envelope.status !== 'sent') return 0;
  const waiting = recipients.filter((r) => ACTIONABLE.includes(r.role) && ['sent', 'viewed'].includes(r.status));
  for (const r of waiting) {
    await sendMail({
      envelopeId, ownerId: owner.id, to: r.email, toName: r.name,
      subject: `Reminder: ${envelope.subject || envelope.title}`,
      heading: `Reminder from ${owner.name}`,
      intro: `"${envelope.title}" is still waiting for you to ${r.role === 'approver' ? 'approve' : 'sign'}.`,
      message: envelope.message, buttonLabel: 'Review & sign', link: signLink(r),
    });
    run('UPDATE recipients SET last_reminded_at = ? WHERE id = ?', now(), r.id);
    logEvent(envelopeId, { recipientId: r.id, actor: actorName, type: 'reminded', detail: `Reminder sent to ${r.email}` });
  }
  return waiting.length;
}

/** Hourly housekeeping: expire stale envelopes and send automatic reminders. */
async function sweep() {
  const ts = now();
  for (const e of all(`SELECT id FROM envelopes WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at < ?`, ts)) {
    run(`UPDATE envelopes SET status = 'expired', updated_at = ? WHERE id = ?`, ts, e.id);
    logEvent(e.id, { actor: 'system', type: 'expired', detail: 'Envelope expired before completion' });
    const { envelope } = loadEnvelope(e.id);
    await notifyOwner(e.id, { subject: `Expired: ${envelope.title}`, heading: 'Envelope expired', intro: `"${envelope.title}" expired before everyone finished. Duplicate it to send again.` });
  }
  for (const e of all(`SELECT id, reminder_days, sent_at FROM envelopes WHERE status = 'sent' AND reminder_days > 0`)) {
    const dueBefore = new Date(Date.now() - e.reminder_days * 864e5).toISOString();
    const waiting = all(
      `SELECT id FROM recipients WHERE envelope_id = ? AND role IN ('signer','approver') AND status IN ('sent','viewed')
       AND COALESCE(last_reminded_at, sent_at) < ?`, e.id, dueBefore);
    if (waiting.length) await remind(e.id, 'system (auto-reminder)');
  }
}

const safeName = (s) => String(s || 'document').replace(/[^\w\s.-]+/g, '').trim().slice(0, 80) || 'document';

module.exports = { loadEnvelope, validateForSend, sendEnvelope, advance, completeEnvelope, notifyOwner, remind, sweep, filePath, readFile, safeName, ACTIONABLE };
