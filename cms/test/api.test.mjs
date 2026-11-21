// End-to-end API tests against `wrangler dev` (local D1) + mock GitHub/Pages/checker.
// Run: node --test --test-concurrency=1 test/api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
const W = 'http://localhost:8787';
const ROOT = new URL('../../', import.meta.url).pathname;
const SITE_PAGES = [...fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && !f.startsWith('google')),
  ...fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(`${ROOT}${d.name}/index.html`) && !['admin', 'cms'].includes(d.name)).map(d => `${d.name}/index.html`)].length;
const GH = 'http://localhost:8789/repos/o/r';
const ADMIN = { email: 'admin@nikolaseo.com', password: 'correct horse battery staple' };

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, path, body, { raw = false, headers = {}, form } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    let payload;
    if (form) payload = form; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(W + path, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('cms_session=')) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async login(email, password) {
    const r = await this.req('POST', '/cms-api/auth/login', { email, password });
    if (r.status === 200) this.csrf = r.data.csrf;
    return r;
  }
}
const admin = new Client();
const ghRead = async path => {
  const ref = await (await fetch(`${GH}/git/ref/heads/main`, { headers: { Authorization: 'Bearer test-token' } })).json();
  const c = await (await fetch(`${GH}/git/commits/${ref.object.sha}`, { headers: { Authorization: 'Bearer test-token' } })).json();
  const t = await (await fetch(`${GH}/git/trees/${c.tree.sha}?recursive=1`, { headers: { Authorization: 'Bearer test-token' } })).json();
  const e = t.tree.find(x => x.path === path);
  if (!e) return null;
  const b = await (await fetch(`${GH}/git/blobs/${e.sha}`, { headers: { Authorization: 'Bearer test-token' } })).json();
  return Buffer.from(b.content, 'base64').toString('utf8');
};
const live = (path, opts = {}) => fetch(W + path, { redirect: 'manual', ...opts });
const wait = ms => new Promise(r => setTimeout(r, ms));

test('setup: refuses bad token, creates first admin once', async () => {
  let r = await admin.req('POST', '/cms-api/setup', { setupToken: 'nope', email: ADMIN.email, password: ADMIN.password });
  assert.equal(r.status, 403);
  r = await admin.req('POST', '/cms-api/setup', { setupToken: 'setup-123', email: ADMIN.email, name: 'Nikola', password: 'short' });
  assert.equal(r.status, 422);
  r = await admin.req('POST', '/cms-api/setup', { setupToken: 'setup-123', email: ADMIN.email, name: 'Nikola', password: ADMIN.password });
  assert.equal(r.status, 200);
  r = await admin.req('POST', '/cms-api/setup', { setupToken: 'setup-123', email: 'x@y.z', password: ADMIN.password });
  assert.equal(r.status, 409);
});

test('auth: wrong password rejected, login works, CSRF enforced, session cookie flags', async () => {
  const bad = await new Client().login(ADMIN.email, 'wrong password!!');
  assert.equal(bad.status, 401);
  const anon = await new Client().req('GET', '/cms-api/pages');
  assert.equal(anon.status, 401);
  const r = await admin.login(ADMIN.email, ADMIN.password);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.ok(r.data.caps.includes('redirects.manage'));
  const noCsrf = await fetch(`${W}/cms-api/pages/sync`, { method: 'POST', headers: { Cookie: admin.cookie } });
  assert.equal(noCsrf.status, 403);
  const crossSite = await fetch(`${W}/cms-api/pages/sync`, { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf, Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
});

test('pages: sync imports every site page; cookies are not forwarded to origin', async () => {
  const r = await admin.req('POST', '/cms-api/pages/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added.length, SITE_PAGES);
  const list = await admin.req('GET', '/cms-api/pages');
  assert.equal(list.data.pages.length, SITE_PAGES);
  assert.ok(list.data.pages.every(p => p.state === 'published'));
  const res = await live('/seo-myths/', { headers: { Cookie: admin.cookie } });
  assert.equal(res.headers.get('x-got-cookie'), 'no');
  const m = await admin.req('POST', '/cms-api/menus/import-from-site', {});
  assert.equal(m.status, 200);
  assert.equal(m.data.items.find(i => i.label === 'SEO Tools').children.length, 9);
});

let myths;
test('editor: open page, regions + SEO; save draft does not touch the live site; preview shows draft', async () => {
  const list = await admin.req('GET', '/cms-api/pages');
  myths = list.data.pages.find(p => p.url === '/seo-myths/');
  const r = await admin.req('GET', `/cms-api/pages/${myths.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.regions.template, 'article');
  assert.match(r.data.seo.title, /SEO Myths/);
  assert.match(r.data.seo.schema, /"@type": "Article"/);
  const before = await ghRead('seo-myths/index.html');
  const body = r.data.regions.body.replace('</h2>', '</h2><p>CMS draft marker <a href="/crawl-budget/" rel="nofollow sponsored" target="_blank">link</a></p>');
  const save = await admin.req('PUT', `/cms-api/pages/${myths.id}/draft`, { base_version: r.data.page.version, body, hero: r.data.regions.hero, seo: { description: 'Draft description' } });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.equal(await ghRead('seo-myths/index.html'), before, 'live file unchanged by draft');
  const liveHtml = await (await live('/seo-myths/')).text();
  assert.ok(!liveHtml.includes('CMS draft marker'));
  const prev = await admin.req('GET', `/cms-api/pages/${myths.id}/preview`);
  assert.ok(prev.data.includes('CMS draft marker'));
  assert.ok(prev.data.includes('Draft description'));
  const anonPrev = await new Client().req('GET', `/cms-api/pages/${myths.id}/preview`);
  assert.equal(anonPrev.status, 401);
  // Draft survives a reload
  const again = await admin.req('GET', `/cms-api/pages/${myths.id}`);
  assert.ok(again.data.page.has_draft);
  assert.ok(again.data.regions.body.includes('CMS draft marker'));
});

test('conflict detection: stale version rejected; external GitHub change blocks publish', async () => {
  const r = await admin.req('GET', `/cms-api/pages/${myths.id}`);
  const stale = await admin.req('PUT', `/cms-api/pages/${myths.id}/draft`, { base_version: r.data.page.version - 1, body: r.data.regions.body });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'version_conflict');
  const original = await ghRead('seo-myths/index.html');
  await fetch(`${GH}/_external-commit`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'seo-myths/index.html', text: original.replace('10 SEO Myths', '10 SEO Myths (edited on GitHub)') }) });
  const pub = await admin.req('POST', `/cms-api/pages/${myths.id}/publish`, {});
  assert.equal(pub.status, 409, JSON.stringify(pub.data));
  assert.match(pub.data.error, /changed on GitHub/);
  // restore the GitHub file so the page can be published
  await fetch(`${GH}/_external-commit`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'seo-myths/index.html', text: original }) });
});

test('publish: commits page + sitemap, live site shows the change, SEO tags are unique', async () => {
  const pub = await admin.req('POST', `/cms-api/pages/${myths.id}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const html = await (await live('/seo-myths/')).text();
  assert.ok(html.includes('CMS draft marker'));
  assert.ok(html.includes('rel="nofollow sponsored"') && html.includes('target="_blank"'));
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((html.match(/name="description"/g) || []).length, 1);
  assert.ok(html.includes('content="Draft description"'));
  assert.ok(!/name="robots"/.test(html), 'no robots meta when index,follow');
  // Everything outside the edited regions is preserved (scripts, nav, other article content)
  assert.ok(html.includes('<script src="../nav.js"></script>') || html.includes('nav.js'));
  assert.ok(html.includes('Why SEO myths survive'));
  const sm = await (await live('/sitemap.xml')).text();
  assert.equal((sm.match(/<loc>/g) || []).length, SITE_PAGES);
});

test('SEO: noindex removes from sitemap, robots meta correct, schema validated, OG/Twitter written', async () => {
  const r = await admin.req('GET', `/cms-api/pages/${myths.id}`);
  const bad = await admin.req('PUT', `/cms-api/pages/${myths.id}/draft`, { base_version: r.data.page.version, seo: { schema: '{ not json' } });
  assert.equal(bad.status, 422);
  const ok = await admin.req('PUT', `/cms-api/pages/${myths.id}/draft`, { base_version: r.data.page.version, sitemap: true, seo: { index: false, follow: true, ogTitle: 'OG T', twitterCard: 'summary', twitterTitle: 'TW T', canonical: 'https://nikolaseo.com/seo-myths/' }, breadcrumbs: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  await admin.req('POST', `/cms-api/pages/${myths.id}/publish`, {});
  const html = await (await live('/seo-myths/')).text();
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(html.includes('content="OG T"') && html.includes('name="twitter:title" content="TW T"'));
  assert.ok(html.includes('"@type":"BreadcrumbList"'));
  const sm = await (await live('/sitemap.xml')).text();
  assert.ok(!sm.includes('/seo-myths/'));
  const r2 = await admin.req('GET', `/cms-api/pages/${myths.id}`);
  await admin.req('PUT', `/cms-api/pages/${myths.id}/draft`, { base_version: r2.data.page.version, sitemap: true, seo: { index: true }, breadcrumbs: false });
  await admin.req('POST', `/cms-api/pages/${myths.id}/publish`, {});
  const sm2 = await (await live('/sitemap.xml')).text();
  assert.ok(sm2.includes('/seo-myths/'));
});

let newPage;
test('create, schedule (cron), duplicate, slug change with redirect, trash and restore', async () => {
  const c = await admin.req('POST', '/cms-api/pages', { title: 'Test Study', slug: 'test-study', description: 'desc' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  newPage = c.data.id;
  assert.equal((await live('/test-study/')).status, 404);
  const p = await admin.req('GET', `/cms-api/pages/${newPage}`);
  const s = await admin.req('PUT', `/cms-api/pages/${newPage}/draft`, { base_version: p.data.page.version, body: '<h2>Intro</h2><p>Hello <strong>world</strong></p>' });
  assert.equal(s.status, 200);
  const past = await admin.req('POST', `/cms-api/pages/${newPage}/schedule`, { at: new Date(Date.now() - 1000).toISOString() });
  assert.equal(past.status, 422);
  const sched = await admin.req('POST', `/cms-api/pages/${newPage}/schedule`, { at: new Date(Date.now() + 61000).toISOString() });
  assert.equal(sched.status, 200);
  assert.equal((await admin.req('GET', '/cms-api/pages')).data.pages.find(x => x.id === newPage).state, 'scheduled');
  await fetch(`${W}/__scheduled`); // not due yet
  assert.equal((await live('/test-study/')).status, 404);
  await wait(62000);
  await fetch(`${W}/__scheduled`);
  await wait(500);
  const res = await live('/test-study/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Hello <strong>world</strong>'));
  assert.ok(html.includes('<link rel="canonical" href="https://nikolaseo.com/test-study/">'));
  assert.ok(html.includes('href="#intro"'), 'TOC rebuilt');
  assert.ok((await (await live('/sitemap.xml')).text()).includes('/test-study/'));

  const dup = await admin.req('POST', `/cms-api/pages/${newPage}/duplicate`, {});
  assert.equal(dup.status, 201);
  assert.equal(dup.data.url, '/test-study-copy/');

  const mv = await admin.req('POST', `/cms-api/pages/${newPage}/slug`, { slug: 'renamed-study', createRedirect: true });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  await wait(200);
  const old = await live('/test-study/');
  assert.equal(old.status, 301);
  assert.match(old.headers.get('location'), /\/renamed-study\/$/);
  assert.equal((await live('/renamed-study/')).status, 200);

  const tr = await admin.req('POST', `/cms-api/pages/${newPage}/trash`, {});
  assert.equal(tr.status, 200);
  assert.equal((await live('/renamed-study/')).status, 404);
  const rs = await admin.req('POST', `/cms-api/pages/${newPage}/restore`, {});
  assert.equal(rs.status, 200);
  assert.equal((await admin.req('GET', '/cms-api/pages')).data.pages.find(x => x.id === newPage).state, 'draft');
});

test('visibility: private and password pages are protected at the edge and removed from the public repo', async () => {
  const pub = await admin.req('POST', `/cms-api/pages/${newPage}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const v = await admin.req('POST', `/cms-api/pages/${newPage}/visibility`, { visibility: 'private' });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(await ghRead('renamed-study/index.html'), null, 'file removed from public repo');
  await wait(200);
  const anon = await live('/renamed-study/');
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location'), /\/admin\/\?next=/);
  const authed = await live('/renamed-study/', { headers: { Cookie: admin.cookie } });
  assert.equal(authed.status, 200);
  assert.match(authed.headers.get('x-robots-tag'), /noindex/);
  assert.match(authed.headers.get('cache-control'), /no-store/);
  assert.ok((await authed.text()).includes('Hello <strong>world</strong>'));
  assert.ok(!(await (await live('/sitemap.xml')).text()).includes('/renamed-study/'));

  const pw0 = await admin.req('POST', `/cms-api/pages/${newPage}/visibility`, { visibility: 'password' });
  assert.equal(pw0.status, 422);
  const pw = await admin.req('POST', `/cms-api/pages/${newPage}/visibility`, { visibility: 'password', password: 'open-sesame' });
  assert.equal(pw.status, 200);
  await wait(200);
  const locked = await live('/renamed-study/');
  assert.equal(locked.status, 401);
  const lockedHtml = await locked.text();
  assert.ok(!lockedHtml.includes('Hello'), 'content not exposed');
  const wrong = await live('/renamed-study/', { method: 'POST', body: new URLSearchParams({ password: 'nope' }) });
  assert.equal(wrong.status, 401);
  const right = await live('/renamed-study/', { method: 'POST', body: new URLSearchParams({ password: 'open-sesame' }) });
  assert.equal(right.status, 303);
  const cookie = right.headers.get('set-cookie').split(';')[0];
  const unlocked = await live('/renamed-study/', { headers: { Cookie: cookie } });
  assert.equal(unlocked.status, 200);
  assert.ok((await unlocked.text()).includes('Hello'));
  const forged = await live('/renamed-study/', { headers: { Cookie: cookie.replace(/=.*/, '=forged') } });
  assert.equal(forged.status, 401);
  // changing the password invalidates existing cookies
  await admin.req('POST', `/cms-api/pages/${newPage}/visibility`, { visibility: 'password', password: 'new-secret' });
  await wait(200);
  assert.equal((await live('/renamed-study/', { headers: { Cookie: cookie } })).status, 401);
  // back to public
  const back = await admin.req('POST', `/cms-api/pages/${newPage}/visibility`, { visibility: 'public' });
  assert.equal(back.status, 200);
  assert.ok((await ghRead('renamed-study/index.html')).includes('Hello'));
});

test('revisions: list and restore as draft', async () => {
  const revs = await admin.req('GET', `/cms-api/pages/${myths.id}/revisions`);
  assert.ok(revs.data.revisions.length >= 3);
  const importRev = revs.data.revisions.find(r => r.kind === 'import');
  const rr = await admin.req('POST', `/cms-api/revisions/${importRev.id}/restore`, {});
  assert.equal(rr.status, 200);
  const p = await admin.req('GET', `/cms-api/pages/${myths.id}`);
  assert.ok(p.data.page.has_draft);
  assert.ok(!p.data.regions.body.includes('CMS draft marker'));
  await admin.req('POST', `/cms-api/pages/${myths.id}/discard-draft`, {});
});

test('protected blocks: tool UI survives editing; removing it needs confirmation', async () => {
  const list = await admin.req('GET', '/cms-api/pages');
  const tool = list.data.pages.find(p => p.url === '/http-status-checker.html');
  const r = await admin.req('GET', `/cms-api/pages/${tool.id}`);
  assert.ok(r.data.regions.body.includes('data-cms-block'));
  const removed = r.data.regions.body.replace(/<div[^>]*data-cms-block[^>]*>[^<]*<\/div>/, '');
  const bad = await admin.req('PUT', `/cms-api/pages/${tool.id}/draft`, { base_version: r.data.page.version, body: removed });
  assert.equal(bad.status, 422);
  const good = await admin.req('PUT', `/cms-api/pages/${tool.id}/draft`, { base_version: r.data.page.version, body: r.data.regions.body.replace('Check URL status', 'Check URL status codes') });
  assert.equal(good.status, 200);
  const prev = await admin.req('GET', `/cms-api/pages/${tool.id}/preview`);
  assert.ok(prev.data.includes('id="checkBtn"') && prev.data.includes('nikolaseo-http-status-checker'));
  await admin.req('POST', `/cms-api/pages/${tool.id}/discard-draft`, {});
});

test('users & roles: server-side enforcement', async () => {
  const mk = async (email, role) => (await admin.req('POST', '/cms-api/users', { email, name: role, role, password: 'a-long-password-123' })).data.user;
  const contributorUser = await mk('contrib@x.com', 'contributor');
  const editorUser = await mk('editor@x.com', 'editor');
  await mk('sub@x.com', 'subscriber');
  const contrib = new Client(); await contrib.login('contrib@x.com', 'a-long-password-123');
  const ed = new Client(); await ed.login('editor@x.com', 'a-long-password-123');
  const sub = new Client(); await sub.login('sub@x.com', 'a-long-password-123');

  assert.equal((await contrib.req('POST', `/cms-api/pages/${myths.id}/publish`, {})).status, 403);
  const p = await contrib.req('GET', `/cms-api/pages/${myths.id}`);
  assert.equal((await contrib.req('PUT', `/cms-api/pages/${myths.id}/draft`, { base_version: p.data.page.version, body: '<p>x</p>' })).status, 403, 'contributor cannot edit others');
  const own = await contrib.req('POST', '/cms-api/pages', { title: 'Contrib draft', slug: 'contrib-draft' });
  assert.equal(own.status, 201);
  const op = await contrib.req('GET', `/cms-api/pages/${own.data.id}`);
  const xss = await contrib.req('PUT', `/cms-api/pages/${own.data.id}/draft`, { base_version: op.data.page.version, body: '<p onclick="alert(1)">hi<script>alert(2)</script><a href="javascript:alert(3)">x</a><iframe src="https://evil.com"></iframe></p>' });
  assert.equal(xss.status, 200);
  const prev = await contrib.req('GET', `/cms-api/pages/${own.data.id}/preview`);
  assert.ok(!/onclick|alert\(2\)|javascript:|evil\.com/.test(prev.data.split('<article')[1]), 'unfiltered HTML stripped for contributors');
  assert.equal((await contrib.req('POST', `/cms-api/pages/${own.data.id}/publish`, {})).status, 403);
  assert.equal((await contrib.req('GET', '/cms-api/redirects')).status, 403);
  assert.equal((await contrib.req('GET', '/cms-api/users')).status, 403);
  assert.equal((await sub.req('GET', '/cms-api/pages')).status, 403);

  assert.equal((await ed.req('GET', '/cms-api/redirects')).status, 200);
  assert.equal((await ed.req('POST', '/cms-api/redirects', { source: '/ed', target: '/x/' })).status, 403, 'editor cannot manage redirects by default');
  await admin.req('PATCH', `/cms-api/users/${editorUser.id}`, { caps: { grant: ['redirects.manage'] } });
  const ed2 = new Client(); await ed2.login('editor@x.com', 'a-long-password-123');
  const made = await ed2.req('POST', '/cms-api/redirects', { source: '/ed', target: '/seo-myths/' });
  assert.equal(made.status, 201);
  await admin.req('DELETE', `/cms-api/redirects/${made.data.redirect.id}`);
  assert.equal((await ed2.req('PUT', '/cms-api/settings', { site_name: 'x' })).status, 403);

  // cannot remove the last admin
  const me = (await admin.req('GET', '/cms-api/auth/me')).data.user;
  assert.equal((await admin.req('PATCH', `/cms-api/users/${me.id}`, { role: 'editor' })).status, 409);
  // reset link flow
  const link = await admin.req('POST', `/cms-api/users/${contributorUser.id}/reset-link`, {});
  const token = link.data.url.split('#reset=')[1];
  assert.equal((await new Client().req('POST', '/cms-api/auth/reset', { token, password: 'brand-new-password-1' })).status, 200);
  assert.equal((await new Client().req('POST', '/cms-api/auth/reset', { token, password: 'brand-new-password-2' })).status, 400, 'single use');
  assert.equal((await contrib.req('GET', '/cms-api/auth/me')).status, 401, 'sessions revoked after reset');
  // deactivated users lose access immediately
  await admin.req('PATCH', `/cms-api/users/${editorUser.id}`, { active: false });
  assert.equal((await ed2.req('GET', '/cms-api/pages')).status, 401);
});

test('login rate limiting', async () => {
  const c = new Client();
  let last;
  for (let i = 0; i < 9; i++) last = await c.login('sub@x.com', `wrong-${i}-password`);
  assert.equal((await new Client().login('sub@x.com', 'a-long-password-123')).status, 429, 'locked even with the right password');
  assert.equal(last.status, 429);
});
