'use strict';

const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.PORT || 3000);

module.exports = {
  appName: process.env.APP_NAME || 'LangSync Sign',
  port,
  // Public URL used in emails and signing links. Set this in production.
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir,
  filesDir: path.join(dataDir, 'files'),
  // Comma-separated list of email domains allowed to create sender accounts (empty = anyone).
  signupDomains: (process.env.SIGNUP_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25),
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      }
    : null,
  mailFrom: process.env.MAIL_FROM || 'LangSync Sign <sign@langsync.local>',
  // Cookies are marked Secure when the public URL is https.
  secureCookies: (process.env.BASE_URL || '').startsWith('https://'),
};
