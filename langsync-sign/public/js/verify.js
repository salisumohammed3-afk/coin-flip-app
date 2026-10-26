// Public page: check whether a PDF is an unmodified LangSync Sign completed document.
import { api, html, raw, fmtDate } from './ui.js';

const app = document.getElementById('app');
app.innerHTML = html`<div class="sign-top"><span class="brand-mark">✍</span><span class="title">LangSync Sign · Verify</span></div>
  <div class="verify-box">
    <div class="card card-pad">
      <h1>Verify a signed document</h1>
      <p class="muted">Check that a completed PDF came from LangSync Sign and hasn't been changed since it was signed. The file is fingerprinted (SHA-256) and compared with our records; it is not stored.</p>
      <label class="dropzone" data-drop><div class="big">🛡</div><div><strong>Drop the completed PDF here</strong> or click to choose</div><input type="file" accept="application/pdf" hidden data-file></label>
      <div data-result style="margin-top:16px"></div>
    </div>
  </div>`;

const result = app.querySelector('[data-result]');
async function check(file) {
  if (!file) return;
  result.innerHTML = '<p class="muted">Checking…</p>';
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await api('POST', '/api/verify', undefined, { form });
    result.innerHTML = r.match
      ? html`<div class="callout"><strong style="color:var(--green)">✅ Authentic and unmodified.</strong>
          <p style="margin:6px 0">"${r.envelope.title}" was completed on ${fmtDate(r.envelope.completed_at)}.</p>
          <ul style="margin:0">${raw(r.signers.map((s) => html`<li>${s.name} (${s.role}) · ${fmtDate(s.completed_at)}</li>`).join(''))}</ul>
          <p class="mono" style="margin:8px 0 0">${r.sha256}</p></div>`
      : html`<div class="callout bad"><strong>⚠️ No match.</strong> This file was not produced by LangSync Sign, or it has been modified since it was completed.<p class="mono" style="margin:8px 0 0">${r.sha256}</p></div>`;
  } catch (err) {
    result.innerHTML = html`<div class="callout bad">${err.message}</div>`;
  }
}
const drop = app.querySelector('[data-drop]');
app.querySelector('[data-file]').onchange = (e) => check(e.target.files[0]);
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); check(e.dataTransfer.files[0]); });
