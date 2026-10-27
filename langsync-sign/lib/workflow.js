'use strict';

// Envelope lifecycle: routing order, notifications, completion, reminders and expiry.

const config = require('./config');
const { all, get, run, now, token, logEvent } = require('./db');
const { sendMail } = require('./mailer');
const { buildFinalPdf } = require('./pdf');
const storage = require('./storage');

const ACTIONABLE = ['signer', 'approver'];
const DONE = ['completed', 'declined'];

const signLink = (r) => `${config.baseUrl}/s/${r.token}`;
const appLink = (envelopeId) => `${config.baseUrl}/#/envelopes/${envelopeId}`;
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
const safeName = (s) => String(s || 'document').replace(/[^\w\s.-]+/g, '').trim().slice(0, 80) || 'document';
const verbFor = (r) => (r.role === 'approver' ? 'approve' : 'sign');

async function loadEnvelope(id) {
  const envelope = await get('SELECT * FROM envelopes WHERE id = ?', id);
  if (!envelope) return null;
  const [documents, recipients, fields, annotations, events, owner] = await Promise.all([
    all('SELECT * FROM documents WHERE envelope_id = ? ORDER BY sort, created_at', id),
    all('SELECT * FROM recipients WHERE envelope_id = ? ORDER BY routing_order, sort', id),
    all('SELECT * FROM fields WHERE envelope_id = ?', id),
    all('SELECT * FROM annotations WHERE envelope_id = ? ORDER BY created_at', id),
    all('SELECT * FROM events WHERE envelope_id = ? ORDER BY id', id),
    get('SELECT id, name, email FROM users WHERE id = ?', envelope.owner_id),
  ]);
  return {
    envelope, documents, recipients, owner, events,
    fields: fields.map((f) => ({ ...f, options: f.options ? JSON.parse(f.options) : null })),
    annotations: annotations.map((a) => ({ ...a, data: JSON.parse(a.data) })),
  };
}

function validateForSend(full) {
  const { documents, recipients, fields } = full;
  const problems = [];
  if (!documents.length) problems.push('Add at least one document.');
  if (!recipients.some((r) => ACTIONABLE.includes(r.role))) problems.push('Add at least one recipient who needs to sign or approve.');
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

/* ------------------------------ email models ------------------------------ */

const docModel = (full) => ({ title: full.envelope.title, files: full.documents.map((d) => ({ name: d.name, pages: d.page_count })) });
const peopleModel = (full) =>
  full.recipients.filter((r) => ACTIONABLE.includes(r.role)).map((r) => ({
    name: r.name,
    done: r.status === 'completed',
    status: r.status === 'completed' ? (r.role === 'approver' ? 'Approved' : 'Signed') : r.status === 'declined' ? 'Declined' : r.status === 'created' ? 'Up next' : 'Waiting',
  }));

async function emailRequest(full, r, { reminder = false } = {}) {
  const { envelope, owner } = full;
  const verb = verbFor(r);
  const details = [['From', `${owner.name} (${owner.email})`]];
  if (envelope.expires_at) details.push(['Please complete by', fmtDay(envelope.expires_at)]);
  if (r.access_code) details.push(['Access code', `Required. ${owner.name.split(' ')[0]} will share it with you separately`]);
  await sendMail({
    envelopeId: envelope.id, ownerId: owner.id, to: r.email, toName: r.name,
    subject: reminder ? `Reminder: "${envelope.title}" is waiting for you` : envelope.subject || `You've received a new legal document: ${envelope.title}`,
    preheader: `${owner.name} needs you to ${verb} "${envelope.title}".`,
    eyebrow: reminder ? 'Friendly reminder' : 'Action required',
    heading: reminder ? 'Your document is still waiting' : "You've received a new legal document",
    intro: `Hi ${r.name.split(' ')[0]}, ${owner.name} at LangSync has sent you "${envelope.title}" to ${verb}. It only takes a minute, and no account is needed.`,
    document: docModel(full), badge: verb === 'approve' ? 'Needs your approval' : 'Needs your signature',
    sender: owner, message: r.private_message || envelope.message,
    button: { label: verb === 'approve' ? 'Review & approve' : 'Review & sign', url: signLink(r) },
    details,
  });
}

async function emailCc(full, r) {
  const { envelope, owner } = full;
  await sendMail({
    envelopeId: envelope.id, ownerId: owner.id, to: r.email, toName: r.name,
    subject: `You've been copied on "${envelope.title}"`,
    eyebrow: 'For your records', heading: "You've been copied on a document",
    intro: `${owner.name} added you as a CC on "${envelope.title}". There's nothing for you to sign. We'll email you the completed copy once everyone has finished.`,
    document: docModel(full), badge: 'You receive a copy', sender: owner, message: r.private_message || envelope.message,
    button: { label: 'View document', url: signLink(r) },
    people: peopleModel(full),
  });
}

/* -------------------------------- lifecycle -------------------------------- */

async function sendEnvelope(envelopeId, actor) {
  const full = await loadEnvelope(envelopeId);
  const problems = validateForSend(full);
  if (problems.length) {
    const err = new Error(problems.join(' '));
    err.status = 400;
    throw err;
  }
  const ts = now();
  const expires = full.envelope.expires_days > 0 ? new Date(Date.now() + full.envelope.expires_days * 864e5).toISOString() : null;
  await run(`UPDATE envelopes SET status = 'sent', sent_at = ?, updated_at = ?, expires_at = ? WHERE id = ?`, ts, ts, expires, envelopeId);
  for (const r of full.recipients) await run(`UPDATE recipients SET token = ?, status = 'created' WHERE id = ?`, token(), r.id);
  await logEvent(envelopeId, { actor: actor.name, type: 'sent', detail: `Sent to ${full.recipients.map((r) => r.email).join(', ')}` });
  await advance(envelopeId);
}

/**
 * Routing: everyone at the lowest routing order that still has an unfinished
 * signer/approver is active. CCs are delivered when their routing order is
 * reached. When nobody is left, the envelope completes.
 */
async function advance(envelopeId) {
  const full = await loadEnvelope(envelopeId);
  const { envelope, recipients } = full;
  if (envelope.status !== 'sent') return;
  const pending = recipients.filter((r) => ACTIONABLE.includes(r.role) && !DONE.includes(r.status));
  if (!pending.length) return completeEnvelope(envelopeId);
  const currentOrder = envelope.sequential ? Math.min(...pending.map((r) => r.routing_order)) : Infinity;
  for (const r of recipients) {
    if (r.status !== 'created' || r.routing_order > currentOrder) continue;
    // Claim the recipient first so concurrent requests can't double-send.
    const claimed = await run(`UPDATE recipients SET status = ?, sent_at = ? WHERE id = ? AND status = 'created'`, r.role === 'cc' ? 'delivered' : 'sent', now(), r.id);
    if (!claimed.changes) continue;
    if (r.role === 'cc') await emailCc(full, r);
    else await emailRequest(full, r);
    await logEvent(envelopeId, { recipientId: r.id, actor: 'system', type: 'delivered', detail: `Email sent to ${r.name} <${r.email}>` });
  }
}

/** Called after a recipient signs or approves. */
async function recipientFinished(envelopeId, recipientId, { marks = 0 } = {}) {
  const full = await loadEnvelope(envelopeId);
  const { envelope, owner } = full;
  const r = full.recipients.find((x) => x.id === recipientId);
  const verb = r.role === 'approver' ? 'approved' : 'signed';
  const actionable = full.recipients.filter((x) => ACTIONABLE.includes(x.role));
  const done = actionable.filter((x) => x.status === 'completed').length;
  const allDone = done === actionable.length;

  if (!allDone) {
    // Confirmation for the signer; the final copy follows when everyone is done.
    await sendMail({
      envelopeId, ownerId: owner.id, to: r.email, toName: r.name,
      subject: `You ${verb} "${envelope.title}"`,
      eyebrow: 'Confirmation', tone: 'good', heading: `You've ${verb} the document`,
      intro: `Thanks, ${r.name.split(' ')[0]}. Your ${r.role === 'approver' ? 'approval' : 'signature'} on "${envelope.title}" has been recorded. We're waiting on the others now, and we'll email you the completed, fully signed copy as soon as everyone has finished.`,
      document: docModel(full), badge: `${done} of ${actionable.length} complete`, sender: owner,
      button: { label: 'View document', url: signLink(r) },
      people: peopleModel(full),
    });
    await sendMail({
      envelopeId, ownerId: owner.id, to: owner.email, toName: owner.name,
      subject: `${r.name} ${verb} "${envelope.title}"`,
      eyebrow: 'Status update', tone: 'good', heading: `${r.name} ${verb} your document`,
      intro: `${r.name} (${r.email}) ${verb} "${envelope.title}"${marks ? ` and added ${marks} markup item${marks === 1 ? '' : 's'}` : ''}. ${actionable.length - done} recipient${actionable.length - done === 1 ? ' is' : 's are'} still to go.`,
      document: docModel(full), badge: `${done} of ${actionable.length} complete`,
      button: { label: 'Track progress', url: appLink(envelopeId) },
      people: peopleModel(full),
    });
  }
  await advance(envelopeId);
}

async function completeEnvelope(envelopeId) {
  const ts = now();
  // Guarded so two signers finishing at once can't complete the envelope twice.
  const res = await run(`UPDATE envelopes SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`, ts, ts, envelopeId);
  if (!res.changes) return;
  await logEvent(envelopeId, { actor: 'system', type: 'completed', detail: 'All recipients finished' });
  for (const r of (await loadEnvelope(envelopeId)).recipients) {
    if (r.role === 'cc') await run(`UPDATE recipients SET status = 'delivered', sent_at = COALESCE(sent_at, ?), completed_at = ? WHERE id = ?`, ts, ts, r.id);
  }
  const full = await loadEnvelope(envelopeId);
  let built;
  try {
    const files = Object.fromEntries(await Promise.all(full.documents.map(async (d) => [d.file, await storage.get(d.file)])));
    built = await buildFinalPdf({ ...full, readFile: (key) => files[key] });
  } catch (err) {
    // Signatures are already recorded; leave the envelope completed and surface the problem.
    console.error(`[complete] could not build final PDF for ${envelopeId}:`, err);
    await logEvent(envelopeId, { actor: 'system', type: 'error', detail: 'Could not generate the completed PDF. Contact your admin.' });
    return;
  }
  const key = `${envelopeId}/completed.pdf`;
  await storage.put(key, built.bytes);
  await run(`UPDATE envelopes SET final_file = ?, final_sha256 = ? WHERE id = ?`, key, built.sha256, envelopeId);

  const { envelope, owner, recipients } = full;
  const filename = `${safeName(envelope.title)} - completed.pdf`;
  // Resend allows 40 MB per email; keep a margin and fall back to the download link.
  const attachments = built.bytes.length < 25 * 1024 * 1024 ? [{ filename, content: built.bytes }] : undefined;
  const details = [
    ['Completed', fmtTime(ts)],
    ['Envelope ID', envelope.id],
    ['Fingerprint', `SHA-256 ${built.sha256.slice(0, 16)}…`],
  ];
  const people = peopleModel(full);
  for (const r of recipients) {
    await sendMail({
      envelopeId, ownerId: owner.id, to: r.email, toName: r.name, attachments,
      subject: `Completed: "${envelope.title}". Here's your signed copy`,
      eyebrow: 'Completed', tone: 'good', heading: 'Your document is complete',
      intro: `Good news, ${r.name.split(' ')[0]}: everyone has signed "${envelope.title}". ${attachments ? 'The completed document, with its certificate of completion, is attached to this email.' : 'Download the completed document, with its certificate of completion, below.'} You can come back to this link any time to download it again.`,
      document: docModel(full), badge: 'Fully executed', sender: owner,
      button: { label: 'Download completed document', url: `${signLink(r)}?download=1` },
      people, details,
      note: 'Keep this email for your records. Anyone can confirm the PDF is authentic and unmodified on the LangSync Sign verify page.',
    });
  }
  await sendMail({
    envelopeId, ownerId: owner.id, to: owner.email, toName: owner.name, attachments,
    subject: `Completed: "${envelope.title}"`,
    eyebrow: 'Completed', tone: 'good', heading: 'Your envelope is complete',
    intro: `Everyone has finished "${envelope.title}". The signed PDF and certificate of completion are attached and stored in ${config.appName}. Every recipient has been sent their copy.`,
    document: docModel(full), badge: 'Fully executed',
    button: { label: 'Open in LangSync Sign', url: appLink(envelopeId) },
    people, details,
  });
}

async function declineEnvelope(full, r, reason) {
  const { envelope, owner } = full;
  await sendMail({
    envelopeId: envelope.id, ownerId: owner.id, to: owner.email, toName: owner.name,
    subject: `${r.name} declined "${envelope.title}"`,
    eyebrow: 'Declined', tone: 'bad', heading: `${r.name} declined to sign`,
    intro: `${r.name} (${r.email}) declined "${envelope.title}", so the envelope has been cancelled for everyone. Fix the issue, then duplicate the envelope to send it again.`,
    document: docModel(full), badge: 'Declined', message: reason, sender: { name: r.name },
    button: { label: 'Open envelope', url: appLink(envelope.id) },
  });
  for (const other of full.recipients.filter((x) => x.id !== r.id && x.status !== 'created')) {
    await sendMail({
      envelopeId: envelope.id, ownerId: owner.id, to: other.email, toName: other.name,
      subject: `"${envelope.title}" was declined`,
      eyebrow: 'No action needed', tone: 'bad', heading: 'This document was declined',
      intro: `${r.name} declined to sign "${envelope.title}", so it has been cancelled. ${owner.name} will be in touch if a new version is needed.`,
      document: docModel(full), badge: 'Cancelled', sender: owner,
    });
  }
}

async function voidEnvelope(full, actor, reason) {
  const { envelope, owner } = full;
  for (const r of full.recipients.filter((x) => x.status !== 'created')) {
    await sendMail({
      envelopeId: envelope.id, ownerId: owner.id, to: r.email, toName: r.name,
      subject: `Voided: "${envelope.title}"`,
      eyebrow: 'No action needed', tone: 'warn', heading: 'This document was withdrawn',
      intro: `${actor.name} voided "${envelope.title}". You don't need to do anything, and the signing link no longer works.`,
      document: docModel(full), badge: 'Voided', message: reason, sender: actor,
    });
  }
}

async function remind(envelopeId, actorName) {
  const full = await loadEnvelope(envelopeId);
  if (full.envelope.status !== 'sent') return 0;
  const waiting = full.recipients.filter((r) => ACTIONABLE.includes(r.role) && ['sent', 'viewed'].includes(r.status));
  for (const r of waiting) {
    await emailRequest(full, r, { reminder: true });
    await run('UPDATE recipients SET last_reminded_at = ? WHERE id = ?', now(), r.id);
    await logEvent(envelopeId, { recipientId: r.id, actor: actorName, type: 'reminded', detail: `Reminder sent to ${r.email}` });
  }
  return waiting.length;
}

/** Re-sends the request email after a recipient is corrected. */
async function resendRequest(envelopeId, recipientId) {
  const full = await loadEnvelope(envelopeId);
  const r = full.recipients.find((x) => x.id === recipientId);
  if (r && ['sent', 'viewed'].includes(r.status)) await emailRequest(full, r);
}

async function expireEnvelope(envelopeId) {
  const res = await run(`UPDATE envelopes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'sent'`, now(), envelopeId);
  if (!res.changes) return;
  await logEvent(envelopeId, { actor: 'system', type: 'expired', detail: 'Envelope expired before completion' });
  const full = await loadEnvelope(envelopeId);
  await sendMail({
    envelopeId, ownerId: full.owner.id, to: full.owner.email, toName: full.owner.name,
    subject: `Expired: "${full.envelope.title}"`,
    eyebrow: 'Expired', tone: 'warn', heading: 'Your envelope expired',
    intro: `"${full.envelope.title}" expired before everyone finished. Duplicate it from LangSync Sign to send it again.`,
    document: docModel(full), badge: 'Expired', people: peopleModel(full),
    button: { label: 'Open envelope', url: appLink(envelopeId) },
  });
}

/** Scheduled housekeeping (Vercel Cron in production): expiry and auto-reminders. */
async function sweep() {
  const ts = now();
  for (const e of await all(`SELECT id FROM envelopes WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at < ?`, ts)) {
    await expireEnvelope(e.id);
  }
  for (const e of await all(`SELECT id, reminder_days FROM envelopes WHERE status = 'sent' AND reminder_days > 0`)) {
    const dueBefore = new Date(Date.now() - e.reminder_days * 864e5).toISOString();
    const waiting = await all(
      `SELECT id FROM recipients WHERE envelope_id = ? AND role IN ('signer','approver') AND status IN ('sent','viewed') AND COALESCE(last_reminded_at, sent_at) < ?`,
      e.id, dueBefore
    );
    if (waiting.length) await remind(e.id, 'system (auto-reminder)');
  }
}

module.exports = {
  loadEnvelope, validateForSend, sendEnvelope, advance, recipientFinished, completeEnvelope,
  declineEnvelope, voidEnvelope, remind, resendRequest, expireEnvelope, sweep, safeName, ACTIONABLE,
};
