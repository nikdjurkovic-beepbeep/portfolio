// NikolaSEO Content Studio — app shell, auth, routing and the simpler views.
import { state, can, canAny, esc, api, toast, toastError, modal, confirmDialog, fmtDate, fmtAgo, statePill, pageHeading, action, copyText, downloadFromApi, clearLinkTargets, STATE_LABEL } from './core.js';
import { renderEditor, leaveEditorGuard } from './editor.js';
import { renderRedirects } from './redirects-view.js';
import { renderMedia } from './media.js';
import { renderMenus } from './menus.js';
import { forcedEnrollment, accountPanel } from './mfa.js';

const root = document.getElementById('root');

/* ============================================================ Boot ==== */

async function boot() {
  window.addEventListener('cms:signed-out', () => { if (state.user) { state.user = null; toast('Your session ended. Sign in again.', 'error'); renderLogin(); } });
  window.addEventListener('cms:mfa-required', () => { if (state.user) startForcedEnrollment(); });
  const hash = location.hash;
  if (hash.startsWith('#reset=')) return renderReset(hash.slice(7));
  try {
    const me = await api('GET', '/auth/me');
    setSession(me);
    if (me.mfa?.mustEnroll) return startForcedEnrollment();
    listen();
    route();
  } catch {
    const setup = await api('GET', '/setup').catch(() => ({}));
    if (setup.needsSetup) renderSetup(); else renderLogin();
  }
}

function setSession(me) {
  state.user = me.user; state.caps = new Set(me.caps); state.csrf = me.csrf; state.mfa = me.mfa || null;
}

function enterApp() {
  if (state.mfa?.mustEnroll) return startForcedEnrollment();
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^\/(?![\/\\])[^\\]*$/.test(next)) { location.href = next; return; } // same-origin paths only (blocks //host and /\host)
  if (!location.hash || location.hash === '#login') history.replaceState(null, '', '#/dashboard');
  listen();
  route();
}

function startForcedEnrollment() {
  document.getElementById('app')?.remove();
  forcedEnrollment(root, {
    email: state.user.email,
    onSignOut: async () => { await api('POST', '/auth/logout').catch(() => {}); state.user = null; renderLogin(); },
    onDone: async () => { setSession(await api('GET', '/auth/me')); root.innerHTML = ''; enterApp(); }
  });
}

/* ============================================================ Auth ==== */

function authShell(inner) {
  root.innerHTML = `<section class="login-screen"><div class="login-card">
    <a class="brand" href="/"><span class="brand-mark">ND<span>.</span></span><span class="brand-copy">NIKOLASEO <small>CONTENT STUDIO</small></span></a>
    ${inner}</div><div class="login-footer">NikolaSEO.com · Content Studio</div></section>`;
}

function renderLogin(message = '') {
  authShell(`<div class="login-kicker">SIGN IN</div><h1>Welcome back.</h1>
    <form id="loginForm" autocomplete="on">
      <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>
      <div class="form-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</div>
      <button class="button primary wide" type="submit">Sign in</button>
    </form>
    <p class="hint">Forgot your password? Ask an administrator for a reset link.</p>`);
  const form = document.getElementById('loginForm');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const me = await api('POST', '/auth/login', { email: form.email.value, password: form.password.value });
      if (me.twoFactorRequired) { renderCodeStep(me.challenge, form.email.value); return; }
      setSession(me);
      enterApp();
    } catch (err) {
      const box = form.querySelector('.form-error'); box.hidden = false; box.textContent = err.message;
    } finally { btn.disabled = false; }
  });
  form.email.focus();
}

function renderCodeStep(challenge, email) {
  let recovery = false;
  authShell(`<div class="login-kicker">TWO-FACTOR AUTHENTICATION</div><h1>Enter your code</h1>
    <p class="login-intro" id="codeIntro">Open your authenticator app and enter the 6-digit code for <b>NikolaSEO</b> (${esc(email)}).</p>
    <form id="codeForm" autocomplete="off">
      <div class="field"><label for="otp" id="otpLabel">Authentication code</label><input id="otp" class="otp-input big" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" required></div>
      <div class="form-error" role="alert" hidden></div>
      <button class="button primary wide" type="submit">Verify</button>
    </form>
    <p class="hint"><button type="button" class="link-btn" id="useRecovery">Lost your phone? Use a recovery code</button> · <button type="button" class="link-btn" id="backToLogin">Start over</button></p>`);
  const form = document.getElementById('codeForm');
  const input = form.otp;
  input.focus();
  input.addEventListener('input', () => { if (!recovery && input.value.replace(/\D/g, '').length === 6) form.requestSubmit(); });
  document.getElementById('backToLogin').onclick = () => renderLogin();
  document.getElementById('useRecovery').onclick = e => {
    recovery = !recovery;
    document.getElementById('otpLabel').textContent = recovery ? 'Recovery code' : 'Authentication code';
    document.getElementById('codeIntro').textContent = recovery ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once.' : 'Open your authenticator app and enter the 6-digit code.';
    input.value = ''; input.placeholder = recovery ? 'abcde-fghjk' : '123 456'; input.maxLength = recovery ? 20 : 7;
    if (recovery) input.removeAttribute('inputmode'); else input.setAttribute('inputmode', 'numeric');
    e.target.textContent = recovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code';
    input.focus();
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    if (btn.disabled) return;
    btn.disabled = true;
    const box = form.querySelector('.form-error');
    try {
      const me = await api('POST', '/auth/login/2fa', recovery ? { challenge, recoveryCode: input.value } : { challenge, code: input.value.replace(/\s/g, '') });
      setSession(me);
      if (recovery) toast(`Signed in with a recovery code. ${me.mfa.recoveryCodesRemaining} left. If you lost your phone, use “Move to a new phone” on your Account page.`, 'warn', 12000);
      enterApp();
    } catch (err) {
      if (err.data?.code === 'challenge_expired') { renderLogin(err.message); return; }
      box.hidden = false; box.textContent = err.message; input.select();
    } finally { btn.disabled = false; }
  });
}

function renderSetup() {
  authShell(`<div class="login-kicker">FIRST-TIME SETUP</div><h1>Create the administrator.</h1>
    <p class="login-intro">Use the one-time setup token configured on the server (SETUP_TOKEN).</p>
    <form id="setupForm">
      <div class="field"><label for="setupToken">Setup token</label><input id="setupToken" type="password" required autocomplete="off"></div>
      <div class="field"><label for="name">Your name</label><input id="name" required></div>
      <div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
      <div class="field"><label for="password">Password <small>(12+ characters)</small></label><input id="password" type="password" minlength="12" required autocomplete="new-password"></div>
      <div class="field"><label for="password2">Repeat password</label><input id="password2" type="password" minlength="12" required autocomplete="new-password"></div>
      <div class="form-error" role="alert" hidden></div>
      <button class="button primary wide" type="submit">Create administrator</button>
    </form>`);
  const form = document.getElementById('setupForm');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const box = form.querySelector('.form-error');
    if (form.password.value !== form.password2.value) { box.hidden = false; box.textContent = 'The two passwords do not match.'; form.password2.focus(); return; }
    try {
      await api('POST', '/setup', { setupToken: form.setupToken.value, name: form.name.value, email: form.email.value, password: form.password.value });
      toast('Administrator created. Sign in to continue.');
      renderLogin();
    } catch (err) { const box = form.querySelector('.form-error'); box.hidden = false; box.textContent = err.message; }
  });
}

function renderReset(token) {
  authShell(`<div class="login-kicker">SET PASSWORD</div><h1>Choose a new password.</h1>
    <form id="resetForm">
      <div class="field"><label for="pw1">New password <small>(12+ characters)</small></label><input id="pw1" type="password" minlength="12" required autocomplete="new-password"></div>
      <div class="field"><label for="pw2">Repeat password</label><input id="pw2" type="password" minlength="12" required autocomplete="new-password"></div>
      <div class="form-error" role="alert" hidden></div>
      <button class="button primary wide" type="submit">Save password</button>
    </form>`);
  const form = document.getElementById('resetForm');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const box = form.querySelector('.form-error');
    if (form.pw1.value !== form.pw2.value) { box.hidden = false; box.textContent = 'The passwords do not match.'; return; }
    try {
      await api('POST', '/auth/reset', { token, password: form.pw1.value });
      history.replaceState(null, '', location.pathname);
      toast('Password saved. Sign in with your new password.');
      renderLogin();
    } catch (err) { box.hidden = false; box.textContent = err.message; }
  });
}

/* ========================================================== Layout ==== */

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '⌂', show: () => can('pages.read') },
  { id: 'pages', label: 'Pages', icon: '▤', show: () => can('pages.read') },
  { id: 'media', label: 'Media', icon: '▧', show: () => can('media.read') },
  { id: 'redirects', label: 'Redirects', icon: '↪', show: () => can('redirects.read') },
  { id: 'menus', label: 'Navigation', icon: '☰', show: () => can('pages.read') },
  { id: 'terms', label: 'Categories & tags', icon: '#', show: () => can('pages.read') },
  { id: 'users', label: 'Users', icon: '◎', show: () => can('users.manage') },
  { id: 'settings', label: 'Settings', icon: '⚙', show: () => can('pages.read') },
  { id: 'activity', label: 'Activity log', icon: '≡', show: () => can('audit.read') }
];

function layout(active) {
  if (!document.getElementById('app')) {
    root.innerHTML = `<div class="app" id="app">
      <aside class="sidebar" id="sidebar">
        <a class="brand sidebar-brand" href="/" target="_blank" rel="noopener"><span class="brand-mark">ND<span>.</span></span><span class="brand-copy">NIKOLASEO <small>CONTENT STUDIO</small></span></a>
        <nav class="side-nav" aria-label="Content Studio"></nav>
        <div class="side-bottom"><a class="side-user" href="#/account"><span class="user-avatar">${esc((state.user.name || state.user.email)[0].toUpperCase())}</span><span><b>${esc(state.user.name || state.user.email)}</b><small>${esc(state.user.role)}</small></span></a>
        <button class="button quiet small wide" id="signOut">Sign out</button></div>
      </aside>
      <div class="main-shell">
        <header class="topbar"><button class="icon-btn mobile-menu" id="mobileMenu" aria-label="Open menu">☰</button><div class="crumbs" id="crumbs"></div><div class="top-actions"><a class="button quiet small" href="/" target="_blank" rel="noopener">View site ↗</a></div></header>
        <main class="workspace" id="workspace" tabindex="-1"></main>
      </div></div>`;
    document.getElementById('signOut').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); state.user = null; location.hash = ''; renderLogin(); };
    document.getElementById('mobileMenu').onclick = () => document.getElementById('sidebar').classList.toggle('open');
  }
  document.querySelector('.side-nav').innerHTML = NAV.filter(n => n.show()).map(n => `<a class="side-link${n.id === active ? ' active' : ''}" href="#/${n.id}"><span class="nav-icon">${n.icon}</span>${esc(n.label)}</a>`).join('');
  document.getElementById('sidebar').classList.remove('open');
  return document.getElementById('workspace');
}

function setCrumbs(...parts) { document.getElementById('crumbs').innerHTML = ['Content Studio', ...parts].map((p, i, a) => (i === a.length - 1 ? `<b>${esc(p)}</b>` : `<span>${esc(p)}</span>`)).join('<span class="sep">/</span>'); }

/* ========================================================== Router ==== */

let currentCleanup = null;
let routeToken = 0;
let listening = false;
function listen() { if (!listening) { listening = true; window.addEventListener('hashchange', route); } }

async function route() {
  const token = ++routeToken;
  if (!state.user) return renderLogin();
  const [, view = 'dashboard', id] = (location.hash.replace(/^#\/?/, '').match(/^([a-z]+)(?:\/(\w+))?/) || []);
  if (!(await leaveEditorGuard())) return;
  if (token !== routeToken) return;
  if (currentCleanup) { try { currentCleanup(); } catch { /* ignore */ } currentCleanup = null; }
  if (!can('pages.read') && view !== 'account') {
    const ws = layout('');
    setCrumbs('Account');
    ws.innerHTML = `${pageHeading('ACCOUNT', `Hello, ${esc(state.user.name || state.user.email)}`, 'Your account can view private pages on the website. There is nothing to manage here.')}<p><a class="button secondary" href="/">Go to the website →</a> <a class="button quiet" href="#/account">Account settings</a></p>`;
    return;
  }
  const shell = layout(view === 'editor' ? 'pages' : view);
  // Each navigation renders into its own container, so a slower, superseded render can never touch the screen.
  const ws = document.createElement('div');
  ws.className = 'view';
  ws.innerHTML = '<div class="loading">Loading…</div>';
  shell.replaceChildren(ws);
  shell.focus({ preventScroll: true });
  try {
    if (view === 'dashboard') { setCrumbs('Dashboard'); await renderDashboard(ws); }
    else if (view === 'pages' && id) {
      setCrumbs('Pages', 'Edit');
      const cleanup = await renderEditor(ws, Number(id));
      if (token === routeToken) currentCleanup = cleanup; else cleanup?.();
    }
    else if (view === 'pages') { setCrumbs('Pages'); await renderPages(ws); }
    else if (view === 'media') { setCrumbs('Media'); await renderMedia(ws); }
    else if (view === 'redirects') { setCrumbs('Redirects'); await renderRedirects(ws); }
    else if (view === 'menus') { setCrumbs('Navigation'); await renderMenus(ws); }
    else if (view === 'terms') { setCrumbs('Categories & tags'); await renderTerms(ws); }
    else if (view === 'users') { setCrumbs('Users'); await renderUsers(ws); }
    else if (view === 'settings') { setCrumbs('Settings'); await renderSettings(ws); }
    else if (view === 'activity') { setCrumbs('Activity log'); await renderActivity(ws); }
    else if (view === 'account') { setCrumbs('Account'); await renderAccount(ws); }
    else ws.innerHTML = pageHeading('NOT FOUND', 'Unknown screen');
  } catch (e) {
    if (token !== routeToken) return;
    ws.innerHTML = `${pageHeading('ERROR', 'This screen could not load')}<div class="notice error">${esc(e.message)}</div><p><button class="button secondary" onclick="location.reload()">Reload</button></p>`;
  }
}

/* ======================================================= Dashboard ==== */

async function renderDashboard(ws) {
  const [{ pages }, settings, redirects] = await Promise.all([
    api('GET', '/pages'), api('GET', '/settings'), can('redirects.read') ? api('GET', '/redirects?per=10') : Promise.resolve(null)
  ]);
  const by = s => pages.filter(p => p.state === s);
  const drafts = pages.filter(p => p.has_draft && p.state !== 'trash');
  const sys = settings.system;
  const issues = redirects ? Object.entries(redirects.summary).filter(([k]) => !['inactive', 'pattern'].includes(k)) : [];
  ws.innerHTML = `${pageHeading('YOUR WEBSITE', 'Content at a glance', 'Pages, drafts and redirects for nikolaseo.com.', can('pages.create') ? '<a class="button primary" href="#/pages" data-new>＋ New page</a>' : '')}
    ${sys.counts.pages === 0 && can('pages.edit_any') ? `<div class="notice">The CMS has not imported the site yet. <button class="button primary small" id="firstSync">Import pages from the repository</button></div>` : ''}
    ${!sys.githubConfigured ? '<div class="notice error">Publishing is not configured on the server (GITHUB_TOKEN). Drafts work; publishing will fail.</div>' : ''}
    ${!sys.mfaConfigured ? '<div class="notice warn">Two-factor authentication is unavailable: the server has no MFA_KEY secret, so sign-in is password-only.</div>' : (!state.mfa?.enabled ? '<div class="notice">Your account is protected by a password only. <a href="#/account">Set up two-factor authentication</a>.</div>' : '')}
    <div class="stat-grid">
      ${[['published', 'Published'], ['draft', 'Drafts'], ['scheduled', 'Scheduled'], ['private', 'Private'], ['password', 'Password']].map(([k, l]) => `<a class="stat-card" href="#/pages?state=${k}"><div class="stat-label">${l}</div><div class="stat-value">${by(k).length}</div></a>`).join('')}
      ${redirects ? `<a class="stat-card" href="#/redirects"><div class="stat-label">Redirects</div><div class="stat-value">${redirects.total}</div><div class="stat-note">${issues.length ? `${issues.reduce((a, [, n]) => a + n, 0)} issue(s)` : 'No issues'}</div></a>` : ''}
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-heading"><h2>Unpublished changes</h2></div>
        ${drafts.length ? `<ul class="plain-list">${drafts.slice(0, 12).map(p => `<li><a href="#/pages/${p.id}"><b>${esc(p.title)}</b><small>${esc(p.url)} · ${esc(p.modified_name || '')} · ${fmtAgo(p.updated_at)}</small></a>${statePill(p.state)}</li>`).join('')}</ul>` : '<p class="muted">No drafts. Everything is published.</p>'}
      </section>
      <section class="panel"><div class="panel-heading"><h2>Scheduled</h2></div>
        ${pages.filter(p => p.scheduled_at).length ? `<ul class="plain-list">${pages.filter(p => p.scheduled_at).map(p => `<li><a href="#/pages/${p.id}"><b>${esc(p.title)}</b><small>${esc(p.url)} · ${fmtDate(p.scheduled_at)}</small></a></li>`).join('')}</ul>` : '<p class="muted">Nothing scheduled.</p>'}
        ${issues.length ? `<h2 style="margin-top:22px">Redirect issues</h2><ul class="plain-list">${issues.map(([k, n]) => `<li><a href="#/redirects?issue=${k}"><b>${n}</b> ${esc(k)}</a></li>`).join('')}</ul>` : ''}
      </section>
      <section class="panel"><div class="panel-heading"><h2>System</h2></div>
        <dl class="kv"><dt>Repository</dt><dd>${esc(sys.repo || '—')} (${esc(sys.branch)})</dd><dt>Publishing</dt><dd>${sys.githubConfigured ? '<span class="ok">Configured</span>' : '<span class="bad">Not configured</span>'}</dd>
        <dt>Scheduler last run</dt><dd>${sys.cronLastRun ? fmtAgo(sys.cronLastRun) : 'not yet'}</dd><dt>Live redirect check</dt><dd>${sys.liveChecker ? 'Available' : 'Not configured'}</dd></dl>
      </section>
    </div>`;
  ws.querySelector('#firstSync')?.addEventListener('click', e => action(e.target, async () => { const r = await api('POST', '/pages/sync', {}); toast(`Imported ${r.added.length} pages.`); if (can('menus.manage')) await api('POST', '/menus/import-from-site', {}).catch(() => {}); route(); }, 'Importing…')());
  ws.querySelector('[data-new]')?.addEventListener('click', e => { e.preventDefault(); newPageDialog(); });
}

/* =========================================================== Pages ==== */

function hashParams() { return new URLSearchParams(location.hash.split('?')[1] || ''); }

async function renderPages(ws) {
  const { pages } = await api('GET', '/pages');
  const params = hashParams();
  let filter = params.get('state') || 'all';
  let q = '';
  const counts = s => (s === 'all' ? pages.filter(p => p.state !== 'trash').length : pages.filter(p => p.state === s).length);
  const tabs = ['all', 'published', 'draft', 'scheduled', 'private', 'password', 'trash'];
  ws.innerHTML = `${pageHeading('CONTENT', 'Pages', 'Every page on nikolaseo.com. Drafts and private pages are stored in the CMS, never in the public repository.',
    `${can('pages.create') ? '<button class="button primary" id="newPage">＋ New page</button>' : ''}${can('pages.edit_any') ? '<button class="button secondary" id="syncPages" title="Import pages and changes committed directly to GitHub">↻ Sync from repository</button>' : ''}${can('pages.publish_any') ? '<button class="button quiet" id="sitemapBtn">Sitemap…</button>' : ''}`)}
    <div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" class="tab${t === filter ? ' active' : ''}" data-tab="${t}">${t === 'all' ? 'All' : STATE_LABEL[t]} <span class="count">${counts(t)}</span></button>`).join('')}</div>
    <section class="panel table-panel"><div class="panel-heading"><div class="search-box"><span>⌕</span><input id="pageSearch" type="search" placeholder="Search title or URL" aria-label="Search pages"></div></div>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Title</th><th>Status</th><th>Author</th><th>Last modified</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></section>`;
  const byParent = new Map();
  pages.forEach(p => { const k = p.parent_id || 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(p); });
  const ordered = [];
  const walk = (pid, depth) => (byParent.get(pid) || []).sort((a, b) => a.menu_order - b.menu_order || a.url.localeCompare(b.url)).forEach(p => { ordered.push({ ...p, depth }); walk(p.id, depth + 1); });
  walk(0, 0);
  pages.forEach(p => { if (!ordered.some(o => o.id === p.id)) ordered.push({ ...p, depth: 0 }); });
  const draw = () => {
    const rows = ordered.filter(p => (filter === 'all' ? p.state !== 'trash' : p.state === filter) && (!q || `${p.title} ${p.url}`.toLowerCase().includes(q)));
    ws.querySelector('#rows').innerHTML = rows.length ? rows.map(p => `<tr>
      <td><div class="title-cell" style="padding-left:${p.depth * 18}px">${p.depth ? '<span class="muted">└</span> ' : ''}<a href="#/pages/${p.id}"><b>${esc(p.title)}</b></a><small>${esc(p.url)}</small></div></td>
      <td>${statePill(p.state)}${p.has_draft && p.state !== 'draft' ? ' <span class="pill warn" title="Saved changes not yet published">Unpublished changes</span>' : ''}${p.scheduled_at ? `<small class="block">⏱ ${fmtDate(p.scheduled_at)}</small>` : ''}</td>
      <td>${esc(p.author_name || '—')}</td><td>${fmtDate(p.updated_at)}<small class="block">${esc(p.modified_name || '')}</small></td>
      <td class="row-actions">${p.state === 'trash'
        ? `<button class="button quiet small" data-restore="${p.id}">Restore</button><button class="button quiet small danger-text" data-purge="${p.id}">Delete permanently</button>`
        : `<a class="button quiet small" href="#/pages/${p.id}">Edit</a><a class="button quiet small" href="/cms-api/pages/${p.id}/preview" target="_blank" rel="noopener">Preview</a>${p.state !== 'draft' && p.state !== 'scheduled' ? `<a class="button quiet small" href="${esc(p.url)}" target="_blank" rel="noopener">View</a>` : ''}${can('pages.create') ? `<button class="button quiet small" data-dup="${p.id}">Duplicate</button>` : ''}${p.url !== '/' ? `<button class="button quiet small danger-text" data-trash="${p.id}">Trash</button>` : ''}`}</td></tr>`).join('')
      : '<tr><td colspan="5"><div class="empty">No pages here.</div></td></tr>';
  };
  draw();
  ws.querySelector('#pageSearch').oninput = e => { q = e.target.value.toLowerCase(); draw(); };
  ws.querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => { filter = b.dataset.tab; ws.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b)); draw(); }));
  ws.querySelector('#newPage')?.addEventListener('click', newPageDialog);
  ws.querySelector('#syncPages')?.addEventListener('click', e => action(e.target, async () => {
    const r = await api('POST', '/pages/sync', {});
    toast(`Sync complete: ${r.added.length} added, ${r.updated.length} updated from GitHub${r.missing.length ? `, ${r.missing.length} missing (moved to drafts)` : ''}.`);
    clearLinkTargets(); route();
  }, 'Syncing…')());
  ws.querySelector('#sitemapBtn')?.addEventListener('click', sitemapDialog);
  ws.querySelector('#rows').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    try {
      if (t.dataset.dup) { const r = await api('POST', `/pages/${t.dataset.dup}/duplicate`, {}); toast(`Duplicated as ${r.url} (draft).`); location.hash = `#/pages/${r.id}`; }
      if (t.dataset.trash) {
        const p = pages.find(x => x.id === Number(t.dataset.trash));
        if (await confirmDialog('Move to trash?', p.state === 'published' || p.state === 'private' || p.state === 'password' ? `<b>${esc(p.title)}</b> is live. Trashing it takes it offline (${esc(p.url)} will return 404). Consider adding a redirect.` : `Move <b>${esc(p.title)}</b> to the trash?`, { confirmLabel: 'Move to trash', danger: true })) {
          await api('POST', `/pages/${p.id}/trash`, {}); toast('Moved to trash.'); route();
        }
      }
      if (t.dataset.restore) { const r = await api('POST', `/pages/${t.dataset.restore}/restore`, {}); toast(r.note); route(); }
      if (t.dataset.purge) {
        if (await confirmDialog('Delete permanently?', 'This removes the page and all its revisions from the CMS. It cannot be undone.', { confirmLabel: 'Delete forever', danger: true, typeToConfirm: 'DELETE' })) {
          await api('DELETE', `/pages/${t.dataset.purge}`); toast('Deleted.'); route();
        }
      }
    } catch (err) { toastError(err); }
  });
}

async function newPageDialog() {
  const { pages } = await api('GET', '/pages');
  const parents = pages.filter(p => /\/index\.html$/.test(p.path) && p.state !== 'trash');
  const m = modal('New page', `<form id="np">
    <div class="field"><label for="npTitle">Title</label><input id="npTitle" required maxlength="200"></div>
    <div class="field"><label for="npSlug">URL slug</label><div class="input-prefix"><span>nikolaseo.com/<span id="npParentPrefix"></span></span><input id="npSlug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="80"></div><small class="hint">Lowercase letters, numbers and hyphens. The page gets a folder-style URL ending in “/”.</small></div>
    <div class="field"><label for="npParent">Parent page (optional)</label><select id="npParent"><option value="">— None (top level) —</option>${parents.map(p => `<option value="${p.id}" data-prefix="${esc(p.url.slice(1))}">${esc(p.title)} (${esc(p.url)})</option>`).join('')}</select></div>
    <div class="field"><label for="npTemplate">Layout</label><select id="npTemplate"><option value="article">SEO Studies article (hero, table of contents, article body)</option><option value="basic">Basic page (hero + body)</option></select></div>
    <div class="field"><label for="npDesc">Search description</label><textarea id="npDesc" maxlength="400" rows="3"></textarea></div>
  </form>`, { actions: '<button class="button quiet" data-close2>Cancel</button><button class="button primary" id="npGo">Create draft →</button>' });
  const t = m.$('#npTitle'), s = m.$('#npSlug');
  t.oninput = () => { if (!s.dataset.touched) s.value = t.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };
  s.oninput = () => { s.dataset.touched = '1'; };
  m.$('#npParent').onchange = e => { m.$('#npParentPrefix').textContent = e.target.selectedOptions[0]?.dataset.prefix || ''; };
  m.$('[data-close2]').onclick = () => m.close();
  m.$('#npGo').onclick = action(m.$('#npGo'), async () => {
    if (!t.value.trim() || !s.value.trim()) { toast('Enter a title and slug.', 'error'); return; }
    const r = await api('POST', '/pages', { title: t.value, slug: s.value, parent_id: m.$('#npParent').value || null, template: m.$('#npTemplate').value, description: m.$('#npDesc').value });
    if (r.warning) toast(r.warning, 'warn', 9000);
    m.close(); clearLinkTargets(); location.hash = `#/pages/${r.id}`;
  }, 'Creating…');
}

async function sitemapDialog() {
  const res = await api('GET', '/sitemap/preview', undefined, { raw: true });
  const xml = await res.text();
  const m = modal('sitemap.xml', `<p class="muted">Generated from published, public, indexable pages that are included in the sitemap and are their own canonical. It is rewritten automatically on every publish.</p><pre class="code-block">${esc(xml)}</pre>`, { wide: true, actions: '<button class="button primary" id="regen">Regenerate now</button>' });
  m.$('#regen').onclick = action(m.$('#regen'), async () => { const r = await api('POST', '/sitemap/regenerate', {}); toast(r.changed ? 'Sitemap committed.' : 'Sitemap was already up to date.'); m.close(); }, 'Publishing…');
}

/* =========================================================== Terms ==== */

async function renderTerms(ws) {
  const { terms } = await api('GET', '/terms');
  const editable = can('terms.manage');
  const block = (tax, label) => `<section class="panel"><div class="panel-heading"><h2>${label}</h2></div>
    ${editable ? `<form class="inline-form" data-add="${tax}"><input placeholder="New ${tax} name" required maxlength="80" aria-label="New ${tax}"><button class="button secondary small">Add</button></form>` : ''}
    <ul class="plain-list">${terms.filter(t => t.taxonomy === tax).map(t => `<li><span><b>${esc(t.name)}</b><small>${esc(t.slug)} · ${t.count} page(s)</small></span>${editable ? `<span><button class="button quiet small" data-rename="${t.id}" data-name="${esc(t.name)}">Rename</button><button class="button quiet small danger-text" data-del="${t.id}">Delete</button></span>` : ''}</li>`).join('') || '<li class="muted">None yet.</li>'}</ul></section>`;
  ws.innerHTML = `${pageHeading('STRUCTURE', 'Categories & tags', 'Assign them to pages in the editor. On articles they are output as <code>article:section</code> and <code>article:tag</code> meta tags.')}<div class="two-col">${block('category', 'Categories')}${block('tag', 'Tags')}</div>`;
  ws.querySelectorAll('[data-add]').forEach(f => f.addEventListener('submit', async e => { e.preventDefault(); try { await api('POST', '/terms', { taxonomy: f.dataset.add, name: f.querySelector('input').value }); route(); } catch (err) { toastError(err); } }));
  ws.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.rename) { const name = prompt('New name', b.dataset.name); if (name) { await api('PATCH', `/terms/${b.dataset.rename}`, { name }); route(); } }
      if (b.dataset.del && await confirmDialog('Delete term?', 'It will be removed from all pages (takes effect on their next publish).', { danger: true, confirmLabel: 'Delete' })) { await api('DELETE', `/terms/${b.dataset.del}`); route(); }
    } catch (err) { toastError(err); }
  });
}

/* =========================================================== Users ==== */

const ROLE_HELP = {
  administrator: 'Everything, including users, settings, redirects and backups.',
  editor: 'All pages, media, navigation, SEO. Redirects only if granted below.',
  author: 'Creates, edits and publishes their own pages; uploads media.',
  contributor: 'Writes drafts of their own pages; cannot publish.',
  subscriber: 'Can view private pages on the website. No CMS access.'
};

async function renderUsers(ws) {
  const { users, roles, caps } = await api('GET', '/users');
  ws.innerHTML = `${pageHeading('PEOPLE', 'Users', 'Roles are enforced by the server on every request.', '<button class="button primary" id="addUser">＋ Add user</button>')}
    <section class="panel table-panel"><div class="table-scroll"><table class="data-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>2FA</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td><b>${esc(u.name || '—')}</b><small class="block">${esc(u.email)}</small></td><td>${esc(u.role)}${(u.caps.grant || []).length || (u.caps.revoke || []).length ? ' <span class="pill">custom</span>' : ''}</td><td>${u.active ? '<span class="ok">Active</span>' : '<span class="bad">Disabled</span>'}</td><td>${u.twoFactor ? '<span class="pill ok-pill">On</span>' : '<span class="pill">Off</span>'}</td><td>${fmtAgo(u.last_login)}</td>
    <td class="row-actions"><button class="button quiet small" data-edit="${u.id}">Edit</button><button class="button quiet small" data-reset="${u.id}">Reset link</button>${u.twoFactor && u.id !== state.user.id ? `<button class="button quiet small" data-reset2fa="${u.id}">Reset 2FA</button>` : ''}${u.id !== state.user.id ? `<button class="button quiet small danger-text" data-del="${u.id}">Delete</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></section>
    <section class="panel"><h2>Roles</h2><dl class="kv">${roles.map(r => `<dt>${r}</dt><dd>${ROLE_HELP[r]}</dd>`).join('')}</dl></section>`;
  const form = (u = {}) => `<div class="field"><label for="uEmail">Email</label><input id="uEmail" type="email" value="${esc(u.email || '')}" ${u.id ? 'disabled' : ''}></div>
    <div class="field"><label for="uName">Name</label><input id="uName" value="${esc(u.name || '')}"></div>
    <div class="field"><label for="uRole">Role</label><select id="uRole">${roles.map(r => `<option ${r === (u.role || 'author') ? 'selected' : ''}>${r}</option>`).join('')}</select><small class="hint" id="roleHelp"></small></div>
    ${u.id ? `<label class="check"><input type="checkbox" id="uActive" ${u.active ? 'checked' : ''}> Active (can sign in)</label>` : '<p class="hint">The user receives a one-time link (valid 72 hours) to set their own password. Copy it and send it to them.</p>'}
    <details class="advanced"><summary>Custom permissions</summary><p class="hint">Grant or remove individual capabilities on top of the role.</p>
    <div class="caps-grid">${caps.map(c => `<label><span>${c}</span><select data-cap="${c}"><option value="">role default</option><option value="grant" ${(u.caps?.grant || []).includes(c) ? 'selected' : ''}>grant</option><option value="revoke" ${(u.caps?.revoke || []).includes(c) ? 'selected' : ''}>revoke</option></select></label>`).join('')}</div></details>`;
  const collect = m => ({ grant: m.$$('[data-cap]').filter(s => s.value === 'grant').map(s => s.dataset.cap), revoke: m.$$('[data-cap]').filter(s => s.value === 'revoke').map(s => s.dataset.cap) });
  const bindRole = m => { const f = () => { m.$('#roleHelp').textContent = ROLE_HELP[m.$('#uRole').value]; }; m.$('#uRole').onchange = f; f(); };
  ws.querySelector('#addUser').onclick = () => {
    const m = modal('Add user', form(), { actions: '<button class="button primary" id="save">Create user</button>' });
    bindRole(m);
    m.$('#save').onclick = action(m.$('#save'), async () => {
      const r = await api('POST', '/users', { email: m.$('#uEmail').value, name: m.$('#uName').value, role: m.$('#uRole').value, caps: collect(m) });
      m.close();
      showLink('User created', 'Send this one-time link to the new user so they can set a password:', r.setupLink);
      route();
    }, 'Creating…');
  };
  ws.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.edit) {
        const u = users.find(x => x.id === Number(b.dataset.edit));
        const m = modal(`Edit ${u.email}`, form(u), { actions: '<button class="button primary" id="save">Save</button>' });
        bindRole(m);
        m.$('#save').onclick = action(m.$('#save'), async () => { await api('PATCH', `/users/${u.id}`, { name: m.$('#uName').value, role: m.$('#uRole').value, active: m.$('#uActive').checked, caps: collect(m) }); m.close(); toast('User saved.'); route(); }, 'Saving…');
      }
      if (b.dataset.reset) { const r = await api('POST', `/users/${b.dataset.reset}/reset-link`, {}); showLink('Password reset link', `Valid for ${r.expiresInHours} hours, single use. Existing sessions end when it is used. Two-factor authentication stays on; a reset link does not bypass it.`, r.url); }
      if (b.dataset.reset2fa) {
        const u = users.find(x => x.id === Number(b.dataset.reset2fa));
        if (await confirmDialog('Reset two-factor authentication?', `Use this when <b>${esc(u.email)}</b> lost their phone and their recovery codes. Their authenticator is removed and they are signed out everywhere. Confirm their identity another way first.`, { danger: true, confirmLabel: 'Reset 2FA' })) {
          const r = await api('POST', `/users/${u.id}/reset-2fa`, {}); toast(r.note, 'success', 9000); route();
        }
      }
      if (b.dataset.del && await confirmDialog('Delete user?', 'Their pages stay; authorship is cleared.', { danger: true, confirmLabel: 'Delete user' })) { await api('DELETE', `/users/${b.dataset.del}`); toast('User deleted.'); route(); }
    } catch (err) { toastError(err); }
  });
}

function showLink(title, text, url) {
  const m = modal(title, `<p>${esc(text)}</p><div class="copy-row"><input readonly value="${esc(url)}" aria-label="Link"><button class="button secondary" id="cp">Copy</button></div>`);
  m.$('#cp').onclick = () => copyText(url);
}

/* ======================================================== Settings ==== */

async function renderSettings(ws) {
  const { settings, system } = await api('GET', '/settings');
  const admin = can('settings.manage');
  ws.innerHTML = `${pageHeading('PREFERENCES', 'Settings')}
    <div class="two-col">
    <section class="panel"><h2>Site defaults</h2><form id="settingsForm">
      <div class="field"><label for="sDefQuery">Default query-string handling for new redirects</label><select id="sDefQuery" ${admin ? '' : 'disabled'}>
        <option value="pass" ${settings.redirect_default_query !== 'ignore' && settings.redirect_default_query !== 'exact' ? 'selected' : ''}>Pass through — match ignoring the query, keep visitor's query (recommended for SEO)</option>
        <option value="ignore" ${settings.redirect_default_query === 'ignore' ? 'selected' : ''}>Ignore — match ignoring the query, drop it</option>
        <option value="exact" ${settings.redirect_default_query === 'exact' ? 'selected' : ''}>Exact — the query must match the source</option></select></div>
      <div class="field"><label for="s2fa">Require two-factor authentication for</label><select id="s2fa" ${admin ? '' : 'disabled'}>
        ${[['none', 'Nobody (optional for everyone)'], ['administrators', 'Administrators'], ['staff', 'Everyone with CMS access (recommended)'], ['all', 'All accounts, including subscribers']].map(([v, l]) => `<option value="${v}" ${(settings.require_2fa || 'staff') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <small class="hint">${system.mfaConfigured ? 'People in these roles without 2FA must set it up before they can do anything else.' : '<span class="warn-text">Not enforced: the server has no MFA_KEY secret.</span>'}</small></div>
      <div class="field"><label for="sOg">Default social image URL (used as a suggestion in the SEO panel)</label><input id="sOg" value="${esc(settings.default_og_image)}" ${admin ? '' : 'disabled'} placeholder="https://nikolaseo.com/…"></div>
      ${admin ? '<button class="button primary">Save settings</button>' : ''}</form></section>
    <section class="panel"><h2>System</h2><dl class="kv">
      <dt>Repository</dt><dd>${esc(system.repo)} · ${esc(system.branch)}</dd><dt>Publishing token</dt><dd>${system.githubConfigured ? '<span class="ok">Configured (server-side secret)</span>' : '<span class="bad">Missing</span>'}</dd>
      <dt>Two-factor</dt><dd>${system.mfaConfigured ? '<span class="ok">Available</span>' : '<span class="bad">MFA_KEY missing</span>'}</dd>
      <dt>Scheduler</dt><dd>every 5 minutes · last run ${system.cronLastRun ? fmtAgo(system.cronLastRun) : 'never'}</dd><dt>Live redirect checker</dt><dd>${system.liveChecker ? 'Configured' : 'Not configured'}</dd>
      <dt>Database</dt><dd>${system.counts.pages} pages · ${system.counts.redirects} redirects · ${system.counts.media} media · ${system.counts.users} users</dd></dl></section>
    ${can('backups.manage') ? `<section class="panel"><h2>Backup &amp; restore</h2><p class="muted">Download a JSON backup of pages, revisions, redirects, media metadata, menus, terms and settings (no passwords). Cloudflare D1 also keeps point-in-time recovery (Time Travel).</p>
      <p><button class="button secondary" id="dlBackup">Download backup</button></p>
      <div class="field"><label for="restoreFile">Restore from a backup file</label><input id="restoreFile" type="file" accept="application/json"></div>
      <div class="field"><span class="label">Restore these parts</span>${['redirects', 'menus', 'terms', 'settings', 'media'].map(p => `<label class="check"><input type="checkbox" data-part="${p}" ${p === 'redirects' ? 'checked' : ''}> ${p}</label>`).join('')}</div>
      <button class="button danger" id="restoreBtn">Restore…</button><p class="hint">Pages are restored individually from revision history, not from here, so a restore can never overwrite live pages in bulk.</p></section>` : ''}
    </div>`;
  ws.querySelector('#settingsForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('PUT', '/settings', { redirect_default_query: ws.querySelector('#sDefQuery').value, default_og_image: ws.querySelector('#sOg').value, require_2fa: ws.querySelector('#s2fa').value }); toast('Settings saved.');
      setSession(await api('GET', '/auth/me'));
      if (state.mfa?.mustEnroll) startForcedEnrollment(); } catch (err) { toastError(err); } });
  ws.querySelector('#dlBackup')?.addEventListener('click', () => downloadFromApi('/backup', 'nikolaseo-cms-backup.json').catch(toastError));
  ws.querySelector('#restoreBtn')?.addEventListener('click', async () => {
    const file = ws.querySelector('#restoreFile').files[0];
    if (!file) return toast('Choose a backup file first.', 'error');
    const parts = [...ws.querySelectorAll('[data-part]:checked')].map(x => x.dataset.part);
    const typed = await confirmDialog('Restore backup?', `This replaces the current <b>${parts.join(', ')}</b> with the backup's contents. Current redirects are backed up first.`, { danger: true, confirmLabel: 'Restore', typeToConfirm: 'RESTORE' });
    if (typed !== 'RESTORE') return;
    try { const data = JSON.parse(await file.text()); const r = await api('POST', '/backup/restore', { ...data, parts, confirm: 'RESTORE' }); toast(`Restored: ${Object.entries(r.restored).map(([k, v]) => `${v} ${k}`).join(', ')}`); } catch (err) { toastError(err); }
  });
}

/* ======================================================== Activity ==== */

async function renderActivity(ws) {
  const level = hashParams().get('level') || '';
  const { entries } = await api('GET', `/audit${level ? `?level=${level}` : ''}`);
  ws.innerHTML = `${pageHeading('HISTORY', 'Activity log', 'Sign-ins, publishing, redirect changes and errors (last 300).')}
    <div class="tabs">${['', 'info', 'warning', 'error'].map(l => `<a class="tab${l === level ? ' active' : ''}" href="#/activity${l ? `?level=${l}` : ''}">${l || 'All'}</a>`).join('')}</div>
    <section class="panel table-panel"><div class="table-scroll"><table class="data-table"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
    ${entries.map(e => `<tr class="lvl-${esc(e.level)}"><td>${fmtDate(e.created_at)}</td><td>${esc(e.user_name || '—')}</td><td><code>${esc(e.action)}</code></td><td>${esc(e.target || '')}</td><td><small>${esc(e.detail || '')}</small></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing logged yet.</td></tr>'}
    </tbody></table></div></section>`;
}

/* ========================================================= Account ==== */

async function renderAccount(ws) {
  const { sessions } = await api('GET', '/auth/sessions');
  ws.innerHTML = `${pageHeading('ACCOUNT', esc(state.user.name || state.user.email), `${esc(state.user.email)} · ${esc(state.user.role)}`)}
    <div class="two-col"><section class="panel"><h2>Change password</h2><form id="pwForm">
      <div class="field"><label for="cur">Current password</label><input id="cur" type="password" required autocomplete="current-password"></div>
      <div class="field"><label for="nw">New password <small>(12+ characters)</small></label><input id="nw" type="password" minlength="12" required autocomplete="new-password"></div>
      <div class="field"><label for="nw2">Repeat new password</label><input id="nw2" type="password" minlength="12" required autocomplete="new-password"></div>
      <button class="button primary">Change password</button><p class="hint">Your other sessions are signed out.</p></form></section>
    <section class="panel" id="mfaPanel"></section>
    <section class="panel"><h2>Active sessions</h2><ul class="plain-list">${sessions.map(s => `<li><span><b>${s.current ? 'This browser' : esc((s.ua || '').slice(0, 60))}</b><small>${esc(s.ip || '')} · last active ${fmtAgo(s.last_seen)}</small></span></li>`).join('')}</ul>
      <button class="button secondary" id="logoutAll">Sign out everywhere</button></section></div>`;
  ws.querySelector('#pwForm').addEventListener('submit', async e => { e.preventDefault(); if (ws.querySelector('#nw').value !== ws.querySelector('#nw2').value) { toastError(new Error('The two new passwords do not match.')); ws.querySelector('#nw2').focus(); return; } try { await api('POST', '/auth/password', { current: ws.querySelector('#cur').value, next: ws.querySelector('#nw').value }); toast('Password changed.'); e.target.reset(); } catch (err) { toastError(err); } });
  ws.querySelector('#logoutAll').onclick = async () => { await api('POST', '/auth/logout-all', {}); state.user = null; renderLogin('Signed out on all devices.'); };
  const me = await api('GET', '/auth/me');
  setSession(me);
  accountPanel(ws.querySelector('#mfaPanel'), { me, onChange: () => route() });
}

export { route };
boot();
