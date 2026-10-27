// Sender app: shell, routing, dashboard, lists, library, outbox.
import { api, html, raw, el, toast, fmtDate, timeAgo, fmtSize, STATUS, pill, initials } from './ui.js';
import { icon, eventTile } from './icons.js';
import { renderEditStep } from './pages/edit.js';
import { renderPrepare } from './pages/prepare.js';
import { renderReview } from './pages/review.js';
import { renderDetail } from './pages/detail.js';

const app = document.getElementById('app');
export const state = { user: null, config: null, cleanup: [] };

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
    if (!a) return await shell('home', renderHome);
    if (a === 'envelopes' && !id) return await shell('envelopes', (c) => renderList(c, query));
    if (a === 'templates') return await shell('templates', (c) => renderList(c, query, true));
    if (a === 'library') return await shell('library', (c) => renderLibrary(c, query));
    if (a === 'outbox') return await shell('outbox', renderOutbox);
    if (a === 'envelopes' && id) {
      if (sub === 'edit') return await shell('envelopes', (c) => renderEditStep(c, id));
      if (sub === 'prepare') return await shell('envelopes', (c) => renderPrepare(c, id), { full: true });
      if (sub === 'review') return await shell('envelopes', (c) => renderReview(c, id));
      return await shell('envelopes', (c) => renderDetail(c, id));
    }
    go('');
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

/* -------------------------------- shell -------------------------------- */

let counts = {};
export const lockup = (h = 28) => html`<img class="lockup" src="/img/lockup.png" alt="LangSync" style="height:${h}px">`;

function shell(active, render, { full = false } = {}) {
  const navItem = (key, href, label, ic, count) =>
    html`<a href="${href}" class="${active === key ? 'on' : ''}">${raw(icon(ic, 20))}<span>${label}</span>${raw(count ? html`<span class="count">${count}</span>` : '')}</a>`;
  app.innerHTML = html`<div class="shell">
    <aside class="sidebar">
      <a class="side-head" href="#/">${raw(lockup())}<span class="badge">Sign</span></a>
      <div class="side-new"><button class="btn primary" data-new>${raw(icon('plus', 18))}New envelope</button></div>
      <nav class="nav">
        ${raw(navItem('home', '#/', 'Home', 'home'))}
        ${raw(navItem('envelopes', '#/envelopes', 'Agreements', 'file', counts.sent))}
        ${raw(navItem('templates', '#/templates', 'Templates', 'template'))}
        ${raw(navItem('library', '#/library', 'File storage', 'folder'))}
        <div class="nav-label">Tools</div>
        ${raw(navItem('outbox', '#/outbox', 'Email outbox', 'mail'))}
        <a href="/verify" target="_blank" rel="noopener">${raw(icon('shield', 20))}<span>Verify a document</span></a>
      </nav>
      <div class="side-foot">
        <div class="who"><span class="avatar-lg">${initials(state.user.name)}</span><div><div class="name">${state.user.name}</div><div class="email">${state.user.email}</div></div></div>
        <button class="signout" data-logout>${raw(icon('logout', 20))}Sign out</button>
      </div>
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
          toast(e.type === 'completed' ? `"${e.title}" is complete` : `${e.actor.replace(/ <.*>/, '')} ${e.type} "${e.title}"`, {
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
  const d = (ms) => raw(`style="animation-delay:${ms}ms"`);
  app.innerHTML = html`<main class="auth">
    <section class="auth-main">
      <div class="rise" ${d(40)}>${raw(lockup(32))}</div>
      <div class="center"><form novalidate>
        <p class="eyebrow rise" ${d(120)}>${isLogin ? 'Welcome back' : 'Get started'}</p>
        <h1 class="rise" ${d(180)}>${isLogin ? 'Sign in to' : 'Create your'}<br>${isLogin ? 'LangSync Sign' : 'Sign account'}</h1>
        <p class="lead rise" ${d(240)}>${isLogin ? 'Send, sign and track agreements. Enter the email and password for your LangSync Sign account.' : 'Sender accounts are for the LangSync team. Recipients never need an account to sign.'}</p>
        <div class="fields rise" ${d(300)}>
          ${raw(isLogin ? '' : '<label class="field"><span>Full name</span><input name="name" type="text" autocomplete="name" placeholder="Your name" required></label>')}
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@company.com" required></label>
          <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="${isLogin ? 'Your password' : 'At least 8 characters'}" required minlength="8"></label>
          <div class="err"></div>
          <button class="btn primary">${isLogin ? 'Sign in' : 'Create account'}</button>
          ${raw(state.config?.allowSignup || !isLogin ? html`<p class="small" style="text-align:center;margin-top:16px"><span class="muted">${isLogin ? 'New to LangSync Sign?' : 'Already have an account?'}</span> <a href="#" class="text-link" data-switch>${isLogin ? 'Create an account' : 'Sign in'}</a></p>` : '')}
        </div>
      </form></div>
      <p class="foot">Access is by invitation. Ask your LangSync contact to be added.</p>
    </section>
    <aside class="auth-aside field-texture">
      <div class="inner rise" ${d(200)}>
        <span class="chip"><span class="chip-ic">${raw(icon('pen', 13))}</span>LangSync Sign</span>
        <h2>Send, sign and store every agreement in one place.</h2>
        <p>Build a package, add signers and CCs, mark it up and send it. Every view and signature is tracked, and the signed copy is stored with a full audit trail.</p>
        <ul>
          <li>${raw(icon('checkCircle', 18))}Signing order, approvers, CCs and access codes</li>
          <li>${raw(icon('checkCircle', 18))}Markup, comments and live status updates</li>
          <li>${raw(icon('checkCircle', 18))}Tamper-evident PDFs with a certificate of completion</li>
        </ul>
      </div>
    </aside>
  </main>`;
  const form = app.querySelector('form');
  app.querySelector('[data-switch]')?.addEventListener('click', (e) => { e.preventDefault(); renderAuth(isLogin ? 'register' : 'login'); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const { user } = await api('POST', `/api/auth/${isLogin ? 'login' : 'register'}`, data);
      state.user = user;
      poll();
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
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  view.innerHTML = html`
    <div class="hero field-texture rise">
      <div><span class="chip dot">LangSync Sign</span>
        <h1>${greeting}, ${state.user.name.split(' ')[0]}</h1>
        <p>Create a package, add signers and CCs, mark it up and send. Every view and signature is tracked here.</p></div>
      <div class="actions-row"><button class="btn primary" data-new>${raw(icon('plus', 18))}New envelope</button><a class="btn ghost" href="#/templates">${raw(icon('template', 18))}Use a template</a></div>
    </div>
    <div class="stats rise" style="animation-delay:80ms">
      ${raw(statCard('Waiting for others', c.sent || 0, '#/envelopes?status=sent', 'clock', ''))}
      ${raw(statCard('Expiring soon', stats.expiring, '#/envelopes?status=sent', 'alert', 'tile-warn'))}
      ${raw(statCard('Completed', c.completed || 0, '#/envelopes?status=completed', 'checkCircle', 'tile-good'))}
      ${raw(statCard('Drafts', c.draft || 0, '#/envelopes?status=draft', 'file', 'tile-violet'))}
    </div>
    <div class="grid-2 rise" style="animation-delay:140ms">
      <div class="card"><div class="card-head"><h2>Recent agreements</h2><a href="#/envelopes" class="text-link small">View all</a></div>${raw(envelopeTable(envelopes.slice(0, 8)))}</div>
      <div class="card"><div class="card-head"><h2>Activity</h2><span class="pill pill-blue">Live</span></div><ul class="feed" data-feed>${raw(feedItems(events))}</ul></div>
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

const statCard = (label, n, href, ic, tone) =>
  html`<a class="card stat" href="${href}"><span class="tile ${tone}">${raw(icon(ic, 18))}</span><div><div class="n">${n}</div><div class="l">${label}</div></div></a>`;

function feedItems(events) {
  if (!events.length) return html`<li class="muted">No activity yet. Send your first envelope to see it here.</li>`;
  return events.slice(0, 30).map((e) => html`<li>${raw(eventTile(e.type))}<div>
    <div class="what"><strong>${e.actor.replace(/ <.*>/, '')}</strong> · ${e.detail || e.type}</div>
    <div class="meta"><a href="#/envelopes/${e.envelope_id}">${e.title}</a> · ${timeAgo(e.created_at)}</div></div></li>`).join('');
}

/* -------------------------------- lists -------------------------------- */

export const emptyState = (ic, title, text) =>
  html`<div class="empty"><span class="tile tile-lg">${raw(icon(ic, 24))}</span><h3>${title}</h3><p>${text}</p></div>`;

export function envelopeTable(envelopes, { templates = false } = {}) {
  if (!envelopes.length) {
    return templates
      ? emptyState('template', 'No templates yet', 'Save any envelope as a template to reuse its documents, roles and fields.')
      : emptyState('inbox', 'Nothing here yet', 'Create an envelope to get started.');
  }
  return html`<table class="list"><thead><tr><th>Subject</th><th class="hide-sm">Recipients</th><th>Status</th><th class="hide-sm">Last change</th></tr></thead><tbody>
    ${raw(envelopes.map((e) => html`<tr class="click" data-href="#/envelopes/${e.id}${e.status === 'draft' || templates ? '/edit' : ''}">
      <td><div class="t-title">${e.title}</div><div class="t-sub">${e.recipients.length ? `To: ${e.recipients.filter((r) => r.role !== 'cc').map((r) => r.name).join(', ') || '—'}` : 'No recipients yet'}</div></td>
      <td class="hide-sm"><div class="avatars">${raw(e.recipients.slice(0, 5).map((r) => html`<span class="avatar" style="background:${r.color}" title="${r.name} · ${r.status}">${initials(r.name) || '?'}</span>`).join(''))}</div></td>
      <td>${templates ? raw('<span class="pill pill-purple">Template</span>') : pill(STATUS, e.status)}${raw(e.status === 'sent' ? html`<div class="t-sub" style="margin-top:4px">${e.recipients.filter((r) => r.status === 'completed').length} of ${e.recipients.filter((r) => r.role !== 'cc').length} done</div>` : '')}</td>
      <td class="hide-sm"><div>${fmtDate(e.updated_at, false)}</div><div class="t-sub">${timeAgo(e.updated_at)}</div></td></tr>`).join(''))}
  </tbody></table>`;
}

function bindRows(root) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
}

export const searchBox = (placeholder, value = '') =>
  html`<label class="search-box" style="width:300px">${raw(icon('search', 16))}<input type="search" placeholder="${placeholder}" value="${value}" data-q aria-label="${placeholder}"></label>`;

async function renderList(view, query, templates = false) {
  const status = query.get('status') || 'all';
  const q = query.get('q') || '';
  const tabs = [['all', 'All'], ['sent', 'Waiting for others'], ['completed', 'Completed'], ['draft', 'Drafts'], ['declined', 'Declined'], ['voided', 'Voided'], ['expired', 'Expired']];
  view.innerHTML = html`<div class="page-head rise"><div><p class="eyebrow">${templates ? 'Reusable packages' : 'All envelopes'}</p><h1>${templates ? 'Templates' : 'Agreements'}</h1>
      <p class="muted">${templates ? 'Documents, recipient roles and fields, ready to send again.' : 'Every envelope you have sent or drafted.'}</p></div>
      <div class="actions-row">${raw(searchBox('Search by title, name or email', q))}
      <button class="btn primary" data-new>${raw(icon('plus', 18))}New ${templates ? 'template' : 'envelope'}</button></div></div>
    <div class="card rise" style="animation-delay:80ms">${raw(templates ? '' : html`<div class="tabs-row">${raw(tabs.map(([k, l]) => html`<a href="#/envelopes?status=${k}" class="${status === k ? 'on' : ''}">${l}</a>`).join(''))}</div>`)}
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
  view.innerHTML = html`<div class="page-head rise"><div><p class="eyebrow">Storage</p><h1>File storage</h1><p class="muted">Every completed agreement and uploaded document, stored on LangSync's own server.</p></div>
    ${raw(searchBox('Search files', query.get('q') || ''))}</div>
    <div class="card rise" style="margin-bottom:18px;animation-delay:80ms"><div class="card-head"><div class="left"><span class="tile tile-good">${raw(icon('checkCircle', 18))}</span><div><h2>Completed agreements</h2><div class="t-sub">Signed PDF with certificate of completion</div></div></div></div><div data-completed></div></div>
    <div class="card rise" style="animation-delay:140ms"><div class="card-head"><div class="left"><span class="tile">${raw(icon('folder', 18))}</span><div><h2>All uploaded documents</h2><div class="t-sub">Originals, as uploaded</div></div></div></div><div data-docs></div></div>`;
  const load = async () => {
    const { documents, completed } = await api('GET', `/api/library?q=${encodeURIComponent(view.querySelector('[data-q]').value)}`);
    view.querySelector('[data-completed]').innerHTML = completed.length
      ? html`<table class="list"><thead><tr><th>Agreement</th><th class="hide-sm">Completed</th><th class="hide-sm">Contents</th><th></th></tr></thead><tbody>${raw(completed.map((c) => html`<tr>
          <td><div class="t-title"><span class="doc-icon">PDF</span>${c.title}</div><div class="t-sub mono">SHA-256 ${c.final_sha256.slice(0, 24)}…</div></td>
          <td class="hide-sm">${fmtDate(c.completed_at)}</td><td class="hide-sm">PDF + certificate</td>
          <td style="text-align:right;white-space:nowrap"><a class="btn ghost small" href="/api/envelopes/${c.envelope_id}/download?inline=1" target="_blank" rel="noopener">${raw(icon('eye', 15))}View</a> <a class="btn primary small" href="/api/envelopes/${c.envelope_id}/download">${raw(icon('download', 15))}Download</a></td></tr>`).join(''))}</tbody></table>`
      : emptyState('folder', 'No completed agreements yet', 'Signed documents appear here automatically.');
    view.querySelector('[data-docs]').innerHTML = documents.length
      ? html`<table class="list"><thead><tr><th>Document</th><th class="hide-sm">Envelope</th><th class="hide-sm">Pages</th><th class="hide-sm">Added</th><th></th></tr></thead><tbody>${raw(documents.map((d) => html`<tr>
          <td><div class="t-title">${d.name}</div><div class="t-sub">${fmtSize(d.size)}</div></td>
          <td class="hide-sm"><a class="text-link" href="#/envelopes/${d.envelope_id}${d.status === 'draft' || d.is_template ? '/edit' : ''}">${d.title}</a> ${d.is_template ? raw('<span class="pill pill-purple">Template</span>') : pill(STATUS, d.status)}</td>
          <td class="hide-sm">${d.page_count}</td><td class="hide-sm">${fmtDate(d.created_at, false)}</td>
          <td style="text-align:right"><a class="btn ghost small" href="/api/envelopes/${d.envelope_id}/documents/${d.id}/file" target="_blank" rel="noopener">Open</a></td></tr>`).join(''))}</tbody></table>`
      : emptyState('search', 'No documents match', 'Try a different search.');
  };
  let t;
  view.querySelector('[data-q]').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  await load();
}

/* -------------------------------- outbox -------------------------------- */

async function renderOutbox(view) {
  const { emails, smtpEnabled } = await api('GET', '/api/outbox');
  view.innerHTML = html`<div class="page-head rise"><div><p class="eyebrow">Notifications</p><h1>Email outbox</h1><p class="muted">Every notification ${state.config.appName} has sent on your behalf.</p></div></div>
    ${raw(smtpEnabled ? '' : html`<div class="callout warn rise" style="margin-bottom:16px">${raw(icon('alert', 18))}<div><strong>Email delivery isn't set up yet.</strong> Notifications are recorded here instead of being sent. Copy a signing link below and share it yourself, or set <span class="mono">SMTP_HOST</span> (see README) to send real emails.</div></div>`)}
    <div class="card rise" style="animation-delay:80ms">${raw(emails.length ? html`<table class="list"><thead><tr><th>To</th><th>Subject</th><th class="hide-sm">Status</th><th class="hide-sm">When</th><th></th></tr></thead><tbody>${raw(emails.map((m) => html`<tr>
      <td><div class="t-title">${m.to_name || m.to_email}</div><div class="t-sub">${m.to_email}</div></td>
      <td>${m.subject}${raw(m.envelope_id ? html`<div class="t-sub"><a class="text-link" href="#/envelopes/${m.envelope_id}">Open envelope</a></div>` : '')}</td>
      <td class="hide-sm">${raw(m.status === 'sent' ? '<span class="pill pill-green">Sent</span>' : m.status === 'failed' ? html`<span class="pill pill-red" title="${m.error || ''}">Failed</span>` : '<span class="pill pill-gray">Logged</span>')}</td>
      <td class="hide-sm">${timeAgo(m.created_at)}</td>
      <td style="text-align:right">${raw(m.link ? html`<button class="btn ghost small" data-copy="${m.link}">${raw(icon('copy', 15))}Copy link</button>` : '')}</td></tr>`).join(''))}</tbody></table>` : emptyState('mail', 'No emails yet', 'Notifications appear here as you send envelopes.'))}</div>`;
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

export { el, icon };
