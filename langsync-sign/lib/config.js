'use strict';

const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.PORT || 3000);
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Secret for signing recipient access-code cookies. Falls back to a value derived from
// the deployment's other secrets, so production needs no extra variable.
function appSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const basis = [serviceKey, process.env.DATABASE_URL, process.env.RESEND_API_KEY].filter(Boolean).join('|');
  if (basis) return crypto.createHash('sha256').update(`langsync-sign:${basis}`).digest('hex');
  return null; // local: a random secret is generated and stored in DATA_DIR
}

module.exports = {
  appName: process.env.APP_NAME || 'LangSync Sign',
  port,
  // Public URL used in emails and signing links. Set this in production.
  baseUrl: (process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${port}`)).replace(/\/$/, ''),
  dataDir,
  filesDir: path.join(dataDir, 'files'),
  databaseUrl: process.env.DATABASE_URL || '',
  supabase: supabaseUrl && serviceKey ? { url: supabaseUrl, serviceKey, bucket: process.env.SUPABASE_BUCKET || 'langsync-sign' } : null,
  appSecret: appSecret(),
  cronSecret: process.env.CRON_SECRET || '',
  // Comma-separated list of email domains allowed to create sender accounts (empty = anyone).
  signupDomains: (process.env.SIGNUP_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25),
  resendKey: process.env.RESEND_API_KEY || '',
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      }
    : null,
  mailFrom: process.env.MAIL_FROM || 'LangSync Sign <sign@langsync.local>',
  replyTo: process.env.MAIL_REPLY_TO || '',
  secureCookies: (process.env.BASE_URL || '').startsWith('https://') || Boolean(process.env.VERCEL),
};
