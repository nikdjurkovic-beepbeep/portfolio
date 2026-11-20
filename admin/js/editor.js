// Page editor: TinyMCE canvas + publish / SEO / page settings panels.
import { state, can, esc, api, toast, toastError, modal, confirmDialog, fmtDate, fmtAgo, statePill, action, getLinkTargets, clearLinkTargets, debounce } from './core.js';
import { editorConfig } from './editor-config.js';
import { openMediaPicker } from './media.js';

let guard = null;
export async function leaveEditorGuard() { return guard ? guard() : true; }

const EDITOR_CSS = `
html{background:#0b1220}
body{margin:24px auto!important;padding:0 24px 80px!important;max-width:820px;background:#0b1220;color:#ecf2fa}
body.wrap{max-width:1100px}
.cms-protected{display:block;border:1px dashed #77e3c4;border-radius:10px;padding:14px 16px;margin:16px 0;color:#77e3c4;background:#77e3c412;font:600 13px/1.4 system-ui,sans-serif;cursor:default;user-select:none}
.mce-content-body [data-mce-selected="inline-boundary"]{background:#77e3c433}
.mce-content-body *[contentEditable=false][data-mce-selected]{outline:2px solid #77e3c4}
a{color:#77e3c4;text-decoration:underline}
img{max-width:100%;height:auto}
table{border-collapse:collapse}td,th{border:1px solid #26374b;padding:6px 8px}
pre{background:#111d30;border:1px solid #26374b;border-radius:8px;padding:12px;overflow:auto}
`;

function pxWidth(text, font) {
  const c = pxWidth.c || (pxWidth.c = document.createElement('canvas').getContext('2d'));
  c.font = font; return Math.round(c.measureText(text || '').width);
}

export async function renderEditor(ws, id) {
  const data = await api('GET', `/pages/${id}`);
  const { page, regions, seo, terms: pageTerms, permissions: perm, assets } = data;
  const [{ terms }, { pages }, settings] = await Promise.all([api('GET', '/terms'), api('GET', '/pages'), api('GET', '/settings')]);
  let version = page.version;
  let dirty = false;
  let saving = false;
  let lastSaved = page.updated_at;
  let editor = null;
  const timers = [];
  const isArticle = regions.template === 'article';
  const readOnly = !perm.edit;
  const live = ['published', 'private', 'password'].includes(page.state);

  const parentOptions = pages.filter(p => p.id !== page.id && p.state !== 'trash').map(p => `<option value="${p.id}" ${p.id === page.parent_id ? 'selected' : ''}>${esc(p.title)} (${esc(p.url)})</option>`).join('');
  const termBoxes = tax => terms.filter(t => t.taxonomy === tax).map(t => `<label class="check"><input type="checkbox" data-term="${t.id}" ${pageTerms.some(x => x.id === t.id) ? 'checked' : ''} ${readOnly ? 'disabled' : ''}> ${esc(t.name)}</label>`).join('') || `<p class="hint">No ${tax === 'category' ? 'categories' : 'tags'} yet. <a href="#/terms">Add some</a>.</p>`;
  const adv = perm.seoAdvanced ? '' : 'disabled title="Requires the seo.advanced permission"';
  const slug = page.url === '/' ? '' : page.url.replace(/\/$/, '').split('/').pop().replace(/\.html?$/, '');

  ws.innerHTML = `
  <div class="editor-top">
    <a class="back-link" href="#/pages">← Pages</a>
    <div class="editor-title"><b id="edTitle">${esc(page.title)}</b><small>${esc(page.url)} ${statePill(page.state)} ${page.has_draft && page.state !== 'draft' ? '<span class="pill warn" id="draftPill">Unpublished changes</span>' : ''}</small></div>
    <span class="save-state" id="saveState">${page.has_draft ? `Draft saved ${fmtAgo(lastSaved)}` : 'No unsaved changes'}</span>
    <div class="editor-actions">
      <a class="button quiet" id="previewBtn" href="/cms-api/pages/${page.id}/preview" target="_blank" rel="noopener">Preview ↗</a>
      ${readOnly ? '' : '<button class="button secondary" id="saveBtn">Save draft</button>'}
      ${perm.publish ? `<button class="button primary" id="publishBtn">${live ? 'Update live page' : 'Publish'}</button>` : ''}
    </div>
  </div>
  <div class="banners" id="banners">
    ${readOnly ? '<div class="notice">You can view this page but not edit it (it is assigned to another author).</div>' : ''}
    ${data.lockedBy ? `<div class="notice warn" id="lockNotice"><b>${esc(data.lockedBy.name || data.lockedBy.email)}</b> is editing this page right now. Your changes could overwrite theirs. <button class="button small secondary" id="takeover">Take over editing</button></div>` : ''}
    ${page.externalChange ? '<div class="notice warn">This page was changed directly on GitHub since the CMS last published it. You are editing the current GitHub version.</div>' : ''}
    ${!perm.publish && !readOnly ? '<div class="notice">Your role can save drafts. An editor or administrator publishes them.</div>' : ''}
  </div>
  <div class="editor-layout">
    <section class="editor-main">
      ${isArticle ? `<div class="panel hero-fields">
        <div class="field"><label for="heroEyebrow">Eyebrow</label><input id="heroEyebrow" value="${esc(regions.hero.eyebrow)}" maxlength="120"></div>
        <div class="field"><label for="heroHeadline">Headline (H1)</label><input id="heroHeadline" class="big" value="${esc(regions.hero.headline)}" maxlength="200"></div>
        <div class="field"><label for="heroLead">Standfirst</label><textarea id="heroLead" rows="2" maxlength="600">${esc(regions.hero.lead)}</textarea></div>
        <div class="field narrow"><label for="heroDate">Byline date</label><input id="heroDate" type="date" value="${esc(regions.hero.date)}"></div>
      </div>` : ''}
      ${regions.template === 'tool' ? '<p class="hint">Interactive tool areas and scripts are shown as locked blocks. They are preserved exactly; edit the text around them.</p>' : ''}
      <textarea id="bodyEditor"></textarea>
      <p class="hint">Tip: select text and press the link button (or Ctrl/⌘+K) to link to another NikolaSEO page or a section of it. Use the image button to insert from the media library.</p>
    </section>
    <aside class="editor-side">
      <div class="tabs side-tabs" role="tablist"><button class="tab active" data-ptab="publish">Publish</button><button class="tab" data-ptab="seo">SEO</button><button class="tab" data-ptab="page">Page</button></div>
      <div class="ptab" data-panel="publish">
        <section class="panel">
          <dl class="kv compact"><dt>Status</dt><dd>${statePill(page.state)}</dd><dt>Last modified</dt><dd>${fmtDate(page.updated_at)}</dd><dt>First published</dt><dd>${fmtDate(page.published_at)}</dd>${page.scheduled_at ? `<dt>Scheduled</dt><dd>${fmtDate(page.scheduled_at)}</dd>` : ''}</dl>
          ${perm.publish ? `<h3>Schedule</h3><div class="field"><label for="schedAt">Publish ${live ? 'these changes' : 'this page'} at</label><input id="schedAt" type="datetime-local"></div>
            <div class="btn-row"><button class="button secondary small" id="schedBtn">Schedule</button>${page.scheduled_at ? '<button class="button quiet small" id="unschedBtn">Cancel schedule</button>' : ''}</div><small class="hint">Times are in your browser's time zone. The scheduler runs every 5 minutes.</small>` : ''}
        </section>
        ${perm.publish ? `<section class="panel"><h3>Visibility</h3>
          ${['public', 'private', 'password'].map(v => `<label class="radio"><input type="radio" name="vis" value="${v}" ${page.visibility === v ? 'checked' : ''} ${v !== 'public' && !perm.privateVisibility ? 'disabled' : ''} ${page.url === '/' && v !== 'public' ? 'disabled' : ''}> <span><b>${{ public: 'Public', private: 'Private', password: 'Password protected' }[v]}</b><small>${{ public: 'Anyone can see it; indexable per SEO settings.', private: 'Only signed-in users with access. Served by the edge, never stored in the public repo.', password: 'Visitors must enter a password. Content is not in any public file.' }[v]}</small></span></label>`).join('')}
          <div class="field" id="pwField" ${page.visibility === 'password' ? '' : 'hidden'}><label for="pagePw">${page.has_password ? 'New password (leave blank to keep)' : 'Page password'}</label><input id="pagePw" type="text" autocomplete="off" minlength="6"></div>
          <button class="button secondary small" id="visBtn">Apply visibility</button>
          <small class="hint">${live ? 'Applies to the live page immediately.' : 'Takes effect when the page is published.'}</small>
        </section>` : ''}
        <section class="panel"><h3>URL</h3>
          ${page.url === '/' ? '<p class="muted">The homepage URL is fixed.</p>' : `<div class="field"><label for="slugIn">Slug</label><div class="input-prefix"><span>${esc(page.url.slice(0, page.url.length - (page.url.endsWith('/') ? slug.length + 1 : slug.length + (page.url.match(/\.html?$/)?.[0].length || 0))))}</span><input id="slugIn" value="${esc(slug)}" ${readOnly ? 'disabled' : ''}></div></div>
          ${live && can('redirects.manage') ? '<label class="check"><input type="checkbox" id="slugRedirect" checked> Create a 301 redirect from the old URL</label>' : ''}
          ${live && !can('redirects.manage') ? '<p class="hint">Changing a live URL breaks existing links. Ask an administrator to add a redirect.</p>' : ''}
          <button class="button secondary small" id="slugBtn" ${readOnly ? 'disabled' : ''}>Change URL</button>`}
        </section>
        <section class="panel"><h3>History &amp; actions</h3><div class="btn-col">
          ${can('revisions.read') ? '<button class="button quiet small" id="revBtn">Revisions…</button>' : ''}
          ${page.has_draft && live && perm.edit ? '<button class="button quiet small" id="discardBtn">Discard unpublished changes</button>' : ''}
          ${live && perm.publish ? '<button class="button quiet small danger-text" id="unpubBtn">Unpublish (take offline)</button>' : ''}
          ${perm.delete && page.url !== '/' ? '<button class="button quiet small danger-text" id="trashBtn">Move to trash</button>' : ''}
        </div></section>
      </div>
      <div class="ptab" data-panel="seo" hidden>
        <section class="panel">
          <div class="serp"><span class="serp-url">nikolaseo.com${esc(page.url === '/' ? '' : ` › ${page.url.split('/').filter(Boolean).join(' › ')}`)}</span><span class="serp-title" id="serpTitle"></span><span class="serp-desc" id="serpDesc"></span></div>
          <div class="field"><label for="seoTitle">SEO title</label><input id="seoTitle" value="${esc(seo.title)}" maxlength="200"><small class="hint counter" id="titleCount"></small></div>
          <div class="field"><label for="seoDesc">Meta description</label><textarea id="seoDesc" rows="3" maxlength="400">${esc(seo.description)}</textarea><small class="hint counter" id="descCount"></small></div>
          <div class="field"><label for="seoCanonical">Canonical URL</label><input id="seoCanonical" value="${esc(seo.canonical)}" placeholder="https://nikolaseo.com${esc(page.url)}" ${adv}><small class="hint">Leave as the page's own URL unless this page duplicates another.</small></div>
          <div class="toggles"><label class="check"><input type="checkbox" id="seoIndex" ${seo.index !== false ? 'checked' : ''} ${adv}> Index</label><label class="check"><input type="checkbox" id="seoFollow" ${seo.follow !== false ? 'checked' : ''} ${adv}> Follow links</label><label class="check"><input type="checkbox" id="seoSitemap" ${seo.sitemap ? 'checked' : ''}> In sitemap</label><label class="check"><input type="checkbox" id="seoCrumbs" ${seo.breadcrumbs ? 'checked' : ''}> Breadcrumb schema</label></div>
          <div class="field"><label for="seoRobots">Extra robots directives</label><input id="seoRobots" value="${esc(seo.robotsExtra)}" placeholder="e.g. max-image-preview:large, max-snippet:-1" ${adv}></div>
          <small class="hint" id="robotsPreview"></small>
        </section>
        <section class="panel"><h3>Social sharing</h3>
          <div class="field"><label for="ogTitle">Open Graph title</label><input id="ogTitle" value="${esc(seo.ogTitle)}" placeholder="Defaults to the SEO title"></div>
          <div class="field"><label for="ogDesc">Open Graph description</label><textarea id="ogDesc" rows="2" placeholder="Defaults to the meta description">${esc(seo.ogDescription)}</textarea></div>
          <div class="field"><label for="ogImage">Open Graph image</label><div class="copy-row"><input id="ogImage" value="${esc(seo.ogImage)}" placeholder="${esc(settings.settings.default_og_image || 'https://nikolaseo.com/…/image.png (1200×630)')}"><button class="button secondary small" id="ogPick" type="button">Media…</button></div><div class="og-thumb" id="ogThumb"></div></div>
          <div class="field"><label for="ogAlt">Image alt text</label><input id="ogAlt" value="${esc(seo.ogImageAlt)}"></div>
          <div class="field"><label for="ogType">Type</label><select id="ogType">${['', 'website', 'article', 'profile'].map(t => `<option value="${t}" ${seo.ogType === t ? 'selected' : ''}>${t || '—'}</option>`).join('')}</select></div>
          <div class="field"><label for="twCard">X/Twitter card</label><select id="twCard">${['', 'summary', 'summary_large_image'].map(t => `<option value="${t}" ${seo.twitterCard === t ? 'selected' : ''}>${t || '— none —'}</option>`).join('')}</select></div>
          <details class="advanced"><summary>X/Twitter overrides</summary>
            <div class="field"><label for="twTitle">Title</label><input id="twTitle" value="${esc(seo.twitterTitle)}" placeholder="Uses Open Graph title"></div>
            <div class="field"><label for="twDesc">Description</label><input id="twDesc" value="${esc(seo.twitterDescription)}" placeholder="Uses Open Graph description"></div>
            <div class="field"><label for="twImage">Image</label><input id="twImage" value="${esc(seo.twitterImage)}" placeholder="Uses Open Graph image"></div></details>
        </section>
        <section class="panel"><h3>Schema markup (JSON-LD)</h3>
          <textarea id="seoSchema" class="mono" rows="9" spellcheck="false" ${adv}>${esc(seo.schema)}</textarea>
          <div class="btn-row"><button class="button quiet small" id="schemaValidate" type="button">Validate</button>${perm.seoAdvanced ? '<button class="button quiet small" id="schemaArticle" type="button">Insert Article template</button><button class="button quiet small" id="schemaFormat" type="button">Format</button>' : ''}</div>
          <small class="hint" id="schemaMsg">Separate several JSON-LD blocks with a blank line. Breadcrumb schema is generated automatically when enabled above.</small>
        </section>
        ${can('redirects.read') ? `<section class="panel"><h3>Redirects</h3><div id="pageRedirects" class="muted">Loading…</div>${can('redirects.manage') ? '<button class="button quiet small" id="addRedirectHere">＋ Redirect an old URL to this page</button>' : ''}</section>` : ''}
      </div>
      <div class="ptab" data-panel="page" hidden>
        <section class="panel"><h3>Hierarchy</h3>
          <div class="field"><label for="parentSel">Parent page</label><select id="parentSel" ${readOnly ? 'disabled' : ''}><option value="">— None —</option>${parentOptions}</select><small class="hint">Used for breadcrumbs and the page tree. The URL does not change.</small></div>
          <div class="field narrow"><label for="menuOrder">Order</label><input id="menuOrder" type="number" value="${page.menu_order}" ${readOnly ? 'disabled' : ''}></div>
        </section>
        <section class="panel"><h3>Categories</h3>${termBoxes('category')}<h3>Tags</h3>${termBoxes('tag')}</section>
        <section class="panel"><dl class="kv compact"><dt>Layout</dt><dd>${esc(regions.template)}</dd><dt>File</dt><dd><code>${esc(page.path)}</code></dd><dt>Created</dt><dd>${fmtDate(page.created_at)}</dd><dt>Version</dt><dd id="verLabel">${version}</dd></dl></section>
      </div>
    </aside>
  </div>`;

  const $ = s => ws.querySelector(s);
  const $$ = s => [...ws.querySelectorAll(s)];

  /* ---------- dirty tracking ---------- */
  const saveState = $('#saveState');
  const markDirty = () => { if (readOnly) return; if (!dirty) { dirty = true; saveState.textContent = 'Unsaved changes'; saveState.className = 'save-state dirty'; } };
  ws.querySelectorAll('.editor-main input, .editor-main textarea, [data-panel="seo"] input, [data-panel="seo"] textarea, [data-panel="seo"] select, [data-panel="page"] input, [data-panel="page"] select').forEach(el => {
    if (['schedAt', 'slugIn', 'pagePw'].includes(el.id)) return;
    el.addEventListener('input', markDirty); el.addEventListener('change', markDirty);
  });
  const beforeUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  guard = async () => {
    if (!dirty) return true;
    const ok = await confirmDialog('Leave without saving?', 'You have changes that are not saved as a draft yet.', { confirmLabel: 'Discard changes', danger: true });
    if (ok) dirty = false; else history.replaceState(null, '', `#/pages/${page.id}`);
    return Boolean(ok);
  };

  /* ---------- tabs ---------- */
  $$('[data-ptab]').forEach(b => (b.onclick = () => { $$('[data-ptab]').forEach(x => x.classList.toggle('active', x === b)); $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.ptab; }); }));

  /* ---------- SEO live helpers ---------- */
  const updateSerp = () => {
    const t = $('#seoTitle').value || page.title;
    const d = $('#seoDesc').value;
    $('#serpTitle').textContent = t; $('#serpDesc').textContent = d || 'No meta description — Google will pick text from the page.';
    const tw = pxWidth(t, '20px Arial'), dw = pxWidth(d, '14px Arial');
    $('#titleCount').innerHTML = `${t.length} characters · ~${tw}px <span class="${tw > 580 ? 'bad' : 'ok'}">${tw > 580 ? '(likely truncated, aim ≤ 580px)' : '(fits)'}</span>`;
    $('#descCount').innerHTML = `${d.length} characters · ~${dw}px <span class="${dw > 920 || d.length < 70 ? 'warn-text' : 'ok'}">${dw > 920 ? '(may be truncated)' : d.length < 70 ? '(short)' : '(good)'}</span>`;
    const idx = $('#seoIndex').checked, fol = $('#seoFollow').checked;
    const robots = [idx ? null : 'noindex', fol ? null : 'nofollow', ...$('#seoRobots').value.split(',').map(s => s.trim()).filter(Boolean)].filter(Boolean);
    $('#robotsPreview').innerHTML = robots.length ? `Output: <code>&lt;meta name="robots" content="${esc(robots.join(', '))}"&gt;</code>` : 'Output: no robots meta (defaults to index, follow).';
    const sm = $('#seoSitemap');
    if (!idx) { sm.checked = false; sm.disabled = true; sm.parentElement.title = 'Noindex pages are never in the sitemap'; } else sm.disabled = false;
    const img = $('#ogImage').value;
    const thumb = $('#ogThumb');
    if (thumb.dataset.src !== img) {
      thumb.dataset.src = img;
      thumb.innerHTML = img ? `<img src="${esc(img)}" alt="">` : '';
      thumb.querySelector('img')?.addEventListener('error', () => { thumb.innerHTML = '<small class="bad">Image not found at that URL</small>'; });
    }
  };
  ['#seoTitle', '#seoDesc', '#seoIndex', '#seoFollow', '#seoRobots', '#ogImage'].forEach(s => $(s).addEventListener('input', updateSerp));
  $('#seoIndex').addEventListener('change', updateSerp);
  updateSerp();
  $('#ogPick').onclick = () => openMediaPicker({ imagesOnly: true, onSelect: m => { $('#ogImage').value = `https://nikolaseo.com/${m.path}`; if (m.alt && !$('#ogAlt').value) $('#ogAlt').value = m.alt; updateSerp(); markDirty(); } });
  const validateSchema = () => {
    const text = $('#seoSchema').value.trim();
    if (!text) { $('#schemaMsg').innerHTML = '<span class="muted">No schema.</span>'; return true; }
    const blocks = (() => { try { JSON.parse(text); return [text]; } catch { return text.split(/\n\s*\n/).filter(b => b.trim()); } })();
    for (const [i, b] of blocks.entries()) {
      try { const j = JSON.parse(b); if (!j['@context'] && !j['@graph']) throw new Error('missing "@context"'); } catch (e) { $('#schemaMsg').innerHTML = `<span class="bad">Block ${i + 1}: ${esc(e.message)}</span>`; return false; }
    }
    $('#schemaMsg').innerHTML = `<span class="ok">Valid JSON-LD (${blocks.length} block${blocks.length > 1 ? 's' : ''}).</span> Test rich results in Google's tool after publishing.`;
    return true;
  };
  $('#schemaValidate').onclick = validateSchema;
  $('#schemaFormat')?.addEventListener('click', () => { try { $('#seoSchema').value = JSON.stringify(JSON.parse($('#seoSchema').value), null, 2); markDirty(); } catch { validateSchema(); } });
  $('#schemaArticle')?.addEventListener('click', () => {
    const tpl = { '@context': 'https://schema.org', '@type': 'Article', headline: $('#heroHeadline')?.value || page.title, description: $('#seoDesc').value, datePublished: $('#heroDate')?.value || (page.published_at || '').slice(0, 10), dateModified: new Date().toISOString().slice(0, 10), author: { '@type': 'Person', name: 'Nikola Djurkovic', url: 'https://nikolaseo.com/' }, publisher: { '@type': 'Person', name: 'Nikola Djurkovic' }, mainEntityOfPage: `https://nikolaseo.com${page.url}`, ...($('#ogImage').value ? { image: $('#ogImage').value } : {}) };
    const cur = $('#seoSchema').value.trim();
    $('#seoSchema').value = cur ? `${cur}\n\n${JSON.stringify(tpl, null, 2)}` : JSON.stringify(tpl, null, 2);
    markDirty(); validateSchema();
  });

  /* ---------- redirects for this URL ---------- */
  const loadRedirects = async () => {
    const box = $('#pageRedirects'); if (!box) return;
    try {
      const r = await api('GET', `/redirects?q=${encodeURIComponent(page.url)}&per=50`);
      const rel = r.redirects.filter(x => x.target === page.url || x.target === `https://nikolaseo.com${page.url}` || x.source === page.url);
      box.innerHTML = rel.length ? `<ul class="plain-list">${rel.map(x => `<li><span><code>${esc(x.source)}</code> → <code>${esc(x.target)}</code><small>${x.code} · ${x.active ? 'active' : 'inactive'} · ${x.hits} hits</small></span></li>`).join('')}</ul>` : '<p class="muted">No redirects point to or from this URL.</p>';
    } catch (e) { box.textContent = e.message; }
  };
  loadRedirects();
  $('#addRedirectHere')?.addEventListener('click', async () => {
    const m = modal('Redirect an old URL here', `<div class="field"><label for="rhSource">Old URL path</label><input id="rhSource" placeholder="/old-page/"></div><div class="field"><label for="rhCode">Type</label><select id="rhCode"><option value="301">301 Permanent</option><option value="302">302 Temporary</option><option value="308">308 Permanent (keep method)</option><option value="307">307 Temporary (keep method)</option></select></div><p class="hint">Target: <code>${esc(page.url)}</code></p>`, { actions: '<button class="button primary" id="rhSave">Create redirect</button>' });
    m.$('#rhSave').onclick = action(m.$('#rhSave'), async () => {
      const r = await api('POST', '/redirects', { source: m.$('#rhSource').value, target: page.url, code: Number(m.$('#rhCode').value) });
      toast(r.issues?.length ? `Redirect created with warnings: ${r.issues.map(i => i.message).join(' ')}` : 'Redirect created and live.', r.issues?.some(i => i.level === 'error') ? 'warn' : 'success');
      m.close(); loadRedirects();
    }, 'Saving…');
  });

  /* ---------- visibility ---------- */
  $$('input[name="vis"]').forEach(r => (r.onchange = () => { $('#pwField').hidden = r.value !== 'password' || !r.checked; }));
  $('#visBtn')?.addEventListener('click', e => action(e.target, async () => {
    const vis = ws.querySelector('input[name="vis"]:checked').value;
    if (live && vis !== page.visibility && !(await confirmDialog('Change visibility now?', vis === 'public' ? 'The page will be published to the public website and repository.' : `The page will be removed from the public website and repository and served only to ${vis === 'private' ? 'signed-in users' : 'visitors with the password'}. Copies already in the public git history cannot be removed by the CMS.`, { confirmLabel: 'Apply' }))) return;
    const r = await api('POST', `/pages/${page.id}/visibility`, { visibility: vis, password: $('#pagePw')?.value || undefined });
    toast(r.warning || `Visibility set to ${vis}.`, r.warning ? 'warn' : 'success', 8000);
    dirty = false; reload();
  }, 'Applying…')());

  /* ---------- URL ---------- */
  $('#slugBtn')?.addEventListener('click', e => action(e.target, async () => {
    const newSlug = $('#slugIn').value.trim();
    if (newSlug === slug) return toast('The URL is unchanged.');
    if (dirty) await saveDraft();
    if (live && !(await confirmDialog('Change the URL of a live page?', `The page moves from <code>${esc(page.url)}</code> to a new URL.${$('#slugRedirect')?.checked ? ' A 301 redirect will send visitors and search engines from the old URL.' : ' <b>No redirect will be created — the old URL will return 404.</b>'}`, { confirmLabel: 'Change URL' }))) return;
    const r = await api('POST', `/pages/${page.id}/slug`, { slug: newSlug, createRedirect: Boolean($('#slugRedirect')?.checked) });
    toast(`URL changed to ${r.url}.${r.redirect ? ' Redirect created.' : ''}${r.menuNeedsPublish ? ' The navigation menu was updated — publish it from Navigation.' : ''}`, 'success', 9000);
    clearLinkTargets(); dirty = false; reload();
  }, 'Moving…')());

  /* ---------- collecting + saving ---------- */
  const collect = () => ({
    base_version: version,
    body: editor ? editor.getContent() : undefined,
    hero: isArticle ? { eyebrow: $('#heroEyebrow').value, headline: $('#heroHeadline').value, lead: $('#heroLead').value, date: $('#heroDate').value } : undefined,
    seo: {
      title: $('#seoTitle').value, description: $('#seoDesc').value, ogTitle: $('#ogTitle').value, ogDescription: $('#ogDesc').value, ogImage: $('#ogImage').value, ogImageAlt: $('#ogAlt').value,
      ogType: $('#ogType').value, twitterCard: $('#twCard').value, twitterTitle: $('#twTitle').value, twitterDescription: $('#twDesc').value, twitterImage: $('#twImage').value,
      ...(perm.seoAdvanced ? { canonical: $('#seoCanonical').value, robotsExtra: $('#seoRobots').value, index: $('#seoIndex').checked, follow: $('#seoFollow').checked, schema: $('#seoSchema').value } : {})
    },
    sitemap: $('#seoSitemap').checked,
    breadcrumbs: $('#seoCrumbs').checked,
    parent_id: $('#parentSel').value ? Number($('#parentSel').value) : null,
    menu_order: Number($('#menuOrder').value) || 0,
    terms: $$('[data-term]:checked').map(x => Number(x.dataset.term)),
    title: isArticle ? $('#heroHeadline').value : undefined
  });

  async function saveDraft({ autosave = false, takeover = false, allowRemoveProtected = false } = {}) {
    if (readOnly || saving) return false;
    if (perm.seoAdvanced && !validateSchema()) { if (!autosave) { toast('Fix the schema markup JSON before saving.', 'error'); $('[data-ptab="seo"]').click(); } return false; }
    saving = true;
    saveState.textContent = autosave ? 'Autosaving…' : 'Saving…';
    try {
      const r = await api('PUT', `/pages/${page.id}/draft`, { ...collect(), autosave, takeover, allowRemoveProtected });
      version = r.version; dirty = false; lastSaved = r.savedAt;
      editor?.setDirty(false);
      $('#verLabel').textContent = version;
      saveState.textContent = autosave ? `Autosaved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      saveState.className = 'save-state';
      $('#edTitle').textContent = collect().title || page.title;
      if (!$('#draftPill') && live) $('.editor-title small').insertAdjacentHTML('beforeend', ' <span class="pill warn" id="draftPill">Unpublished changes</span>');
      return true;
    } catch (e) {
      saveState.textContent = 'Not saved'; saveState.className = 'save-state dirty';
      if (e.data?.code === 'version_conflict') conflictDialog(e.message);
      else if (e.data?.code === 'locked') {
        if (!autosave && await confirmDialog('Page is being edited', `${esc(e.message)} Take over? Their unsaved work is not affected, but your save will become the newest version.`, { confirmLabel: 'Take over and save' })) { saving = false; return saveDraft({ takeover: true }); }
      } else if (e.data?.code === 'protected_removed') {
        if (can('unfiltered_html') && await confirmDialog('Remove interactive blocks?', `${esc(e.message)} This can break the tool on this page.`, { confirmLabel: 'Remove them', danger: true })) { saving = false; return saveDraft({ allowRemoveProtected: true }); }
        else if (!autosave) toast('Use Undo to restore the removed block(s).', 'error');
      } else if (!autosave) toastError(e);
      return false;
    } finally { saving = false; }
  }

  function conflictDialog(message) {
    const m = modal('Someone else changed this page', `<p>${esc(message)}</p><p class="muted">Your current text is below so you can copy anything you need before reloading.</p><textarea class="mono" rows="8" readonly>${esc(editor?.getContent() || '')}</textarea>`,
      { wide: true, actions: '<button class="button quiet" data-keep>Keep editing</button><button class="button primary" data-reload>Reload latest version</button>' });
    m.$('[data-keep]').onclick = () => m.close();
    m.$('[data-reload]').onclick = () => { m.close(); dirty = false; reload(); };
  }

  function reload() { dirty = false; window.dispatchEvent(new HashChangeEvent('hashchange')); }

  $('#saveBtn')?.addEventListener('click', e => action(e.target, async () => { if (await saveDraft()) toast('Draft saved. The live page is unchanged.'); }, 'Saving…')());

  $('#publishBtn')?.addEventListener('click', e => action(e.target, async () => {
    if (dirty || !page.has_draft) { if (!(await saveDraft())) return; }
    const vis = page.visibility;
    if (!(await confirmDialog(live ? 'Update the live page?' : 'Publish this page?', `${vis === 'public' ? 'The page will be committed to the website repository and go live within about a minute.' : `The page will be live for ${vis === 'private' ? 'signed-in users' : 'visitors with the password'} only.`} The sitemap is updated automatically.`, { confirmLabel: live ? 'Update' : 'Publish' }))) return;
    try {
      await api('POST', `/pages/${page.id}/publish`, { base_version: version });
    } catch (err) {
      if (err.data?.code === 'stale_file' || /changed on GitHub/.test(err.message)) {
        if (can('pages.publish_any') && await confirmDialog('The live file changed on GitHub', `${esc(err.message)}<br><br>Publishing anyway will <b>replace</b> the GitHub version with yours.`, { confirmLabel: 'Publish anyway', danger: true })) {
          await api('POST', `/pages/${page.id}/publish`, { base_version: version, force: true });
        } else return;
      } else throw err;
    }
    toast(vis === 'public' ? 'Published. GitHub Pages updates the site in about a minute.' : 'Published.', 'success', 7000);
    dirty = false; clearLinkTargets(); reload();
  }, 'Publishing…')());

  $('#schedBtn')?.addEventListener('click', e => action(e.target, async () => {
    const v = $('#schedAt').value;
    if (!v) return toast('Choose a date and time.', 'error');
    if (dirty || !page.has_draft) { if (!(await saveDraft())) return; }
    const r = await api('POST', `/pages/${page.id}/schedule`, { at: new Date(v).toISOString() });
    toast(`Scheduled for ${fmtDate(r.scheduled_at)}.`); dirty = false; reload();
  }, 'Scheduling…')());
  $('#unschedBtn')?.addEventListener('click', e => action(e.target, async () => { await api('POST', `/pages/${page.id}/unschedule`, {}); toast('Schedule cancelled.'); reload(); })());

  $('#discardBtn')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Discard unpublished changes?', 'The editor will show the live version again. The discarded draft stays in revision history.', { confirmLabel: 'Discard', danger: true }))) return;
    try { await api('POST', `/pages/${page.id}/discard-draft`, {}); dirty = false; toast('Draft discarded.'); reload(); } catch (e) { toastError(e); }
  });
  $('#unpubBtn')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Unpublish this page?', `<code>${esc(page.url)}</code> will return 404 and be removed from the sitemap. The content is kept as a draft. Consider a redirect if the page has links or rankings.`, { confirmLabel: 'Unpublish', danger: true }))) return;
    try { await api('POST', `/pages/${page.id}/unpublish`, {}); toast('Unpublished. The page is now a draft.'); dirty = false; reload(); } catch (e) { toastError(e); }
  });
  $('#trashBtn')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Move to trash?', live ? 'This takes the page offline.' : 'You can restore it from the trash.', { confirmLabel: 'Move to trash', danger: true }))) return;
    try { await api('POST', `/pages/${page.id}/trash`, {}); dirty = false; toast('Moved to trash.'); location.hash = '#/pages'; } catch (e) { toastError(e); }
  });
  $('#revBtn')?.addEventListener('click', () => revisionsDialog(page, () => { dirty = false; reload(); }));
  $('#takeover')?.addEventListener('click', async () => { await api('POST', `/pages/${page.id}/lock`, { takeover: true }); $('#lockNotice').remove(); toast('You are now editing this page.'); });

  /* ---------- TinyMCE ---------- */
  const targets = await getLinkTargets().catch(() => []);
  const linkList = targets.filter(t => t.id !== page.id || true).map(t => ({
    title: `${t.title}${t.published ? '' : ' (draft)'}${t.visibility !== 'public' ? ` (${t.visibility})` : ''}`,
    menu: [{ title: `${t.url} — top of page`, value: t.url }, ...t.sections.map(s => ({ title: `§ ${s.label}`, value: `${t.id === page.id ? '' : t.url}#${s.id}` }))]
  }));
  await new Promise(resolve => {
    tinymce.init(editorConfig({
      target: $('#bodyEditor'),
      contentCss: [...new Set(['/site.css', ...(assets.stylesheets || [])])],
      contentStyle: `${assets.styles || ''}\n${EDITOR_CSS}`,
      bodyClass: isArticle ? 'article' : 'wrap',
      // Relative image paths in the page resolve against the page's own folder, as on the live site.
      baseUrl: `${location.origin}${page.url.endsWith('/') ? page.url : page.url.replace(/[^/]*$/, '')}`,
      linkList,
      height: Math.max(560, window.innerHeight - 260),
      setup: ed => {
        ed.ui.registry.addButton('cmsimage', { icon: 'image', tooltip: 'Insert image or file from the media library', onAction: () => openMediaPicker({ onSelect: m => insertMedia(ed, m) }) });
        ed.on('init', () => {
          ed.setContent(regions.body || '<p></p>');
          ed.undoManager.clear();
          ed.setDirty(false);
          if (readOnly) ed.mode.set('readonly');
          editor = ed; resolve();
        });
        // TinyMCE's own dirty flag ignores non-content commands (e.g. visual aids on init).
        ed.on('dirty input undo redo', () => { if (editor) markDirty(); });
        ed.addShortcut('meta+s', 'Save draft', () => saveDraft().then(ok => ok && toast('Draft saved.')));
      }
    }));
  });

  /* ---------- autosave + locks ---------- */
  if (!readOnly) {
    if (!data.lockedBy) api('POST', `/pages/${page.id}/lock`, {}).catch(() => {});
    timers.push(setInterval(() => { if (dirty && !saving) saveDraft({ autosave: true }); }, 30000));
    timers.push(setInterval(async () => {
      try {
        const l = await api('POST', `/pages/${page.id}/lock`, {});
        if (l.locked && !$('#lockNotice')) $('#banners').insertAdjacentHTML('beforeend', `<div class="notice warn" id="lockNotice"><b>${esc(l.by?.name || l.by?.email || 'Someone')}</b> started editing this page.</div>`);
        if (l.version !== version && !saving) $('#banners').insertAdjacentHTML('beforeend', '<div class="notice warn">This page was saved by someone else. Reload before continuing to avoid a conflict.</div>');
      } catch { /* ignore */ }
    }, 60000));
  }
  document.addEventListener('keydown', ctrlS);
  function ctrlS(e) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveDraft().then(ok => ok && toast('Draft saved.')); } }

  function cleanup() {
    timers.forEach(clearInterval);
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('keydown', ctrlS);
    guard = null;
    if (!readOnly) fetch(`/cms-api/pages/${page.id}/lock`, { method: 'DELETE', headers: { 'X-CSRF-Token': state.csrf }, keepalive: true }).catch(() => {});
    try { editor?.remove(); } catch { /* ignore */ }
    tinymce.get('bodyEditor')?.remove();
  }
  return cleanup;
}

function insertMedia(ed, m) {
  const src = `/${m.path.split('/').map(encodeURIComponent).join('/')}`;
  if (!/^image\//.test(m.mime)) {
    ed.insertContent(`<a href="${esc(src)}">${esc(m.title || m.path.split('/').pop())}</a>`);
    return;
  }
  const dims = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : '';
  const img = `<img src="${esc(src)}" alt="${esc(m.alt || '')}"${dims} loading="lazy">`;
  ed.insertContent(m.caption ? `<figure class="figure">${img}<figcaption class="caption">${esc(m.caption)}</figcaption></figure><p></p>` : `<figure class="figure">${img}</figure><p></p>`);
  if (!m.alt) toast('This image has no alt text. Select it and use the image button to add a description.', 'warn', 8000);
}

async function revisionsDialog(page, onRestored) {
  const { revisions } = await api('GET', `/pages/${page.id}/revisions`);
  const label = { autosave: 'Autosave', draft: 'Draft saved', publish: 'Published', restore: 'Restored', import: 'Imported from GitHub', unpublish: 'Unpublished' };
  const m = modal(`Revisions — ${page.title}`, `<p class="muted">Every save and publish is kept. Restoring loads a revision as a draft; nothing goes live until you publish.</p>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>When</th><th>Type</th><th>By</th><th>Size</th><th></th></tr></thead><tbody>
    ${revisions.map(r => `<tr><td>${fmtDate(r.created_at)}</td><td>${esc(label[r.kind] || r.kind)}</td><td>${esc(r.user_name || '—')}</td><td>${Math.round(r.size / 1024)} KB</td><td class="row-actions"><a class="button quiet small" href="/cms-api/pages/${page.id}/preview?rev=${r.id}" target="_blank" rel="noopener">View</a><button class="button quiet small" data-compare="${r.id}">Compare</button>${can('pages.edit_own') || can('pages.edit_any') ? `<button class="button secondary small" data-restore="${r.id}">Restore as draft</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div><div id="diffBox"></div>`, { wide: true });
  m.el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.restore) {
        if (!(await confirmDialog('Restore this revision?', 'It replaces the current draft (the current draft stays in history).', { confirmLabel: 'Restore as draft' }))) return;
        const r = await api('POST', `/revisions/${b.dataset.restore}/restore`, {});
        toast(r.note); m.close(); onRestored();
      }
      if (b.dataset.compare) {
        const [a, cur] = await Promise.all([api('GET', `/revisions/${b.dataset.compare}`), api('GET', `/revisions/${revisions[0].id}`)]);
        m.$('#diffBox').innerHTML = `<h3>Text changes: selected revision → latest</h3>${wordDiff(a.text, cur.text)}`;
      }
    } catch (err) { toastError(err); }
  });
}

/** Small word-level diff (LCS on words, capped for size). */
function wordDiff(a, b) {
  const A = a.split(/\s+/).slice(0, 4000), B = b.split(/\s+/).slice(0, 4000);
  if (A.join(' ') === B.join(' ')) return '<p class="muted">No text differences (changes may be in markup, SEO or layout).</p>';
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(esc(A[i])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`<del>${esc(A[i++])}</del>`);
    else out.push(`<ins>${esc(B[j++])}</ins>`);
  }
  while (i < n) out.push(`<del>${esc(A[i++])}</del>`);
  while (j < m) out.push(`<ins>${esc(B[j++])}</ins>`);
  // Collapse long unchanged runs
  const html = out.join(' ').replace(/((?:(?!<(?:ins|del)>)[^<\s]+ ){40,})/g, run => { const w = run.trim().split(' '); return `${w.slice(0, 12).join(' ')} <span class="muted">…</span> ${w.slice(-12).join(' ')} `; });
  return `<div class="diff">${html}</div>`;
}
