// Media library + picker used by the editor.
import { can, esc, api, toast, toastError, modal, confirmDialog, fmtBytes, fmtDate, pageHeading, action, copyText, debounce } from './core.js';

const IMAGE_RE = /^image\//;
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.pdf,.txt,.csv,.docx,.xlsx,.pptx';
const nameOf = p => p.split('/').pop();
const urlOf = p => `/${p.split('/').map(encodeURIComponent).join('/')}`;

async function imageInfo(file) {
  if (!IMAGE_RE.test(file.type)) return {};
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(img.src); };
    img.onerror = () => resolve({});
    img.src = URL.createObjectURL(file);
  });
}

/** Optional client-side optimisation: downscale + convert JPEG/PNG to WebP when it saves bytes. */
async function optimise(file, maxWidth) {
  if (!/^image\/(jpeg|png)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxWidth / bmp.width);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.82));
    if (!blob || blob.type !== 'image/webp') return file;
    if (blob.size >= file.size && scale === 1) return file;
    return new File([blob], file.name.replace(/\.(jpe?g|png)$/i, '.webp'), { type: 'image/webp' });
  } catch { return file; }
}

export async function uploadFiles(files, { folder = '', optimiseImages = true, maxWidth = 2000, onProgress } = {}) {
  const done = [], failed = [];
  for (const [i, original] of [...files].entries()) {
    onProgress?.(`Uploading ${i + 1} of ${files.length}: ${original.name}`);
    try {
      if (original.size > 10 * 1024 * 1024 && !/^image\/(jpeg|png)$/.test(original.type)) throw new Error('larger than 10 MB');
      const file = optimiseImages ? await optimise(original, maxWidth) : original;
      if (file.size > 10 * 1024 * 1024) throw new Error('larger than 10 MB after optimisation');
      const info = await imageInfo(file);
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('folder', folder);
      if (info.width) { form.append('width', info.width); form.append('height', info.height); }
      const r = await api('POST', '/media', undefined, { form });
      done.push({ ...r, saved: original.size - file.size });
    } catch (e) { failed.push(`${original.name}: ${e.message}`); }
  }
  if (done.length) toast(`${done.length} file(s) uploaded.${done.some(d => d.saved > 1024) ? ` Optimisation saved ${fmtBytes(done.reduce((a, d) => a + Math.max(0, d.saved), 0))}.` : ''}`);
  if (failed.length) toast(`Not uploaded — ${failed.join('; ')}`, 'error');
  return done;
}

function card(m, { selectable = false } = {}) {
  const isImg = IMAGE_RE.test(m.mime);
  return `<button type="button" class="media-card" data-path="${esc(m.path)}">
    <span class="media-thumb">${isImg ? `<img src="${esc(urlOf(m.path))}" alt="" loading="lazy">` : `<span class="file-icon">${esc(m.path.split('.').pop().toUpperCase())}</span>`}</span>
    <span class="media-info"><b title="${esc(m.path)}">${esc(m.title || nameOf(m.path))}</b><small>${m.width ? `${m.width}×${m.height} · ` : ''}${fmtBytes(m.size)}${!m.alt && isImg ? ' · <span class="warn-text">no alt</span>' : ''}</small></span>
    ${selectable ? '' : ''}</button>`;
}

function filterMedia(list, { q, type, collection }) {
  return list.filter(m => (!q || `${m.path} ${m.title} ${m.alt} ${m.caption}`.toLowerCase().includes(q))
    && (!type || (type === 'image' ? IMAGE_RE.test(m.mime) : !IMAGE_RE.test(m.mime)))
    && (!collection || m.collection === collection));
}

function uploadPanel(collections) {
  return `<section class="panel upload-panel">
    <label class="dropzone" id="drop"><input type="file" id="fileIn" multiple accept="${ACCEPT}" hidden>
      <b>Drop files here or click to choose</b><small>Images: JPEG, PNG, WebP, AVIF, GIF, SVG · Documents: PDF, CSV, TXT, DOCX, XLSX, PPTX · up to 10 MB each</small></label>
    <div class="upload-opts">
      <div class="field"><label for="upFolder">Folder</label><input id="upFolder" list="folderList" placeholder="e.g. studies (optional)" maxlength="60"><datalist id="folderList">${collections.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <label class="check"><input type="checkbox" id="upOpt" checked> Optimise JPEG/PNG (convert to WebP, max width <input id="upMax" type="number" value="2000" min="400" max="6000" step="100" class="tiny">px)</label>
      <span id="upStatus" class="muted" role="status"></span>
    </div></section>`;
}

function bindUpload(root, after) {
  const input = root.querySelector('#fileIn');
  const drop = root.querySelector('#drop');
  const go = async files => {
    if (!files.length) return;
    const status = root.querySelector('#upStatus');
    const done = await uploadFiles(files, { folder: root.querySelector('#upFolder').value, optimiseImages: root.querySelector('#upOpt').checked, maxWidth: Number(root.querySelector('#upMax').value) || 2000, onProgress: t => { status.textContent = t; } });
    status.textContent = '';
    input.value = '';
    after(done);
  };
  input.onchange = () => go([...input.files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); go([...e.dataTransfer.files]); };
}

export async function renderMedia(ws) {
  let { media, collections } = await api('GET', '/media');
  const f = { q: '', type: '', collection: '' };
  ws.innerHTML = `${pageHeading('ASSETS', 'Media library', 'Files are stored in the site repository and served from nikolaseo.com. Titles, alt text, captions and collections are stored in the CMS.',
    `${can('media.upload') ? '<button class="button secondary" id="syncMedia" title="Index images and documents already in the repository">↻ Sync from repository</button>' : ''}`)}
    ${can('media.upload') ? uploadPanel(collections) : ''}
    <section class="panel table-panel"><div class="panel-heading filters">
      <div class="search-box"><span>⌕</span><input type="search" id="mq" placeholder="Search name, alt text, caption" aria-label="Search media"></div>
      <select id="mt" aria-label="Type"><option value="">All types</option><option value="image">Images</option><option value="doc">Documents</option></select>
      <select id="mc" aria-label="Collection"><option value="">All collections</option>${collections.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      <span class="muted" id="mcount"></span></div>
      <div class="media-grid" id="grid"></div></section>`;
  const draw = () => {
    const list = filterMedia(media, f);
    ws.querySelector('#mcount').textContent = `${list.length} of ${media.length}`;
    ws.querySelector('#grid').innerHTML = list.map(m => card(m)).join('') || `<div class="empty">${media.length ? 'Nothing matches.' : 'No media indexed yet. Use “Sync from repository” to index existing files, or upload.'}</div>`;
  };
  const reloadList = async () => { ({ media, collections } = await api('GET', '/media')); draw(); };
  draw();
  ws.querySelector('#mq').oninput = debounce(e => { f.q = e.target.value.toLowerCase(); draw(); }, 150);
  ws.querySelector('#mt').onchange = e => { f.type = e.target.value; draw(); };
  ws.querySelector('#mc').onchange = e => { f.collection = e.target.value; draw(); };
  if (can('media.upload')) bindUpload(ws, async done => { await reloadList(); if (done.length === 1) details(media.find(m => m.path === done[0].path), reloadList); });
  ws.querySelector('#syncMedia')?.addEventListener('click', e => action(e.target, async () => { const r = await api('POST', '/media/sync', {}); toast(`Indexed ${r.added} new file(s)${r.removed ? `, removed ${r.removed} missing` : ''}.`); await reloadList(); }, 'Syncing…')());
  ws.querySelector('#grid').addEventListener('click', e => { const c = e.target.closest('[data-path]'); if (c) details(media.find(m => m.path === c.dataset.path), reloadList); });
}

function details(m, onChange) {
  if (!m) return;
  const isImg = IMAGE_RE.test(m.mime);
  const editable = can('media.edit');
  const abs = `https://nikolaseo.com${urlOf(m.path)}`;
  const d = modal(nameOf(m.path), `<div class="media-detail">
    <div class="media-preview">${isImg ? `<img src="${esc(urlOf(m.path))}?v=${esc((m.sha || '').slice(0, 7))}" alt="${esc(m.alt)}" id="prevImg">` : `<span class="file-icon big">${esc(m.path.split('.').pop().toUpperCase())}</span>`}</div>
    <div>
      <dl class="kv compact"><dt>URL</dt><dd><div class="copy-row"><input readonly value="${esc(abs)}" aria-label="File URL"><button class="button quiet small" data-copy>Copy</button></div></dd>
      <dt>Type</dt><dd>${esc(m.mime)}</dd><dt>Size</dt><dd>${fmtBytes(m.size)}</dd><dt>Dimensions</dt><dd id="dims">${m.width ? `${m.width} × ${m.height}px` : '—'}</dd><dt>Added</dt><dd>${fmtDate(m.created_at)}</dd></dl>
      <div class="field"><label for="mdTitle">Title</label><input id="mdTitle" value="${esc(m.title)}" ${editable ? '' : 'disabled'}></div>
      ${isImg ? `<div class="field"><label for="mdAlt">Alt text <small>(describe the image for screen readers and search)</small></label><textarea id="mdAlt" rows="2" ${editable ? '' : 'disabled'}>${esc(m.alt)}</textarea><small class="hint">Used as the default when inserting. Images already on pages keep their own alt text.</small></div>
      <div class="field"><label for="mdCap">Caption</label><input id="mdCap" value="${esc(m.caption)}" ${editable ? '' : 'disabled'}></div>` : ''}
      <div class="field"><label for="mdCol">Collection</label><input id="mdCol" value="${esc(m.collection)}" ${editable ? '' : 'disabled'}></div>
      <div id="usage" class="muted"></div>
    </div></div>`, {
    wide: true,
    actions: `<button class="button quiet" data-usage>Where is it used?</button>${editable ? '<label class="button quiet">Replace file…<input type="file" data-replace hidden></label>' : ''}${can('media.delete') ? '<button class="button quiet danger-text" data-del>Delete</button>' : ''}${editable ? '<button class="button primary" data-save>Save details</button>' : ''}`
  });
  d.$('[data-copy]').onclick = () => copyText(abs);
  const img = d.$('#prevImg');
  if (img && !m.width && editable) img.addEventListener('load', () => { d.$('#dims').textContent = `${img.naturalWidth} × ${img.naturalHeight}px`; api('PATCH', '/media', { path: m.path, title: m.title, alt: m.alt, caption: m.caption, collection: m.collection, width: img.naturalWidth, height: img.naturalHeight }).catch(() => {}); }, { once: true });
  d.$('[data-save]')?.addEventListener('click', e => action(e.target, async () => {
    await api('PATCH', '/media', { path: m.path, title: d.$('#mdTitle').value, alt: d.$('#mdAlt')?.value || '', caption: d.$('#mdCap')?.value || '', collection: d.$('#mdCol').value });
    toast('Details saved.'); d.close(); onChange?.();
  }, 'Saving…')());
  d.$('[data-usage]').onclick = e => action(e.target, async () => {
    const r = await api('GET', `/media/usage?path=${encodeURIComponent(m.path)}`);
    d.$('#usage').innerHTML = r.usedIn.length ? `<b>Used on:</b><ul>${r.usedIn.map(u => `<li><code>${esc(u.path)}</code> (${esc(u.where)})</li>`).join('')}</ul>` : 'Not referenced by any page.';
  }, 'Checking…')();
  d.$('[data-replace]')?.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!(await confirmDialog('Replace this file?', `Every page that uses <code>${esc(m.path)}</code> will show the new file. The URL stays the same, so no links break.`, { confirmLabel: 'Replace' }))) return;
    try {
      const info = await imageInfo(file);
      const form = new FormData(); form.append('file', file, file.name); form.append('path', m.path);
      if (info.width) { form.append('width', info.width); form.append('height', info.height); }
      const r = await api('POST', '/media/replace', undefined, { form });
      toast(r.note, 'success', 8000); d.close(); onChange?.();
    } catch (err) { toastError(err); }
  });
  d.$('[data-del]')?.addEventListener('click', async () => {
    try {
      await api('DELETE', `/media?path=${encodeURIComponent(m.path)}`);
      toast('File deleted.'); d.close(); onChange?.();
    } catch (err) {
      if (err.data?.code !== 'in_use') return toastError(err);
      const list = err.data.usedIn.map(u => `<li><code>${esc(u.path)}</code> (${esc(u.where)})</li>`).join('');
      if (await confirmDialog('File is in use', `${esc(err.message)}<ul>${list}</ul>Delete anyway? Those pages will show a broken image or link.`, { danger: true, confirmLabel: 'Delete anyway', typeToConfirm: 'DELETE' }) === 'DELETE') {
        try { await api('DELETE', `/media?path=${encodeURIComponent(m.path)}&force=1`); toast('File deleted.'); d.close(); onChange?.(); } catch (e2) { toastError(e2); }
      }
    }
  });
}

/** Picker for the editor and the SEO image field. */
export async function openMediaPicker({ imagesOnly = false, onSelect }) {
  let { media, collections } = await api('GET', '/media');
  const f = { q: '', type: imagesOnly ? 'image' : '', collection: '' };
  let selected = null;
  const m = modal(imagesOnly ? 'Choose an image' : 'Insert from media library', `
    ${can('media.upload') ? uploadPanel(collections) : ''}
    <div class="panel-heading filters"><div class="search-box"><span>⌕</span><input type="search" id="pq" placeholder="Search" aria-label="Search media"></div>
    ${imagesOnly ? '' : '<select id="pt" aria-label="Type"><option value="">All</option><option value="image">Images</option><option value="doc">Documents</option></select>'}</div>
    <div class="picker-layout"><div class="media-grid compact" id="pgrid"></div>
    <aside class="picker-side" id="pside"><p class="muted">Select a file.</p></aside></div>`, { wide: true, actions: '<button class="button primary" id="pInsert" disabled>Insert</button>' });
  const draw = () => {
    m.$('#pgrid').innerHTML = filterMedia(media, f).map(x => card(x, { selectable: true })).join('') || '<div class="empty">No files.</div>';
    if (selected) m.$(`[data-path="${CSS.escape(selected.path)}"]`)?.classList.add('selected');
  };
  const side = () => {
    const isImg = IMAGE_RE.test(selected.mime);
    m.$('#pside').innerHTML = `${isImg ? `<img src="${esc(urlOf(selected.path))}" alt="" class="side-thumb">` : ''}<b>${esc(nameOf(selected.path))}</b><small class="block">${selected.width ? `${selected.width}×${selected.height} · ` : ''}${fmtBytes(selected.size)}</small>
      ${isImg ? `<div class="field"><label for="pAlt">Alt text</label><textarea id="pAlt" rows="2">${esc(selected.alt)}</textarea></div><div class="field"><label for="pCap">Caption (optional)</label><input id="pCap" value="${esc(selected.caption)}"></div>` : `<div class="field"><label for="pTitle">Link text</label><input id="pTitle" value="${esc(selected.title || nameOf(selected.path))}"></div>`}`;
  };
  draw();
  m.$('#pq').oninput = debounce(e => { f.q = e.target.value.toLowerCase(); draw(); }, 150);
  m.$('#pt')?.addEventListener('change', e => { f.type = e.target.value; draw(); });
  m.$('#pgrid').addEventListener('click', e => {
    const c = e.target.closest('[data-path]'); if (!c) return;
    selected = media.find(x => x.path === c.dataset.path);
    m.$$('.media-card').forEach(x => x.classList.toggle('selected', x === c));
    side(); m.$('#pInsert').disabled = false;
  });
  m.$('#pgrid').addEventListener('dblclick', () => m.$('#pInsert').click());
  if (can('media.upload')) bindUpload(m.el, async done => {
    ({ media, collections } = await api('GET', '/media'));
    if (done[0]) { selected = media.find(x => x.path === done[0].path); side(); m.$('#pInsert').disabled = false; }
    draw();
  });
  m.$('#pInsert').onclick = async () => {
    if (!selected) return;
    const alt = m.$('#pAlt')?.value.trim();
    const caption = m.$('#pCap')?.value.trim();
    const title = m.$('#pTitle')?.value.trim();
    const item = { ...selected, alt: alt ?? selected.alt, caption: caption ?? '', title: title || selected.title };
    if (IMAGE_RE.test(selected.mime) && can('media.edit') && (alt !== selected.alt) && alt) {
      api('PATCH', '/media', { path: selected.path, title: selected.title, alt, caption: selected.caption, collection: selected.collection }).catch(() => {});
    }
    m.close(); onSelect(item);
  };
}
