// Renders PDFs page by page with an overlay layer for fields and markup.
// Every position in LangSync Sign is a 0..1 fraction of the displayed page.
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { el, html } from './ui.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

/**
 * @returns {Promise<Array<{docId, index, el, overlay, aspect}>>}
 */
export async function renderDocuments(container, documents, urlFor) {
  container.innerHTML = '';
  const pages = [];
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          entry.target.__render();
        }
      }
    },
    { rootMargin: '600px 0px' }
  );

  for (const doc of documents) {
    const section = el(html`<section class="doc" data-doc="${doc.id}"><header class="doc-head"><span class="doc-icon">PDF</span><span>${doc.name}</span><span class="muted">${doc.page_count} page${doc.page_count === 1 ? '' : 's'}</span></header></section>`);
    container.append(section);
    const pdf = await pdfjsLib.getDocument({ url: urlFor(doc), isEvalSupported: false }).promise;
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const pageEl = el(html`<div class="page" data-doc="${doc.id}" data-page="${i}"><canvas></canvas><div class="page-overlay"></div><div class="page-num">${doc.name}, page ${i + 1} of ${pdf.numPages}</div></div>`);
      pageEl.style.aspectRatio = `${vp.width} / ${vp.height}`;
      section.append(pageEl);
      let renderedWidth = 0;
      pageEl.__render = async () => {
        const width = pageEl.clientWidth;
        if (!width || Math.abs(width - renderedWidth) < 40) return;
        renderedWidth = width;
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const viewport = page.getViewport({ scale: (width * dpr) / vp.width });
        const canvas = pageEl.querySelector('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      };
      observer.observe(pageEl);
      const entry = { docId: doc.id, index: i, el: pageEl, overlay: pageEl.querySelector('.page-overlay'), aspect: vp.width / vp.height, text: [] };
      // Where the page's own words sit, as fractions, so the editor can warn when a box covers them.
      entry.textReady = page.getTextContent().then(({ items }) => {
        entry.text = items.filter((t) => t.str && t.str.trim() && t.width > 0).map((t) => {
          const h = t.height || Math.hypot(t.transform[2], t.transform[3]);
          const [x1, y1, x2, y2] = vp.convertToViewportRectangle([t.transform[4], t.transform[5], t.transform[4] + t.width, t.transform[5] + h]);
          return { x: Math.min(x1, x2) / vp.width, y: Math.min(y1, y2) / vp.height, w: Math.abs(x2 - x1) / vp.width, h: Math.abs(y2 - y1) / vp.height };
        });
      }).catch(() => {});
      pages.push(entry);
    }
  }

  // Sharpen pages after big layout changes (e.g. window resize).
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => pages.forEach((p) => p.el.getBoundingClientRect().top < window.innerHeight * 2 && p.el.__render()), 300);
  });
  return pages;
}

/** True when a field box hides a real share of any word on its page. */
export function coversText(page, f) {
  return (page?.text || []).some((t) => {
    const ix = Math.min(f.x + f.w, t.x + t.w) - Math.max(f.x, t.x);
    const iy = Math.min(f.y + f.h, t.y + t.h) - Math.max(f.y, t.y);
    return ix > 0 && iy > 0 && (ix * iy) / (t.w * t.h) > 0.2;
  });
}

export const findPage = (pages, docId, index) => pages.find((p) => p.docId === docId && p.index === index);

export function placeBox(node, f) {
  node.style.left = `${f.x * 100}%`;
  node.style.top = `${f.y * 100}%`;
  node.style.width = `${f.w * 100}%`;
  node.style.height = `${f.h * 100}%`;
}

// Default sizes are px on a US Letter page at 96dpi (scaled to the real page on drop).
export const FIELD_TYPES = {
  signature: { label: 'Signature', svg: 'pen', w: 170, h: 46 },
  initials: { label: 'Initial', icon: 'AZ', w: 64, h: 40 },
  date_signed: { label: 'Date Signed', svg: 'calendar', w: 120, h: 24 },
  full_name: { label: 'Name', svg: 'user', w: 170, h: 24 },
  email: { label: 'Email', svg: 'mail', w: 190, h: 24 },
  company: { label: 'Company', svg: 'building', w: 170, h: 24 },
  title: { label: 'Title', svg: 'idCard', w: 150, h: 24 },
  text: { label: 'Text', svg: 'type', w: 170, h: 24 },
  checkbox: { label: 'Checkbox', svg: 'squareCheck', w: 20, h: 20 },
  dropdown: { label: 'Dropdown', svg: 'chevronSquare', w: 170, h: 26 },
  radio: { label: 'Radio', svg: 'radio', w: 20, h: 20 },
  date: { label: 'Date', svg: 'calendarPlus', w: 130, h: 26 },
  approve: { label: 'Approve', svg: 'check', w: 110, h: 30 },
  decline: { label: 'Decline', svg: 'ban', w: 110, h: 30 },
  stamp: { label: 'Stamp', svg: 'stamp', w: 120, h: 120 },
};

// Grouped like DocuSign's "Standard Fields" panel.
export const FIELD_GROUPS = [
  ['Signature', ['signature', 'initials', 'date_signed']],
  ['Contact Information', ['full_name', 'email', 'company', 'title']],
  ['Inputs', ['text', 'checkbox', 'dropdown', 'radio', 'date']],
  ['Actions', ['approve', 'decline', 'stamp']],
];
