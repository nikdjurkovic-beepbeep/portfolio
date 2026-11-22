// Shared admin helpers: API client, escaping, toasts, modals, formatting.

export const state = { user: null, caps: new Set(), csrf: '', settings: null, mfa: null };

export const can = cap => state.caps.has(cap);
export const canAny = (...caps) => caps.some(c => state.caps.has(c));

export function esc(v = '') {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

/** JSON API call. Throws ApiError with the server's message on failure. */
export async function api(method, path, body, { form, raw } = {}) {
  const headers = {};
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(`/cms-api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Network error: the CMS could not be reached. Check your connection; nothing was saved.', 0, {});
  }
  if (raw) { if (!res.ok) throw new ApiError(`Request failed (${res.status}).`, res.status, {}); return res; }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/setup')) {
    window.dispatchEvent(new CustomEvent('cms:signed-out'));
  }
  if (res.status === 403 && data.code === 'mfa_enrollment_required') window.dispatchEvent(new CustomEvent('cms:mfa-required'));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data);
  return data;
}

/* ----------------------------------------------------------- Toasts ---- */

export function toast(message, kind = 'success', ms = 4200) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? Math.max(ms, 7000) : ms);
}

export function toastError(e) { toast(e?.message || String(e), 'error'); }

/* ----------------------------------------------------------- Modals ---- */

/**
 * Open a modal. `content` is HTML. Returns { el, close, done } where `done` resolves
 * with the value passed to close().
 */
export function modal(title, content, { wide = false, actions = '', onOpen } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal-head"><h2 id="modalTitle">${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${content}</div>
    ${actions ? `<div class="modal-actions">${actions}</div>` : ''}
  </div>`;
  let resolve;
  const done = new Promise(r => (resolve = r));
  const previous = document.activeElement;
  const close = value => { backdrop.remove(); document.removeEventListener('keydown', onKey); previous?.focus?.(); resolve(value); };
  const onKey = e => { if (e.key === 'Escape') close(undefined); };
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(undefined); });
  backdrop.querySelector('[data-close]').addEventListener('click', () => close(undefined));
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  const first = backdrop.querySelector('input:not([type=hidden]),select,textarea,button.primary');
  setTimeout(() => (first || backdrop.querySelector('.modal')).focus?.(), 30);
  const api = { el: backdrop, close, done, $: s => backdrop.querySelector(s), $$: s => [...backdrop.querySelectorAll(s)] };
  onOpen?.(api);
  return api;
}

export function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false, typeToConfirm = '' } = {}) {
  const m = modal(title, `<p class="modal-text">${message}</p>${typeToConfirm ? `<div class="field"><label for="typeConfirm">Type <b>${esc(typeToConfirm)}</b> to confirm</label><input id="typeConfirm" autocomplete="off"></div>` : ''}`,
    { actions: `<button class="button quiet" data-cancel>Cancel</button><button class="button ${danger ? 'danger' : 'primary'}" data-ok ${typeToConfirm ? 'disabled' : ''}>${esc(confirmLabel)}</button>` });
  m.$('[data-cancel]').onclick = () => m.close(false);
  m.$('[data-ok]').onclick = () => m.close(typeToConfirm ? m.$('#typeConfirm').value : true);
  if (typeToConfirm) m.$('#typeConfirm').oninput = e => { m.$('[data-ok]').disabled = e.target.value !== typeToConfirm; };
  return m.done;
}

export function promptDialog(title, label, { value = '', placeholder = '', type = 'text', help = '' } = {}) {
  const m = modal(title, `<div class="field"><label for="promptInput">${esc(label)}</label><input id="promptInput" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}">${help ? `<small class="hint">${help}</small>` : ''}</div>`,
    { actions: '<button class="button quiet" data-cancel>Cancel</button><button class="button primary" data-ok>OK</button>' });
  m.$('[data-cancel]').onclick = () => m.close(null);
  m.$('[data-ok]').onclick = () => m.close(m.$('#promptInput').value);
  m.$('#promptInput').onkeydown = e => { if (e.key === 'Enter') m.close(m.$('#promptInput').value); };
  return m.done;
}

/* ------------------------------------------------------- Formatting ---- */

export function fmtDate(v, withTime = true) {
  if (!v) return '—';
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return esc(v);
  return d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function fmtAgo(v) {
  if (!v) return 'never';
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(v, false);
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const STATE_LABEL = { published: 'Published', draft: 'Draft', scheduled: 'Scheduled', private: 'Private', password: 'Password', trash: 'Trash' };
export const statePill = s => `<span class="pill state-${esc(s)}">${esc(STATE_LABEL[s] || s)}</span>`;

export function download(filename, text, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function downloadFromApi(path, fallbackName) {
  const res = await api('GET', path, undefined, { raw: true });
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  download(name, await res.text(), res.headers.get('Content-Type') || 'text/plain');
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => toast('Copied.'));
  const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast('Copied.');
  return Promise.resolve();
}

export function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) { button.dataset.label = button.innerHTML; button.textContent = label; button.disabled = true; }
  else { if (button.dataset.label) button.innerHTML = button.dataset.label; button.disabled = false; }
}

/** Wrap an async click handler with busy state + error toast. */
export function action(button, fn, label) {
  return async (...args) => {
    setBusy(button, true, label);
    try { return await fn(...args); } catch (e) { toastError(e); } finally { setBusy(button, false); }
  };
}

export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Page list cache used by link pickers. */
let linkTargets = null;
export async function getLinkTargets(force = false) {
  if (!linkTargets || force) linkTargets = (await api('GET', '/pages/link-targets')).targets;
  return linkTargets;
}
export function clearLinkTargets() { linkTargets = null; }

export function pageHeading(eyebrow, title, intro = '', actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${intro ? `<p>${intro}</p>` : ''}</div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}
