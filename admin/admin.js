(() => {
  'use strict';

  const OWNER = 'nikdjurkovic-beepbeep';
  const REPO = 'portfolio';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const SITE = 'https://nikolaseo.com';
  const EXTENSIONS = /\.(html?)$/i;
  const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
  const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };

  let token = '';
  let repository = null;
  let tree = [];
  let pages = [];
  let currentView = 'overview';
  let currentFile = '';
  let originalHtml = '';
  let isNewPage = false;
  let addNewPageToMenu = false;
  let editorRootSelector = 'main';
  let frameReady = false;
  let dirty = false;
  let savedSelection = null;
  let toastTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const loginScreen = $('#loginScreen');
  const app = $('#app');
  const workspace = $('#workspace');
  const toast = $('#toast');

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw || 'Unexpected GitHub response.' }; }
    if (!response.ok) {
      const message = data.message || `GitHub returned ${response.status}.`;
      if (response.status === 401) throw new Error('GitHub did not accept that access key. Check that it is active, then connect again.');
      if (response.status === 403) throw new Error(`GitHub declined this action. Check that the key has Contents read and write access. ${message}`);
      if (response.status === 409 || response.status === 422) throw new Error(`The repository changed while this page was open. Refresh the page list and try again. ${message}`);
      throw new Error(message);
    }
    return data;
  }

  function pathApi(path, suffix = '') {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `/repos/${OWNER}/${REPO}/contents/${encoded}${suffix}`;
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function slugify(value) {
    return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
  }

  function utf8FromBase64(value) {
    const binary = atob(value.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function base64FromBytes(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function appUrlForPath(path) {
    if (path === 'index.html') return `${SITE}/`;
    if (/\/index\.html$/i.test(path)) return `${SITE}/${path.replace(/\/index\.html$/i, '')}/`;
    return `${SITE}/${path}`;
  }

  function pageRootSelector(path) {
    return /\/index\.html$/i.test(path) ? 'article.article' : 'main';
  }

  function classifyPage(path) {
    if (path === 'index.html') return 'Homepage';
    if (/^seo-vs-geo-case-study\/index\.html$/i.test(path)) return 'SEO Studies';
    if (/\/index\.html$/i.test(path)) return 'SEO Studies';
    if (/\.html?$/i.test(path)) return 'SEO Tools';
    return 'Page';
  }

  function pageTitleFromHtml(path, html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim();
    const heading = doc.querySelector('main h1, h1')?.textContent?.trim();
    if (path === 'index.html') return { title: 'Homepage', detail: title || heading || 'Home' };
    return { title: heading || title || path, detail: path };
  }

  function showToast(message, kind = 'success') {
    toast.textContent = message;
    toast.className = `toast show${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function setLoginError(message = '') {
    const node = $('#loginError');
    node.textContent = message;
    node.hidden = !message;
  }

  function setBusy(button, busy, label = 'Working…') {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent.trim();
      button.textContent = label;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      button.disabled = false;
    }
  }

  async function connect(event) {
    event.preventDefault();
    const field = $('#accessToken');
    const candidate = field.value.trim();
    if (!candidate) return;
    token = candidate;
    field.value = '';
    const button = $('#connectButton');
    setBusy(button, true, 'Connecting…');
    setLoginError('');
    try {
      repository = await api(`/repos/${OWNER}/${REPO}`);
      if (repository.full_name?.toLowerCase() !== `${OWNER}/${REPO}`.toLowerCase()) {
        throw new Error('This key is connected to a different repository.');
      }
      if (repository.default_branch !== BRANCH) {
        throw new Error(`The site branch is ${repository.default_branch || 'unknown'}, while this editor is configured for ${BRANCH}.`);
      }
      if (repository.permissions && repository.permissions.push === false) {
        throw new Error('This account can read the repository but cannot publish changes. Give the fine-grained key Contents read and write access.');
      }
      await refreshTree();
      loginScreen.hidden = true;
      app.hidden = false;
      $('#branchLabel').textContent = `${BRANCH} branch`;
      $('#connectionStatus').textContent = 'Connected';
      renderView('overview');
    } catch (error) {
      token = '';
      repository = null;
      setLoginError(error.message || 'Could not connect to GitHub.');
    } finally {
      setBusy(button, false);
    }
  }

  async function refreshTree() {
    const result = await api(`/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
    if (result.truncated) throw new Error('This site repository is too large to index in one pass.');
    tree = result.tree || [];
    const htmlFiles = tree.filter(item => item.type === 'blob' && EXTENSIONS.test(item.path) && !item.path.startsWith('admin/') && !/^google[^/]*\.html$/i.test(item.path));
    pages = await Promise.all(htmlFiles.map(async file => {
      try {
        const response = await api(pathApi(file.path, `?ref=${encodeURIComponent(BRANCH)}`));
        const html = utf8FromBase64(response.content || '');
        const meta = pageTitleFromHtml(file.path, html);
        return { path: file.path, sha: file.sha, size: file.size, title: meta.title, detail: meta.detail, group: classifyPage(file.path), html };
      } catch {
        return { path: file.path, sha: file.sha, size: file.size, title: file.path, detail: file.path, group: classifyPage(file.path), html: '' };
      }
    }));
    pages.sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.group.localeCompare(b.group) || a.title.localeCompare(b.title)));
    $('#pageCount').textContent = String(pages.length);
  }

  function pageCounts() {
    return {
      homepage: pages.filter(page => page.path === 'index.html').length,
      tools: pages.filter(page => page.group === 'SEO Tools').length,
      studies: pages.filter(page => page.group === 'SEO Studies').length
    };
  }

  function renderView(view) {
    if (view === 'editor') {
      if (currentFile) openEditor(currentFile, originalHtml, true);
      return;
    }
    currentView = view;
    $$('.side-link[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    const names = { overview: 'Overview', pages: 'All pages', media: 'Media library', settings: 'Settings', editor: 'Edit page' };
    $('#currentSection').textContent = names[view] || 'Content Studio';
    if (view === 'overview') renderOverview();
    if (view === 'pages') renderPages();
    if (view === 'media') renderMedia();
    if (view === 'settings') renderSettings();
    $('#sidebar').classList.remove('open');
  }

  function renderOverview() {
    const counts = pageCounts();
    workspace.innerHTML = `
      <div class="page-heading"><div><div class="eyebrow">YOUR WEBSITE</div><h1>Content at a glance</h1><p>Manage every published page from one place.</p></div><div class="heading-actions"><button class="button primary" data-action="open-pages">Open all pages <span>→</span></button></div></div>
      <div class="stat-grid">
        <article class="stat-card"><div class="stat-label">PUBLISHED PAGES</div><div class="stat-value accent">${pages.length}</div><div class="stat-note">All editable HTML pages</div></article>
        <article class="stat-card"><div class="stat-label">SEO TOOLS</div><div class="stat-value">${counts.tools}</div><div class="stat-note">Interactive tools included</div></article>
        <article class="stat-card"><div class="stat-label">SEO STUDIES</div><div class="stat-value">${counts.studies}</div><div class="stat-note">Editorial pages</div></article>
      </div>
      <div class="dashboard-grid">
        <section class="panel table-panel"><div class="panel-heading"><div><h2>Recently opened pages</h2><p>Your homepage and featured editorial page.</p></div><button class="button quiet small" data-action="open-pages">View all</button></div>
          <div class="table-scroll"><table class="content-table"><thead><tr><th>PAGE</th><th>TYPE</th><th>STATUS</th><th></th></tr></thead><tbody>${pages.slice(0, 5).map(renderPageRow).join('')}</tbody></table></div>
        </section>
        <aside class="panel quick-panel"><div class="eyebrow">PUBLISHING</div><h2>Your workflow stays simple</h2><p>Edit the page in a familiar visual editor. When you publish, the change is saved to your site repository and GitHub Pages updates the website.</p><div class="quick-actions"><button class="button secondary" data-action="open-pages"><span>▤</span> Browse all pages</button><button class="button secondary" data-action="open-media"><span>▧</span> Upload an image</button></div><div class="note-box" style="margin-top:14px"><strong>Safe by default.</strong> Your GitHub key stays in this browser tab and is not saved by the editor.</div></aside>
      </div>`;
  }

  function renderPageRow(page) {
    return `<tr><td><div class="content-title"><span class="doc-icon">${page.path === 'index.html' ? '⌂' : page.group === 'SEO Tools' ? '⌕' : '▤'}</span><span><b>${escapeHtml(page.title)}</b><small>${escapeHtml(page.path)}</small></span></div></td><td>${escapeHtml(page.group)}</td><td><span class="status-pill">Published</span></td><td><button class="button quiet small" data-edit="${escapeHtml(page.path)}">Edit</button></td></tr>`;
  }

  function renderPages(filter = '') {
    const filtered = pages.filter(page => `${page.title} ${page.path} ${page.group}`.toLowerCase().includes(filter.toLowerCase()));
    workspace.innerHTML = `
      <div class="page-heading"><div><div class="eyebrow">CONTENT</div><h1>All pages</h1><p>Edit the homepage, SEO studies and every SEO tool page.</p></div><div class="heading-actions"><button class="button primary" data-action="new-page">＋ New page</button><button class="button secondary" data-action="refresh-pages">↻ Refresh list</button></div></div>
      <section class="panel table-panel"><div class="panel-heading"><div><h2>Website pages</h2><p>${pages.length} pages available to edit</p></div><div class="search-box"><span>⌕</span><input id="pageSearch" type="search" placeholder="Search pages" aria-label="Search pages" value="${escapeHtml(filter)}"></div></div>
        <div class="table-scroll"><table class="content-table"><thead><tr><th>PAGE</th><th>TYPE</th><th>STATUS</th><th></th></tr></thead><tbody id="pageRows">${filtered.length ? filtered.map(renderPageRow).join('') : '<tr><td colspan="4"><div class="empty-state"><b>No page found</b>Try another search.</div></td></tr>'}</tbody></table></div>
      </section>
      <p class="editor-hint"><span class="hint-bulb">ⓘ</span><span>The editor changes the visible page content and page metadata. Site navigation, canonical URLs, verification files, and tool scripts stay intact.</span></p>`;
    const search = $('#pageSearch');
    search?.addEventListener('input', () => {
      const value = search.value;
      const matches = pages.filter(page => `${page.title} ${page.path} ${page.group}`.toLowerCase().includes(value.toLowerCase()));
      $('#pageRows').innerHTML = matches.length ? matches.map(renderPageRow).join('') : '<tr><td colspan="4"><div class="empty-state"><b>No page found</b>Try another search.</div></td></tr>';
    });
  }

  function getPageEditorRoot(doc, path) {
    const selector = pageRootSelector(path);
    return doc.querySelector(selector) || doc.querySelector('main') || doc.body;
  }

  function buildEditorFrame(html, path) {
    const base = appUrlForPath(path);
    let source = html;
    if (/<head\b[^>]*>/i.test(source)) source = source.replace(/<head\b[^>]*>/i, match => `${match}<base href="${base}">`);
    return source;
  }

  async function openEditor(path, htmlOverride = '', restoring = false) {
    const page = pages.find(item => item.path === path) || { path, title: path.split('/')[0], detail: path, group: classifyPage(path) };
    if (!page) return;
    currentFile = path;
    if (htmlOverride) originalHtml = htmlOverride;
    else if (!restoring) originalHtml = page.html;
    editorRootSelector = pageRootSelector(path);
    dirty = isNewPage;
    frameReady = false;
    currentView = 'editor';
    $$('.side-link[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === 'pages'));
    $('#currentSection').textContent = 'Edit page';
    workspace.innerHTML = `<div class="page-heading"><div><div class="eyebrow">PAGE EDITOR</div><h1>Opening page…</h1></div></div>`;
    if (!originalHtml) {
      try {
        const response = await api(pathApi(path, `?ref=${encodeURIComponent(BRANCH)}`));
        originalHtml = utf8FromBase64(response.content || '');
      } catch (error) { showToast(error.message, 'error'); renderView('pages'); return; }
    }
    const doc = new DOMParser().parseFromString(originalHtml, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim() || page.title;
    const description = doc.querySelector('meta[name="description"]')?.content || '';
    const canonical = doc.querySelector('link[rel="canonical"]')?.href || appUrlForPath(path);
    const mainRoot = doc.querySelector('main h1, h1')?.textContent?.trim() || '';
    const headlineOutsideRoot = (() => {
      const h1 = doc.querySelector('main h1, h1');
      return h1 && !getPageEditorRoot(doc, path).contains(h1) ? h1.textContent.trim() : '';
    })();
    workspace.innerHTML = `
      <div class="editor-topline"><button class="back-link" data-action="open-pages"><span>←</span> All pages</button><div class="editor-actions">${isNewPage ? '<span class="status-pill">New page draft</span><span class="button quiet" title="Available after publishing">Preview ↗</span>' : `<a class="button quiet" href="${escapeHtml(appUrlForPath(path))}" target="_blank" rel="noreferrer">Preview ↗</a>`}<button class="button primary" id="publishButton">${isNewPage ? 'Publish page' : 'Publish changes'} <span>↗</span></button></div></div>
      <div class="editor-layout">
        <section class="editor-main"><div class="editor-meta"><b>Visual editor</b><small id="editorStatus">${escapeHtml(path)}</small></div>
          <div class="toolbar" role="toolbar" aria-label="Text formatting">
            <button type="button" class="tool-button" data-command="undo" title="Undo">↶</button><button type="button" class="tool-button" data-command="redo" title="Redo">↷</button><span class="tool-divider"></span>
            <button type="button" class="tool-button" data-command="bold" title="Bold"><b>B</b></button><button type="button" class="tool-button" data-command="italic" title="Italic"><i>I</i></button><button type="button" class="tool-button" data-command="underline" title="Underline"><u>U</u></button><span class="tool-divider"></span>
            <button type="button" class="tool-button" data-block="P" title="Paragraph">¶</button><button type="button" class="tool-button" data-block="H2" title="Heading 2">H2</button><button type="button" class="tool-button" data-block="H3" title="Heading 3">H3</button><button type="button" class="tool-button" data-command="formatBlock" data-value="BLOCKQUOTE" title="Quote">❞</button><span class="tool-divider"></span>
            <button type="button" class="tool-button" data-command="insertUnorderedList" title="Bulleted list">☷</button><button type="button" class="tool-button" data-command="insertOrderedList" title="Numbered list">1.</button><button type="button" class="tool-button" data-action="insert-link" title="Insert internal link" aria-label="Insert link">↗</button><button type="button" class="tool-button" data-action="remove-link" title="Remove link" aria-label="Remove link" disabled><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 13 4-4"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="m3 3 18 18"/></svg></button><button type="button" class="tool-button" data-action="open-media" title="Insert image">▧</button>
          </div>
          <div class="editor-stage"><iframe class="editor-frame" id="pageFrame" title="Editable page preview" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe><p class="editor-hint"><span class="hint-bulb">✦</span><span>Click into the page to edit its text. Use the toolbar to format selected text. Interactive controls are shown as part of the design; their behavior stays in the published page.</span></p></div>
        </section>
        <aside class="editor-sidebar">
          <section class="panel field-panel"><h3>Page details</h3>
            <div class="field"><label for="pageTitle">Browser title</label><input id="pageTitle" value="${escapeHtml(title)}" maxlength="150"><small class="field-note">Shown in the browser tab and search results.</small></div>
            ${headlineOutsideRoot ? `<div class="field"><label for="pageHeadline">Visible headline</label><input id="pageHeadline" value="${escapeHtml(headlineOutsideRoot)}" maxlength="180"></div>` : ''}
            <div class="field"><label for="pageDescription">Search description</label><textarea id="pageDescription" maxlength="320" placeholder="A short description for search results">${escapeHtml(description)}</textarea><small class="field-note">A short summary for search engines.</small></div>
            <div class="field"><label>Page address</label><div class="url-field"><code>${escapeHtml(canonical)}</code></div><small class="field-note">Fixed to preserve the current canonical URL.</small></div>
          </section>
          <section class="panel field-panel"><h3>Search preview</h3><div class="search-preview"><strong id="seoPreviewTitle">${escapeHtml(title)}</strong><small>${escapeHtml(canonical)}</small><p id="seoPreviewDescription">${escapeHtml(description || 'Add a search description to preview how this page may appear.')}</p></div></section>
          <section class="panel field-panel"><h3>Publishing</h3><div class="settings-row"><span>Visibility</span><b>Public</b></div><div class="settings-row"><span>Site branch</span><b>${BRANCH}</b></div><small class="field-note">Publishing commits this page to the live site repository.</small></section>
        </aside>
      </div>`;

    const frame = $('#pageFrame');
    frame.addEventListener('load', () => {
      try {
        const frameDoc = frame.contentDocument;
        const editRoot = frameDoc.querySelector(editorRootSelector) || frameDoc.querySelector('main') || frameDoc.body;
        if (!editRoot) throw new Error('The visible page area could not be found.');
        editRoot.setAttribute('contenteditable', 'true');
        editRoot.setAttribute('spellcheck', 'true');
        editRoot.style.outline = '2px solid transparent';
        editRoot.style.outlineOffset = '5px';
        editRoot.addEventListener('focusin', () => { editRoot.style.outlineColor = '#77e3c466'; });
        editRoot.addEventListener('focusout', () => { editRoot.style.outlineColor = 'transparent'; });
        editRoot.addEventListener('input', markDirty);
        frameDoc.addEventListener('selectionchange', updateUnlinkButton);
        editRoot.addEventListener('keyup', updateUnlinkButton);
        editRoot.addEventListener('mouseup', updateUnlinkButton);
        editRoot.addEventListener('focusin', updateUnlinkButton);
        frameReady = true;
        updateUnlinkButton();
        $('#editorStatus').textContent = isNewPage ? 'New page draft' : 'Ready to edit';
      } catch (error) {
        $('#editorStatus').textContent = 'Preview unavailable';
        showToast(`The preview could not be opened: ${error.message}`, 'error');
      }
    }, { once: true });
    frame.srcdoc = buildEditorFrame(originalHtml, path);
    $$('.toolbar button').forEach(button => button.addEventListener('mousedown', event => event.preventDefault()));
    $('#publishButton').addEventListener('click', saveCurrentPage);
    $('#pageTitle').addEventListener('input', () => {
      $('#seoPreviewTitle').textContent = $('#pageTitle').value;
      markDirty();
    });
    $('#pageDescription').addEventListener('input', () => {
      $('#seoPreviewDescription').textContent = $('#pageDescription').value || 'Add a search description to preview how this page may appear.';
      markDirty();
    });
    $('#pageHeadline')?.addEventListener('input', markDirty);
  }

  function markDirty() {
    if (!dirty) {
      dirty = true;
      const status = $('#editorStatus');
      if (status) status.textContent = 'Unsaved changes';
    }
  }

  function toolbarClick(event) {
    const commandButton = event.target.closest('[data-command], [data-block]');
    if (commandButton && frameReady) {
      const doc = $('#pageFrame').contentDocument;
      const command = commandButton.dataset.command;
      if (command === 'formatBlock' && commandButton.dataset.value) doc.execCommand(command, false, commandButton.dataset.value);
      else if (command) doc.execCommand(command, false, null);
      else if (commandButton.dataset.block) doc.execCommand('formatBlock', false, commandButton.dataset.block);
      markDirty();
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'insert-link' && frameReady) openInternalLinkPicker();
    if (action === 'remove-link' && frameReady) removeSelectedLinks();
    if (action === 'open-media') openMediaChooser();
    if (action === 'open-pages') leaveEditorAndGo('pages');
    if (action === 'refresh-pages') refreshPagesAndRender();
  }

  function leaveEditorAndGo(view) {
    if (currentView === 'editor' && dirty && !window.confirm('You have unpublished changes. Leave this page and discard them?')) return;
    dirty = false;
    renderView(view);
  }

  function publicPageUrl(path) {
    if (path === 'index.html') return '/';
    if (/\/index\.html$/i.test(path)) return `/${path.slice(0, -11)}/`;
    return `/${path}`;
  }

  function pageSections(page) {
    if (!page.html) return [];
    const doc = new DOMParser().parseFromString(page.html, 'text/html');
    const root = getPageEditorRoot(doc, page.path);
    return [...root.querySelectorAll('[id]')]
      .filter(element => /^H[1-3]$/.test(element.tagName) || /^(SECTION|ARTICLE)$/.test(element.tagName))
      .map(element => ({ id: element.id, label: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 90) || element.id }))
      .filter(item => item.id);
  }

  function comparePoints(doc, firstNode, firstOffset, secondNode, secondOffset) {
    const first = doc.createRange();
    first.setStart(firstNode, firstOffset);
    first.collapse(true);
    const second = doc.createRange();
    second.setStart(secondNode, secondOffset);
    second.collapse(true);
    return first.compareBoundaryPoints(doc.defaultView.Range.START_TO_START, second);
  }

  function applyLinkToRange(doc, root, range, href, isInternal) {
    if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return [];
    const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
    const segments = [];
    let node;
    while ((node = walker.nextNode())) {
      const length = node.nodeValue.length;
      if (!length || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(node.parentElement?.tagName || '')) continue;
      const beginsBeforeTextEnd = comparePoints(doc, range.startContainer, range.startOffset, node, length) < 0;
      const endsAfterTextStart = comparePoints(doc, range.endContainer, range.endOffset, node, 0) > 0;
      if (!beginsBeforeTextEnd || !endsAfterTextStart) continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : length;
      if (to > from) segments.push({ node, from, to });
    }

    const links = [];
    for (const segment of segments.reverse()) {
      const existing = segment.node.parentElement?.closest('a');
      if (existing && root.contains(existing)) {
        existing.setAttribute('href', href);
        if (isInternal) styleInternalLink(existing);
        links.push(existing);
        continue;
      }
      let selected = segment.node;
      if (segment.from > 0) selected = selected.splitText(segment.from);
      const selectedLength = segment.to - segment.from;
      if (selectedLength < selected.length) selected.splitText(selectedLength);
      const anchor = doc.createElement('a');
      anchor.setAttribute('href', href);
      if (isInternal) styleInternalLink(anchor);
      selected.parentNode.insertBefore(anchor, selected);
      anchor.appendChild(selected);
      links.push(anchor);
    }
    return links.reverse();
  }

  function styleInternalLink(link) {
    link.classList.add('cms-internal-link');
    link.style.color = '#77e3c4';
    link.style.textDecoration = 'underline';
    link.style.textDecorationColor = '#77e3c4';
    link.style.textUnderlineOffset = '3px';
  }

  function closestLink(node, root) {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    while (element && element !== root) {
      if (element.tagName === 'A') return element;
      element = element.parentElement;
    }
    return null;
  }

  function unwrapLink(link) {
    const parent = link.parentNode;
    if (!parent) return;
    while (link.firstChild) parent.insertBefore(link.firstChild, link);
    parent.removeChild(link);
  }

  function unlinkLinksFromRange(doc, root, range) {
    if (range.collapsed) {
      const link = closestLink(range.startContainer, root);
      if (!link) return [];
      unwrapLink(link);
      return [link];
    }

    const targets = [...root.querySelectorAll('a')].map(link => {
      const contents = doc.createRange();
      contents.selectNodeContents(link);
      const startsBeforeEnd = comparePoints(doc, range.startContainer, range.startOffset, contents.endContainer, contents.endOffset) < 0;
      const endsAfterStart = comparePoints(doc, range.endContainer, range.endOffset, contents.startContainer, contents.startOffset) > 0;
      if (!startsBeforeEnd || !endsAfterStart) return null;

      const startsBeforeLink = comparePoints(doc, range.startContainer, range.startOffset, contents.startContainer, contents.startOffset) <= 0;
      const endsAfterLink = comparePoints(doc, range.endContainer, range.endOffset, contents.endContainer, contents.endOffset) >= 0;
      const selected = range.cloneRange();
      if (startsBeforeLink) selected.setStart(contents.startContainer, contents.startOffset);
      if (endsAfterLink) selected.setEnd(contents.endContainer, contents.endOffset);
      return { link, selected, wholeLink: startsBeforeLink && endsAfterLink };
    }).filter(Boolean);

    for (const target of targets.reverse()) {
      if (target.wholeLink) {
        unwrapLink(target.link);
        continue;
      }

      const beforeRange = doc.createRange();
      beforeRange.selectNodeContents(target.link);
      beforeRange.setEnd(target.selected.startContainer, target.selected.startOffset);
      const selectedContents = target.selected.cloneContents();
      const afterRange = doc.createRange();
      afterRange.selectNodeContents(target.link);
      afterRange.setStart(target.selected.endContainer, target.selected.endOffset);

      const replacement = doc.createDocumentFragment();
      const beforeContents = beforeRange.cloneContents();
      if (beforeContents.childNodes.length) {
        const beforeLink = target.link.cloneNode(false);
        beforeLink.appendChild(beforeContents);
        replacement.appendChild(beforeLink);
      }
      replacement.appendChild(selectedContents);
      const afterContents = afterRange.cloneContents();
      if (afterContents.childNodes.length) {
        const afterLink = target.link.cloneNode(false);
        afterLink.appendChild(afterContents);
        replacement.appendChild(afterLink);
      }
      target.link.parentNode.insertBefore(replacement, target.link);
      target.link.parentNode.removeChild(target.link);
    }
    return targets.map(target => target.link);
  }

  function updateUnlinkButton() {
    const button = $('[data-action="remove-link"]');
    const frame = $('#pageFrame');
    const doc = frame?.contentDocument;
    const selection = doc?.getSelection();
    if (!button || !doc || !selection || !selection.rangeCount) {
      if (button) button.disabled = true;
      return;
    }
    const root = doc.querySelector(editorRootSelector) || doc.querySelector('main') || doc.body;
    const range = selection.getRangeAt(0);
    const hasLink = range.collapsed
      ? Boolean(closestLink(range.startContainer, root))
      : [...root.querySelectorAll('a')].some(link => {
        const contents = doc.createRange();
        contents.selectNodeContents(link);
        return comparePoints(doc, range.startContainer, range.startOffset, contents.endContainer, contents.endOffset) < 0 &&
          comparePoints(doc, range.endContainer, range.endOffset, contents.startContainer, contents.startOffset) > 0;
      });
    button.disabled = !hasLink;
  }

  function removeSelectedLinks() {
    const frame = $('#pageFrame');
    const doc = frame?.contentDocument;
    const selection = doc?.getSelection();
    if (!doc || !selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0).cloneRange();
    const root = doc.querySelector(editorRootSelector) || doc.querySelector('main') || doc.body;
    const removed = unlinkLinksFromRange(doc, root, range);
    if (!removed.length) {
      showToast('Place the cursor in a link or select linked text to remove it.', 'error');
      updateUnlinkButton();
      return;
    }
    selection.removeAllRanges();
    markDirty();
    updateUnlinkButton();
    showToast(removed.length === 1 ? 'Link removed.' : `${removed.length} links removed.`);
  }

  function openInternalLinkPicker() {
    const frame = $('#pageFrame');
    const selection = frame?.contentDocument?.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      showToast('Select the text you want to link, then choose the link button.', 'error');
      return;
    }
    savedSelection = selection.getRangeAt(0).cloneRange();
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop internal-link-modal';
    overlay.innerHTML = `<form class="modal" id="internalLinkForm" role="dialog" aria-modal="true" aria-labelledby="internalLinkTitle"><div class="eyebrow">LINKS</div><h2 id="internalLinkTitle">Insert link</h2><p>Choose one of your pages and optionally a section, or enter an external URL.</p><div class="field"><label for="internalPage">Destination page</label><select id="internalPage"><option value="">Choose a page</option>${pages.map(page => `<option value="${escapeHtml(page.path)}">${escapeHtml(page.title)} — ${escapeHtml(publicPageUrl(page.path))}</option>`).join('')}</select></div><div class="field"><label for="internalSection">Section (optional)</label><select id="internalSection" disabled><option value="">Top of page</option></select><small class="field-note">Sections are based on headings and named sections on the selected page.</small></div><div class="field"><label for="manualHref">External URL (optional)</label><input id="manualHref" type="url" placeholder="https://example.com/page"><small class="field-note">Enter an external web address here, or leave it blank to use the selected site page.</small></div><div class="field"><label for="internalHref">Link address</label><input id="internalHref" readonly placeholder="Select a page or enter a URL"></div><div class="field"><label for="internalLinkText">Selected text</label><input id="internalLinkText" readonly value="${escapeHtml(selection.toString().trim().slice(0, 180))}"></div><div class="modal-actions"><button type="button" class="button quiet" data-cancel-link>Cancel</button><button type="submit" class="button primary" id="applyInternalLink" disabled>Insert link</button></div></form>`;
    document.body.append(overlay);
    const pageSelect = $('#internalPage', overlay);
    const sectionSelect = $('#internalSection', overlay);
    const hrefField = $('#internalHref', overlay);
    const applyButton = $('#applyInternalLink', overlay);
    const manualHref = $('#manualHref', overlay);
    const updateHref = () => {
      if (manualHref.value.trim()) {
        hrefField.value = manualHref.value.trim();
        applyButton.disabled = false;
        return;
      }
      if (!pageSelect.value) { hrefField.value = ''; applyButton.disabled = true; return; }
      hrefField.value = `${publicPageUrl(pageSelect.value)}${sectionSelect.value ? `#${encodeURIComponent(sectionSelect.value)}` : ''}`;
      applyButton.disabled = false;
    };
    pageSelect.addEventListener('change', () => {
      const page = pages.find(item => item.path === pageSelect.value);
      const sections = page ? pageSections(page) : [];
      sectionSelect.innerHTML = `<option value="">Top of page</option>${sections.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('')}`;
      sectionSelect.disabled = !page || !sections.length;
      updateHref();
    });
    sectionSelect.addEventListener('change', updateHref);
    manualHref.addEventListener('input', updateHref);
    $('#internalLinkForm', overlay).addEventListener('submit', event => {
      event.preventDefault();
      if (!hrefField.value || !savedSelection) return;
      if (manualHref.value.trim()) {
        let parsed;
        try { parsed = new URL(manualHref.value.trim()); } catch { showToast('Enter a complete external URL.', 'error'); return; }
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) { showToast('Use an http, https, or mailto link.', 'error'); return; }
        hrefField.value = parsed.href;
      }
      const frameDocument = frame.contentDocument;
      frame.contentWindow.focus();
      const editRoot = frameDocument.querySelector(editorRootSelector) || frameDocument.querySelector('main') || frameDocument.body;
      const newLinks = applyLinkToRange(frameDocument, editRoot, savedSelection, hrefField.value, !manualHref.value.trim());
      if (!newLinks.length) { showToast('The link could not be added. Re-select the text and try again.', 'error'); return; }
      savedSelection = null;
      overlay.remove();
      frameDocument.getSelection()?.removeAllRanges();
      markDirty();
      showToast('Link inserted.');
    });
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-cancel-link]')) {
        overlay.remove();
        savedSelection = null;
        frame.contentWindow.focus();
      }
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        overlay.remove();
        savedSelection = null;
        frame.contentWindow.focus();
      }
    });
    pageSelect.focus();
  }

  function updateToc(doc, article) {
    if (!article || !doc.querySelector('.mobile-toc, .toc')) return;
    const headings = [...article.querySelectorAll('h2')];
    const used = new Set();
    const records = headings.map(heading => {
      let id = heading.id || slugify(heading.textContent);
      const base = id;
      let suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
      used.add(id);
      heading.id = id;
      return { id, label: heading.textContent.trim() };
    });
    doc.querySelectorAll('.toc nav, .mobile-toc nav').forEach(nav => {
      nav.innerHTML = records.map(item => `<a href="#${escapeHtml(item.id)}">${escapeHtml(item.label)}</a>`).join('');
    });
  }

  function addSitemapEntry(sitemap, slug) {
    const url = `${SITE}/${slug}/`;
    if (sitemap.includes(url)) return sitemap;
    const date = new Date().toISOString().slice(0, 10);
    const entry = `  <url><loc>${url}</loc><lastmod>${date}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n`;
    return /<\/urlset>/i.test(sitemap) ? sitemap.replace(/<\/urlset>/i, `${entry}</urlset>`) : sitemap;
  }

  function relativeMenuHref(pagePath, slug) {
    const directoryDepth = Math.max(0, pagePath.split('/').length - 1);
    return `${'../'.repeat(directoryDepth)}${slug}/`;
  }

  function addStudyMenuEntry(html, pagePath, slug, title) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const dropdown = [...doc.querySelectorAll('details.nav-dropdown')].find(item => item.querySelector('summary')?.textContent.trim() === 'SEO Studies');
    const panel = dropdown?.querySelector('.dropdown-panel');
    if (!panel || [...panel.querySelectorAll('a')].some(link => link.getAttribute('href')?.includes(`${slug}/`))) return html;
    const link = doc.createElement('a');
    link.href = relativeMenuHref(pagePath, slug);
    link.textContent = title;
    panel.append(link);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  function openNewPageDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `<form class="modal" id="newPageForm" role="dialog" aria-modal="true" aria-labelledby="newPageTitle"><div class="eyebrow">CREATE CONTENT</div><h2 id="newPageTitle">Add a new page</h2><p>Start with a page styled like your GEO study. You can edit its headline and content before publishing.</p><div class="field"><label for="newTitle">Page title</label><input id="newTitle" required maxlength="120" placeholder="e.g. Technical SEO field notes"></div><div class="field"><label for="newSlug">URL slug</label><input id="newSlug" required maxlength="70" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="technical-seo-field-notes"><small class="field-note">This becomes <code>nikolaseo.com/your-slug/</code> and stays fixed after publishing.</small></div><div class="field"><label for="newDescription">Search description</label><textarea id="newDescription" maxlength="320" placeholder="A short summary for search results"></textarea></div><label class="menu-checkbox"><input id="newMenuEntry" type="checkbox"><span><b>Add to the SEO Studies menu</b><small>Updates the menu across the website. Leave unchecked to keep the page off the menu.</small></span></label><div class="modal-actions"><button type="button" class="button quiet" data-cancel-new>Cancel</button><button type="submit" class="button primary">Continue to editor →</button></div></form>`;
    document.body.append(overlay);
    const titleInput = $('#newTitle', overlay);
    const slugInput = $('#newSlug', overlay);
    titleInput.addEventListener('input', () => {
      if (!slugInput.dataset.manual) slugInput.value = slugify(titleInput.value);
    });
    slugInput.addEventListener('input', () => { slugInput.dataset.manual = 'true'; });
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-cancel-new]')) overlay.remove();
    });
    $('#newPageForm', overlay).addEventListener('submit', event => {
      event.preventDefault();
      const title = titleInput.value.trim();
      const slug = slugify(slugInput.value.trim());
      const description = $('#newDescription', overlay).value.trim();
      const path = `${slug}/index.html`;
      const exists = tree.some(item => item.path === path || item.path === `${slug}.html`);
      if (!title || exists || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        showToast(exists ? 'That URL is already in use.' : 'Enter a valid title and URL slug using lowercase letters, numbers and hyphens.', 'error');
        return;
      }
      const template = pages.find(page => page.path === 'seo-vs-geo-case-study/index.html') || pages.find(page => page.path.endsWith('/index.html'));
      if (!template?.html) { showToast('Could not find a page template in this repository.', 'error'); return; }
      const doc = new DOMParser().parseFromString(template.html, 'text/html');
      doc.title = `${title} | NikolaSEO`;
      const canonical = doc.querySelector('link[rel="canonical"]');
      if (canonical) canonical.href = `${SITE}/${slug}/`;
      let descriptionTag = doc.querySelector('meta[name="description"]');
      if (!descriptionTag) { descriptionTag = doc.createElement('meta'); descriptionTag.name = 'description'; doc.head.append(descriptionTag); }
      descriptionTag.content = description;
      const h1 = doc.querySelector('.hero h1, main h1');
      if (h1) h1.textContent = title;
      const lead = doc.querySelector('.hero .lead');
      if (lead) lead.textContent = description || 'Add a short introduction to this page.';
      const article = doc.querySelector('article.article');
      if (article) article.innerHTML = '<h2 id="overview">Overview</h2><p>Start writing your page content here.</p>';
      updateToc(doc, article);
      const newHtml = '<!doctype html>\n' + doc.documentElement.outerHTML;
      addNewPageToMenu = $('#newMenuEntry', overlay).checked;
      isNewPage = true;
      overlay.remove();
      openEditor(path, newHtml);
    });
    titleInput.focus();
  }

  async function saveCurrentPage() {
    if (!currentFile || !frameReady) { showToast('The page preview is still loading. Try again in a moment.', 'error'); return; }
    const button = $('#publishButton');
    setBusy(button, true, 'Publishing…');
    $('#connectionStatus').textContent = 'Publishing';
    try {
      const doc = new DOMParser().parseFromString(originalHtml, 'text/html');
      const sourceRoot = getPageEditorRoot(doc, currentFile);
      const previewRoot = $('#pageFrame').contentDocument.querySelector(editorRootSelector) || $('#pageFrame').contentDocument.querySelector('main');
      if (!sourceRoot || !previewRoot) throw new Error('The page content area is missing. No changes were sent.');
      sourceRoot.innerHTML = previewRoot.innerHTML;

      const titleValue = $('#pageTitle').value.trim();
      if (titleValue) doc.title = titleValue;
      const descriptionValue = $('#pageDescription').value.trim();
      let descriptionTag = doc.querySelector('meta[name="description"]');
      if (!descriptionTag && descriptionValue) {
        descriptionTag = doc.createElement('meta');
        descriptionTag.name = 'description';
        doc.head.append(descriptionTag);
      }
      if (descriptionTag) descriptionTag.content = descriptionValue;

      const headline = $('#pageHeadline');
      if (headline) {
        const h1 = doc.querySelector('main h1, h1');
        if (h1) h1.textContent = headline.value.trim();
      }
      if (sourceRoot.matches('article.article')) updateToc(doc, sourceRoot);

      const nextHtml = '<!doctype html>\n' + doc.documentElement.outerHTML;
      let publishedHtml = nextHtml;
      const changes = [{ path: currentFile, content: nextHtml, encoding: 'utf-8' }];
      let commitMessage = `Update ${currentFile} from NikolaSEO Content Studio`;
      if (isNewPage) {
        const slug = currentFile.split('/')[0];
        const articleTitle = doc.querySelector('.hero h1')?.textContent?.trim() || doc.title;
        const sitemapResponse = await api(pathApi('sitemap.xml', `?ref=${encodeURIComponent(BRANCH)}`));
        const sitemap = utf8FromBase64(sitemapResponse.content || '');
        changes.push({ path: 'sitemap.xml', content: addSitemapEntry(sitemap, slug), encoding: 'utf-8' });
        if (addNewPageToMenu) {
          for (const page of pages) {
            if (!page.html) continue;
            const updated = addStudyMenuEntry(page.html, page.path, slug, articleTitle);
            if (updated !== page.html) changes.push({ path: page.path, content: updated, encoding: 'utf-8' });
          }
          const newPageWithMenu = addStudyMenuEntry(nextHtml, currentFile, slug, articleTitle);
          changes[0].content = newPageWithMenu;
          publishedHtml = newPageWithMenu;
        }
        commitMessage = `Publish new page: ${articleTitle}`;
      }
      await commitFiles(changes, commitMessage);
      originalHtml = publishedHtml;
      isNewPage = false;
      addNewPageToMenu = false;
      dirty = false;
      $('#editorStatus').textContent = 'Published successfully';
      $('#connectionStatus').textContent = 'Connected';
      showToast('Published. GitHub Pages is updating your website.');
      await refreshTree();
      const currentFrame = $('#pageFrame');
      if (currentFrame) {
        frameReady = false;
        currentFrame.addEventListener('load', () => {
          const frameDoc = currentFrame.contentDocument;
          const editRoot = frameDoc.querySelector(editorRootSelector) || frameDoc.querySelector('main') || frameDoc.body;
          if (editRoot) {
            editRoot.setAttribute('contenteditable', 'true');
            editRoot.setAttribute('spellcheck', 'true');
            editRoot.addEventListener('input', markDirty);
            frameReady = true;
          }
        }, { once: true });
        currentFrame.srcdoc = buildEditorFrame(originalHtml, currentFile);
      }
    } catch (error) {
      $('#connectionStatus').textContent = 'Connected';
      showToast(error.message || 'Could not publish this page.', 'error');
    } finally {
      setBusy(button, false);
    }
  }

  async function commitFiles(changes, message) {
    if (!token) throw new Error('Your GitHub connection has ended. Refresh and connect again.');
    const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    const parent = await api(`/repos/${OWNER}/${REPO}/git/commits/${ref.object.sha}`);
    const blobs = [];
    for (const file of changes) {
      const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: file.encoding || 'utf-8' })
      });
      blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
      method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree: blobs })
    });
    const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
      method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] })
    });
    await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false })
    });
    return commit;
  }

  async function refreshPagesAndRender() {
    try {
      await refreshTree();
      renderView('pages');
      showToast('Page list refreshed.');
    } catch (error) { showToast(error.message, 'error'); }
  }

  function mediaFiles() {
    return tree.filter(item => item.type === 'blob' && IMAGE_EXTENSIONS.test(item.path) && !/^favicon\.svg$/i.test(item.path)).map(file => ({ ...file, name: file.path.split('/').pop() }));
  }

  function renderMedia() {
    currentView = 'media';
    const files = mediaFiles();
    const cards = files.map(file => {
      const ext = file.name.split('.').pop().toLowerCase();
      const src = `../${file.path.split('/').map(encodeURIComponent).join('/')}`;
      return `<article class="media-card"><div class="media-thumb"><img src="${escapeHtml(src)}" alt="${escapeHtml(file.name)}" loading="lazy"><span class="file-placeholder" hidden>▧</span></div><div class="media-info"><span><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b><small>${escapeHtml(ext.toUpperCase())} · ${formatBytes(file.size || 0)}</small></span></div></article>`;
    }).join('');
    workspace.innerHTML = `
      <div class="page-heading"><div><div class="eyebrow">ASSETS</div><h1>Media library</h1><p>Upload images and add them to any page.</p></div></div>
      <section class="panel" style="padding:16px;margin-bottom:15px"><label class="media-drop" id="mediaDrop" for="mediaUpload"><input type="file" id="mediaUpload" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden><span><b>Drop images here or choose files</b><small>PNG, JPG, WEBP or GIF · Up to 5 MB each · Stored in your site repository</small></span></label><p class="editor-hint" style="margin-bottom:0"><span class="hint-bulb">ⓘ</span><span>Uploads are committed to <code>assets/uploads/</code>. Images stay in the repository and remain available to all pages.</span></p></section>
      <section class="panel table-panel"><div class="panel-heading"><div><h2>Site images</h2><p>${files.length} image${files.length === 1 ? '' : 's'} in the repository</p></div></div><div class="media-grid">${cards || '<div class="media-empty">No uploaded images yet. Add an image above to start your library.</div>'}</div></section>`;
    $('#mediaUpload')?.addEventListener('change', event => uploadImages([...event.target.files]));
    bindMediaFallback(workspace);
    const drop = $('#mediaDrop');
    drop?.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragover'); });
    drop?.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop?.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragover'); uploadImages([...event.dataTransfer.files]); });
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function bindMediaFallback(root) {
    root.querySelectorAll('.media-thumb img').forEach(image => image.addEventListener('error', () => {
      image.hidden = true;
      if (image.nextElementSibling) image.nextElementSibling.hidden = false;
    }, { once: true }));
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function uploadImages(files) {
    if (!files.length) return;
    const valid = files.filter(file => file.size <= 5 * 1024 * 1024 && /^image\/(png|jpeg|webp|gif)$/i.test(file.type));
    const invalid = files.length - valid.length;
    if (!valid.length) { showToast('Choose PNG, JPG, WEBP or GIF images up to 5 MB each.', 'error'); return; }
    const upload = $('#mediaUpload');
    const oldLabel = $('.media-drop b')?.textContent;
    if ($('.media-drop b')) $('.media-drop b').textContent = `Uploading ${valid.length} image${valid.length === 1 ? '' : 's'}…`;
    if ($('#pickerStatus')) $('#pickerStatus').textContent = 'Uploading images…';
    try {
      const changes = [];
      for (const file of valid) {
        const ext = file.name.split('.').pop().toLowerCase();
        const safeName = file.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(-90) || `image.${ext}`;
        const stamped = `${Date.now()}-${safeName}`;
        changes.push({ path: `assets/uploads/${stamped}`, content: await readFileBase64(file), encoding: 'base64' });
      }
      await commitFiles(changes, `Upload ${changes.length} image${changes.length === 1 ? '' : 's'} from NikolaSEO Content Studio`);
      await refreshTree();
      showToast(`${changes.length} image${changes.length === 1 ? '' : 's'} added to the media library.${invalid ? ` ${invalid} unsupported file${invalid === 1 ? '' : 's'} skipped.` : ''}`);
      if ($('#mediaPicker')) renderMediaPicker();
      else if (currentView === 'media') renderMedia();
    } catch (error) {
      showToast(error.message || 'Image upload failed.', 'error');
      if ($('.media-drop b') && oldLabel) $('.media-drop b').textContent = oldLabel;
      if (upload) upload.value = '';
    }
  }

  function insertMedia(path) {
    const frame = $('#pageFrame');
    if (!frame || !frameReady) { showToast('Open a page before inserting an image.', 'error'); return; }
    const prefix = currentFile.includes('/') ? '../'.repeat(currentFile.split('/').length - 1) : '';
    const src = `${prefix}${path.split('/').map(encodeURIComponent).join('/')}`;
    const name = path.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const figure = `<figure class="figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" loading="lazy"></figure>`;
    const doc = frame.contentDocument;
    if (savedSelection) {
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(savedSelection);
    }
    doc.execCommand('insertHTML', false, figure);
    savedSelection = null;
    markDirty();
    $('#mediaPicker')?.remove();
    frame.contentWindow.focus();
  }

  function renderMediaPicker() {
    const overlay = $('#mediaPicker');
    if (!overlay) return;
    const files = mediaFiles();
    const cards = files.map(file => {
      const ext = file.name.split('.').pop().toLowerCase();
      const src = `../${file.path.split('/').map(encodeURIComponent).join('/')}`;
      return `<article class="media-card"><div class="media-thumb"><img src="${escapeHtml(src)}" alt="${escapeHtml(file.name)}" loading="lazy"><span class="file-placeholder" hidden>▧</span></div><div class="media-info"><span><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b><small>${escapeHtml(ext.toUpperCase())} · ${formatBytes(file.size || 0)}</small></span><button class="button secondary small" data-insert-media="${escapeHtml(file.path)}">Insert</button></div></article>`;
    }).join('');
    overlay.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="pickerTitle"><div class="modal-header"><h2 id="pickerTitle">Choose an image</h2><div class="heading-actions"><label class="picker-upload">＋ Upload<input type="file" id="pickerUpload" accept="image/png,image/jpeg,image/webp,image/gif" multiple></label><button class="button quiet small" data-picker-close aria-label="Close media library">Close</button></div></div><p>Select an image to add it where your cursor is in the page.</p><small id="pickerStatus" class="field-note"></small><div class="media-grid">${cards || '<div class="media-empty">No images yet. Upload one to add it to the page.</div>'}</div></section>`;
    $('#pickerUpload')?.addEventListener('change', event => uploadImages([...event.target.files]));
    bindMediaFallback(overlay);
  }

  function openMediaChooser() {
    if (!frameReady) { showToast('Wait for the page preview to finish loading.', 'error'); return; }
    const selection = $('#pageFrame')?.contentDocument?.getSelection();
    savedSelection = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    let overlay = $('#mediaPicker');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mediaPicker';
      overlay.className = 'modal-backdrop media-picker';
      overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest('[data-picker-close]')) overlay.remove();
        const path = event.target.closest('[data-insert-media]')?.dataset.insertMedia;
        if (path) insertMedia(path);
      });
      document.body.append(overlay);
    }
    renderMediaPicker();
  }

  function renderSettings() {
    workspace.innerHTML = `
      <div class="page-heading"><div><div class="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Manage the connection used to publish your website.</p></div></div>
      <div class="settings-grid">
        <section class="panel settings-card"><h2>Website repository</h2><div class="settings-row"><span>Website</span><b><a href="https://nikolaseo.com" target="_blank" rel="noreferrer">NikolaSEO.com ↗</a></b></div><div class="settings-row"><span>Repository</span><b>${OWNER}/${REPO}</b></div><div class="settings-row"><span>Publish branch</span><b>${BRANCH}</b></div><div class="settings-row"><span>Pages managed</span><b>${pages.length}</b></div><div class="settings-actions"><a class="button secondary" href="https://github.com/${OWNER}/${REPO}" target="_blank" rel="noreferrer">Open repository ↗</a></div></section>
        <section class="panel settings-card"><h2>Access and privacy</h2><p style="color:#91a5b6;font-size:10px;line-height:1.7;margin:0">The GitHub key is held in memory for this tab only. The editor sends it directly to GitHub's API to read and publish files; it is not written to browser storage or the site repository.</p><div class="note-box" style="margin-top:14px"><strong>Recommended access:</strong> fine-grained key limited to this repository, with Contents read and write permission. GitHub deployment updates the website after each publishing commit.</div><div class="settings-actions"><button class="button danger" id="disconnectButton">Disconnect GitHub</button></div></section>
      </div>`;
    $('#disconnectButton').addEventListener('click', disconnect);
  }

  function disconnect() {
    token = '';
    repository = null;
    tree = [];
    pages = [];
    currentFile = '';
    originalHtml = '';
    app.hidden = true;
    loginScreen.hidden = false;
    $('#connectionStatus').textContent = 'Disconnected';
    showToast('Disconnected. Your access key has been cleared from this tab.');
  }

  async function handleClick(event) {
    const edit = event.target.closest('[data-edit]');
    if (edit) { await openEditor(edit.dataset.edit); return; }
    const insert = event.target.closest('[data-insert-media]');
    if (insert) { insertMedia(insert.dataset.insertMedia); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'open-pages') { leaveEditorAndGo('pages'); return; }
    if (action === 'open-media') {
      if (event.target.closest('.toolbar')) return;
      renderMedia(); return;
    }
    if (action === 'refresh-pages') { await refreshPagesAndRender(); return; }
    if (action === 'new-page') { openNewPageDialog(); return; }
    if (action === 'back-editor') { renderView('editor'); return; }
  }

  $('#connectForm').addEventListener('submit', connect);
  $('#workspace').addEventListener('click', handleClick);
  $('#workspace').addEventListener('click', toolbarClick);
  $$('.side-link[data-view]').forEach(button => button.addEventListener('click', () => leaveEditorAndGo(button.dataset.view)));
  $('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && currentView === 'editor') {
      event.preventDefault();
      saveCurrentPage();
    }
  });
  window.addEventListener('pagehide', () => { token = ''; });
})();
