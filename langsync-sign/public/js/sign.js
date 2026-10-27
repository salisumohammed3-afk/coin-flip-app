// Recipient experience: access code, e-sign consent, guided signing, markup, decline.
import { api, html, raw, el, toast, fmtDate, modal, confirmDialog, ROLE_LABEL } from './ui.js';
import { renderDocuments, findPage, placeBox, FIELD_TYPES } from './viewer.js';
import { Markup, markupToolbar } from './markup.js';
import { adoptSignature } from './signature.js';
import { icon } from './icons.js';

const LOCKUP = '<img class="lockup" src="/img/lockup.png" alt="LangSync" style="height:26px">';

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
    return card('alert', 'This link is not valid', err.message, '', 'bad');
  }
  document.title = `${data.envelope.title} · LangSync Sign`;
  if (data.needsCode) return renderCode(data);
  if (new URLSearchParams(location.search).get('download') === '1' && data.mode === 'completed') location.href = `${base}/download`;

  const { mode, envelope, owner, recipient } = data;
  if (mode === 'closed') {
    const what = envelope.status === 'voided' ? `was voided by ${owner.name}${envelope.void_reason ? `: “${envelope.void_reason}”` : '.'}` : envelope.status === 'expired' ? 'has expired.' : envelope.status === 'declined' ? 'was declined by a recipient and is no longer active.' : 'is no longer active.';
    return card('ban', 'No action needed', `"${envelope.title}" ${what}`, '', 'warn');
  }
  if (mode === 'waiting') {
    return card('clock', 'It\'s not your turn yet', `"${envelope.title}" needs to be completed by other recipients first. We'll email you as soon as it's ready for you.`);
  }
  if (mode === 'sign') return renderSigning(data);
  return renderReadOnly(data);
}

function card(ic, title, text, extra = '', tone = '') {
  app.innerHTML = html`<div class="sign-top">${raw(LOCKUP)}<span class="badge">Sign</span></div>
    <div class="center-wrap field-texture"><div class="card center-card rise"><span class="tile tile-lg ${tone ? `tile-${tone}` : 'tile-grad'}">${raw(icon(ic, 24))}</span><h1>${title}</h1><p class="muted">${text}</p>${raw(extra)}</div></div>`;
}

function renderCode(data) {
  card('lock', 'Enter your access code', `${data.owner.name} protected "${data.envelope.title}" with an access code. They should have shared it with you separately.`,
    html`<form data-code style="margin-top:16px"><input type="text" name="code" autocomplete="one-time-code" placeholder="Access code" style="text-align:center;font-size:18px;max-width:240px"><div class="err"></div><button class="btn primary">Continue</button></form>`);
  const form = app.querySelector('[data-code]');
  form.querySelector('input').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', `${base}/access`, { code: form.code.value });
      /* ------------------------------- helpers -------------------------------- */

// DocuSign-style frame around an adopted signature.
const signedFrame = (img) => html`<div class="signed-frame"><span class="sf-label">Signed by:</span><img src="${img}" alt="Signature"></div>`;

function pickStamp() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg' });
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 600 / Math.max(img.width, img.height));
        const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { toast('That image could not be read.', { type: 'error' }); resolve(null); };
      img.src = URL.createObjectURL(file);
    };
    input.click();
  });
}

function downloadDocs(data) {
  if (data.envelope.has_final) return (location.href = `${base}/download`);
  for (const d of data.documents) window.open(`${base}/documents/${d.id}?download=1`, '_blank', 'noopener');
}

async function printPages(pages) {
  toast('Preparing pages for printing…');
  await Promise.all(pages.map((p) => p.el.__render(true)));
  window.print();
}

function showPages(pages, documents) {
  modal({
    title: 'Pages',
    render(body, close) {
      body.innerHTML = documents.map((d) => html`<h3 style="margin:8px 0">${d.name}</h3><div class="page-list">${raw(
        pages.filter((p) => p.docId === d.id).map((p) => html`<button class="btn ghost small" data-go="${pages.indexOf(p)}">Page ${p.index + 1}</button>`).join('')
      )}</div>`).join('');
      body.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
        pages[Number(b.dataset.go)].el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        close();
      }));
    },
  });
}

load();
    } catch (err) {
      form.querySelector('.err').textContent = err.message;
    }
  };
}

function header(data, right = '') {
  return html`<div class="sign-top">${raw(LOCKUP)}<span class="divider"></span>
    <div><div class="title">${data.envelope.title}</div><div class="from">From ${data.owner.name} · ${data.owner.email}</div></div>
    <div class="spacer"></div>${raw(right)}</div>`;
}

/* ------------------------------- read only ------------------------------- */

async function renderReadOnly(data) {
  const { mode, envelope, recipient } = data;
  const banner = mode === 'completed'
    ? html`<strong>Completed ${fmtDate(envelope.completed_at)}.</strong> All parties have finished. Download the signed copy with its certificate of completion.`
    : mode === 'done'
      ? html`<strong>You're done.</strong> Thanks, ${recipient.name}. We'll email everyone the completed copy once all parties have finished.`
      : html`<strong>You're receiving a copy.</strong> ${data.owner.name} added you as a CC, so there's nothing to sign. You'll get the completed copy by email.`;
  app.innerHTML = html`${raw(header(data, envelope.status === 'completed' ? html`<a class="btn primary" href="${base}/download">${raw(icon('download', 17))}Download signed PDF</a>` : ''))}
    <div class="sign-banner"><span class="tile ${mode === 'view' ? '' : 'tile-good'}">${raw(icon(mode === 'view' ? 'mail' : 'checkCircle', 18))}</span><p>${raw(banner)}</p></div>
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
    if (f.image) node.innerHTML = f.type === 'signature' ? signedFrame(f.image) : html`<img src="${f.image}" alt="">`;
    else if (f.type === 'checkbox') node.innerHTML = html`<span class="val">${f.value === 'true' ? '☑' : '☐'}</span>`;
    else if (f.type === 'radio') node.innerHTML = html`<span class="val">${f.value === 'true' ? '◉' : '○'}</span>`;
    else if (f.type === 'approve') node.innerHTML = f.value ? '<span class="approved-tag">APPROVED</span>' : '';
    else if (f.type === 'decline') node.innerHTML = '';
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
      <div class="split">
        <button class="btn primary" data-finish>${finishLabel}</button><button class="btn primary split-caret" data-menu-toggle aria-label="More options" aria-haspopup="menu">${raw(icon('chevronDown', 16))}</button>
        <div class="menu" data-menu role="menu" hidden>
          <button role="menuitem" data-later>${raw(icon('clock', 16))}Finish later</button>
          <button role="menuitem" data-decline>${raw(icon('xCircle', 16))}Decline to sign</button>
          <button role="menuitem" data-dl>${raw(icon('download', 16))}Download documents</button>
          <button role="menuitem" data-print>${raw(icon('printer', 16))}Print</button>
        </div>
      </div>`))}
    <div class="sign-banner" data-banner></div>
    <div class="sign-stage"><div class="docs" data-docs><div class="empty">Loading documents…</div></div></div>
    <aside class="sign-rail" aria-label="Document tools">
      <button data-pages>${raw(icon('pages', 20))}<span>View pages</span></button>
      <button data-dl>${raw(icon('download', 20))}<span>Download</span></button>
      <button data-print>${raw(icon('printer', 20))}<span>Print</span></button>
      <div class="rail-zoom"><button data-zoom="1" aria-label="Zoom in">${raw(icon('zoomIn', 20))}</button><span data-zoom-label>100%</span><button data-zoom="-1" aria-label="Zoom out">${raw(icon('zoomOut', 20))}</button></div>
    </aside>
    <div class="ready-bar" data-ready hidden>
      <div><h3>Ready to ${finishLabel.toLowerCase()}?</h3><p>You've completed the required fields. Review your work, then select ${finishLabel}.</p></div>
      <button class="btn primary" data-finish-bar>${finishLabel}</button>
    </div>
    <button class="next-btn" data-next hidden>Start</button>
    ${raw(envelope.allow_markup ? `<div class="sign-tools" data-tools><button class="btn ghost small" data-toggle-markup>${icon('pen', 15)}<span>Mark up / comment</span></button><div data-bar hidden></div></div>` : '')}`;
  const $ = (s) => app.querySelector(s);

  const renderBanner = () => {
    const msg = envelope.message ? html`<div class="small" style="margin-bottom:6px"><strong>${data.owner.name}:</strong> <span style="white-space:pre-wrap">${envelope.message}</span></div>` : '';
    if (!consented) {
      $('[data-banner]').innerHTML = html`<div class="txt">${raw(msg)}Please read the <a href="#" data-disclosure>Electronic Record and Signature Disclosure</a>.<br>
        <label class="check" style="margin:8px 0 0"><input type="checkbox" data-agree><span>I agree to use electronic records and signatures.</span></label></div>
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
      $('[data-banner]').innerHTML = html`<div class="txt">${raw(msg)}${isApprover && !myFields.length
        ? 'Review the documents, then click Approve.'
        : html`You're signing as <strong>${recipient.name}</strong> (${ROLE_LABEL[recipient.role].toLowerCase()}). Click each highlighted field, then click ${finishLabel}.`}</div>`;
    }
    document.body.classList.toggle('locked', !consented);
  };

  const pages = await renderDocuments($('[data-docs]'), data.documents, (d) => `${base}/documents/${d.id}`);
  drawReadonlyFields(pages, data.fields);

  const AUTO = ['date_signed', 'email', 'approve', 'decline'];
  const groupOf = (f) => myFields.filter((x) => x.type === 'radio' && (x.label || x.id) === (f.label || f.id));
  const required = (f) => (f.type === 'radio' ? groupOf(f).some((x) => x.required) : f.required && !AUTO.includes(f.type));
  const isFilled = (f) => {
    if (f.type === 'signature') return values[f.id] === 'signed';
    if (f.type === 'initials') return values[f.id] === 'initialed';
    if (f.type === 'checkbox') return values[f.id] === 'true';
    if (f.type === 'radio') return groupOf(f).some((x) => values[x.id] === 'true');
    if (AUTO.includes(f.type)) return true;
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
        ? html`<button class="sigbtn" title="Click to remove">${raw(f.type === 'signature' ? signedFrame(img) : html`<img src="${img}" alt="Your initials">`)}</button>`
        : html`<button class="sigbtn">${raw(icon('pen', 14))}<span>${f.type === 'signature' ? 'Sign' : 'Initial'}</span></button>`;
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
      node.innerHTML = html`<span class="val">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>`;
    } else if (f.type === 'radio') {
      if (!node.querySelector('input')) {
        node.innerHTML = html`<input type="radio" name="grp-${f.label || f.id}" aria-label="${f.label}: ${f.options?.[0] || 'Option'}" title="${f.options?.[0] || ''}">`;
        node.querySelector('input').onchange = () => {
          for (const x of groupOf(f)) values[x.id] = x.id === f.id ? 'true' : 'false';
          groupOf(f).forEach(paintField);
          update();
        };
      }
      node.className = `sfld radio ${isFilled(f) ? 'filled' : required(f) ? 'todo' : 'todo optional'}`;
      node.querySelector('input').checked = values[f.id] === 'true';
    } else if (f.type === 'dropdown') {
      if (!node.querySelector('select')) {
        node.innerHTML = html`<select aria-label="${f.label || 'Choose an option'}"><option value="">${f.label || 'Choose…'}</option>${raw((f.options || []).map((o) => html`<option>${o}</option>`).join(''))}</select>`;
        node.querySelector('select').onchange = (e) => { values[f.id] = e.target.value; paintField(f); update(); };
      }
    } else if (f.type === 'date') {
      if (!node.querySelector('input')) {
        node.innerHTML = html`<input type="date" aria-label="${f.label || 'Date'}">`;
        node.querySelector('input').onchange = (e) => { values[f.id] = e.target.value; paintField(f); update(); };
      }
    } else if (f.type === 'approve') {
      node.className = 'sfld action';
      node.innerHTML = html`<button class="act-btn approve">${raw(icon('check', 15))}Approve</button>`;
      node.querySelector('button').onclick = () => finish();
    } else if (f.type === 'decline') {
      node.className = 'sfld action';
      node.innerHTML = html`<button class="act-btn decline">${raw(icon('ban', 15))}Decline</button>`;
      node.querySelector('button').onclick = () => decline();
    } else if (f.type === 'stamp') {
      node.innerHTML = values[f.id]
        ? html`<button class="sigbtn" title="Click to remove"><img src="${values[f.id]}" alt="Your stamp"></button>`
        : html`<button class="sigbtn">${raw(icon('stamp', 16))}<span>Stamp</span></button>`;
      node.querySelector('button').onclick = async () => {
        if (!consented) return toast('Please agree to use electronic signatures first.');
        if (values[f.id]) { values[f.id] = ''; paintField(f); return update(); }
        const img = await pickStamp();
        if (!img) return;
        values[f.id] = img;
        paintField(f);
        update();
        nextField();
      };
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

  // Radio groups count once, via their first button.
  const remaining = () => myFields.filter((f) => required(f) && !isFilled(f) && (f.type !== 'radio' || groupOf(f)[0] === f));
  function update() {
    const req = myFields.filter(required);
    const left = remaining().length;
    $('[data-progress]').innerHTML = req.length
      ? html`<span class="progress-bar"><span style="width:${Math.round(((req.length - left) / req.length) * 100)}%"></span></span>${req.length - left} of ${req.length} required`
      : '';
    const next = $('[data-next]');
    next.hidden = !consented || !left;
    next.textContent = req.length - left === 0 ? 'Start' : 'Next';
    $('[data-finish]').classList.toggle('accent', consented && !left);
    $('[data-ready]').hidden = !consented || left > 0;
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
      $('[data-toggle-markup] span').textContent = open ? 'Done marking up' : 'Mark up / comment';
      if (!open) bar.reset();
    };
  } else {
    new Markup(pages, { items: data.annotations, author: { type: 'recipient', id: recipient.id, name: recipient.name } });
  }

  /* tools: menu, pages, download, print, zoom */
  const menu = $('[data-menu]');
  $('[data-menu-toggle]').onclick = () => (menu.hidden = !menu.hidden);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.split')) menu.hidden = true; });
  $('[data-later]').onclick = () => {
    menu.hidden = true;
    card('clock', 'Come back any time', `Your progress isn't saved, but "${envelope.title}" stays waiting for you. Use the link in your email to sign it later.`);
  };
  app.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => { menu.hidden = true; downloadDocs(data); }));
  app.querySelectorAll('[data-print]').forEach((b) => (b.onclick = () => { menu.hidden = true; printPages(pages); }));
  $('[data-pages]').onclick = () => showPages(pages, data.documents);
  let zoom = 1;
  app.querySelectorAll('[data-zoom]').forEach((b) => (b.onclick = () => {
    zoom = Math.min(2, Math.max(0.6, +(zoom + Number(b.dataset.zoom) * 0.2).toFixed(1)));
    $('[data-docs]').style.maxWidth = `${880 * zoom}px`;
    $('[data-zoom-label]').textContent = `${Math.round(zoom * 100)}%`;
    window.dispatchEvent(new Event('resize'));
  }));

  /* finish & decline */
  const finish = async (e) => {
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
    const btns = app.querySelectorAll('[data-finish], [data-finish-bar]');
    btns.forEach((b) => (b.disabled = true));
    try {
      const res = await api('POST', `${base}/complete`, { values, signature, initials, annotations: marks });
      document.body.classList.remove('markup-active');
      card('checkCircle', isApprover ? 'Approved' : 'You\'re done signing',
        res.status === 'completed'
          ? 'Everyone has finished. A copy of the completed document is on its way to your inbox.'
          : `Thanks, ${recipient.name}. ${data.owner.name} has been notified. We'll email you the completed copy once everyone has finished.`,
        res.status === 'completed' ? html`<a class="btn primary" href="${base}/download">${raw(icon('download', 17))}Download signed PDF</a>` : '', 'good');
    } catch (err) {
      btns.forEach((b) => (b.disabled = false));
      toast(err.message, { type: 'error' });
    }
  };
  $('[data-finish]').onclick = finish;
  $('[data-finish-bar]').onclick = finish;

  const decline = async () => {
    menu.hidden = true;
    const reason = await confirmDialog({
      title: 'Decline to sign?', danger: true, confirmLabel: 'Decline',
      message: `${data.owner.name} will be notified and the envelope will be cancelled for everyone.`,
      input: { label: 'Reason for declining', required: true, placeholder: 'e.g. The company name is wrong' },
    });
    if (!reason) return;
    await api('POST', `${base}/decline`, { reason });
    card('xCircle', 'You declined to sign', `${data.owner.name} has been notified.`, '', 'bad');
  };
  $('[data-decline]').onclick = decline;

  renderBanner();
  update();
}

/* ------------------------------- helpers -------------------------------- */

// DocuSign-style frame around an adopted signature.
const signedFrame = (img) => html`<div class="signed-frame"><span class="sf-label">Signed by:</span><img src="${img}" alt="Signature"></div>`;

function pickStamp() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg' });
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 600 / Math.max(img.width, img.height));
        const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { toast('That image could not be read.', { type: 'error' }); resolve(null); };
      img.src = URL.createObjectURL(file);
    };
    input.click();
  });
}

function downloadDocs(data) {
  if (data.envelope.has_final) return (location.href = `${base}/download`);
  for (const d of data.documents) window.open(`${base}/documents/${d.id}?download=1`, '_blank', 'noopener');
}

async function printPages(pages) {
  toast('Preparing pages for printing…');
  await Promise.all(pages.map((p) => p.el.__render(true)));
  window.print();
}

function showPages(pages, documents) {
  modal({
    title: 'Pages',
    render(body, close) {
      body.innerHTML = documents.map((d) => html`<h3 style="margin:8px 0">${d.name}</h3><div class="page-list">${raw(
        pages.filter((p) => p.docId === d.id).map((p) => html`<button class="btn ghost small" data-go="${pages.indexOf(p)}">Page ${p.index + 1}</button>`).join('')
      )}</div>`).join('');
      body.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
        pages[Number(b.dataset.go)].el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        close();
      }));
    },
  });
}

load();
