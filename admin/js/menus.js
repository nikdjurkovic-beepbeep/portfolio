// Navigation manager: edit menus, nest/reorder items, preview on any page, publish to the site header.
import { can, esc, api, toast, toastError, modal, confirmDialog, pageHeading, action, getLinkTargets, fmtAgo } from './core.js';

export async function renderMenus(ws) {
  const manage = can('menus.manage');
  let { menus } = await api('GET', '/menus');
  const targets = await getLinkTargets().catch(() => []);
  const { pages } = await api('GET', '/pages');
  if (!menus.length && manage) {
    ws.innerHTML = `${pageHeading('STRUCTURE', 'Navigation')}<div class="notice">No menus yet. Import the current site header to start.<br><br><button class="button primary" id="imp">Import navigation from the live site</button></div>`;
    ws.querySelector('#imp').onclick = e => action(e.target, async () => { await api('POST', '/menus/import-from-site', {}); renderMenus(ws); }, 'Importing…')();
    return;
  }
  let current = menus.find(m => m.location === 'primary') || menus[0];
  let items = structuredClone(current?.items || []);
  let dirty = false;

  const pageOptions = sel => `<option value="">— custom URL —</option>${targets.filter(t => t.published).map(t => `<option value="${esc(t.url)}" ${t.url === sel ? 'selected' : ''}>${esc(t.title)} (${esc(t.url)})</option>`).join('')}`;

  ws.innerHTML = `${pageHeading('STRUCTURE', 'Navigation', 'The primary menu is the site header on every page. Edit, preview, then publish — publishing rewrites the header on all pages in one commit.',
    manage ? '<button class="button secondary" id="newMenu">＋ New menu</button>' : '')}
    <div class="tabs" id="menuTabs"></div>
    <div class="menu-layout">
      <section class="panel"><div class="panel-heading"><div><h2 id="menuName"></h2><p id="menuMeta" class="muted"></p></div>
        <div class="heading-actions">${manage ? '<button class="button quiet small" id="renameMenu">Rename</button><button class="button quiet small" id="primaryMenu">Make primary</button><button class="button quiet small danger-text" id="deleteMenu">Delete</button>' : ''}</div></div>
        <ol class="menu-tree" id="tree"></ol>
        ${manage ? `<div class="btn-row"><button class="button secondary small" id="addPage">＋ Add page</button><button class="button secondary small" id="addCustom">＋ Add custom link</button><button class="button secondary small" id="addDropdown">＋ Add dropdown</button></div>
        <div class="btn-row sticky-actions"><button class="button secondary" id="saveMenu">Save menu</button><button class="button primary" id="publishMenu">Publish to site</button><span class="save-state" id="menuState"></span></div>` : ''}
        <details class="advanced"><summary>Breadcrumbs &amp; page hierarchy</summary><p class="hint">Breadcrumb schema is generated per page from its parent pages (set the parent in the page editor → Page tab, and enable “Breadcrumb schema” in the SEO tab). Current hierarchy:</p>${hierarchy(pages)}</details>
      </section>
      <section class="panel preview-panel"><div class="panel-heading"><h2>Preview</h2><select id="prevPage" aria-label="Preview on page">${targets.filter(t => t.published).map(t => `<option value="${esc(t.url)}">${esc(t.title)}</option>`).join('')}</select></div>
        <p class="hint">Saved menu shown on the selected page. Save first to see changes.</p>
        <iframe id="prevFrame" title="Navigation preview" sandbox="allow-same-origin allow-scripts"></iframe></section>
    </div>`;
  const $ = s => ws.querySelector(s);

  const drawTabs = () => {
    $('#menuTabs').innerHTML = menus.map(m => `<button class="tab${m.id === current.id ? ' active' : ''}" data-menu="${m.id}">${esc(m.name)}${m.location === 'primary' ? ' <span class="pill ok-pill">primary</span>' : ''}${m.unpublished && m.location === 'primary' ? ' <span class="pill warn">unpublished</span>' : ''}</button>`).join('');
    $('#menuName').textContent = current.name;
    $('#menuMeta').textContent = `${current.location === 'primary' ? 'Shown in the site header' : 'Not shown on the site (no location)'} · saved ${fmtAgo(current.updated_at)}`;
    if ($('#primaryMenu')) $('#primaryMenu').hidden = current.location === 'primary';
    if ($('#publishMenu')) $('#publishMenu').disabled = current.location !== 'primary';
  };

  const itemRow = (it, path) => {
    const top = path.length === 1;
    const idx = path.join('.');
    const internal = it.url && it.url.startsWith('/') && targets.some(t => t.url === it.url.split('#')[0]);
    return `<li data-path="${idx}"><div class="menu-item${it.children?.length ? ' has-children' : ''}">
      <div class="mi-fields">
        <input class="mi-label" value="${esc(it.label)}" aria-label="Label" placeholder="Label" ${manage ? '' : 'disabled'}>
        ${it.children?.length && !it.url ? '<span class="muted">Dropdown</span>' : `<select class="mi-page" aria-label="Page" ${manage ? '' : 'disabled'}>${pageOptions(internal ? it.url.split('#')[0] : '')}</select><input class="mi-url" value="${esc(it.url)}" aria-label="URL" placeholder="/page/ or https://…" ${manage ? '' : 'disabled'}>`}
        <label class="check small"><input type="checkbox" class="mi-tab" ${it.newTab ? 'checked' : ''} ${manage ? '' : 'disabled'}> new tab</label>
      </div>
      ${manage ? `<div class="mi-actions">
        <button class="icon-btn" data-act="up" title="Move up" aria-label="Move up">↑</button><button class="icon-btn" data-act="down" title="Move down" aria-label="Move down">↓</button>
        ${top ? '<button class="icon-btn" data-act="indent" title="Nest under the item above" aria-label="Nest under previous">→</button>' : '<button class="icon-btn" data-act="outdent" title="Move out of the dropdown" aria-label="Move out">←</button>'}
        <button class="icon-btn danger-text" data-act="remove" title="Remove" aria-label="Remove">✕</button></div>` : ''}
    </div>${it.children?.length ? `<ol>${it.children.map((c, j) => itemRow(c, [...path, j])).join('')}</ol>` : ''}</li>`;
  };

  const drawTree = () => { $('#tree').innerHTML = items.map((it, i) => itemRow(it, [i])).join('') || '<li class="empty">No items.</li>'; };
  const get = path => { const [a, b] = path.split('.').map(Number); return b === undefined ? { list: items, i: a } : { list: items[a].children, i: b }; };
  const setDirty = () => { dirty = true; if ($('#menuState')) $('#menuState').textContent = 'Unsaved changes'; };

  const preview = () => {
    const url = $('#prevPage').value || '/';
    const path = url === '/' ? 'index.html' : url.endsWith('/') ? `${url.slice(1)}index.html` : url.slice(1);
    $('#prevFrame').src = `/cms-api/menus/${current.id}/preview?path=${encodeURIComponent(path)}`;
  };

  drawTabs(); drawTree(); preview();

  $('#prevPage').onchange = preview;
  $('#tree').addEventListener('input', e => {
    const li = e.target.closest('li[data-path]'); if (!li) return;
    const { list, i } = get(li.dataset.path);
    if (e.target.classList.contains('mi-label')) list[i].label = e.target.value;
    if (e.target.classList.contains('mi-url')) list[i].url = e.target.value;
    setDirty();
  });
  $('#tree').addEventListener('change', e => {
    const li = e.target.closest('li[data-path]'); if (!li) return;
    const { list, i } = get(li.dataset.path);
    if (e.target.classList.contains('mi-page') && e.target.value) {
      list[i].url = e.target.value;
      li.querySelector(':scope > .menu-item .mi-url').value = e.target.value;
      if (!list[i].label) { list[i].label = targets.find(t => t.url === e.target.value)?.title || ''; li.querySelector(':scope > .menu-item .mi-label').value = list[i].label; }
    }
    if (e.target.classList.contains('mi-tab')) list[i].newTab = e.target.checked;
    setDirty();
  });
  $('#tree').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const path = b.closest('li[data-path]').dataset.path;
    const { list, i } = get(path);
    const [a] = path.split('.').map(Number);
    const act = b.dataset.act;
    if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    if (act === 'remove') list.splice(i, 1);
    if (act === 'indent') {
      if (i === 0) return toast('There is no item above to nest under.', 'error');
      if (list[i].children?.length) return toast('Items that already have children cannot be nested (the header supports one dropdown level).', 'error');
      const [moved] = list.splice(i, 1);
      (list[i - 1].children ||= []).push({ ...moved, children: [] });
    }
    if (act === 'outdent') { const [moved] = list.splice(i, 1); items.splice(a + 1, 0, { ...moved, children: [] }); }
    drawTree(); setDirty();
  });
  const add = item => { items.push(item); drawTree(); setDirty(); $('#tree').lastElementChild?.querySelector('input')?.focus(); };
  $('#addCustom')?.addEventListener('click', () => add({ label: '', url: '', newTab: false, children: [] }));
  $('#addDropdown')?.addEventListener('click', () => add({ label: 'New dropdown', url: '', newTab: false, children: [{ label: '', url: '', newTab: false, children: [] }] }));
  $('#addPage')?.addEventListener('click', () => {
    const m = modal('Add pages to the menu', `<div class="check-list">${targets.filter(t => t.published).map(t => `<label class="check"><input type="checkbox" value="${esc(t.url)}" data-title="${esc(t.title)}"> ${esc(t.title)} <small class="muted">${esc(t.url)}</small></label>`).join('')}</div>`, { actions: '<button class="button primary" id="addSel">Add selected</button>' });
    m.$('#addSel').onclick = () => { m.$$('input:checked').forEach(c => items.push({ label: c.dataset.title, url: c.value, newTab: false, children: [] })); m.close(); drawTree(); setDirty(); };
  });

  const save = async () => {
    await api('PUT', `/menus/${current.id}`, { items });
    ({ menus } = await api('GET', '/menus'));
    current = menus.find(m => m.id === current.id);
    dirty = false; $('#menuState').textContent = 'Saved (not yet published)';
    drawTabs(); preview();
  };
  $('#saveMenu')?.addEventListener('click', e => action(e.target, async () => { await save(); toast('Menu saved. Use “Publish to site” to update the live header.'); }, 'Saving…')());
  $('#publishMenu')?.addEventListener('click', e => action(e.target, async () => {
    if (dirty) await save();
    if (!(await confirmDialog('Publish navigation?', 'The header on every public page is rewritten in a single commit. Private pages and drafts are updated in the CMS.', { confirmLabel: 'Publish' }))) return;
    let r;
    try { r = await api('POST', `/menus/${current.id}/publish`, {}); } catch (err) {
      if (err.data?.code !== 'broken_links') throw err;
      if (!(await confirmDialog('Some links are not published pages', `${esc(err.message)}<br><br>Publish anyway?`, { confirmLabel: 'Publish anyway', danger: true }))) return;
      r = await api('POST', `/menus/${current.id}/publish`, { allowBroken: true });
    }
    toast(`Navigation published (${r.filesUpdated} page file(s) updated).`);
    ({ menus } = await api('GET', '/menus')); current = menus.find(m => m.id === current.id); drawTabs(); $('#menuState').textContent = 'Published';
  }, 'Publishing…')());
  $('#menuTabs').addEventListener('click', async e => {
    const b = e.target.closest('[data-menu]'); if (!b) return;
    if (dirty && !(await confirmDialog('Discard unsaved menu changes?', 'Switching menus discards your edits.', { confirmLabel: 'Discard', danger: true }))) return;
    current = menus.find(m => m.id === Number(b.dataset.menu)); items = structuredClone(current.items); dirty = false;
    drawTabs(); drawTree(); preview();
  });
  $('#newMenu')?.addEventListener('click', async () => {
    const name = prompt('Menu name');
    if (!name) return;
    try { await api('POST', '/menus', { name, items: [] }); renderMenus(ws); } catch (e) { toastError(e); }
  });
  $('#renameMenu')?.addEventListener('click', async () => {
    const name = prompt('Menu name', current.name); if (!name) return;
    try { await api('PUT', `/menus/${current.id}`, { name }); renderMenus(ws); } catch (e) { toastError(e); }
  });
  $('#primaryMenu')?.addEventListener('click', async () => {
    const prev = menus.find(m => m.location === 'primary');
    if (!(await confirmDialog('Make this the site header menu?', `${prev ? `“${esc(prev.name)}” stops being the header menu. ` : ''}Nothing changes on the site until you publish.`, { confirmLabel: 'Make primary' }))) return;
    try { if (prev) await api('PUT', `/menus/${prev.id}`, { location: null }); await api('PUT', `/menus/${current.id}`, { location: 'primary' }); renderMenus(ws); } catch (e) { toastError(e); }
  });
  $('#deleteMenu')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete menu?', `Delete “${esc(current.name)}”?`, { danger: true, confirmLabel: 'Delete' }))) return;
    try { await api('DELETE', `/menus/${current.id}`); renderMenus(ws); } catch (e) { toastError(e); }
  });
}

function hierarchy(pages) {
  const by = new Map();
  pages.filter(p => p.state !== 'trash').forEach(p => { const k = p.parent_id || 0; if (!by.has(k)) by.set(k, []); by.get(k).push(p); });
  const walk = pid => `<ul class="tree">${(by.get(pid) || []).sort((a, b) => a.menu_order - b.menu_order || a.url.localeCompare(b.url)).map(p => `<li><a href="#/pages/${p.id}">${esc(p.title)}</a> <small class="muted">${esc(p.url)}</small>${by.has(p.id) ? walk(p.id) : ''}</li>`).join('')}</ul>`;
  return walk(0);
}
