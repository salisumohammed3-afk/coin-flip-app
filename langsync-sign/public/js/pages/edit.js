// Step 1: documents, recipients (signers / approvers / CCs), message and settings.
import { api, html, raw, toast, fmtSize, debounce, RECIPIENT_COLORS, confirmDialog } from '../ui.js';
import { go, state } from '../app.js';
import { icon } from '../icons.js';

export function stepsBar(env, current) {
  const steps = [['edit', 'Documents & recipients'], ['prepare', 'Fields & markup'], ['review', env.is_template ? 'Save template' : 'Review & send']];
  const idx = steps.findIndex(([k]) => k === current);
  return html`<div class="steps">${raw(steps.map(([k, label], i) => html`${raw(i ? '<span class="sep"></span>' : '')}<a href="#/envelopes/${env.id}/${k}" class="${i === idx ? 'on' : i < idx ? 'done' : ''}"><span class="n">${i < idx ? '✓' : i + 1}</span>${label}</a>`).join(''))}</div>`;
}

export async function renderEditStep(view, id) {
  let env = await api('GET', `/api/envelopes/${id}`);
  if (!env.is_template && env.status !== 'draft') return go(`envelopes/${id}`);
  const recipients = env.recipients.map((r) => ({ ...r }));
  let saving = Promise.resolve();

  view.innerHTML = html`
    <div class="page-head">
      <div><p class="eyebrow">${env.is_template ? 'Template' : 'Draft envelope'}</p>
        <input type="text" data-title value="${env.title}" aria-label="Envelope title" style="font-family:var(--ls-font-display);font-size:30px;font-weight:700;letter-spacing:-.03em;border:0;padding:0;border-radius:0;background:transparent;color:var(--ls-ink);box-shadow:none;min-width:320px"></div>
      ${raw(stepsBar(env, 'edit'))}
    </div>

    <div class="card card-pad" style="margin-bottom:18px">
      <div class="section-title"><span class="tile">${raw(icon('file', 18))}</span><div><h2>Documents</h2><p class="muted small">Everything in this package</p></div></div>
      <label class="dropzone" data-drop>
        <span class="tile tile-lg">${raw(icon('upload', 24))}</span><div><strong>Drop files here</strong> or click to upload</div>
        <div class="muted small">PDF, PNG or JPG · up to 10 files at a time · documents are combined into one package</div>
        <input type="file" multiple accept="application/pdf,image/png,image/jpeg" hidden data-file>
      </label>
      <ul class="doc-list" data-docs></ul>
    </div>

    <div class="card card-pad" style="margin-bottom:18px">
      <div class="recipient-head"><div class="section-title" style="margin:0"><span class="tile">${raw(icon('users', 18))}</span><div><h2>Recipients</h2><p class="muted small">Signers, approvers and people who get a copy</p></div></div>
        <label class="check" style="margin:0"><input type="checkbox" data-seq ${env.sequential ? 'checked' : ''}><span><strong>Set signing order</strong> <span class="muted small">— recipients act one after another</span></span></label></div>
      <div data-recipients></div>
      <div class="actions-row"><button class="btn ghost small" data-add>${raw(icon('plus', 15))}Add recipient</button><button class="btn ghost small" data-add-me>${raw(icon('user', 15))}Add me</button></div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px">
      <div class="section-title"><span class="tile">${raw(icon('mail', 18))}</span><div><h2>Message</h2><p class="muted small">What recipients see in their email</p></div></div>
      <label class="field"><span>Email subject <span class="hint">(defaults to "Please sign: <em>envelope title</em>")</span></span><input type="text" data-subject maxlength="200" value="${env.subject}"></label>
      <label class="field"><span>Message to all recipients</span><textarea rows="4" data-message maxlength="5000" placeholder="Hi, please review and sign. Thanks!">${env.message}</textarea></label>
    </div>

    <div class="card card-pad">
      <div class="section-title"><span class="tile">${raw(icon('shield', 18))}</span><div><h2>Settings</h2><p class="muted small">Markup, expiry and reminders</p></div></div>
      <label class="check"><input type="checkbox" data-markup ${env.allow_markup ? 'checked' : ''}><span><strong>Let recipients mark up documents</strong><br><span class="muted small">Recipients can draw, highlight, add text and leave comments. Their markup is flattened into the completed PDF.</span></span></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:520px">
        <label class="field"><span>Expires after (days)</span><input type="number" min="0" max="365" data-expires value="${env.expires_days}"><span class="hint small muted">0 = never</span></label>
        <label class="field"><span>Auto-remind every (days)</span><input type="number" min="0" max="60" data-remind value="${env.reminder_days}"><span class="hint small muted">0 = off</span></label>
      </div>
    </div>

    <div class="wizard-foot">
      <span class="save-state" data-saved style="margin-right:auto"></span>
      <button class="btn ghost" data-delete>Discard</button>
      <button class="btn ghost" data-close>Save &amp; close</button>
      <button class="btn primary" data-next>Next: place fields${raw(icon('arrowRight', 17))}</button>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const savedLabel = (text) => ($('[data-saved]').textContent = text);

  /* ---------- documents ---------- */
  const renderDocs = () => {
    $('[data-docs]').innerHTML = env.documents.map((d) => html`<li><span class="doc-icon">PDF</span><div class="grow"><div class="t-title">${d.name}</div>
      <div class="t-sub">${d.page_count} page${d.page_count === 1 ? '' : 's'} · ${fmtSize(d.size)}</div></div>
      <a class="btn ghost small" target="_blank" rel="noopener" href="/api/envelopes/${env.id}/documents/${d.id}/file">Preview</a>
      <button class="icon-btn" data-rm="${d.id}" title="Remove" aria-label="Remove ${d.name}">${raw(icon('trash', 17))}</button></li>`).join('');
    view.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      const ok = await confirmDialog({ title: 'Remove document?', message: 'Any fields or markup placed on it will be removed too.', confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      env = await api('DELETE', `/api/envelopes/${env.id}/documents/${b.dataset.rm}`);
      renderDocs();
    }));
  };
  const uploadFiles = async (files) => {
    if (!files.length) return;
    files = [...files];
    savedLabel(`Uploading ${files.length} file(s)…`);
    try {
      // In production, files go straight to private storage via signed URLs, then get imported.
      const plan = await api('POST', `/api/envelopes/${env.id}/uploads`, { files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) });
      if (plan.direct) {
        await Promise.all(plan.uploads.map(async (u, i) => {
          const res = await fetch(u.url, { method: 'PUT', body: files[i], headers: { 'content-type': files[i].type || 'application/octet-stream', 'x-upsert': 'true' } });
          if (!res.ok) throw new Error(`Upload of ${files[i].name} failed (${res.status}).`);
        }));
        env = await api('POST', `/api/envelopes/${env.id}/documents/import`, { files: plan.uploads.map((u, i) => ({ key: u.key, name: files[i].name, type: files[i].type })) });
      } else {
        const form = new FormData();
        files.forEach((f) => form.append('files', f));
        env = await api('POST', `/api/envelopes/${env.id}/documents`, undefined, { form });
      }
      $('[data-title]').value = env.title;
      renderDocs();
      savedLabel('Uploaded ✓');
    } catch (err) {
      toast(err.message, { type: 'error' });
      savedLabel('');
    }
  };
  const drop = $('[data-drop]');
  $('[data-file]').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); });
  renderDocs();

  /* ---------- recipients ---------- */
  const saveRecipients = debounce(() => {
    saving = saving.then(async () => {
      savedLabel('Saving…');
      const payload = recipients.map((r) => ({ ...r, routing_order: $('[data-seq]').checked ? r.routing_order || 1 : 1 }));
      const res = await api('PUT', `/api/envelopes/${env.id}/recipients`, payload);
      res.recipients.forEach((r) => { if (recipients[r.sort]) recipients[r.sort].id = r.id; });
      env = res;
      savedLabel('All changes saved ✓');
    }).catch((err) => toast(err.message, { type: 'error' }));
    return saving;
  }, 600);

  const renderRecipients = () => {
    const seq = $('[data-seq]').checked;
    const box = $('[data-recipients]');
    box.classList.toggle('no-order', !seq);
    box.innerHTML = recipients.length ? recipients.map((r, i) => html`<div class="recipient" style="--c:${r.color}" data-i="${i}">
        <div class="handle order-col" title="Signing order">${raw(icon('users', 17))}</div>
        <input class="order order-col" type="number" min="1" max="99" value="${r.routing_order}" data-k="routing_order" title="Signing order" aria-label="Signing order">
        <input type="text" placeholder="Name" value="${r.name}" data-k="name" aria-label="Recipient name">
        <input type="email" placeholder="Email" value="${r.email}" data-k="email" aria-label="Recipient email">
        <select data-k="role" aria-label="Recipient role">
          <option value="signer" ${r.role === 'signer' ? 'selected' : ''}>Needs to sign</option>
          <option value="approver" ${r.role === 'approver' ? 'selected' : ''}>Needs to approve</option>
          <option value="cc" ${r.role === 'cc' ? 'selected' : ''}>Receives a copy (CC)</option>
        </select>
        <button class="icon-btn" data-remove title="Remove recipient" aria-label="Remove recipient">${raw(icon('x', 17))}</button>
        <details class="more" ${r.access_code || r.private_message ? 'open' : ''}><summary class="muted small" style="cursor:pointer">More options: access code, private message</summary>
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-top:8px">
            <label class="field"><span>Access code <span class="hint">(share separately)</span></span><input type="text" value="${r.access_code}" data-k="access_code" maxlength="64" placeholder="Optional"></label>
            <label class="field"><span>Private message <span class="hint">(replaces the main message for them)</span></span><input type="text" value="${r.private_message}" data-k="private_message" maxlength="2000" placeholder="Optional"></label>
          </div></details>
      </div>`).join('') : '<div class="empty" style="padding:24px">No recipients yet. Add the people who need to sign, approve, or get a copy.</div>';
    box.querySelectorAll('.recipient').forEach((row) => {
      const r = recipients[+row.dataset.i];
      row.querySelectorAll('[data-k]').forEach((input) => {
        input.addEventListener('input', () => {
          r[input.dataset.k] = input.dataset.k === 'routing_order' ? Number(input.value) || 1 : input.value;
          saveRecipients();
        });
      });
      row.querySelector('[data-remove]').onclick = () => {
        recipients.splice(+row.dataset.i, 1);
        renderRecipients();
        saveRecipients();
      };
    });
  };
  const addRecipient = (data = {}) => {
    const used = new Set(recipients.map((r) => r.color));
    recipients.push({
      name: '', email: '', role: 'signer', access_code: '', private_message: '',
      routing_order: recipients.length ? Math.max(...recipients.map((r) => r.routing_order || 1)) + 1 : 1,
      color: RECIPIENT_COLORS.find((c) => !used.has(c)) || RECIPIENT_COLORS[recipients.length % RECIPIENT_COLORS.length],
      ...data,
    });
    renderRecipients();
    saveRecipients();
    view.querySelector(`.recipient[data-i="${recipients.length - 1}"] [data-k=name]`)?.focus();
  };
  $('[data-add]').onclick = () => addRecipient();
  $('[data-add-me]').onclick = () => addRecipient({ name: state.user.name, email: state.user.email });
  $('[data-seq]').onchange = () => {
    if ($('[data-seq]').checked) recipients.forEach((r, i) => (r.routing_order = i + 1));
    patch({ sequential: $('[data-seq]').checked });
    renderRecipients();
    saveRecipients();
  };
  renderRecipients();

  /* ---------- message & settings ---------- */
  const patch = (body) => {
    saving = saving.then(async () => {
      savedLabel('Saving…');
      env = { ...env, ...(await api('PATCH', `/api/envelopes/${env.id}`, body)) };
      savedLabel('All changes saved ✓');
    }).catch((err) => toast(err.message, { type: 'error' }));
    return saving;
  };
  const savePatch = debounce(() => patch({
    title: $('[data-title]').value, subject: $('[data-subject]').value, message: $('[data-message]').value,
    allow_markup: $('[data-markup]').checked, expires_days: Number($('[data-expires]').value), reminder_days: Number($('[data-remind]').value),
  }), 600);
  ['[data-title]', '[data-subject]', '[data-message]', '[data-expires]', '[data-remind]'].forEach((s) => $(s).addEventListener('input', savePatch));
  $('[data-markup]').onchange = savePatch;

  const flush = async () => {
    savePatch.flush();
    await saveRecipients.flush();
    await saving;
  };

  $('[data-close]').onclick = async () => { await flush(); go(env.is_template ? 'templates' : 'envelopes'); };
  $('[data-delete]').onclick = async () => {
    const ok = await confirmDialog({ title: `Discard this ${env.is_template ? 'template' : 'draft'}?`, message: 'Its documents and settings will be deleted permanently.', confirmLabel: 'Discard', danger: true });
    if (!ok) return;
    await api('DELETE', `/api/envelopes/${env.id}`);
    go(env.is_template ? 'templates' : 'envelopes');
  };
  $('[data-next]').onclick = async () => {
    await flush();
    if (!env.documents.length) return toast('Upload at least one document first.', { type: 'error' });
    if (!recipients.some((r) => r.role !== 'cc')) return toast('Add at least one recipient who signs or approves.', { type: 'error' });
    const bad = recipients.find((r) => !r.name.trim() || (!env.is_template && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)));
    if (bad) return toast(env.is_template ? 'Give every recipient role a name (e.g. "Client").' : 'Every recipient needs a name and a valid email.', { type: 'error' });
    go(`envelopes/${env.id}/prepare`);
  };
}
