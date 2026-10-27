// Step 3: review everything and send (or save the template).
import { api, html, raw, toast, ROLE_LABEL } from '../ui.js';
import { go } from '../app.js';
import { stepsBar } from './edit.js';
import { icon } from '../icons.js';

export async function renderReview(view, id) {
  const env = await api('GET', `/api/envelopes/${id}`);
  if (!env.is_template && env.status !== 'draft') return go(`envelopes/${id}`);
  const problems = [];
  if (!env.documents.length) problems.push('Add at least one document.');
  if (!env.recipients.some((r) => r.role !== 'cc')) problems.push('Add at least one recipient who signs or approves.');
  for (const r of env.recipients.filter((r) => r.role === 'signer')) {
    if (!env.fields.some((f) => f.recipient_id === r.id && f.type === 'signature')) problems.push(`${r.name || 'A signer'} has no signature field.`);
  }
  if (!env.is_template) {
    for (const r of env.recipients) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) problems.push(`${r.name || 'A recipient'} needs a valid email.`);
  }
  const ordered = [...env.recipients].sort((a, b) => a.routing_order - b.routing_order);

  view.innerHTML = html`
    <div class="page-head"><div><p class="eyebrow">${env.is_template ? 'Template' : 'Ready to send'}</p><h1>${env.title}</h1></div>${raw(stepsBar(env, 'review'))}</div>
    ${raw(problems.length ? html`<div class="callout bad" style="margin-bottom:16px">${raw(icon('alert', 18))}<div><strong>Fix these before ${env.is_template ? 'saving' : 'sending'}:</strong><ul style="margin:6px 0 0">${raw(problems.map((p) => html`<li>${p}</li>`).join(''))}</ul></div></div>` : '')}
    <div class="detail-grid">
      <div class="card">
        <div class="card-head"><h2>Recipients</h2><span class="muted small">${env.sequential ? 'Signing in order' : 'Everyone at once'}</span></div>
        <ul class="timeline">${raw(ordered.map((r) => {
          const n = env.fields.filter((f) => f.recipient_id === r.id).length;
          return html`<li style="--c:${r.color}"><span class="ord">${env.sequential ? r.routing_order : '•'}</span>
            <div><div class="t-title">${r.name}</div><div class="t-sub">${r.email || 'Email added when the template is used'}</div>
            <div class="t-sub">${ROLE_LABEL[r.role]}${r.role === 'cc' ? '' : `, ${n} field${n === 1 ? '' : 's'}`}${r.access_code ? ', access code' : ''}</div></div><span></span></li>`;
        }).join(''))}</ul>
      </div>
      <div style="display:grid;gap:18px">
        <div class="card card-pad"><h2 style="margin-bottom:10px">Documents</h2>
          ${raw(env.documents.map((d) => html`<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="doc-icon">PDF</span><span>${d.name}</span><span class="muted small">${d.page_count}p</span></div>`).join(''))}
          <p class="muted small">${env.annotations.length} markup item${env.annotations.length === 1 ? '' : 's'}, ${env.fields.length} field${env.fields.length === 1 ? '' : 's'}</p></div>
        <div class="card card-pad"><h2 style="margin-bottom:10px">Email</h2>
          <dl class="kv"><dt>Subject</dt><dd>${env.subject || `Please sign: ${env.title}`}</dd><dt>Message</dt><dd style="white-space:pre-wrap">${env.message || 'No message'}</dd>
          <dt>Expires</dt><dd>${env.expires_days ? `${env.expires_days} days after sending` : 'Never'}</dd>
          <dt>Reminders</dt><dd>${env.reminder_days ? `Every ${env.reminder_days} days` : 'Off'}</dd>
          <dt>Markup</dt><dd>${env.allow_markup ? 'Recipients can mark up' : 'Off'}</dd></dl></div>
      </div>
    </div>
    <div class="wizard-foot">
      <button class="btn ghost" data-back>${raw(icon('arrowLeft', 17))}Back</button>
      ${raw(env.is_template
        ? '<button class="btn ghost" data-save>Save template</button><button class="btn primary" data-use>Use template now →</button>'
        : `<button class="btn primary" data-send>${icon('send', 17)}Send envelope</button>`)}
    </div>`;

  const $ = (s) => view.querySelector(s);
  $('[data-back]').onclick = () => go(`envelopes/${id}/prepare`);
  $('[data-save]')?.addEventListener('click', () => { toast('Template saved', { type: 'success' }); go('templates'); });
  $('[data-use]')?.addEventListener('click', async () => {
    const draft = await api('POST', `/api/envelopes/${id}/duplicate`, { title: env.title });
    toast('Draft created from template. Fill in the recipients\' emails.');
    go(`envelopes/${draft.id}/edit`);
  });
  $('[data-send]')?.addEventListener('click', async (e) => {
    if (problems.length) return toast(problems[0], { type: 'error' });
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    try {
      await api('POST', `/api/envelopes/${id}/send`);
      toast('Envelope sent! We\'ll notify you as people view and sign.', { type: 'success', timeout: 6000 });
      go(`envelopes/${id}`);
    } catch (err) {
      toast(err.message, { type: 'error' });
      e.target.disabled = false;
      e.target.textContent = 'Send envelope';
    }
  });
}
