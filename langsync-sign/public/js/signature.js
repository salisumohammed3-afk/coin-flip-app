// "Adopt your signature" dialog: draw, type (in a handwriting font) or upload.
import { modal, html, initials as toInitials } from './ui.js';

const FONTS = ['Dancing Script', 'Great Vibes', 'Caveat', 'Homemade Apple'];

/** Resolves with { signature, initials } PNG data URLs, or undefined if cancelled. */
export function adoptSignature({ name, need = 'signature' }) {
  return modal({
    title: 'Adopt your signature',
    wide: true,
    render(body, close) {
      body.innerHTML = html`
        <div class="adopt-grid">
          <label class="field"><span>Full name</span><input name="name" type="text" autocomplete="name"></label>
          <label class="field"><span>Initials</span><input name="initials" type="text" maxlength="5"></label>
        </div>
        <div class="tabs" role="tablist">
          <button class="tab on" data-tab="type" role="tab">Type</button>
          <button class="tab" data-tab="draw" role="tab">Draw</button>
          <button class="tab" data-tab="upload" role="tab">Upload</button>
        </div>
        <div class="tab-panel" data-panel="type">
          <div class="font-choices">${FONTS.map((f, i) => html`<label class="font-choice"><input type="radio" name="font" value="${f}" ${i === 0 ? 'checked' : ''}><span class="font-sample" style="font-family:'${f}'" data-sample></span><span class="font-initials" style="font-family:'${f}'" data-isample></span></label>`).map((s) => ({ __raw: s }))}</div>
        </div>
        <div class="tab-panel" data-panel="draw" hidden>
          <div class="draw-pair">
            <div><div class="muted small">Signature</div><canvas class="pad" data-pad="signature" width="900" height="260"></canvas></div>
            <div><div class="muted small">Initials</div><canvas class="pad pad-small" data-pad="initials" width="320" height="260"></canvas></div>
          </div>
          <button class="btn ghost small" data-clear>Clear</button>
        </div>
        <div class="tab-panel" data-panel="upload" hidden>
          <p class="muted">Upload a photo or scan of your signature on white paper (PNG or JPG). Your typed initials will be used for initials fields.</p>
          <input type="file" accept="image/png,image/jpeg" data-upload>
          <div class="upload-preview"></div>
        </div>
        <p class="legal small muted">By selecting Adopt and sign, I agree that the signature and initials will be the electronic representation of my signature and initials for all purposes when I use them on documents, just the same as a pen-and-paper signature.</p>
        <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Adopt and sign</button></div>`;

      const nameInput = body.querySelector('[name=name]');
      const initInput = body.querySelector('[name=initials]');
      nameInput.value = name || '';
      initInput.value = toInitials(name);
      let tab = 'type';
      let uploaded = null;

      const refreshSamples = () => {
        body.querySelectorAll('[data-sample]').forEach((s) => (s.textContent = nameInput.value || 'Your name'));
        body.querySelectorAll('[data-isample]').forEach((s) => (s.textContent = initInput.value || 'YN'));
      };
      nameInput.oninput = () => { initInput.value = toInitials(nameInput.value); refreshSamples(); };
      initInput.oninput = refreshSamples;
      refreshSamples();

      body.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
        tab = b.dataset.tab;
        body.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
        body.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
      }));

      const pads = Object.fromEntries([...body.querySelectorAll('[data-pad]')].map((c) => [c.dataset.pad, drawingPad(c)]));
      body.querySelector('[data-clear]').onclick = () => Object.values(pads).forEach((p) => p.clear());

      body.querySelector('[data-upload]').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const img = await loadImage(URL.createObjectURL(file));
        uploaded = cleanUpload(img);
        body.querySelector('.upload-preview').innerHTML = `<img src="${uploaded}" alt="Uploaded signature preview">`;
      };

      body.querySelector('[data-x]').onclick = () => close(undefined);
      body.querySelector('[data-ok]').onclick = async () => {
        const fullName = nameInput.value.trim();
        const ini = initInput.value.trim();
        let signature, initialsImg;
        if (tab === 'type') {
          if (!fullName) return nameInput.focus();
          const font = body.querySelector('[name=font]:checked').value;
          signature = await typed(fullName, font, 120);
          initialsImg = await typed(ini || toInitials(fullName), font, 120);
        } else if (tab === 'draw') {
          if (need === 'signature' && pads.signature.empty) return flash(pads.signature.canvas);
          if (need === 'initials' && pads.initials.empty) return flash(pads.initials.canvas);
          signature = pads.signature.empty ? null : trim(pads.signature.canvas);
          initialsImg = pads.initials.empty ? await typed(ini || toInitials(fullName), FONTS[0], 120) : trim(pads.initials.canvas);
        } else {
          if (!uploaded) return;
          signature = uploaded;
          initialsImg = await typed(ini || toInitials(fullName), FONTS[0], 120);
        }
        close({ signature, initials: initialsImg });
      };
    },
  });
}

function flash(node) {
  node.classList.add('shake');
  setTimeout(() => node.classList.remove('shake'), 500);
}

function drawingPad(canvas) {
  const ctx = canvas.getContext('2d');
  const pad = { canvas, empty: true, clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); pad.empty = true; } };
  let last = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    last = pos(e);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 2.2, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1446';
    ctx.fill();
    pad.empty = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const p = pos(e);
    ctx.strokeStyle = '#1a1446';
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(...last);
    ctx.lineTo(...p);
    ctx.stroke();
    last = p;
  });
  const end = () => (last = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return pad;
}

async function typed(text, font, size) {
  await document.fonts.load(`${size}px "${font}"`).catch(() => {});
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `${size}px "${font}"`;
  const w = Math.ceil(ctx.measureText(text).width) + size;
  c.width = Math.min(w, 2000);
  c.height = Math.round(size * 1.8);
  ctx.font = `${size}px "${font}"`;
  ctx.fillStyle = '#1a1446';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, c.height / 2);
  return trim(c);
}

/** Crop transparent edges so the signature fills its field. */
function trim(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas.toDataURL('image/png');
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Turn a photo of ink on paper into a transparent PNG. */
function cleanUpload(img) {
  const scale = Math.min(1, 900 / img.width, 300 / img.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    d.data[i + 3] = lum > 200 ? 0 : Math.min(255, (230 - lum) * 2.2);
  }
  ctx.putImageData(d, 0, 0);
  return trim(c);
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});
