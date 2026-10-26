'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');
const { run, now, uid } = require('./db');

const transport = config.smtp ? nodemailer.createTransport(config.smtp) : null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout({ heading, intro, message, buttonLabel, link, footer }) {
  // Mirrors the LangSync design system: Outfit/DM Sans, ink #0B1220, brand #0099FF, gradient accent.
  return `<!doctype html><html><body style="margin:0;background:#F6F8FB;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#0B1220">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E9EDF3">
<tr><td style="height:4px;background:linear-gradient(135deg,#128EFE,#9135FC);background-color:#0099FF;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:22px 28px 0"><img src="${esc(config.baseUrl)}/img/lockup.png" alt="LangSync" height="26" style="height:26px;width:auto;display:block;border:0"></td></tr>
<tr><td style="padding:22px 28px 28px">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#0B64A8">${esc(config.appName)}</p>
<h1 style="margin:0 0 12px;font-family:'Outfit','DM Sans',Helvetica,Arial,sans-serif;font-size:24px;line-height:1.2;letter-spacing:-0.02em;color:#0B1220">${esc(heading)}</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#5B6472">${esc(intro)}</p>
${message ? `<div style="margin:0 0 22px;padding:14px 16px;background:#F6F9FE;border:1px solid #E9EDF3;border-radius:12px;font-size:14px;line-height:1.55;white-space:pre-wrap;color:#0B1220">${esc(message)}</div>` : ''}
${link ? `<a href="${esc(link)}" style="display:inline-block;background:#0099FF;color:#fff;text-decoration:none;padding:13px 24px;border-radius:12px;font-weight:600;font-size:15px">${esc(buttonLabel)}</a>` : ''}
${footer ? `<p style="margin:24px 0 0;font-size:12px;color:#5B6472;line-height:1.5">${esc(footer)}</p>` : ''}
</td></tr></table>
<p style="font-size:11px;color:#5B6472;margin-top:16px">Do not forward this email: the link is unique to you.</p>
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
