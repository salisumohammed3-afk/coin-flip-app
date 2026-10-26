'use strict';

const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const config = require('./config');

const BRAND = hex('#49229D');
const BRAND_LIGHT = hex('#8B36FE');
const GRAY = hex('#3B3B3B');
const MID_GRAY = hex('#8A8A8A');
const RULE = hex('#E8E8E8');

function hex(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
  const n = m ? parseInt(m[1], 16) : 0x111111;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Accepts a PDF or PNG/JPEG upload and returns normalised PDF bytes. */
async function normalizeUpload(buffer, mimetype, originalName) {
  const lower = String(originalName || '').toLowerCase();
  const isPdf = mimetype === 'application/pdf' || lower.endsWith('.pdf');
  const isPng = mimetype === 'image/png' || lower.endsWith('.png');
  const isJpg = mimetype === 'image/jpeg' || /\.jpe?g$/.test(lower);
  if (isPdf) {
    let doc;
    try {
      doc = await PDFDocument.load(buffer, { updateMetadata: false });
    } catch (err) {
      if (/encrypt/i.test(err.message)) throw userError('This PDF is password-protected. Remove the password and upload again.');
      throw userError(`"${originalName}" could not be read as a PDF.`);
    }
    const pageCount = doc.getPageCount();
    if (!pageCount) throw userError(`"${originalName}" has no pages.`);
    return { bytes: Buffer.from(buffer), pageCount };
  }
  if (isPng || isJpg) {
    const doc = await PDFDocument.create();
    const img = isPng ? await doc.embedPng(buffer) : await doc.embedJpg(buffer);
    // Fit the image onto a US Letter page with a small margin.
    const pageW = 612, pageH = 792, margin = 36;
    const scale = Math.min((pageW - margin * 2) / img.width, (pageH - margin * 2) / img.height, 1);
    const page = doc.addPage([pageW, pageH]);
    const w = img.width * scale, h = img.height * scale;
    page.drawImage(img, { x: (pageW - w) / 2, y: pageH - margin - h, width: w, height: h });
    return { bytes: Buffer.from(await doc.save()), pageCount: 1 };
  }
  throw userError('Upload PDFs or images (PNG/JPG). Export Word or Google Docs files to PDF first.');
}

function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Coordinates in LangSync Sign are fractions (0..1) of the page *as displayed*
 * (top-left origin, rotation applied). This maps them into PDF user space.
 */
function pageMapper(page) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const W = box.width, H = box.height;
  const viewW = rot % 180 === 0 ? W : H;
  const viewH = rot % 180 === 0 ? H : W;
  const toPdf = (fx, fy) => {
    const u = fx * viewW, v = fy * viewH;
    let x, y;
    if (rot === 90) { x = v; y = u; }
    else if (rot === 180) { x = W - u; y = v; }
    else if (rot === 270) { x = W - v; y = H - u; }
    else { x = u; y = H - v; }
    return { x: x + box.x, y: y + box.y };
  };
  return {
    viewW, viewH, rotate: degrees(rot), toPdf,
    // Bottom-left anchor of a displayed rect, which is where pdf-lib draws from.
    anchor: (r) => toPdf(r.x, r.y + r.h),
  };
}

function makeSanitizer(font) {
  const cache = new Map();
  return (text) =>
    Array.from(String(text ?? '').replace(/\r?\n/g, ' '))
      .map((ch) => {
        if (!cache.has(ch)) {
          try { font.widthOfTextAtSize(ch, 10); cache.set(ch, ch); } catch { cache.set(ch, '?'); }
        }
        return cache.get(ch);
      })
      .join('');
}

function fitText(font, text, maxWidth, maxSize, minSize = 4) {
  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

async function embedDataUrl(doc, dataUrl, cache) {
  if (!dataUrl) return null;
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  const img = m[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  cache.set(dataUrl, img);
  return img;
}

async function stampField(doc, page, map, field, ctx) {
  const { font, bold, clean, images, recipientsById, envelopeId } = ctx;
  const r = { x: field.x, y: field.y, w: field.w, h: field.h };
  const boxW = r.w * map.viewW, boxH = r.h * map.viewH;
  const origin = map.anchor(r);
  const recipient = recipientsById[field.recipient_id];
  const textColor = hex('#111111');

  if (field.type === 'signature' || field.type === 'initials') {
    const dataUrl = field.type === 'signature' ? recipient?.signature_image : recipient?.initials_image;
    const img = await embedDataUrl(doc, dataUrl || field.value, images);
    if (!img) return;
    // Reserve a sliver at the top for the "signed via" tag, as DocuSign does.
    const tagH = field.type === 'signature' && boxH > 24 ? Math.min(6, boxH * 0.18) : 0;
    const availH = boxH - tagH;
    const scale = Math.min(boxW / img.width, availH / img.height);
    const w = img.width * scale, h = img.height * scale;
    const pt = at(map, origin, 0, (availH - h) / 2);
    page.drawImage(img, { ...pt, width: w, height: h, rotate: map.rotate });
    if (tagH) {
      const size = Math.min(tagH, 5.5);
      const tag = `${config.appName} · ${envelopeId.slice(-8).toUpperCase()}`;
      page.drawText(clean(tag), { ...at(map, origin, 0, boxH - size), size, font: bold, color: BRAND, rotate: map.rotate });
    }
    return;
  }

  if (field.type === 'checkbox') {
    const s = Math.min(boxW, boxH);
    page.drawRectangle({ ...at(map, origin), width: s, height: s, borderColor: GRAY, borderWidth: 0.8, rotate: map.rotate });
    if (field.value === 'true') {
      const size = s * 0.9;
      const tw = bold.widthOfTextAtSize('X', size);
      page.drawText('X', { ...at(map, origin, (s - tw) / 2, s * 0.15), size, font: bold, color: textColor, rotate: map.rotate });
    }
    return;
  }

  const value = clean(field.value || '');
  if (!value) return;
  const size = fitText(font, value, boxW - 2, Math.min(boxH * 0.7, 12));
  page.drawText(value, { ...at(map, origin, 1, (boxH - size) / 2 + size * 0.2), size, font, color: textColor, rotate: map.rotate });
}

/** Offsets (dx, dy) run along the displayed box's own axes, so rotated pages still stamp upright. */
function at(map, origin, dx = 0, dy = 0) {
  const a = (map.rotate.angle * Math.PI) / 180;
  return {
    x: origin.x + dx * Math.cos(a) - dy * Math.sin(a),
    y: origin.y + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

function stampAnnotation(page, map, ann, ctx, noteNumber) {
  const d = ann.data;
  const color = hex(d.color || '#8B36FE');
  const scaleW = map.viewW;
  if (ann.kind === 'pen' && Array.isArray(d.points) && d.points.length > 1) {
    const thickness = Math.max(0.5, (d.width || 0.003) * scaleW);
    for (let i = 1; i < d.points.length; i++) {
      page.drawLine({ start: map.toPdf(...d.points[i - 1]), end: map.toPdf(...d.points[i]), thickness, color, opacity: d.opacity ?? 1, lineCap: 1 });
    }
  } else if (ann.kind === 'line') {
    const thickness = Math.max(0.5, (d.width || 0.003) * scaleW);
    page.drawLine({ start: map.toPdf(d.x1, d.y1), end: map.toPdf(d.x2, d.y2), thickness, color, lineCap: 1 });
  } else if (ann.kind === 'highlight' || ann.kind === 'rect') {
    const w = d.w * map.viewW, h = d.h * map.viewH;
    const opts = ann.kind === 'highlight'
      ? { color, opacity: 0.32 }
      : { borderColor: color, borderWidth: Math.max(0.75, (d.width || 0.003) * scaleW) };
    page.drawRectangle({ ...map.anchor(d), width: w, height: h, rotate: map.rotate, ...opts });
  } else if (ann.kind === 'text') {
    const size = Math.max(5, (d.size || 0.018) * map.viewH);
    const origin = map.toPdf(d.x, d.y);
    String(d.text || '').split(/\r?\n/).forEach((line, i) => {
      page.drawText(ctx.clean(line), { ...at(map, origin, 0, -size * (i + 1) * 1.15 + size * 0.2), size, font: ctx.font, color, rotate: map.rotate });
    });
  } else if (ann.kind === 'note') {
    const s = 0.022 * map.viewW;
    const origin = map.toPdf(d.x, d.y);
    page.drawRectangle({ ...at(map, origin, 0, -s), width: s, height: s, color: hex('#FFD84D'), borderColor: hex('#B8860B'), borderWidth: 0.6, rotate: map.rotate });
    const label = String(noteNumber);
    const size = s * 0.6;
    const tw = ctx.bold.widthOfTextAtSize(label, size);
    page.drawText(label, { ...at(map, origin, (s - tw) / 2, -s + s * 0.25), size, font: ctx.bold, color: hex('#5A4100'), rotate: map.rotate });
  }
}

const fmt = (iso) => (iso ? new Date(iso).toUTCString().replace('GMT', 'UTC') : '—');

/** Simple flowing text layout used for the certificate of completion. */
class Writer {
  constructor(doc, fonts, header) {
    Object.assign(this, { doc, fonts, header, pages: [] });
    this.margin = 48;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([612, 792]);
    this.pages.push(this.page);
    this.y = 792 - this.margin;
    this.page.drawRectangle({ x: 0, y: 792 - 6, width: 612, height: 6, color: BRAND });
    this.page.drawText(this.fonts.clean(this.header), { x: this.margin, y: 792 - 28, size: 8, font: this.fonts.bold, color: MID_GRAY });
    this.y = 792 - 52;
  }
  ensure(h) {
    if (this.y - h < this.margin + 20) this.newPage();
  }
  text(str, { size = 10, font = this.fonts.font, color = GRAY, indent = 0, gap = 4, width } = {}) {
    const maxW = (width || 612 - this.margin * 2) - indent;
    for (const line of wrap(this.fonts.clean(str), font, size, maxW)) {
      this.ensure(size + gap);
      this.page.drawText(line, { x: this.margin + indent, y: this.y - size, size, font, color });
      this.y -= size + gap;
    }
  }
  rule(gap = 10) {
    this.ensure(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: 612 - this.margin, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= gap;
  }
  space(h) { this.y -= h; }
  row(cols, { size = 8.5, font = this.fonts.font, color = GRAY } = {}) {
    // cols: [{ text, width }]
    const wrapped = cols.map((c) => wrap(this.fonts.clean(c.text), font, size, c.width - 6));
    const lines = Math.max(...wrapped.map((w) => w.length), 1);
    const h = lines * (size + 2.5) + 4;
    this.ensure(h);
    let x = this.margin;
    wrapped.forEach((ls, i) => {
      ls.forEach((l, j) => this.page.drawText(l, { x, y: this.y - size - j * (size + 2.5), size, font, color }));
      x += cols[i].width;
    });
    this.y -= h;
  }
}

function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= maxW) { line = tryLine; continue; }
      if (line) out.push(line);
      // Hard-break words longer than the column (hashes, user agents).
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW) {
        let i = w.length;
        while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > maxW) i--;
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

const ROLE_LABEL = { signer: 'Needs to sign', approver: 'Needs to approve', cc: 'Receives a copy' };

async function addCertificate(doc, fonts, { envelope, owner, documents, recipients, events, notes, images }) {
  const w = new Writer(doc, fonts, `${config.appName} · Certificate of Completion · Envelope ${envelope.id}`);
  const { bold, font } = fonts;
  w.text('Certificate of Completion', { size: 22, font: bold, color: BRAND, gap: 8 });
  w.text(`${envelope.title}`, { size: 13, font: bold, color: hex('#111111'), gap: 10 });
  w.row([{ text: 'Envelope ID', width: 120 }, { text: envelope.id, width: 396 }], { font: bold });
  w.row([{ text: 'Status', width: 120 }, { text: envelope.status === 'completed' ? 'Completed' : envelope.status, width: 396 }]);
  w.row([{ text: 'Sender', width: 120 }, { text: `${owner.name} <${owner.email}>`, width: 396 }]);
  w.row([{ text: 'Sent', width: 120 }, { text: fmt(envelope.sent_at), width: 396 }]);
  w.row([{ text: 'Completed', width: 120 }, { text: fmt(envelope.completed_at), width: 396 }]);
  w.row([{ text: 'Signing order', width: 120 }, { text: envelope.sequential ? 'Sequential (routing order)' : 'Parallel', width: 396 }]);

  w.rule();
  w.text('Documents', { size: 12, font: bold, color: BRAND, gap: 6 });
  for (const d of documents) {
    w.text(`${d.name} — ${d.page_count} page${d.page_count === 1 ? '' : 's'}`, { size: 9.5, font: bold });
    w.text(`Original SHA-256: ${d.sha256}`, { size: 8, color: MID_GRAY, gap: 6 });
  }

  w.rule();
  w.text('Recipients', { size: 12, font: bold, color: BRAND, gap: 6 });
  for (const r of recipients) {
    const sigImg = r.signature_image ? await embedDataUrl(doc, r.signature_image, images) : null;
    w.ensure(sigImg ? 96 : 70);
    w.text(`${r.name} <${r.email}>`, { size: 10, font: bold, color: hex('#111111'), gap: 3 });
    w.text(`${ROLE_LABEL[r.role] || r.role} · Routing order ${r.routing_order} · Status: ${r.status}`, { size: 8.5, gap: 3 });
    const auth = r.access_code ? 'Email link + access code' : 'Email link';
    w.text(`Authentication: ${auth}`, { size: 8.5, gap: 3 });
    if (sigImg) {
      const h = 34, scale = h / sigImg.height, sw = Math.min(sigImg.width * scale, 180);
      w.ensure(h + 8);
      w.page.drawRectangle({ x: w.margin, y: w.y - h - 4, width: sw + 10, height: h + 4, borderColor: BRAND_LIGHT, borderWidth: 0.6 });
      w.page.drawImage(sigImg, { x: w.margin + 5, y: w.y - h - 2, width: sw, height: Math.min(h, (sw / sigImg.width) * sigImg.height) });
      w.space(h + 10);
    }
    const lines = [
      ['Sent', r.sent_at], ['Viewed', r.viewed_at], ['E-sign consent', r.consented_at],
      [r.role === 'approver' ? 'Approved' : r.role === 'cc' ? 'Copy delivered' : 'Signed', r.completed_at],
    ];
    if (r.declined_at) lines.push(['Declined', r.declined_at]);
    for (const [label, ts] of lines) if (ts) w.row([{ text: label, width: 110 }, { text: fmt(ts), width: 406 }]);
    if (r.decline_reason) w.row([{ text: 'Decline reason', width: 110 }, { text: r.decline_reason, width: 406 }]);
    if (r.ip) w.row([{ text: 'IP address', width: 110 }, { text: r.ip, width: 406 }]);
    if (r.user_agent) w.row([{ text: 'Device', width: 110 }, { text: r.user_agent.slice(0, 220), width: 406 }], { color: MID_GRAY });
    w.space(8);
  }

  if (notes.length) {
    w.rule();
    w.text('Comments', { size: 12, font: bold, color: BRAND, gap: 6 });
    notes.forEach((n, i) => {
      w.text(`#${i + 1} · ${n.author_name} · ${n.docName}, page ${n.page + 1} · ${fmt(n.created_at)}`, { size: 8.5, font: bold, gap: 2 });
      w.text(n.data.text || '', { size: 9, indent: 10, gap: 6 });
    });
  }

  w.rule();
  w.text('Event history', { size: 12, font: bold, color: BRAND, gap: 6 });
  w.row([{ text: 'Time (UTC)', width: 140 }, { text: 'Actor', width: 120 }, { text: 'Event', width: 90 }, { text: 'Detail', width: 166 }], { font: bold });
  for (const e of events) {
    w.row([
      { text: new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19), width: 140 },
      { text: e.actor, width: 120 },
      { text: e.type, width: 90 },
      { text: [e.detail, e.ip ? `IP ${e.ip}` : ''].filter(Boolean).join(' · '), width: 166 },
    ]);
  }

  w.rule();
  w.text(
    'Each recipient agreed to conduct business electronically and to use electronic signatures before signing. ' +
      'Electronic signatures are intended to be legally binding under the U.S. ESIGN Act, UETA, and eIDAS (simple electronic signature). ' +
      'Timestamps are recorded by the LangSync Sign server. The SHA-256 fingerprint of this completed file can be checked on the Verify page.',
    { size: 8, color: MID_GRAY }
  );

  w.pages.forEach((p, i) =>
    p.drawText(`Page ${i + 1} of ${w.pages.length}`, { x: 612 - 48 - 60, y: 26, size: 7.5, font, color: MID_GRAY })
  );
}

/**
 * Builds the combined, completed PDF: every document with fields and markup
 * flattened in, followed by the certificate of completion.
 */
async function buildFinalPdf({ envelope, owner, documents, recipients, fields, annotations, events, readFile }) {
  const out = await PDFDocument.create();
  out.setTitle(`${envelope.title} (completed)`);
  out.setProducer(config.appName);
  out.setCreator(config.appName);
  out.setSubject(`Envelope ${envelope.id}`);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const clean = makeSanitizer(font);
  const fonts = { font, bold, clean };
  const images = new Map();
  const recipientsById = Object.fromEntries(recipients.map((r) => [r.id, r]));
  const notes = [];

  for (const d of documents) {
    const src = await PDFDocument.load(readFile(d.file), { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      const map = pageMapper(page);
      for (const f of fields.filter((f) => f.document_id === d.id && f.page === index)) {
        await stampField(out, page, map, f, { ...fonts, images, recipientsById, envelopeId: envelope.id });
      }
      for (const a of annotations.filter((a) => a.document_id === d.id && a.page === index)) {
        if (a.kind === 'note') notes.push({ ...a, docName: d.name });
        stampAnnotation(page, map, a, fonts, a.kind === 'note' ? notes.length : 0);
      }
      // Envelope ID stamp in the page margin, like DocuSign's header.
      const tag = `${config.appName} Envelope ID: ${envelope.id}`;
      const p = map.toPdf(0.02, 0.012);
      page.drawText(clean(tag), { x: p.x, y: p.y - 6, size: 6, font, color: MID_GRAY, rotate: map.rotate });
    }
  }

  await addCertificate(out, fonts, { envelope, owner, documents, recipients, events, notes, images });
  const bytes = Buffer.from(await out.save());
  return { bytes, sha256: sha256(bytes) };
}

module.exports = { normalizeUpload, buildFinalPdf, sha256, pageMapper };
