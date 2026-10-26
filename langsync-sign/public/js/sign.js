// Recipient experience: access code, e-sign consent, guided signing, markup, decline.
import { api, html, raw, el, toast, fmtDate, modal, confirmDialog, ROLE_LABEL } from './ui.js';
import { renderDocuments, findPage, placeBox, FIELD_TYPES } from './viewer.js';
import { Markup, markupToolbar } from './markup.js';
import { adoptSignature } from './signature.js';

const app = document.getElementById('app');
const token = location.pathname.split('/s/')[1]?.replace(/\/$/, '');
const base = `/api/sign/${token}`;

const DISCLOSURE = `Electronic Record and Signature Disclosure

By checking the box, you agree that:
• You can access and read this document electronically.
• You consent to receive documents and notices for this transaction electronically rather than on paper.
• Your electronic signature and initials are the legal equivalent of your handwritten signature and initials.
• You may withdraw consent before signing by choosing "Decline to sign", and you can ask the sender for a paper copy.
• Your IP address, device details and the time of each action will be recorded in the audit trail.`;

async function load() {
  let data;
  try {
    data = await api('GET', base);
  } catch (err) {
    return card('🔗', 'This link is not valid', err.message);
  }
  document.title = `${data.envelope.title} · LangSync Sign`;
  if (data.needsCode) return renderCode(data);
  if (new URLSearchParams(location.search).get('download') === '1' && data.mode === 'completed') location.href = `${base}/download`;

  const { mode, envelope, owner, recipient } = data;
  if (mode === 'closed') {
    const what = envelope.status === 'voided' ? `was voided by ${owner.name}${envelope.void_reason ? `: “${envelope.void_reason}”` : '.'}` : envelope.status === 'expired' ? 'has expired.' : envelope.status === 'declined' ? 'was declined by a recipient and is no longer active.' : 'is no longer active.';
    return card('🚫', 'No action needed', `"${envelope.title}" ${what}`);
  }
  if (mode === 'waiting') {
    return card('⏳', 'It\'s not your turn yet', `"${envelope.title}" needs to be completed by other recipients first. We'll email you as soon as it's ready for you.`);
  }
  if (mode === 'sign') return renderSigning(data);
  return renderReadOnly(data);
}

function card(icon, title, text, extra = '') {
  app.innerHTML = html`<div class="sign-top"><span class="brand-mark">✍</span><span class="title">LangSync Sign</span></div>
    <div class="card center-card"><div class="big">${icon}</div><h1>${title}</h1><p class="muted">${text}</p>${raw(extra)}</div>`;
}

function renderCode(data) {
  card('🔐', 'Enter your access code', `${data.owner.name} protected "${data.envelope.title}" with an access code. They should have shared it with you separately.`,
    html`<form data-code style="margin-top:16px"><input type="text" name="code" autocomplete="one-time-code" placeholder="Access code" style="text-align:center;font-size:18px;max-width:240px"><div class="err"></div><button class="btn primary">Continue</button></form>`);
  const form = app.querySelector('[data-code]');
  form.querySelector('input').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', `${base}/access`, { code: form.code.value });
      load();
    } catch (err) {
      form.querySelector('.err').textContent = err.message;
    }
  };
}

function header(data, right = '') {
  return html`<div class="sign-top"><span class="brand-mark">✍</span>
    <div><div class="title">${data.envelope.title}</div><div class="from">From ${data.owner.name} · ${data.owner.email}</div></div>
    <div class="spacer"></div>${raw(right)}</div>`;
}

/* ------------------------------- read only ------------------------------- */

async function renderReadOnly(data) {
  const { mode, envelope, recipient } = data;
  const banner = mode === 'completed'
    ? html`<strong>✅ Completed ${fmtDate(envelope.completed_at)}.</strong> All parties have finished. Download the signed copy with its certificate of completion.`
    : mode === 'done'
      ? html`<strong>✅ You're done.</strong> Thanks, ${recipient.name}. We'll email everyone the completed copy once all parties have finished.`
      : html`<strong>You're receiving a copy.</strong> ${data.owner.name} added you as a CC, so there's nothing to sign. You'll get the completed copy by email.`;
  app.innerHTML = html`${raw(header(data, envelope.status === 'completed' ? html`<a class="btn primary" href="${base}/download">⬇ Download signed PDF</a>` : ''))}
    <div class="sign-banner"><p>${raw(banner)}</p></div>
    <div class="sign-stage"><div class="docs" data-docs></div></div>`;
  const pages = await renderDocuments(app.querySelector('[data-docs]'), data.documents, (d) => `${base}/documents/${d.id}`);
  drawReadonlyFields(pages, data.fields);
  new Markup(pages, { items: data.annotations, author: { type: 'recipient', id: recipient.id, name: recipient.name } });
}

function drawReadonlyFields(pages, fields) {
  for (const f of fields.filter((f) => f.readonly)) {
    const page = findPage(pages, f.document_id, f.page);
    if (!page) continue;
    const node = el('<div class="sfld ro filled"></div>');
    placeBox(node, f);
    if (f.image) node.innerHTML = html`<div class="sig-wrap">${raw(f.type === 'signature' ? '<span class="tag">LangSync Sign</span>' : '')}<img src="${f.image}" alt=""></div>`;
    else if (f.type === 'checkbox') node.innerHTML = html`<span class="val">${f.value === 'true' ? '☑' : '☐'}</span>`;
    else node.innerHTML = html`<span class="val">${f.value}</span>`;
    page.overlay.append(node);
  }
}

/* -------------------------------- signing -------------------------------- */

async function renderSigning(data) {
  const { envelope, recipient } = data;
  const myFields = data.fields.filter((f) => !f.readonly);
  const values = {};
  let signature = recipient.signature_image;
  let initials = recipient.initials_image;
  let consented = recipient.consented;
  const isApprover = recipient.role === 'approver';
  const finishLabel = isApprover ? 'Approve' : 'Finish';

  app.innerHTML = html`${raw(header(data, html`<span class="progress" data-progress></span>
      <button class="btn ghost small" data-decline>Decline</button>
      <button class="btn primary" data-finish>${finishLabel}</button>`))}
    <div class="sign-banner" data-banner></div>
    <div class="sign-stage"><div class="docs" data-docs><div class="empty">Loading documents…</div></div></div>
    <button class="next-btn" data-next hidden>Start</button>
    ${raw(envelope.allow_markup ? '<div class="sign-tools" data-tools><button class="btn ghost small" data-toggle-markup>✎ Mark up / comment</button><div data-bar hidden></div></div>' : '')}`;
  const $ = (s) => app.querySelector(s);

  const renderBanner = () => {
    const msg = envelope.message ? html`<div class="small" style="margin-bottom:6px"><strong>${data.owner.name}:</strong> <span style="white-space:pre-wrap">${envelope.message}</span></div>` : '';
    if (!consented) {
      $('[data-banner]').innerHTML = html`<p>${raw(msg)}Please read the <a href="#" data-disclosure>Electronic Record and Signature Disclosure</a>.<br>
        <label class="check" style="margin:8px 0 0"><input type="checkbox" data-agree><span>I agree to use electronic records and signatures.</span></label></p>
        <button class="btn primary" data-continue disabled>Continue</button>`;
      $('[data-agree]').onchange = (e) => ($('[data-continue]').disabled = !e.target.checked);
      $('[data-disclosure]').onclick = (e) => { e.preventDefault(); modal({ title: 'Electronic Record and Signature Disclosure', render: (b) => { b.innerHTML = html`<p class="note-text">${DISCLOSURE}</p>`; } }); };
      $('[data-continue]').onclick = async () => {
        await api('POST', `${base}/consent`);
        consented = true;
        renderBanner();
        update();
        nextField();
      };
    } else {
      $('[data-banner]').innerHTML = html`<p>${raw(msg)}${isApprover && !myFields.length
        ? 'Review the documents, then click Approve.'
        : html`You're signing as <strong>${recipient.name}</strong> (${ROLE_LABEL[recipient.role].toLowerCase()}). Click each highlighted field, then click ${finishLabel}.`}</p>`;
    }
    document.body.classList.toggle('locked', !consented);
  };

  const pages = await renderDocuments($('[data-docs]'), data.documents, (d) => `${base}/documents/${d.id}`);
  drawReadonlyFields(pages, data.fields);

  const required = (f) => f.required && !['date_signed', 'email'].includes(f.type);
  const isFilled = (f) => {
    if (f.type === 'signature') return values[f.id] === 'signed';
    if (f.type === 'initials') return values[f.id] === 'initialed';
    if (f.type === 'checkbox') return values[f.id] === 'true';
    if (['date_signed', 'email'].includes(f.type)) return true;
    return Boolean(String(values[f.id] || '').trim());
  };

  const nodes = new Map();
  for (const f of myFields) {
    const page = findPage(pages, f.document_id, f.page);
    if (!page) continue;
    const node = el(html`<div class="sfld" data-fid="${f.id}" title="${f.label || FIELD_TYPES[f.type].label}${f.required ? ' (required)' : ''}"></div>`);
    placeBox(node, f);
    page.overlay.append(node);
    nodes.set(f.id, node);
    if (f.type === 'full_name') values[f.id] = recipient.name;
    paintField(f);
  }

  function paintField(f) {
    const node = nodes.get(f.id);
    const filled = isFilled(f);
    node.className = `sfld ${filled ? 'filled' : 'todo'} ${f.required ? '' : 'optional'}`;
    if (f.type === 'signature' || f.type === 'initials') {
      const img = f.type === 'signature' ? signature : initials;
      node.innerHTML = filled && img
        ? html`<button class="sigbtn" title="Click to remove"><div class="sig-wrap">${raw(f.type === 'signature' ? '<span class="tag">LangSync Sign</span>' : '')}<img src="${img}" alt="Your ${f.type}"></div></button>`
        : html`<button class="sigbtn"><span>${f.type === 'signature' ? 'Sign' : 'Initial'}</span><span style="font-size:1.4em">${f.type === 'signature' ? '✍' : '⤓'}</span></button>`;
      node.querySelector('button').onclick = async () => {
        if (!consented) return toast('Please agree to use electronic signatures first.');
        if (filled) { values[f.id] = ''; paintField(f); return update(); }
        if (!(f.type === 'signature' ? signature : initials)) {
          const adopted = await adoptSignature({ name: recipient.name, need: f.type });
          if (!adopted) return;
          signature = adopted.signature || signature;
          initials = adopted.initials || initials;
        }
        values[f.id] = f.type === 'signature' ? 'signed' : 'initialed';
        paintField(f);
        update();
        nextField();
      };
    } else if (f.type === 'date_signed') {
      node.innerHTML = html`<span class="val">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>`;
    } else if (f.type === 'email') {
      node.innerHTML = html`<span class="val">${recipient.email}</span>`;
    } else if (f.type === 'checkbox') {
      if (!node.querySelector('input')) {
        node.innerHTML = '<input type="checkbox">';
        node.querySelector('input').onchange = (e) => { values[f.id] = e.target.checked ? 'true' : 'false'; paintField(f); update(); };
      }
      node.querySelector('input').checked = values[f.id] === 'true';
      node.querySelector('input').setAttribute('aria-label', f.label || 'Checkbox');
    } else if (!node.querySelector('input')) {
      node.innerHTML = html`<input type="text" placeholder="${f.label || FIELD_TYPES[f.type].label}${f.required ? ' *' : ''}" aria-label="${f.label || FIELD_TYPES[f.type].label}">`;
      const input = node.querySelector('input');
      input.value = values[f.id] || '';
      input.oninput = () => {
        values[f.id] = input.value;
        node.classList.toggle('filled', isFilled(f));
        node.classList.toggle('todo', !isFilled(f));
        update();
      };
    }
  }

  const remaining = () => myFields.filter((f) => required(f) && !isFilled(f));
  function update() {
    const req = myFields.filter(required);
    const left = remaining().length;
    $('[data-progress]').textContent = req.length ? `${req.length - left} of ${req.length} required fields` : '';
    const next = $('[data-next]');
    next.hidden = !consented || !left;
    next.textContent = req.length - left === 0 ? 'Start' : 'Next';
    $('[data-finish]').classList.toggle('accent', consented && !left);
  }

  function nextField() {
    const f = remaining().sort((a, b) => order(a) - order(b))[0];
    if (!f) return;
    const node = nodes.get(f.id);
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('current');
    setTimeout(() => node.classList.remove('current'), 2600);
    node.querySelector('input')?.focus({ preventScroll: true });
  }
  const docIndex = Object.fromEntries(data.documents.map((d, i) => [d.id, i]));
  const order = (f) => docIndex[f.document_id] * 1e6 + f.page * 1e3 + f.y * 100 + f.x;
  $('[data-next]').onclick = nextField;

  /* markup */
  let markup = null;
  if (envelope.allow_markup) {
    markup = new Markup(pages, {
      items: data.annotations,
      canEdit: (a) => !a.id && a.author_id === recipient.id,
      author: { type: 'recipient', id: recipient.id, name: recipient.name },
    });
    const bar = markupToolbar(markup);
    $('[data-bar]').append(bar);
    $('[data-toggle-markup]').onclick = () => {
      if (!consented) return toast('Please agree to use electronic signatures first.');
      const open = $('[data-bar]').hidden;
      $('[data-bar]').hidden = !open;
      $('[data-toggle-markup]').textContent = open ? 'Done marking up' : '✎ Mark up / comment';
      if (!open) bar.reset();
    };
  } else {
    new Markup(pages, { items: data.annotations, author: { type: 'recipient', id: recipient.id, name: recipient.name } });
  }

  /* finish & decline */
  $('[data-finish]').onclick = async (e) => {
    if (!consented) return toast('Please agree to use electronic signatures first.', { type: 'error' });
    const left = remaining();
    if (left.length) {
      toast(`Please complete ${left.length} more required field${left.length === 1 ? '' : 's'}.`, { type: 'error' });
      return nextField();
    }
    const marks = markup ? markup.mine() : [];
    const ok = await confirmDialog({
      title: isApprover ? 'Approve these documents?' : 'Finish signing?',
      message: `${isApprover ? 'Your approval' : 'Your signature'}${marks.length ? ` and ${marks.length} markup item${marks.length === 1 ? '' : 's'}` : ''} will be applied to "${envelope.title}". This can't be undone.`,
      confirmLabel: finishLabel,
    });
    if (!ok) return;
    e.target.disabled = true;
    try {
      const res = await api('POST', `${base}/complete`, { values, signature, initials, annotations: marks });
      document.body.classList.remove('markup-active');
      card('🎉', isApprover ? 'Approved!' : 'You\'re done signing!',
        res.status === 'completed'
          ? 'Everyone has finished. A copy of the completed document is on its way to your inbox.'
          : `Thanks, ${recipient.name}. ${data.owner.name} has been notified. We'll email you the completed copy once everyone has finished.`,
        res.status === 'completed' ? html`<a class="btn primary" href="${base}/download">⬇ Download signed PDF</a>` : '');
    } catch (err) {
      e.target.disabled = false;
      toast(err.message, { type: 'error' });
    }
  };

  $('[data-decline]').onclick = async () => {
    const reason = await confirmDialog({
      title: 'Decline to sign?', danger: true, confirmLabel: 'Decline',
      message: `${data.owner.name} will be notified and the envelope will be cancelled for everyone.`,
      input: { label: 'Reason for declining', required: true, placeholder: 'e.g. The company name is wrong' },
    });
    if (!reason) return;
    await api('POST', `${base}/decline`, { reason });
    card('👋', 'You declined to sign', `${data.owner.name} has been notified.`);
  };

  renderBanner();
  update();
}

load();
