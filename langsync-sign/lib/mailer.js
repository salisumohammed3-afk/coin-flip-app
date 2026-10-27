'use strict';

// Email delivery (Resend HTTP API, or SMTP) plus the branded LangSync Sign template.
// Every email is also recorded in the outbox so senders can see what went out.

const config = require('./config');
const { run, now, uid } = require('./db');

let smtp = null;
if (!config.resendKey && config.smtp) smtp = require('nodemailer').createTransport(config.smtp);
const provider = config.resendKey ? 'resend' : smtp ? 'smtp' : null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const C = { ink: '#0B1220', muted: '#5B6472', line: '#E9EDF3', brand: '#0099FF', brandInk: '#0B64A8', wash: '#F6F9FE', sunken: '#F6F8FB', good: '#0F7A44', goodWash: '#E6F7EE', bad: '#C0392B', badWash: '#FDECEA', warn: '#8A5A00', warnWash: '#FFF4E0' };
const FONT = "'DM Sans','Segoe UI',Helvetica,Arial,sans-serif";
const DISPLAY = "'Outfit','DM Sans','Segoe UI',Helvetica,Arial,sans-serif";
const TONES = { brand: [C.brandInk, '#E8F3FF'], good: [C.good, C.goodWash], bad: [C.bad, C.badWash], warn: [C.warn, C.warnWash] };

/**
 * Renders the branded email.
 * @param {object} m
 *   eyebrow, heading, intro, tone ('brand'|'good'|'bad'|'warn'), badge (short status text),
 *   document { title, files: [{ name, pages }] }, sender { name, email }, message,
 *   button { label, url }, details: [[label, value]], people: [{ name, status }], note, footer
 */
function render(m) {
  const [toneInk, toneWash] = TONES[m.tone || 'brand'];
  const preheader = m.preheader || m.intro || '';
  const files = m.document?.files || [];
  const docCard = m.document ? `
    <tr><td style="padding:0 32px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;background:${C.wash}">
        <tr><td style="padding:18px 20px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td valign="top" style="padding-right:14px"><div style="width:44px;height:52px;border-radius:8px;background:#fff;border:1px solid ${C.line};text-align:center;line-height:52px;font:700 11px ${FONT};color:${C.bad};letter-spacing:.04em">PDF</div></td>
            <td valign="top">
              <div style="font:600 16px/1.35 ${DISPLAY};color:${C.ink}">${esc(m.document.title)}</div>
              ${files.length ? `<div style="font:400 13px/1.5 ${FONT};color:${C.muted};margin-top:4px">${files.map((f) => `${esc(f.name)}${f.pages ? ` · ${f.pages} page${f.pages === 1 ? '' : 's'}` : ''}`).join('<br>')}</div>` : ''}
              ${m.badge ? `<div style="margin-top:10px"><span style="display:inline-block;padding:3px 10px;border-radius:99px;background:${toneWash};color:${toneInk};font:600 12px ${FONT}">${esc(m.badge)}</span></div>` : ''}
            </td></tr></table>
        </td></tr>
      </table>
    </td></tr>` : '';
  const messageCard = m.message ? `
    <tr><td style="padding:0 32px 22px">
      <div style="font:600 12px ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Message from ${esc(m.sender?.name || 'the sender')}</div>
      <div style="border-left:3px solid ${C.brand};padding:4px 0 4px 14px;font:400 15px/1.6 ${FONT};color:${C.ink};white-space:pre-wrap">${esc(m.message)}</div>
    </td></tr>` : '';
  const button = m.button ? `
    <tr><td style="padding:4px 32px 10px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:${C.brand};box-shadow:0 6px 18px rgba(0,153,255,.28)">
        <a href="${esc(m.button.url)}" style="display:inline-block;padding:14px 28px;font:600 15px ${FONT};color:#ffffff;text-decoration:none;border-radius:12px">${esc(m.button.label)} &rarr;</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:6px 32px 24px;font:400 12px/1.6 ${FONT};color:${C.muted}">Button not working? Paste this link into your browser:<br><a href="${esc(m.button.url)}" style="color:${C.brandInk};word-break:break-all">${esc(m.button.url)}</a></td></tr>` : '';
  const people = m.people?.length ? `
    <tr><td style="padding:0 32px 22px">
      <div style="font:600 12px ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Recipients</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px">
        ${m.people.map((p, i) => `<tr><td style="padding:11px 16px;${i ? `border-top:1px solid ${C.line};` : ''}font:500 14px ${FONT};color:${C.ink}">${esc(p.name)}</td><td align="right" style="padding:11px 16px;${i ? `border-top:1px solid ${C.line};` : ''}font:500 13px ${FONT};color:${p.done ? C.good : C.muted}">${p.done ? '&#10003; ' : ''}${esc(p.status)}</td></tr>`).join('')}
      </table>
    </td></tr>` : '';
  const details = m.details?.length ? `
    <tr><td style="padding:0 32px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sunken};border-radius:12px">
        ${m.details.map(([k, v]) => `<tr><td style="padding:9px 16px;font:400 13px ${FONT};color:${C.muted};width:130px;vertical-align:top">${esc(k)}</td><td style="padding:9px 16px;font:500 13px ${FONT};color:${C.ink};word-break:break-word">${esc(v)}</td></tr>`).join('')}
      </table>
    </td></tr>` : '';
  const note = m.note ? `<tr><td style="padding:0 32px 24px;font:400 13px/1.6 ${FONT};color:${C.muted}">${esc(m.note)}</td></tr>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(m.heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${C.sunken};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sunken}"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:18px;overflow:hidden">
    <tr><td style="height:5px;line-height:5px;font-size:0;background:${C.brand};background-image:linear-gradient(135deg,#128EFE,#9135FC)">&nbsp;</td></tr>
    <tr><td style="padding:26px 32px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><img src="${esc(config.baseUrl)}/img/lockup.png" alt="LangSync" height="28" style="height:28px;width:auto;display:block;border:0"></td>
        <td align="right" style="font:600 12px ${FONT};color:${C.muted}">Sign</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:30px 32px 0">
      ${m.eyebrow ? `<div style="font:600 13px ${FONT};color:${toneInk};margin-bottom:8px">${esc(m.eyebrow)}</div>` : ''}
      <h1 style="margin:0;font:700 28px/1.15 ${DISPLAY};letter-spacing:-0.02em;color:${C.ink}">${esc(m.heading)}</h1>
      ${m.intro ? `<p style="margin:14px 0 24px;font:400 15px/1.65 ${FONT};color:${C.muted}">${esc(m.intro)}</p>` : '<div style="height:20px"></div>'}
    </td></tr>
    ${docCard}${messageCard}${button}${people}${details}${note}
    <tr><td style="padding:20px 32px 26px;border-top:1px solid ${C.line};font:400 12px/1.6 ${FONT};color:${C.muted}">
      ${m.footer ? `${esc(m.footer)}<br>` : ''}
      <strong style="color:${C.ink}">Do not share this email.</strong> It contains a secure link that is unique to you.<br>
      Sent with ${esc(config.appName)}${m.sender ? ` on behalf of ${esc(m.sender.name)}` : ''}. Electronic signatures are legally binding under the ESIGN Act, UETA and eIDAS.
    </td></tr>
  </table>
  <div style="font:400 11px ${FONT};color:${C.muted};padding-top:16px">LangSync · ${esc(config.baseUrl.replace(/^https?:\/\//, ''))}</div>
</td></tr></table></body></html>`;
}

function toText(m) {
  return [
    m.heading, '', m.intro,
    m.document ? `\nDocument: ${m.document.title}` : '',
    m.message ? `\nMessage from ${m.sender?.name || 'the sender'}:\n${m.message}` : '',
    m.button ? `\n${m.button.label}: ${m.button.url}` : '',
    ...(m.details || []).map(([k, v]) => `${k}: ${v}`),
    m.note ? `\n${m.note}` : '',
    '\nDo not share this email: the link is unique to you.',
  ].filter((l) => l !== undefined).join('\n');
}

async function deliver({ to, toName, subject, html, text, attachments }) {
  if (provider === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: config.mailFrom,
        to: [toName ? `${toName.replace(/["<>]/g, '')} <${to}>` : to],
        subject, html, text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  await smtp.sendMail({ from: config.mailFrom, to: toName ? `"${toName.replace(/"/g, '')}" <${to}>` : to, subject, html, text, attachments });
}

/**
 * Sends one branded email and records it in the outbox.
 * `message` is the template model accepted by render().
 */
async function sendMail({ envelopeId = null, ownerId = null, to, toName = '', subject, attachments, ...model }) {
  const id = uid('m_');
  const html = render(model);
  const text = toText(model);
  let status = 'logged';
  let error = null;
  if (provider) {
    try {
      await deliver({ to, toName, subject, html, text, attachments });
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = err.message;
      console.error(`[mail] failed to send to ${to}: ${err.message}`);
    }
  } else {
    console.log(`[mail] (no email provider configured) to=${to} subject="${subject}"${model.button ? ` link=${model.button.url}` : ''}`);
  }
  await run(
    `INSERT INTO emails (id, envelope_id, owner_id, to_email, to_name, subject, body, link, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, envelopeId, ownerId, to, toName, subject, text, model.button?.url || null, status, error, now()
  );
  return { id, status, html };
}

module.exports = { sendMail, render, smtpEnabled: Boolean(provider), provider };
