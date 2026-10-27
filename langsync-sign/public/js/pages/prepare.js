// Step 2: place signing fields for each recipient and mark up the documents.
import { api, html, raw, el, toast, debounce, ROLE_LABEL, initials } from '../ui.js';
import { go, state } from '../app.js';
import { renderDocuments, findPage, placeBox, coversText, FIELD_TYPES, FIELD_GROUPS } from '../viewer.js';
import { Markup, markupToolbar } from '../markup.js';
import { stepsBar } from './edit.js';
import { icon } from '../icons.js';

const REF_WIDTH = 816; // default field sizes are in px on a US Letter page at 96dpi
let seq = 0;

export async function renderPrepare(view, id) {
  let env = await api('GET', `/api/envelopes/${id}`);
  if (!env.is_template && env.status !== 'draft') return go(`envelopes/${id}`);
  if (!env.documents.length) return go(`envelopes/${id}/edit`);
  const signers = env.recipients.filter((r) => r.role !== 'cc');
  if (!signers.length) return go(`envelopes/${id}/edit`);

  let fields = env.fields.map((f) => ({ ...f, _id: `f${++seq}` }));
  let current = signers[0].id;
  let selected = null;
  let armed = null;

  view.innerHTML = html`
    <div class="topbar">
      <div><div class="t-title">${env.title}</div><div class="save-state" data-saved>All changes saved</div></div>
      <div class="spacer"></div>${raw(stepsBar(env, 'prepare'))}<div class="spacer"></div>
      <button class="btn ghost" data-back>${raw(icon('arrowLeft', 17))}Back</button><button class="btn primary" data-next>Next${raw(icon('arrowRight', 17))}</button>
    </div>
    <div class="stage-wrap">
      <aside class="palette">
        <div class="mode-switch"><button class="on" data-mode="fields">Fields</button><button data-mode="markup">Markup</button></div>
        <div data-pane="fields">
          <div class="fields-head"><h2>Fields</h2><button class="icon-btn" data-search-toggle title="Search fields" aria-label="Search fields">${raw(icon('search', 20))}</button></div>
          <label class="search-box" data-search hidden>${raw(icon('search', 15))}<input type="search" placeholder="Search fields" aria-label="Search fields"></label>
          <div class="rcp-picker">
            <button class="rcp-pill" data-rcp-toggle aria-haspopup="listbox"></button>
            <div class="rcp-menu" data-rcp-menu role="listbox" hidden>${raw(signers.map((r) => html`<button class="rcp-menu-item" role="option" style="--c:${r.color}" data-rcp="${r.id}"><span class="rcp-av">${initials(r.name) || '?'}</span><span><div>${r.name || 'Unnamed'}</div><div class="muted small">${ROLE_LABEL[r.role]}</div></span></button>`).join(''))}</div>
          </div>
          <div class="pal-divider"></div>
          <div data-palette>${raw(FIELD_GROUPS.map(([group, types]) => html`<section class="pal-group" data-group><h4>${group}</h4><div class="pal-grid">${raw(types.map((type) => {
            const t = FIELD_TYPES[type];
            return html`<button class="pal-item" data-type="${type}" data-label="${t.label.toLowerCase()}" title="Drag onto the page, or click then click the page"><span class="ic">${raw(t.svg ? icon(t.svg, 16) : `<b>${t.icon}</b>`)}</span><span class="pl">${t.label}</span></button>`;
          }).join(''))}</div></section>`).join(''))}</div>
          <p class="muted small">Drag a field onto the page, or click it and then click where it goes. Drag to move, use the corner to resize, Delete to remove.</p>
        </div>
        <div data-pane="markup" hidden>
          <p class="muted small" style="margin-top:0">Annotate the documents before sending. Markup is shown to recipients and flattened into the final PDF.</p>
          <div data-markupbar></div>
        </div>
      </aside>
      <div class="stage"><div class="docs" data-docs><div class="empty">Loading documents…</div></div></div>
      <aside class="props" data-props></aside>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const savedLabel = (t) => ($('[data-saved]').textContent = t);
  const recipientById = (rid) => env.recipients.find((r) => r.id === rid);

  const pages = await renderDocuments($('[data-docs]'), env.documents, (d) => `/api/envelopes/${env.id}/documents/${d.id}/file`);

  /* ---------------- saving ---------------- */
  let saving = Promise.resolve();
  const saveFields = debounce(() => {
    saving = saving.then(async () => {
      savedLabel('Saving…');
      await api('PUT', `/api/envelopes/${env.id}/fields`, fields.map(({ _id, id, value, filled_at, ...f }) => f));
      savedLabel('All changes saved ✓');
    }).catch((err) => { savedLabel('Not saved'); toast(err.message, { type: 'error' }); });
    return saving;
  }, 500);
  const saveMarkup = debounce(() => {
    saving = saving.then(async () => {
      savedLabel('Saving…');
      await api('PUT', `/api/envelopes/${env.id}/annotations`, markup.mine());
      savedLabel('All changes saved ✓');
    }).catch((err) => { savedLabel('Not saved'); toast(err.message, { type: 'error' }); });
    return saving;
  }, 500);

  /* ---------------- markup ---------------- */
  const markup = new Markup(pages, {
    items: env.annotations,
    canEdit: (a) => a.author_type === 'sender',
    author: { type: 'sender', id: state.user.id, name: state.user.name },
    onChange: () => {
      saveMarkup();
      if (!selected) renderProps();
    },
  });
  const bar = markupToolbar(markup);
  $('[data-markupbar]').append(bar);
  view.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    view.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
    $('[data-pane=fields]').hidden = b.dataset.mode !== 'fields';
    $('[data-pane=markup]').hidden = b.dataset.mode !== 'markup';
    if (b.dataset.mode === 'fields') bar.reset();
    else select(null);
  }));
  state.cleanup.push(() => bar.reset());

  /* ---------------- fields ---------------- */
  const label = (f) => {
    if (f.type === 'radio') return f.options?.[0] || 'Option';
    if (['text', 'dropdown', 'date'].includes(f.type) && f.label) return `${FIELD_TYPES[f.type].label}: ${f.label}`;
    return FIELD_TYPES[f.type].label;
  };
  const NOT_REQUIRABLE = ['signature', 'date_signed', 'email', 'approve', 'decline'];

  function drawField(f) {
    const page = findPage(pages, f.document_id, f.page);
    if (!page) return;
    let node = page.overlay.querySelector(`[data-fid="${f._id}"]`);
    const r = recipientById(f.recipient_id);
    if (!node) {
      node = el(html`<div class="fld edit" data-fid="${f._id}" tabindex="0"><span class="fl"></span><span class="rz"></span></div>`);
      page.overlay.append(node);
      bindField(node, f, page);
    }
    node.style.setProperty('--c', r?.color || '#8B36FE');
    node.title = `${label(f)}, ${r?.name || ''}`;
    markOverlap(node, f, page);
    node.querySelector('.fl').innerHTML = html`${['checkbox', 'radio'].includes(f.type) ? '' : label(f)}${raw(f.required && !['checkbox', 'radio'].includes(f.type) && !NOT_REQUIRABLE.includes(f.type) ? '<span class="req">*</span>' : '')}`;
    node.dataset.type = f.type;
    node.classList.toggle('sel', selected === f);
    placeBox(node, f);
  }
  // Flags a box that sits on top of the document's own text, which would print over it.
  function markOverlap(node, f, page) {
    const over = coversText(page, f);
    node.classList.toggle('overlap', over);
    node.title = node.title.replace(/\. Covers text on the page.*$/, '') + (over ? '. Covers text on the page, move it into a blank space.' : '');
  }
  const drawAll = () => {
    view.querySelectorAll('.fld').forEach((n) => n.remove());
    fields.forEach(drawField);
  };

  function bindField(node, f, page) {
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(f);
      node.focus();
      const resizing = e.target.classList.contains('rz');
      const rect = page.overlay.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, f: { ...f } };
      node.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / rect.width;
        const dy = (ev.clientY - start.y) / rect.height;
        if (resizing) {
          f.w = clamp(start.f.w + dx, 0.012, 1 - f.x);
          f.h = clamp(start.f.h + dy, 0.01, 1 - f.y);
        } else {
          f.x = clamp(start.f.x + dx, 0, 1 - f.w);
          f.y = clamp(start.f.y + dy, 0, 1 - f.h);
        }
        placeBox(node, f);
        markOverlap(node, f, page);
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        if (f.x !== start.f.x || f.y !== start.f.y || f.w !== start.f.w || f.h !== start.f.h) saveFields();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    });
  }

  function addField(type, page, fx, fy) {
    const def = FIELD_TYPES[type];
    const w = def.w / REF_WIDTH;
    const h = (def.h * page.aspect) / REF_WIDTH;
    const f = {
      _id: `f${++seq}`, type, document_id: page.docId, page: page.index, recipient_id: current,
      x: clamp(fx, 0, 1 - w), y: clamp(fy, 0, 1 - h), w, h, required: !['checkbox', 'radio', 'approve', 'decline'].includes(type), label: '', options: null,
    };
    if (type === 'dropdown') f.options = ['Option 1', 'Option 2'];
    if (type === 'radio') {
      // New radio buttons join this recipient's most recent group, like adding another option.
      const last = [...fields].reverse().find((x) => x.type === 'radio' && x.recipient_id === current);
      f.label = last?.label || 'Choice 1';
      const n = fields.filter((x) => x.type === 'radio' && x.recipient_id === current && x.label === f.label).length;
      f.options = [`Option ${n + 1}`];
    }
    fields.push(f);
    drawField(f);
    select(f);
    saveFields();
  }

  function select(f) {
    selected = f;
    view.querySelectorAll('.fld').forEach((n) => n.classList.toggle('sel', f && n.dataset.fid === f._id));
    renderProps();
  }

  function removeField(f) {
    fields = fields.filter((x) => x !== f);
    view.querySelector(`[data-fid="${f._id}"]`)?.remove();
    select(null);
    saveFields();
  }

  function renderProps() {
    const props = $('[data-props]');
    if (!selected) {
      const counts = signers.map((r) => {
        const mine = fields.filter((f) => f.recipient_id === r.id);
        const hasSig = mine.some((f) => f.type === 'signature');
        return html`<div class="rcp-opt" style="--c:${r.color};cursor:default"><span class="sw"></span><span style="flex:1"><div>${r.name}</div>
          <div class="muted small">${mine.length} field${mine.length === 1 ? '' : 's'}${raw(r.role === 'signer' && !hasSig ? ', <span style="color:var(--ls-bad)">needs a signature</span>' : '')}</div></span></div>`;
      }).join('');
      const marks = markup.mine().length;
      props.innerHTML = html`<h3>Summary</h3><div class="rcp-select">${raw(counts)}</div>
        <p class="muted small" style="margin-top:14px">${marks} markup item${marks === 1 ? '' : 's'} added.</p>
        <div class="callout small" style="margin-top:14px">${raw(icon('sparkles', 16))}<span>Select a field to change who fills it, whether it's required, or its label.</span></div>`;
      return;
    }
    const f = selected;
    props.innerHTML = html`<h3>${FIELD_TYPES[f.type].label} field</h3>
      <label class="field"><span>Recipient</span><select data-p="recipient">${raw(signers.map((r) => html`<option value="${r.id}" ${r.id === f.recipient_id ? 'selected' : ''}>${r.name}</option>`).join(''))}</select></label>
      ${raw(NOT_REQUIRABLE.includes(f.type) ? '' : html`<label class="check"><input type="checkbox" data-p="required" ${f.required ? 'checked' : ''}><span>${f.type === 'radio' ? 'Require a choice in this group' : 'Required'}</span></label>`)}
      ${raw(['text', 'company', 'title', 'full_name', 'checkbox', 'dropdown', 'date', 'stamp'].includes(f.type) ? html`<label class="field"><span>Label / tooltip</span><input type="text" data-p="label" value="${f.label}" maxlength="120" placeholder="${f.type === 'checkbox' ? 'e.g. I agree to the terms' : f.type === 'stamp' ? 'e.g. Company seal' : 'e.g. Company number'}"></label>` : '')}
      ${raw(f.type === 'dropdown' ? html`<label class="field"><span>Options <span class="hint">(one per line)</span></span><textarea rows="5" data-p="options">${(f.options || []).join('\n')}</textarea></label>` : '')}
      ${raw(f.type === 'radio' ? html`<label class="field"><span>Group name <span class="hint">(one choice per group)</span></span><input type="text" data-p="label" value="${f.label}" maxlength="120"></label><label class="field"><span>This option</span><input type="text" data-p="option" value="${f.options?.[0] || ''}" maxlength="100"></label><button class="btn ghost small" data-add-option>${raw(icon('plus', 15))}Add another option</button>` : '')}
      <div class="actions-row"><button class="btn ghost small" data-dup>Duplicate</button><button class="btn ghost small danger-text" data-del>Delete</button></div>
      <p class="muted small" style="margin-top:14px">${HELP[f.type] || ''}</p>`;
    props.querySelector('[data-p=options]')?.addEventListener('input', (e) => { f.options = e.target.value.split('\n').map((o) => o.trim()).filter(Boolean); drawField(f); saveFields(); });
    props.querySelector('[data-p=option]')?.addEventListener('input', (e) => { f.options = [e.target.value]; drawField(f); saveFields(); });
    props.querySelector('[data-add-option]')?.addEventListener('click', () => {
      const n = fields.filter((x) => x.type === 'radio' && x.recipient_id === f.recipient_id && x.label === f.label).length;
      const copy = { ...f, _id: `f${++seq}`, options: [`Option ${n + 1}`], y: clamp(f.y + f.h * 1.8, 0, 1 - f.h) };
      fields.push(copy);
      drawField(copy);
      select(copy);
      saveFields();
    });
    props.querySelector('[data-p=recipient]').onchange = (e) => { f.recipient_id = e.target.value; drawField(f); saveFields(); };
    props.querySelector('[data-p=required]')?.addEventListener('change', (e) => { f.required = e.target.checked; drawField(f); saveFields(); });
    props.querySelector('[data-p=label]')?.addEventListener('input', (e) => { f.label = e.target.value; drawField(f); saveFields(); });
    props.querySelector('[data-del]').onclick = () => removeField(f);
    props.querySelector('[data-dup]').onclick = () => {
      const copy = { ...f, _id: `f${++seq}`, y: clamp(f.y + f.h + 0.01, 0, 1 - f.h) };
      fields.push(copy);
      drawField(copy);
      select(copy);
      saveFields();
    };
  }

  /* ---------------- palette: drag or click-to-place ---------------- */
  const menu = $('[data-rcp-menu]');
  const pill = $('[data-rcp-toggle]');
  const renderPill = () => {
    const r = recipientById(current);
    pill.style.setProperty('--c', r.color);
    pill.innerHTML = html`<span class="rcp-av">${initials(r.name) || '?'}</span><span class="rcp-name">${r.name || 'Unnamed'}</span>${raw(icon('chevronDown', 18))}`;
    view.querySelectorAll('.pal-item').forEach((p) => p.style.setProperty('--c', r.color));
    menu.querySelectorAll('[data-rcp]').forEach((x) => x.classList.toggle('on', x.dataset.rcp === current));
  };
  pill.onclick = () => (menu.hidden = !menu.hidden);
  menu.querySelectorAll('[data-rcp]').forEach((b) => (b.onclick = () => {
    current = b.dataset.rcp;
    menu.hidden = true;
    renderPill();
  }));
  const closeMenu = (e) => { if (!e.target.closest('.rcp-picker')) menu.hidden = true; };
  document.addEventListener('pointerdown', closeMenu);
  state.cleanup.push(() => document.removeEventListener('pointerdown', closeMenu));
  renderPill();

  // Field search, like DocuSign's magnifier in the panel header.
  $('[data-search-toggle]').onclick = () => {
    const box = $('[data-search]');
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector('input').focus();
  };
  $('[data-search] input').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    view.querySelectorAll('.pal-item').forEach((p) => (p.hidden = q && !p.dataset.label.includes(q)));
    view.querySelectorAll('[data-group]').forEach((g) => (g.hidden = ![...g.querySelectorAll('.pal-item')].some((p) => !p.hidden)));
  };

  const pageAt = (x, y) => {
    const node = document.elementsFromPoint(x, y).find((n) => n.classList?.contains('page'));
    return node && pages.find((p) => p.el === node);
  };

  view.querySelectorAll('.pal-item').forEach((item) => {
    item.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const type = item.dataset.type;
      const start = { x: e.clientX, y: e.clientY };
      let ghost = null;
      const move = (ev) => {
        if (!ghost && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        if (!ghost) {
          ghost = el(html`<div class="ghost-field" style="--c:${recipientById(current).color}">${FIELD_TYPES[type].label}</div>`);
          document.body.append(ghost);
        }
        const page = pageAt(ev.clientX, ev.clientY);
        const scale = page ? page.el.clientWidth / REF_WIDTH : 1;
        ghost.style.width = `${FIELD_TYPES[type].w * scale}px`;
        ghost.style.height = `${FIELD_TYPES[type].h * scale}px`;
        ghost.style.left = `${ev.clientX - 8}px`;
        ghost.style.top = `${ev.clientY - 8}px`;
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!ghost) {
          // A click: arm the field type and place it on the next page click.
          armed = armed === type ? null : type;
          view.querySelectorAll('.pal-item').forEach((p) => p.classList.toggle('armed', p.dataset.type === armed));
          return;
        }
        ghost.remove();
        const page = pageAt(ev.clientX, ev.clientY);
        if (!page) return;
        const r = page.overlay.getBoundingClientRect();
        addField(type, page, (ev.clientX - 8 - r.left) / r.width, (ev.clientY - 8 - r.top) / r.height);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });

  pages.forEach((page) => {
    page.overlay.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fld') || markup.tool) return;
      if (armed) {
        const r = page.overlay.getBoundingClientRect();
        addField(armed, page, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        armed = null;
        view.querySelectorAll('.pal-item').forEach((p) => p.classList.remove('armed'));
      } else select(null);
    });
  });

  const onKey = (e) => {
    if (!selected || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeField(selected); }
    if (e.key === 'Escape') select(null);
    const step = e.shiftKey ? 0.01 : 0.002;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key]) {
      e.preventDefault();
      selected.x = clamp(selected.x + arrows[e.key][0], 0, 1 - selected.w);
      selected.y = clamp(selected.y + arrows[e.key][1], 0, 1 - selected.h);
      drawField(selected);
      saveFields();
    }
  };
  document.addEventListener('keydown', onKey);
  state.cleanup.push(() => document.removeEventListener('keydown', onKey));

  drawAll();
  // Re-check boxes once each page's text positions are known.
  pages.forEach((p) => p.textReady.then(() => fields.filter((f) => f.document_id === p.docId && f.page === p.index).forEach(drawField)));
  renderProps();

  /* ---------------- navigation ---------------- */
  const flush = async () => {
    await saveFields.flush();
    await saveMarkup.flush();
    await saving;
  };
  $('[data-back]').onclick = async () => { await flush(); go(`envelopes/${env.id}/edit`); };
  $('[data-next]').onclick = async () => {
    await flush();
    const missing = signers.filter((r) => r.role === 'signer' && !fields.some((f) => f.recipient_id === r.id && f.type === 'signature'));
    if (missing.length) return toast(`Add a signature field for ${missing.map((r) => r.name).join(', ')}.`, { type: 'error' });
    go(`envelopes/${env.id}/review`);
  };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const HELP = {
  date_signed: 'Filled in automatically with the date the recipient signs.',
  email: "Filled in automatically with the recipient's email.",
  full_name: "Pre-filled with the recipient's name.",
  date: 'The recipient picks a date from a calendar.',
  dropdown: 'The recipient chooses one of these options.',
  radio: 'Radio buttons with the same group name act as one question: the recipient can pick only one.',
  approve: 'A button that approves and completes the document for this recipient, without needing a signature.',
  decline: 'A button that lets the recipient decline. Declining cancels the envelope and notifies you.',
  stamp: 'The recipient uploads an image of their company stamp or seal, which is placed here.',
};
