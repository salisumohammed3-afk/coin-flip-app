// Shared UI helpers: API calls, escaping, modals, toasts, formatting.

export async function api(method, url, body, { form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i >= values.length) return out + s;
    const v = values[i];
    const str = v && v.__raw !== undefined ? v.__raw : Array.isArray(v) ? v.map((x) => (x && x.__raw !== undefined ? x.__raw : esc(x))).join('') : esc(v);
    return out + s + str;
  }, '');
}
export const raw = (s) => ({ __raw: String(s) });

export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export function toast(message, { type = 'info', timeout = 4200, action } = {}) {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = el('<div class="toasts" role="status" aria-live="polite"></div>');
    document.body.append(host);
  }
  const t = el(html`<div class="toast toast-${type}"><span>${message}</span></div>`);
  if (action) {
    const b = el(html`<button class="link">${action.label}</button>`);
    b.onclick = () => { action.onClick(); t.remove(); };
    t.append(b);
  }
  host.append(t);
  setTimeout(() => t.classList.add('out'), timeout);
  setTimeout(() => t.remove(), timeout + 400);
}

/** Opens a modal. `render(body, close)` fills it; resolves with the value passed to close(). */
export function modal({ title, wide = false, render, dismissable = true }) {
  return new Promise((resolve) => {
    const wrap = el(html`<div class="modal-backdrop"><div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head"><h2>${title}</h2>${raw(dismissable ? '<button class="icon-btn modal-x" aria-label="Close">✕</button>' : '')}</div>
      <div class="modal-body"></div></div></div>`);
    const close = (value) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(undefined); };
    document.addEventListener('keydown', onKey);
    if (dismissable) {
      wrap.querySelector('.modal-x').onclick = () => close(undefined);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(undefined); });
    }
    document.body.append(wrap);
    render(wrap.querySelector('.modal-body'), close);
    wrap.querySelector('input, textarea, select, button.primary')?.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, input }) {
  return modal({
    title,
    render(body, close) {
      body.innerHTML = html`<p class="muted">${message}</p>
        ${raw(input ? html`<label class="field"><span>${input.label}</span><textarea rows="3" placeholder="${input.placeholder || ''}"></textarea></label>` : '')}
        <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirmLabel}</button></div>`;
      body.querySelector('[data-x]').onclick = () => close(undefined);
      body.querySelector('[data-ok]').onclick = () => {
        if (!input) return close(true);
        const v = body.querySelector('textarea').value.trim();
        if (input.required && !v) return body.querySelector('textarea').focus();
        close(v);
      };
    },
  });
}

export function prompt({ title, label, value = '', multiline = false, confirmLabel = 'Save' }) {
  return modal({
    title,
    render(body, close) {
      body.innerHTML = html`<label class="field"><span>${label}</span>${raw(multiline ? '<textarea rows="4"></textarea>' : '<input type="text">')}</label>
        <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${confirmLabel}</button></div>`;
      const input = body.querySelector('input, textarea');
      input.value = value;
      body.querySelector('[data-x]').onclick = () => close(undefined);
      body.querySelector('[data-ok]').onclick = () => close(input.value);
      if (!multiline) input.onkeydown = (e) => { if (e.key === 'Enter') close(input.value); };
      setTimeout(() => input.focus(), 0);
    },
  });
}

export const fmtDate = (iso, withTime = true) =>
  iso ? new Date(iso).toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) : '—';

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  const units = [[60, 'min'], [24, 'h'], [7, 'd'], [4.35, 'wk'], [12, 'mo']];
  let v = s / 60;
  let label = 'min';
  for (let i = 1; i < units.length && v >= units[i][0]; i++) { v /= units[i][0]; label = units[i][1]; }
  return `${Math.floor(v)} ${label} ago`;
}

export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const STATUS = {
  draft: { label: 'Draft', cls: 'gray' },
  sent: { label: 'Waiting for others', cls: 'blue' },
  completed: { label: 'Completed', cls: 'green' },
  declined: { label: 'Declined', cls: 'red' },
  voided: { label: 'Voided', cls: 'gray' },
  expired: { label: 'Expired', cls: 'amber' },
};

export const RECIPIENT_STATUS = {
  created: { label: 'Not sent yet', cls: 'gray' },
  sent: { label: 'Sent', cls: 'blue' },
  delivered: { label: 'Copy delivered', cls: 'blue' },
  viewed: { label: 'Viewed', cls: 'amber' },
  completed: { label: 'Completed', cls: 'green' },
  declined: { label: 'Declined', cls: 'red' },
};

export const ROLE_LABEL = { signer: 'Needs to sign', approver: 'Needs to approve', cc: 'Receives a copy' };

export const pill = (map, key) => {
  const s = map[key] || { label: key, cls: 'gray' };
  return raw(html`<span class="pill pill-${s.cls}">${s.label}</span>`);
};

export const RECIPIENT_COLORS = ['#8B36FE', '#0EA5E9', '#F59E0B', '#10B981', '#EF4444', '#EC4899', '#6366F1', '#14B8A6'];

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); return fn(...args); };
  return wrapped;
}

export const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 3).join('').toUpperCase();
