// Sender app: shell, routing, dashboard, lists, library, outbox.
import { api, html, raw, el, toast, fmtDate, timeAgo, fmtSize, STATUS, pill, initials } from './ui.js';
import { renderEditStep } from './pages/edit.js';
import { renderPrepare } from './pages/prepare.js';
import { renderReview } from './pages/review.js';
import { renderDetail } from './pages/detail.js';

const app = document.getElementById('app');
export const state = { user: null, config: null, cleanup: [] };

const EVENT_ICON = { sent: '📨', delivered: '✉️', viewed: '👀', signed: '✍️', approved: '✅', completed: '🎉', declined: '⛔', voided: '🚫', reminded: '🔔', created: '📝', corrected: '✏️', expired: '⌛', consented: '🤝', downloaded: '⬇️', authenticated: '🔐', auth_failed: '⚠️', document_added: '📄', document_removed: '🗑' };
export const eventIcon = (t) => EVENT_ICON[t] || '•';

/* ------------------------------- routing ------------------------------- */

export function go(path) {
  location.hash = `#/${path.replace(/^\//, '')}`;
}

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

async function route() {
  state.cleanup.splice(0).forEach((fn) => fn());
  document.body.classList.remove('markup-active');
  if (!state.user) return renderAuth();
  const { parts, query } = parseHash();
  const [a, id, sub] = parts;
  try {
    if (!a) return shell('home', renderHome);
    if (a === 'envelopes' && !id) return shell('envelopes', (c) => renderList(c, query));
    if (a === 'templates') return shell('templates', (c) => renderList(c, query, true));
    if (a === 'library') return shell('library', (c) => renderLibrary(c, query));
    if (a === 'outbox') return shell('outbox', renderOutbox);
    if (a === 'envelopes' && id) {
      if (sub === 'edit') return shell('envelopes', (c) => renderEditStep(c, id), { bare: false });
      if (sub === 'prepare') return shell('envelopes', (c) => renderPrepare(c, id), { full: true });
      if (sub === 'review') return shell('envelopes', (c) => renderReview(c, id));
      return shell('envelopes', (c) => renderDetail(c, id));
    }
    go('');
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

/* -------------------------------- shell -------------------------------- */

let counts = {};
function shell(active, render, { full = false } = {}) {
  const navItem = (key, href, label, icon, count) =>
    html`<a href="${href}" class="${active === key ? 'on' : ''}"><span>${icon}</span>${label}${raw(count ? html`<span class="count">${count}</span>` : '')}</a>`;
  app.innerHTML = html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/"><span class="brand-mark">✍</span><span>LangSync<small>Sign</small></span></a>
      <button class="btn accent new-btn" data-new>＋ New envelope</button>
      <nav class="nav">
        ${raw(navItem('home', '#/', 'Home', '⌂'))}
        ${raw(navItem('envelopes', '#/envelopes', 'Agreements', '📑', counts.sent))}
        ${raw(navItem('templates', '#/templates', 'Templates', '🧩'))}
        ${raw(navItem('library', '#/library', 'File storage', '🗂'))}
        <div class="nav-label">Tools</div>
        ${raw(navItem('outbox', '#/outbox', 'Email outbox', '📬'))}
        <a href="/verify" target="_blank" rel="noopener"><span>🛡</span>Verify a document</a>
      </nav>
      <div class="sidebar-foot"><div class="who">${state.user.name}</div><div class="muted small">${state.user.email}</div><button data-logout>Sign out</button></div>
    </aside>
    <main class="main"><div class="${full ? '' : 'content'}" id="view"></div></main>
  </div>`;
  app.querySelector('[data-new]').onclick = () => newEnvelope();
  app.querySelector('[data-logout]').onclick = async () => {
    await api('POST', '/api/auth/logout');
    state.user = null;
    route();
  };
  return render(app.querySelector('#view'));
}

export async function newEnvelope(template = false) {
  const env = await api('POST', '/api/envelopes', { template });
  go(`envelopes/${env.id}/edit`);
}

/* ------------------------------ live updates ------------------------------ */

let lastEventId = null;
async function poll() {
  if (!state.user) return;
  try {
    const { events } = await api('GET', `/api/activity?after=${lastEventId ?? 0}`);
    if (lastEventId !== null) {
      for (const e of events.slice().reverse()) {
        if (['viewed', 'signed', 'approved', 'declined', 'completed', 'expired'].includes(e.type)) {
          toast(`${eventIcon(e.type)} ${e.type === 'completed' ? `"${e.title}" is complete` : `${e.actor.replace(/ <.*>/, '')} ${e.type} "${e.title}"`}`, {
            type: e.type === 'declined' ? 'error' : e.type === 'completed' ? 'success' : 'info',
            action: { label: 'Open', onClick: () => go(`envelopes/${e.envelope_id}`) },
          });
        }
      }
      if (events.length) window.dispatchEvent(new CustomEvent('lss:activity', { detail: events }));
    }
    if (events.length) lastEventId = Math.max(lastEventId ?? 0, ...events.map((e) => e.id));
    else if (lastEventId === null) lastEventId = 0;
  } catch {}
}
setInterval(poll, 10000);

/* -------------------------------- auth --------------------------------- */

function renderAuth(mode = state.config?.hasUsers ? 'login' : 'register') {
  const isLogin = mode === 'login';
  app.innerHTML = html`<div class="auth">
    <div class="auth-art">
      <div class="brand"><span class="brand-mark">✍</span><span>LangSync<small>Sign</small></span></div>
      <div>
        <h1>Send, sign and store agreements without the DocuSign bill.</h1>
        <ul><li>✓ Packages with multiple documents and signers</li><li>✓ Signing order, CCs, approvers and access codes</li><li>✓ Markup, comments and a full audit trail</li><li>✓ Tamper-evident completed PDFs with a certificate</li></ul>
      </div>
      <div class="small" style="color:#A99BD6">Self-hosted by LangSync</div>
    </div>
    <div class="auth-form"><form novalidate>
      <h2>${isLogin ? 'Welcome back' : 'Create your account'}</h2>
      <p class="muted">${isLogin ? 'Sign in to send and track agreements.' : 'Sender accounts are for the LangSync team.'}</p>
      ${raw(isLogin ? '' : '<label class="field"><span>Full name</span><input name="name" type="text" autocomplete="name" required></label>')}
      <label class="field"><span>Work email</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="8"></label>
      <div class="err"></div>
      <button class="btn primary" style="width:100%;justify-content:center">${isLogin ? 'Sign in' : 'Create account'}</button>
      ${raw(state.config?.allowSignup || isLogin === false ? html`<p class="muted small" style="text-align:center">${isLogin ? 'New here?' : 'Already have an account?'} <a href="#" data-switch>${isLogin ? 'Create an account' : 'Sign in'}</a></p>` : '')}
    </form></div></div>`;
  const form = app.querySelector('form');
  app.querySelector('[data-switch]')?.addEventListener('click', (e) => { e.preventDefault(); renderAuth(isLogin ? 'register' : 'login'); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const { user } = await api('POST', `/api/auth/${isLogin ? 'login' : 'register'}`, data);
      state.user = user;
      route();
    } catch (err) {
      form.querySelector('.err').textContent = err.message;
    }
  };
}

/* -------------------------------- home --------------------------------- */

async function renderHome(view) {
  const [stats, { envelopes }, { events }] = await Promise.all([
    api('GET', '/api/stats'),
    api('GET', '/api/envelopes'),
    api('GET', '/api/activity'),
  ]);
  counts = stats.counts;
  const c = stats.counts;
  view.innerHTML = html`
    <div class="hero">
      <div><h1>Hi ${state.user.name.split(' ')[0]} 👋</h1><p>Create a package, add signers and CCs, mark it up, and send. We'll track every view and signature.</p></div>
      <div class="actions-row"><button class="btn white" data-new>＋ New envelope</button><a class="btn ghost" href="#/templates">Use a template</a></div>
    </div>
    <div class="stats">
      ${raw(statCard('Waiting for others', c.sent || 0, '#/envelopes?status=sent'))}
      ${raw(statCard('Expiring soon', stats.expiring, '#/envelopes?status=sent'))}
      ${raw(statCard('Completed', c.completed || 0, '#/envelopes?status=completed'))}
      ${raw(statCard('Drafts', c.draft || 0, '#/envelopes?status=draft'))}
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Recent agreements</h2><a href="#/envelopes" class="small">View all</a></div>${raw(envelopeTable(envelopes.slice(0, 8)))}</div>
      <div class="card"><div class="card-head"><h2>Activity</h2><span class="muted small">Live</span></div><ul class="feed" data-feed>${raw(feedItems(events))}</ul></div>
    </div>`;
  view.querySelector('[data-new]').onclick = () => newEnvelope();
  bindRows(view);
  const onActivity = async () => {
    const { events } = await api('GET', '/api/activity');
    const feed = view.querySelector('[data-feed]');
    if (feed) feed.innerHTML = feedItems(events);
  };
  window.addEventListener('lss:activity', onActivity);
  state.cleanup.push(() => window.removeEventListener('lss:activity', onActivity));
}

const statCard = (label, n, href) => html`<a class="card stat" href="${href}"><div class="n">${n}</div><div class="l">${label}</div></a>`;

function feedItems(events) {
  if (!events.length) return html`<li class="muted">No activity yet. Send your first envelope!</li>`;
  return events.slice(0, 30).map((e) => html`<li><span class="dot">${eventIcon(e.type)}</span><div>
    <div><strong>${e.actor.replace(/ <.*>/, '')}</strong> · ${e.detail || e.type}</div>
    <div class="meta"><a href="#/envelopes/${e.envelope_id}">${e.title}</a> · ${timeAgo(e.created_at)}</div></div></li>`).join('');
}

/* -------------------------------- lists -------------------------------- */

export function envelopeTable(envelopes, { templates = false } = {}) {
  if (!envelopes.length) {
    return html`<div class="empty"><div class="big">${templates ? '🧩' : '📭'}</div><h3>${templates ? 'No templates yet' : 'Nothing here yet'}</h3>
      <p>${templates ? 'Save any envelope as a template to reuse its documents, roles and fields.' : 'Create an envelope to get started.'}</p></div>`;
  }
  return html`<table class="list"><thead><tr><th>Subject</th><th class="hide-sm">Recipients</th><th>Status</th><th class="hide-sm">Last change</th></tr></thead><tbody>
    ${raw(envelopes.map((e) => html`<tr class="click" data-href="#/envelopes/${e.id}${e.status === 'draft' || templates ? '/edit' : ''}">
      <td><div class="t-title">${e.title}</div><div class="t-sub">${e.recipients.length ? `To: ${e.recipients.filter((r) => r.role !== 'cc').map((r) => r.name).join(', ') || '—'}` : 'No recipients yet'}</div></td>
      <td class="hide-sm"><div class="avatars">${raw(e.recipients.slice(0, 5).map((r) => html`<span class="avatar" style="background:${r.color}" title="${r.name} · ${r.status}">${initials(r.name) || '?'}</span>`).join(''))}</div></td>
      <td>${templates ? raw('<span class="pill pill-purple">Template</span>') : pill(STATUS, e.status)}${raw(e.status === 'sent' ? html`<div class="t-sub">${e.recipients.filter((r) => r.status === 'completed').length}/${e.recipients.filter((r) => r.role !== 'cc').length} done</div>` : '')}</td>
      <td class="hide-sm"><div>${fmtDate(e.updated_at, false)}</div><div class="t-sub">${timeAgo(e.updated_at)}</div></td></tr>`).join(''))}
  </tbody></table>`;
}

function bindRows(root) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
}

async function renderList(view, query, templates = false) {
  const status = query.get('status') || 'all';
  const q = query.get('q') || '';
  const tabs = [['all', 'All'], ['sent', 'Waiting for others'], ['completed', 'Completed'], ['draft', 'Drafts'], ['declined', 'Declined'], ['voided', 'Voided'], ['expired', 'Expired']];
  view.innerHTML = html`<div class="page-head"><div><h1>${templates ? 'Templates' : 'Agreements'}</h1>
      <p class="muted">${templates ? 'Reusable packages: documents, recipient roles and fields ready to go.' : 'Every envelope you have sent or drafted.'}</p></div>
      <div class="actions-row"><input type="search" placeholder="Search by title, name or email" value="${q}" data-q style="width:280px">
      <button class="btn primary" data-new>＋ New ${templates ? 'template' : 'envelope'}</button></div></div>
    <div class="card">${raw(templates ? '' : html`<div class="tabs-row">${raw(tabs.map(([k, l]) => html`<a href="#/envelopes?status=${k}" class="${status === k ? 'on' : ''}">${l}</a>`).join(''))}</div>`)}
      <div data-table><div class="empty">Loading…</div></div></div>`;
  view.querySelector('[data-new]').onclick = () => newEnvelope(templates);
  const load = async () => {
    const params = new URLSearchParams({ status, q: view.querySelector('[data-q]').value });
    if (templates) params.set('template', '1');
    const { envelopes } = await api('GET', `/api/envelopes?${params}`);
    view.querySelector('[data-table]').innerHTML = envelopeTable(envelopes, { templates });
    bindRows(view);
  };
  let t;
  view.querySelector('[data-q]').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  await load();
  const onActivity = () => load();
  window.addEventListener('lss:activity', onActivity);
  state.cleanup.push(() => window.removeEventListener('lss:activity', onActivity));
}

/* ------------------------------- library ------------------------------- */

async function renderLibrary(view, query) {
  view.innerHTML = html`<div class="page-head"><div><h1>File storage</h1><p class="muted">Every completed agreement and uploaded document, stored on LangSync's own server.</p></div>
    <input type="search" placeholder="Search files" data-q style="width:280px" value="${query.get('q') || ''}"></div>
    <div class="card" style="margin-bottom:18px"><div class="card-head"><h2>Completed agreements</h2><span class="muted small">Signed PDF + certificate of completion</span></div><div data-completed></div></div>
    <div class="card"><div class="card-head"><h2>All uploaded documents</h2><span class="muted small">Originals, as uploaded</span></div><div data-docs></div></div>`;
  const load = async () => {
    const { documents, completed } = await api('GET', `/api/library?q=${encodeURIComponent(view.querySelector('[data-q]').value)}`);
    view.querySelector('[data-completed]').innerHTML = completed.length
      ? html`<table class="list"><thead><tr><th>Agreement</th><th class="hide-sm">Completed</th><th class="hide-sm">Size</th><th></th></tr></thead><tbody>${raw(completed.map((c) => html`<tr>
          <td><div class="t-title"><span class="doc-icon">PDF</span> ${c.title}</div><div class="t-sub mono">SHA-256 ${c.final_sha256.slice(0, 24)}…</div></td>
          <td class="hide-sm">${fmtDate(c.completed_at)}</td><td class="hide-sm">${fmtSize(c.size)}</td>
          <td style="text-align:right;white-space:nowrap"><a class="btn ghost small" href="/api/envelopes/${c.envelope_id}/download?inline=1" target="_blank" rel="noopener">View</a> <a class="btn primary small" href="/api/envelopes/${c.envelope_id}/download">Download</a></td></tr>`).join(''))}</tbody></table>`
      : '<div class="empty"><div class="big">🗂</div><h3>No completed agreements yet</h3></div>';
    view.querySelector('[data-docs]').innerHTML = documents.length
      ? html`<table class="list"><thead><tr><th>Document</th><th class="hide-sm">Envelope</th><th class="hide-sm">Pages</th><th class="hide-sm">Added</th><th></th></tr></thead><tbody>${raw(documents.map((d) => html`<tr>
          <td><div class="t-title">${d.name}</div><div class="t-sub">${fmtSize(d.size)}</div></td>
          <td class="hide-sm"><a href="#/envelopes/${d.envelope_id}${d.status === 'draft' || d.is_template ? '/edit' : ''}">${d.title}</a> ${d.is_template ? raw('<span class="pill pill-purple">Template</span>') : pill(STATUS, d.status)}</td>
          <td class="hide-sm">${d.page_count}</td><td class="hide-sm">${fmtDate(d.created_at, false)}</td>
          <td style="text-align:right"><a class="btn ghost small" href="/api/envelopes/${d.envelope_id}/documents/${d.id}/file" target="_blank" rel="noopener">Open</a></td></tr>`).join(''))}</tbody></table>`
      : '<div class="empty">No documents match.</div>';
  };
  let t;
  view.querySelector('[data-q]').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  await load();
}

/* -------------------------------- outbox -------------------------------- */

async function renderOutbox(view) {
  const { emails, smtpEnabled } = await api('GET', '/api/outbox');
  view.innerHTML = html`<div class="page-head"><div><h1>Email outbox</h1><p class="muted">Every notification ${state.config.appName} has sent on your behalf.</p></div></div>
    ${raw(smtpEnabled ? '' : '<div class="callout warn" style="margin-bottom:16px"><strong>Email delivery is not configured.</strong> Notifications are recorded here instead of being sent. Copy a signing link below and share it yourself, or set <span class="mono">SMTP_HOST</span> (see README) to send real emails.</div>')}
    <div class="card">${raw(emails.length ? html`<table class="list"><thead><tr><th>To</th><th>Subject</th><th class="hide-sm">Status</th><th class="hide-sm">When</th><th></th></tr></thead><tbody>${raw(emails.map((m) => html`<tr>
      <td><div class="t-title">${m.to_name || m.to_email}</div><div class="t-sub">${m.to_email}</div></td>
      <td>${m.subject}${raw(m.envelope_id ? html`<div class="t-sub"><a href="#/envelopes/${m.envelope_id}">Open envelope</a></div>` : '')}</td>
      <td class="hide-sm">${raw(m.status === 'sent' ? '<span class="pill pill-green">Sent</span>' : m.status === 'failed' ? html`<span class="pill pill-red" title="${m.error || ''}">Failed</span>` : '<span class="pill pill-gray">Logged</span>')}</td>
      <td class="hide-sm">${timeAgo(m.created_at)}</td>
      <td style="text-align:right">${raw(m.link ? html`<button class="btn ghost small" data-copy="${m.link}">Copy link</button>` : '')}</td></tr>`).join(''))}</tbody></table>` : '<div class="empty"><div class="big">📬</div><h3>No emails yet</h3></div>')}</div>`;
  view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast('Link copied');
  }));
}

/* -------------------------------- boot --------------------------------- */

(async function boot() {
  state.config = await api('GET', '/api/config');
  document.title = state.config.appName;
  state.user = (await api('GET', '/api/auth/me')).user;
  if (state.user) {
    api('GET', '/api/stats').then((s) => (counts = s.counts)).catch(() => {});
    poll();
  }
  window.addEventListener('hashchange', route);
  route();
})();

export { el };
