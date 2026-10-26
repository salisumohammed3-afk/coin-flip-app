// Document markup: pen, highlighter, box, line, text and sticky-note comments.
import { el, html, esc, modal, prompt, fmtDate } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 1000;

export const MARKUP_TOOLS = [
  { id: 'pen', label: 'Pen', icon: '✎', color: '#E5484D' },
  { id: 'highlight', label: 'Highlight', icon: '▮', color: '#FFE14D' },
  { id: 'rect', label: 'Box', icon: '▢', color: '#49229D' },
  { id: 'line', label: 'Line / strike', icon: '╱', color: '#E5484D' },
  { id: 'text', label: 'Text', icon: 'T', color: '#49229D' },
  { id: 'note', label: 'Comment', icon: '💬', color: '#FFD84D' },
  { id: 'eraser', label: 'Erase', icon: '⌫' },
];
export const MARKUP_COLORS = ['#E5484D', '#49229D', '#0EA5E9', '#10B981', '#111111', '#FFE14D'];

let localId = 0;

export class Markup {
  /**
   * @param pages     page objects from renderDocuments()
   * @param items     existing annotations
   * @param canEdit   (item) => boolean, whether the current user may erase it
   * @param author    { type, id, name } stamped on new items
   * @param onChange  called after any change
   */
  constructor(pages, { items = [], canEdit = () => false, author, onChange = () => {} }) {
    Object.assign(this, { pages, canEdit, author, onChange });
    this.items = items.map((a) => ({ ...a, _id: a.id || `local${++localId}` }));
    this.tool = null;
    this.color = null;
    this.history = [];
    for (const p of pages) this.#mount(p);
  }

  /** Items created by the current author (what gets saved). */
  mine() {
    return this.items.filter((a) => this.canEdit(a)).map(({ _id, ...rest }) => rest);
  }

  setTool(tool) {
    this.tool = tool;
    const def = MARKUP_TOOLS.find((t) => t.id === tool);
    if (def?.color && !this.colorPinned) this.color = def.color;
    document.body.classList.toggle('markup-active', !!tool);
    document.body.dataset.markupTool = tool || '';
  }

  setColor(color) {
    this.color = color;
    this.colorPinned = true;
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.items = prev;
    this.#drawAll();
    this.onChange();
  }

  #snapshot() {
    this.history.push(this.items.slice());
    if (this.history.length > 50) this.history.shift();
  }

  #add(page, kind, data) {
    this.#snapshot();
    this.items.push({
      _id: `local${++localId}`, document_id: page.docId, page: page.index, kind, data,
      author_type: this.author.type, author_id: this.author.id, author_name: this.author.name, created_at: new Date().toISOString(),
    });
    this.#drawAll();
    this.onChange();
  }

  #mount(page) {
    const H = W / page.aspect;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('markup-svg');
    page.overlay.prepend(svg);
    page.svg = svg;
    page.H = H;
    this.#draw(page);
    this.#bindPointer(page);
  }

  #drawAll() {
    this.pages.forEach((p) => this.#draw(p));
  }

  #draw(page) {
    const { svg, H } = page;
    svg.innerHTML = '';
    // Number comments in document order so they match the certificate.
    const docOrder = [...new Set(this.pages.map((p) => p.docId))];
    const key = (docId, index) => docOrder.indexOf(docId) * 100000 + index;
    let noteNo = this.items.filter((a) => a.kind === 'note' && key(a.document_id, a.page) < key(page.docId, page.index)).length;
    for (const a of this.items.filter((a) => a.document_id === page.docId && a.page === page.index)) {
      const node = this.#shape(a, H, a.kind === 'note' ? ++noteNo : 0);
      if (!node) continue;
      node.dataset.id = a._id;
      if (this.canEdit(a)) node.classList.add('mine');
      svg.append(node);
    }
  }

  #shape(a, H, noteNo) {
    const d = a.data;
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const title = (n, text) => {
      const t = document.createElementNS(NS, 'title');
      t.textContent = text;
      n.append(t);
      return n;
    };
    const by = `${a.author_name || 'You'}${a.created_at ? ` · ${fmtDate(a.created_at)}` : ''}`;
    if (a.kind === 'pen') {
      const pts = d.points.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
      return title(mk('polyline', { points: pts, fill: 'none', stroke: d.color, 'stroke-width': (d.width || 0.003) * W, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }), by);
    }
    if (a.kind === 'highlight') return title(mk('rect', { x: d.x * W, y: d.y * H, width: d.w * W, height: d.h * H, fill: d.color, 'fill-opacity': 0.35 }), by);
    if (a.kind === 'rect') return title(mk('rect', { x: d.x * W, y: d.y * H, width: d.w * W, height: d.h * H, fill: 'none', stroke: d.color, 'stroke-width': (d.width || 0.003) * W }), by);
    if (a.kind === 'line') return title(mk('line', { x1: d.x1 * W, y1: d.y1 * H, x2: d.x2 * W, y2: d.y2 * H, stroke: d.color, 'stroke-width': (d.width || 0.003) * W, 'stroke-linecap': 'round' }), by);
    if (a.kind === 'text') {
      const size = (d.size || 0.018) * H;
      const t = mk('text', { x: d.x * W, y: d.y * H, fill: d.color, 'font-size': size, 'font-family': 'Helvetica, Arial, sans-serif' });
      String(d.text).split('\n').forEach((line, i) => {
        const span = mk('tspan', { x: d.x * W, dy: i === 0 ? size * 0.95 : size * 1.15 });
        span.textContent = line;
        t.append(span);
      });
      return title(t, by);
    }
    if (a.kind === 'note') {
      const s = 0.022 * W;
      const g = mk('g', { class: 'note', transform: `translate(${d.x * W} ${d.y * H})` });
      g.append(mk('rect', { width: s, height: s, rx: 3, fill: '#FFD84D', stroke: '#B8860B', 'stroke-width': 1.2 }));
      const n = mk('text', { x: s / 2, y: s * 0.72, 'text-anchor': 'middle', 'font-size': s * 0.62, 'font-weight': 700, fill: '#5A4100', 'font-family': 'Helvetica, Arial, sans-serif' });
      n.textContent = noteNo;
      g.append(n);
      g.addEventListener('click', (e) => {
        if (this.tool) return;
        e.stopPropagation();
        modal({
          title: `Comment #${noteNo}`,
          render: (body) => { body.innerHTML = html`<p class="note-text">${d.text}</p><p class="muted small">${by}</p>`; },
        });
      });
      return title(g, `${d.text}\n— ${by}`);
    }
    return null;
  }

  #bindPointer(page) {
    const { svg } = page;
    let active = null;
    const pos = (e) => {
      const r = svg.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    svg.addEventListener('pointerdown', async (e) => {
      if (!this.tool) return;
      e.preventDefault();
      const [x, y] = pos(e);
      const color = this.color || '#E5484D';
      if (this.tool === 'eraser') {
        const id = e.target.closest('[data-id]')?.dataset.id;
        const item = this.items.find((a) => a._id === id);
        if (item && this.canEdit(item)) {
          this.#snapshot();
          this.items = this.items.filter((a) => a !== item);
          this.#drawAll();
          this.onChange();
        }
        return;
      }
      if (this.tool === 'text') {
        const text = await prompt({ title: 'Add text', label: 'Text to place on the page', multiline: true, confirmLabel: 'Place text' });
        if (text?.trim()) this.#add(page, 'text', { x, y, text: text.trim(), color, size: 0.018 });
        return;
      }
      if (this.tool === 'note') {
        const text = await prompt({ title: 'Add a comment', label: 'Your comment (shown as a numbered note and listed on the certificate)', multiline: true, confirmLabel: 'Add comment' });
        if (text?.trim()) this.#add(page, 'note', { x: Math.min(x, 0.97), y: Math.min(y, 0.97), text: text.trim(), color: '#FFD84D' });
        return;
      }
      svg.setPointerCapture(e.pointerId);
      active = { start: [x, y], points: [[x, y]], preview: null };
      const H = page.H;
      const stroke = this.tool === 'pen' ? 0.003 : 0.0025;
      if (this.tool === 'pen') {
        active.preview = document.createElementNS(NS, 'polyline');
        Object.entries({ fill: 'none', stroke: color, 'stroke-width': stroke * W, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => active.preview.setAttribute(k, v));
      } else if (this.tool === 'line') {
        active.preview = document.createElementNS(NS, 'line');
        Object.entries({ stroke: color, 'stroke-width': stroke * W, 'stroke-linecap': 'round' }).forEach(([k, v]) => active.preview.setAttribute(k, v));
      } else {
        active.preview = document.createElementNS(NS, 'rect');
        if (this.tool === 'highlight') { active.preview.setAttribute('fill', color); active.preview.setAttribute('fill-opacity', 0.35); }
        else { active.preview.setAttribute('fill', 'none'); active.preview.setAttribute('stroke', color); active.preview.setAttribute('stroke-width', stroke * W); }
      }
      active.H = H;
      active.color = color;
      active.stroke = stroke;
      svg.append(active.preview);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!active) return;
      const [x, y] = pos(e);
      const H = active.H;
      if (this.tool === 'pen') {
        active.points.push([+x.toFixed(4), +y.toFixed(4)]);
        active.preview.setAttribute('points', active.points.map(([px, py]) => `${px * W},${py * H}`).join(' '));
      } else if (this.tool === 'line') {
        const [sx, sy] = active.start;
        Object.entries({ x1: sx * W, y1: sy * H, x2: x * W, y2: y * H }).forEach(([k, v]) => active.preview.setAttribute(k, v));
        active.end = [x, y];
      } else {
        const [sx, sy] = active.start;
        active.box = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
        Object.entries({ x: active.box.x * W, y: active.box.y * H, width: active.box.w * W, height: active.box.h * H }).forEach(([k, v]) => active.preview.setAttribute(k, v));
      }
    });
    const finish = () => {
      if (!active) return;
      const a = active;
      active = null;
      a.preview.remove();
      if (this.tool === 'pen' && a.points.length > 1) this.#add(page, 'pen', { points: simplify(a.points), color: a.color, width: a.stroke });
      else if (this.tool === 'line' && a.end && Math.hypot(a.end[0] - a.start[0], a.end[1] - a.start[1]) > 0.005) {
        this.#add(page, 'line', { x1: a.start[0], y1: a.start[1], x2: a.end[0], y2: a.end[1], color: a.color, width: a.stroke });
      } else if ((this.tool === 'highlight' || this.tool === 'rect') && a.box && a.box.w > 0.004 && a.box.h > 0.003) {
        this.#add(page, this.tool, { ...roundBox(a.box), color: a.color, width: a.stroke });
      }
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
  }
}

const roundBox = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, +v.toFixed(4)]));

// Drop points closer than ~1px apart to keep stored strokes small.
function simplify(points) {
  const out = [points[0]];
  for (const p of points.slice(1)) {
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.0015) out.push(p);
  }
  if (out.length === 1) out.push(points[points.length - 1]);
  return out.slice(0, 2000);
}

/** Toolbar with markup tools, colours and undo. */
export function markupToolbar(markup, { onToolChange } = {}) {
  const bar = el(html`<div class="markup-bar" role="toolbar" aria-label="Markup tools">
    ${MARKUP_TOOLS.map((t) => html`<button class="tool" data-tool="${t.id}" title="${t.label}" aria-pressed="false"><span>${t.icon}</span><small>${t.label}</small></button>`).map((s) => ({ __raw: s }))}
    <span class="bar-sep"></span>
    ${MARKUP_COLORS.map((c) => html`<button class="swatch" data-color="${c}" style="--c:${c}" title="Colour ${c}" aria-label="Colour ${c}"></button>`).map((s) => ({ __raw: s }))}
    <span class="bar-sep"></span>
    <button class="tool" data-undo title="Undo"><span>↶</span><small>Undo</small></button>
  </div>`);
  bar.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]');
    const c = e.target.closest('[data-color]');
    if (e.target.closest('[data-undo]')) return markup.undo();
    if (c) {
      markup.setColor(c.dataset.color);
      bar.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === c));
      return;
    }
    if (t) {
      const next = markup.tool === t.dataset.tool ? null : t.dataset.tool;
      markup.setTool(next);
      bar.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === next)));
      onToolChange?.(next);
    }
  });
  bar.reset = () => {
    markup.setTool(null);
    bar.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  };
  return bar;
}

export { esc };
