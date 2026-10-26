// Envelope tracking page: live recipient status, history, preview and actions.
import { api, html, raw, el, toast, fmtDate, timeAgo, STATUS, RECIPIENT_STATUS, ROLE_LABEL, pill, confirmDialog, modal } from '../ui.js';
import { go, state, eventIcon } from '../app.js';
import { renderDocuments, findPage, placeBox, FIELD_TYPES } from '../viewer.js';
import { Markup } from '../markup.js';

export async function renderDetail(view, id) {
  let env = await api('GET', `/api/envelopes/${id}`);
  if (env.status === 'draft' || env.is_template) return go(`envelopes/${id}/edit`);

  view.innerHTML = html`<div data-head></div>
    <div class="detail-grid">
      <div style="display:grid;gap:18px;min-width:0">
        <div class="card"><div class="card-head"><h2>Recipients</h2><span class="muted small" data-progress></span></div><ul class="timeline" data-recipients></ul></div>
        <div class="card"><div class="card-head"><h2>Documents</h2><span class="muted small">${env.documents.length} file${env.documents.length === 1 ? '' : 's'}</span></div><div class="preview-docs"><div class="docs" data-docs></div></div></div>
      </div>
      <div style="display:grid;gap:18px">
        <div class="card card-pad" data-details></div>
        <div class="card"><div class="card-head"><h2>History</h2><span class="muted small">Audit trail</span></div><table class="history" data-history></table></div>
      </div>
    </div>`;
  const $ = (s) => view.querySelector(s);

  function paint() {
    const actionable = env.recipients.filter((r) => r.role !== 'cc');
    const done = actionable.filter((r) => r.status === 'completed').length;
    $('[data-head]').innerHTML = html`<div class="page-head">
      <div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h1>${env.title}</h1>${pill(STATUS, env.status)}</div>
        <p class="muted">From ${env.owner.name} · Sent ${fmtDate(env.sent_at)}${env.completed_at ? ` · Completed ${fmtDate(env.completed_at)}` : ''}</p></div>
      <div class="actions-row">
        ${raw(env.has_final ? html`<a class="btn ghost" href="/api/envelopes/${env.id}/download?inline=1" target="_blank" rel="noopener">View completed PDF</a><a class="btn primary" href="/api/envelopes/${env.id}/download">⬇ Download</a>` : '')}
        ${raw(env.status === 'sent' ? '<button class="btn primary" data-remind>🔔 Remind</button><button class="btn ghost" data-void>Void</button>' : '')}
        <button class="btn ghost" data-dup>Duplicate</button>
        <button class="btn ghost" data-tpl>Save as template</button>
        ${raw(env.status !== 'sent' ? '<button class="btn ghost" data-del style="color:var(--red)">Delete</button>' : '')}
      </div></div>
      ${raw(env.status === 'declined' ? html`<div class="callout bad" style="margin-bottom:16px"><strong>Declined</strong> by ${env.recipients.find((r) => r.status === 'declined')?.name}: “${env.recipients.find((r) => r.status === 'declined')?.decline_reason}”. Duplicate the envelope to fix and resend.</div>` : '')}
      ${raw(env.status === 'voided' ? html`<div class="callout bad" style="margin-bottom:16px"><strong>Voided:</strong> ${env.void_reason}</div>` : '')}
      ${raw(env.status === 'expired' ? '<div class="callout warn" style="margin-bottom:16px"><strong>Expired</strong> before everyone signed. Duplicate it to send again.</div>' : '')}`;
    $('[data-progress]').textContent = `${done} of ${actionable.length} complete`;

    $('[data-recipients]').innerHTML = [...env.recipients].sort((a, b) => a.routing_order - b.routing_order).map((r) => html`<li style="--c:${r.color}">
      <span class="ord">${env.sequential ? r.routing_order : r.role === 'cc' ? 'cc' : '•'}</span>
      <div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="t-title">${r.name}</span>${pill(RECIPIENT_STATUS, r.status)}</div>
        <div class="t-sub">${r.email} · ${ROLE_LABEL[r.role]}${r.access_code ? ' · 🔐 access code' : ''}</div>
        <div class="t-sub">${[r.sent_at && `Sent ${timeAgo(r.sent_at)}`, r.viewed_at && `Viewed ${timeAgo(r.viewed_at)}`, r.completed_at && `${r.role === 'approver' ? 'Approved' : r.role === 'cc' ? 'Delivered' : 'Signed'} ${fmtDate(r.completed_at)}`, r.declined_at && `Declined ${fmtDate(r.declined_at)}`].filter(Boolean).join(' · ') || (env.status === 'sent' ? 'Waiting for earlier recipients' : '')}</div>
        ${raw(r.signature_image ? html`<img src="${r.signature_image}" alt="Signature of ${r.name}" style="max-height:38px;max-width:180px;margin-top:6px">` : '')}
      </div>
      <div class="acts">
        ${raw(r.link && !['completed', 'declined'].includes(r.status) ? html`<button class="btn ghost small" data-copy="${r.link}" title="Copy this recipient's private signing link">Copy link</button>` : '')}
        ${raw(env.status === 'sent' && !['completed', 'declined'].includes(r.status) ? html`<button class="btn ghost small" data-correct="${r.id}">Correct</button>` : '')}
      </div></li>`).join('');

    $('[data-details]').innerHTML = html`<h2 style="margin-bottom:12px">Details</h2><dl class="kv">
      <dt>Envelope ID</dt><dd class="mono">${env.id}</dd>
      <dt>Status</dt><dd>${STATUS[env.status]?.label}</dd>
      <dt>Created</dt><dd>${fmtDate(env.created_at)}</dd>
      <dt>Sent</dt><dd>${fmtDate(env.sent_at)}</dd>
      <dt>Expires</dt><dd>${env.expires_at ? fmtDate(env.expires_at) : 'Never'}</dd>
      <dt>Reminders</dt><dd>${env.reminder_days ? `Every ${env.reminder_days} days` : 'Manual only'}</dd>
      ${raw(env.completed_at ? html`<dt>Completed</dt><dd>${fmtDate(env.completed_at)}</dd><dt>SHA-256</dt><dd class="mono">${env.final_sha256}</dd>` : '')}
      <dt>Originals</dt><dd>${raw(env.documents.map((d) => html`<div><a href="/api/envelopes/${env.id}/documents/${d.id}/file" target="_blank" rel="noopener">${d.name}</a></div>`).join(''))}</dd>
      </dl>`;

    $('[data-history]').innerHTML = [...env.events].reverse().map((e) => html`<tr><td>${fmtDate(e.created_at)}</td>
      <td>${eventIcon(e.type)} <strong>${e.actor.replace(/ <.*>/, '')}</strong> · ${e.detail || e.type}${raw(e.ip ? html`<div class="muted small">IP ${e.ip}</div>` : '')}</td></tr>`).join('');

    bindActions();
  }

  function bindActions() {
    view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Signing link copied. Only share it with that recipient.');
    }));
    view.querySelectorAll('[data-correct]').forEach((b) => (b.onclick = () => correct(env.recipients.find((r) => r.id === b.dataset.correct))));
    $('[data-remind]')?.addEventListener('click', async () => {
      const { reminded } = await api('POST', `/api/envelopes/${env.id}/remind`);
      toast(reminded ? `Reminder sent to ${reminded} recipient${reminded === 1 ? '' : 's'}` : 'Nobody is waiting to act right now.');
      refresh();
    });
    $('[data-void]')?.addEventListener('click', async () => {
      const reason = await confirmDialog({ title: 'Void this envelope?', message: 'Recipients will no longer be able to view or sign it, and they will be notified.', confirmLabel: 'Void envelope', danger: true, input: { label: 'Reason (shared with recipients)', required: true } });
      if (!reason) return;
      env = await api('POST', `/api/envelopes/${env.id}/void`, { reason });
      paint();
    });
    $('[data-dup]').onclick = async () => {
      const copy = await api('POST', `/api/envelopes/${env.id}/duplicate`, {});
      toast('Copied to a new draft');
      go(`envelopes/${copy.id}/edit`);
    };
    $('[data-tpl]').onclick = async () => {
      const tpl = await api('POST', `/api/envelopes/${env.id}/duplicate`, { template: true });
      toast('Saved as a template');
      go(`envelopes/${tpl.id}/edit`);
    };
    $('[data-del]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete this envelope?', message: 'This permanently removes the envelope, its documents and its completed PDF from storage.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await api('DELETE', `/api/envelopes/${env.id}`);
      go('envelopes');
    });
  }

  async function correct(r) {
    const result = await modal({
      title: `Correct ${r.name}`,
      render(body, close) {
        body.innerHTML = html`<p class="muted small">Fix a typo or send to a different person. Their old link stops working and a new email is sent.</p>
          <label class="field"><span>Name</span><input type="text" name="name" value="${r.name}"></label>
          <label class="field"><span>Email</span><input type="email" name="email" value="${r.email}"></label>
          <label class="field"><span>Access code</span><input type="text" name="access_code" value="${r.access_code}" placeholder="None"></label>
          <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Save &amp; resend</button></div>`;
        body.querySelector('[data-x]').onclick = () => close();
        body.querySelector('[data-ok]').onclick = () => close(Object.fromEntries(['name', 'email', 'access_code'].map((k) => [k, body.querySelector(`[name=${k}]`).value])));
      },
    });
    if (!result) return;
    try {
      env = await api('PATCH', `/api/envelopes/${env.id}/recipients/${r.id}`, result);
      toast('Recipient corrected and re-sent', { type: 'success' });
      paint();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  async function renderPreview() {
    const pages = await renderDocuments($('[data-docs]'), env.documents, (d) => `/api/envelopes/${env.id}/documents/${d.id}/file`);
    for (const f of env.fields) {
      const page = findPage(pages, f.document_id, f.page);
      const r = env.recipients.find((x) => x.id === f.recipient_id);
      if (!page || !r) continue;
      const node = el('<div class="sfld ro"></div>');
      placeBox(node, f);
      if (f.filled_at && (f.type === 'signature' || f.type === 'initials')) {
        // Initials images aren't sent to the list view; the signature is enough to show it's done.
        node.innerHTML = f.type === 'signature' && r.signature_image ? html`<div class="sig-wrap"><span class="tag">LangSync Sign</span><img src="${r.signature_image}" alt=""></div>` : html`<span class="val">✓ ${FIELD_TYPES[f.type].label}</span>`;
      } else if (f.filled_at) {
        node.innerHTML = f.type === 'checkbox' ? html`<span class="val">${f.value === 'true' ? '☑' : '☐'}</span>` : html`<span class="val">${f.value}</span>`;
      } else {
        node.classList.add('fld');
        node.style.setProperty('--c', r.color);
        node.innerHTML = html`<span class="fl">${FIELD_TYPES[f.type].label}</span>`;
        node.title = `${r.name} · not filled yet`;
      }
      page.overlay.append(node);
    }
    new Markup(pages, { items: env.annotations, author: { type: 'sender', id: state.user.id, name: state.user.name } });
  }

  async function refresh() {
    const prevStatus = env.status;
    const prevSigned = env.recipients.filter((r) => r.status === 'completed').length;
    env = await api('GET', `/api/envelopes/${id}`);
    paint();
    if (env.status !== prevStatus || env.recipients.filter((r) => r.status === 'completed').length !== prevSigned) renderPreview();
  }

  paint();
  renderPreview().catch((err) => toast(`Couldn't render preview: ${err.message}`, { type: 'error' }));

  const onActivity = (e) => { if (e.detail.some((ev) => ev.envelope_id === id)) refresh(); };
  window.addEventListener('lss:activity', onActivity);
  state.cleanup.push(() => window.removeEventListener('lss:activity', onActivity));
}
