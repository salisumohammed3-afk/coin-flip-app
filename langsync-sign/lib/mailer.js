'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');
const { run, now, uid } = require('./db');

const transport = config.smtp ? nodemailer.createTransport(config.smtp) : null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout({ heading, intro, message, buttonLabel, link, footer }) {
  return `<!doctype html><html><body style="margin:0;background:#F6F2FF;font-family:'HK Grotesk Pro','HK Grotesk',Helvetica,Arial,sans-serif;color:#111">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #E8E8E8">
<tr><td style="background:linear-gradient(90deg,#49229D,#8B36FE);background-color:#49229D;padding:20px 28px;color:#fff;font-weight:700;font-size:18px">${esc(config.appName)}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-size:22px;color:#49229D">${esc(heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#3B3B3B">${esc(intro)}</p>
${message ? `<div style="margin:0 0 20px;padding:14px 16px;background:#F6F2FF;border-radius:10px;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(message)}</div>` : ''}
${link ? `<a href="${esc(link)}" style="display:inline-block;background:#49229D;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">${esc(buttonLabel)}</a>` : ''}
${footer ? `<p style="margin:24px 0 0;font-size:12px;color:#8A8A8A;line-height:1.5">${esc(footer)}</p>` : ''}
</td></tr></table>
<p style="font-size:11px;color:#8A8A8A;margin-top:16px">Do not forward this email: the link is unique to you.</p>
</td></tr></table></body></html>`;
}

/**
 * Sends an email when SMTP is configured, and always records it in the outbox
 * so senders can see (and copy) every link even without a mail server.
 */
async function sendMail({ envelopeId = null, ownerId = null, to, toName = '', subject, heading, intro, message, buttonLabel, link, footer, attachments }) {
  const id = uid('m_');
  const html = layout({ heading, intro, message, buttonLabel, link, footer });
  const text = [heading, '', intro, message ? `\n${message}\n` : '', link ? `${buttonLabel}: ${link}` : '', footer || ''].join('\n');
  let status = 'logged';
  let error = null;
  if (transport) {
    try {
      await transport.sendMail({ from: config.mailFrom, to: toName ? `"${toName.replace(/"/g, '')}" <${to}>` : to, subject, html, text, attachments });
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = err.message;
      console.error(`[mail] failed to send to ${to}: ${err.message}`);
    }
  } else {
    console.log(`[mail] (no SMTP configured) to=${to} subject="${subject}"${link ? ` link=${link}` : ''}`);
  }
  run(
    `INSERT INTO emails (id, envelope_id, owner_id, to_email, to_name, subject, body, link, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, envelopeId, ownerId, to, toName, subject, text, link || null, status, error, now()
  );
  return { id, status };
}

module.exports = { sendMail, smtpEnabled: Boolean(transport) };
