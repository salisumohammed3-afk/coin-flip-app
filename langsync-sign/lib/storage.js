'use strict';

// File storage with two backends:
//  - Supabase Storage (private bucket) in production. Browsers upload and download
//    directly with short-lived signed URLs, which sidesteps serverless body limits.
//  - Local disk (DATA_DIR/files) in development and tests.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const SIGNED_URL_SECONDS = 300;

function localStore() {
  const root = config.filesDir;
  const full = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid storage key');
    return p;
  };
  return {
    kind: 'local',
    async put(key, bytes) {
      fs.mkdirSync(path.dirname(full(key)), { recursive: true });
      fs.writeFileSync(full(key), bytes);
    },
    async get(key) {
      return fs.readFileSync(full(key));
    },
    async size(key) {
      try { return fs.statSync(full(key)).size; } catch { return 0; }
    },
    async removePrefix(prefix) {
      fs.rmSync(full(prefix), { recursive: true, force: true });
    },
    async remove(key) {
      fs.rmSync(full(key), { force: true });
    },
    // Local mode streams through the app instead of redirecting.
    signedDownloadUrl: null,
    signedUploadUrl: null,
    localPath: full,
  };
}

function supabaseStore() {
  const { url, serviceKey, bucket } = config.supabase;
  const api = `${url}/storage/v1`;
  const headers = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const enc = (key) => key.split('/').map(encodeURIComponent).join('/');
  async function call(method, p, body, extra = {}) {
    const res = await fetch(`${api}${p}`, { method, headers: { ...headers, ...extra }, body });
    if (!res.ok) throw new Error(`Storage ${method} ${p} failed: ${res.status} ${await res.text()}`);
    return res;
  }
  async function list(prefix) {
    const res = await call('POST', `/object/list/${bucket}`, JSON.stringify({ prefix, limit: 1000 }), { 'content-type': 'application/json' });
    return res.json();
  }
  return {
    kind: 'supabase',
    async put(key, bytes, contentType = 'application/pdf') {
      await call('POST', `/object/${bucket}/${enc(key)}`, bytes, { 'content-type': contentType, 'x-upsert': 'true' });
    },
    async get(key) {
      const res = await call('GET', `/object/${bucket}/${enc(key)}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async size(key) {
      const dir = path.posix.dirname(key);
      const items = await list(dir === '.' ? '' : dir);
      return items.find((i) => i.name === path.posix.basename(key))?.metadata?.size || 0;
    },
    async removePrefix(prefix) {
      // Folders are one level deep: <envelopeId>/<file>, plus <envelopeId>/uploads/<file>.
      const names = [];
      for (const dir of [prefix, `${prefix}/uploads`]) {
        for (const item of await list(dir)) if (item.id) names.push(`${dir}/${item.name}`);
      }
      if (names.length) await call('DELETE', `/object/${bucket}`, JSON.stringify({ prefixes: names }), { 'content-type': 'application/json' });
    },
    async remove(key) {
      await call('DELETE', `/object/${bucket}`, JSON.stringify({ prefixes: [key] }), { 'content-type': 'application/json' });
    },
    async signedDownloadUrl(key, filename, asAttachment) {
      const res = await call('POST', `/object/sign/${bucket}/${enc(key)}`, JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }), { 'content-type': 'application/json' });
      const { signedURL } = await res.json();
      const u = new URL(`${api}${signedURL}`);
      if (asAttachment) u.searchParams.set('download', filename);
      return u.toString();
    },
    async signedUploadUrl(key) {
      const res = await call('POST', `/object/upload/sign/${bucket}/${enc(key)}`, '{}', { 'content-type': 'application/json' });
      const { url: rel } = await res.json();
      return `${api}${rel}`;
    },
  };
}

module.exports = config.supabase ? supabaseStore() : localStore();
