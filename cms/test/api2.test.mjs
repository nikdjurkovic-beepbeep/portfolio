// Redirects, media and navigation end-to-end tests (run after api.test.mjs on the same environment).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../admin/js/shared/redirects.js';

const W = 'http://localhost:8787';
let cookie = '', csrf = '';
async function req(method, path, body, { form } = {}) {
  const h = { Cookie: cookie };
  if (method !== 'GET') h['X-CSRF-Token'] = csrf;
  let payload;
  if (form) payload = form; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(W + path, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const live = (p, o = {}) => fetch(W + p, { redirect: 'manual', ...o });

test('login', async () => {
  const res = await fetch(`${W}/cms-api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@nikolaseo.com', password: 'correct horse battery staple' }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  csrf = (await res.json()).csrf;
});

test('redirect CRUD: every status code returns the right HTTP response and Location', async () => {
  for (const code of [301, 302, 303, 307, 308]) {
    const r = await req('POST', '/cms-api/redirects', { source: `/t${code}`, target: '/seo-myths/', code });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const res = await live(`/t${code}?utm_source=x`);
    assert.equal(res.status, code);
    assert.equal(res.headers.get('location'), `${W}/seo-myths/?utm_source=x`);
  }
  // POST preserved with 307/308 (no method rewriting at the edge)
  const post = await live('/t307', { method: 'POST', body: 'a=1' });
  assert.equal(post.status, 307);
  // cross-domain absolute target
  await req('POST', '/cms-api/redirects', { source: '/go-out', target: 'https://example.com/landing', code: 302, query: 'ignore' });
  const out = await live('/go-out?x=1');
  assert.equal(out.headers.get('location'), 'https://example.com/landing');
  // wildcard and regex
  await req('POST', '/cms-api/redirects', { source: '/old-tools/*', target: '/*', match: 'wildcard' });
  assert.equal((await live('/old-tools/serp-preview.html')).headers.get('location'), `${W}/serp-preview.html`);
  await req('POST', '/cms-api/redirects', { source: '^/studies/(\\d{4})/([a-z-]+)/?$', target: '/$2/', match: 'regex', code: 308 });
  const rx = await live('/studies/2026/crawl-budget');
  assert.equal(rx.status, 308);
  assert.equal(rx.headers.get('location'), `${W}/crawl-budget/`);
  // query exact
  await req('POST', '/cms-api/redirects', { source: '/promo?id=7', target: '/schema-markup/', query: 'exact' });
  assert.equal((await live('/promo?id=7')).status, 301);
  assert.equal((await live('/promo?id=8')).status, 404);
});

test('edit, deactivate, delete; hits and last access recorded; duplicates refused', async () => {
  const list = await req('GET', '/cms-api/redirects?q=/t301');
  const r = list.data.redirects[0];
  assert.ok(r.hits >= 1, 'hit counted');
  assert.ok(r.last_hit);
  const dup = await req('POST', '/cms-api/redirects', { source: '/T301/', target: '/x/' });
  assert.equal(dup.status, 409);
  const ed = await req('PUT', `/cms-api/redirects/${r.id}`, { target: '/crawl-budget/' });
  assert.equal(ed.status, 200);
  assert.equal((await live('/t301')).headers.get('location'), `${W}/crawl-budget/`);
  await req('PUT', `/cms-api/redirects/${r.id}`, { active: false });
  assert.equal((await live('/t301')).status, 404);
  await req('DELETE', `/cms-api/redirects/${r.id}`);
  assert.equal((await req('GET', '/cms-api/redirects?q=/t301')).data.redirects.length, 0);
});

test('validation and diagnostics: self, loop, chain, reserved, invalid target', async () => {
  assert.equal((await req('POST', '/cms-api/redirects', { source: '/same', target: '/same' })).status, 422);
  assert.equal((await req('POST', '/cms-api/redirects', { source: '/admin/x', target: '/y' })).status, 422);
  assert.equal((await req('POST', '/cms-api/redirects', { source: '/a b', target: '/y' })).status, 422);
  assert.equal((await req('POST', '/cms-api/redirects', { source: '/z', target: 'javascript:alert(1)' })).status, 422);
  assert.equal((await req('POST', '/cms-api/redirects', { source: '/z', target: '/y', code: 305 })).status, 422);
  await req('POST', '/cms-api/redirects', { source: '/loop-a', target: '/loop-b' });
  const lb = await req('POST', '/cms-api/redirects', { source: '/loop-b', target: '/loop-a' });
  assert.ok(lb.data.issues.some(i => i.type === 'loop'));
  // Runtime loop guard: browser sees bounded hops, never an infinite server loop. Tester shows the loop.
  const t = await req('POST', '/cms-api/redirects/test', { url: '/loop-a' });
  assert.equal(t.data.loop, true);
  await req('POST', '/cms-api/redirects', { source: '/chain-1', target: '/t302' });
  const t2 = await req('POST', '/cms-api/redirects/test', { url: '/chain-1?q=1' });
  assert.equal(t2.data.hops.length, 2);
  assert.equal(t2.data.final, 'https://nikolaseo.com/seo-myths/?q=1');
  assert.equal(t2.data.finalIsKnownPage, true);
  const diag = await req('GET', '/cms-api/redirects?issue=chain');
  assert.ok(diag.data.redirects.some(r => r.source === '/chain-1'));
  assert.ok(diag.data.summary.loop >= 2);
  // Testing a candidate rule before saving it
  const cand = await req('POST', '/cms-api/redirects/test', { url: '/never-saved', rule: { source: '/never-saved', target: '/serp-preview.html', code: 302 } });
  assert.equal(cand.data.hops[0].code, 302);
  assert.equal((await live('/never-saved')).status, 404, 'candidate not live');
});

test('CSV: 2,000-row import with preview, validation, duplicates, conflicts, overwrite confirmation, summary', async () => {
  const lines = ['Source URL,Target URL,Redirect Type,query,active,notes'];
  for (let i = 0; i < 1990; i++) lines.push(`/bulk/old-${i}/,/seo-myths/,301,pass,true,row ${i}`);
  lines.push('/bulk/old-1/,/seo-myths/,301,pass,true,dup in file');      // duplicate in file
  lines.push('/bulk/old-2/,/crawl-budget/,301,pass,true,conflict in file'); // conflict in file
  lines.push('/t302,/schema-markup/,302,pass,true,conflicts with existing'); // conflict with DB
  lines.push('/t303,/seo-myths/,303,pass,true,identical to existing');       // duplicate of DB
  lines.push('not-a-path,/x/,301,pass,true,bad source');
  lines.push('/bad-code,/x/,399,pass,true,bad code');
  lines.push('/bad-target,ftp://x,301,pass,true,bad target');
  lines.push('/bad-bool,/x/,301,pass,maybe,bad active');
  lines.push('/loop-c,/loop-d,301,pass,true,');
  lines.push('/loop-d,/loop-c,301,pass,true,');
  const { rules, headerErrors } = R.rowsToRules(R.parseCsv(lines.join('\n')));
  assert.equal(headerErrors.length, 0);
  const t0 = Date.now();
  const prev = await req('POST', '/cms-api/redirects/import/preview', { rows: rules });
  assert.equal(prev.status, 200);
  console.log('preview ms', Date.now() - t0, prev.data.counts);
  const c = prev.data.counts;
  assert.equal(c.total, 2000);
  assert.equal(c.invalid, 6); // bad source/code/target/bool + 2 loop rows
  assert.equal(c.duplicate, 2);
  assert.equal(c.conflict, 2);
  assert.equal(c.valid, 1990);
  // Overwrite requires typed confirmation
  assert.equal((await req('POST', '/cms-api/redirects/import/commit', { rows: rules, overwriteConflicts: true })).status, 422);
  const before = (await req('GET', '/cms-api/redirects')).data.total;
  const t1 = Date.now();
  const commit = await req('POST', '/cms-api/redirects/import/commit', { rows: rules });
  console.log('commit ms', Date.now() - t1);
  assert.equal(commit.status, 200, JSON.stringify(commit.data).slice(0, 300));
  assert.equal(commit.data.imported, 1990);
  assert.equal(commit.data.failed.length, 6);
  assert.ok(commit.data.failed.every(f => f.row && f.errors.length));
  assert.equal(commit.data.skipped.length, 4);
  assert.equal(commit.data.updated, 0, 'conflicts not overwritten without confirmation');
  assert.equal((await req('GET', '/cms-api/redirects')).data.total, before + 1990);
  assert.equal((await live('/t302')).headers.get('location'), `${W}/seo-myths/`, 'existing rule untouched');
  const res = await live('/bulk/old-1500');
  assert.equal(res.status, 301);
  // Explicit overwrite
  const ow = await req('POST', '/cms-api/redirects/import/commit', { rows: [{ _row: 2, source: '/t302', target: '/schema-markup/', code: 302 }], overwriteConflicts: true, confirmOverwrite: 'OVERWRITE' });
  assert.equal(ow.data.updated, 1);
  assert.equal((await live('/t302')).headers.get('location'), `${W}/schema-markup/`);
  // Backups were taken before each import
  const b = await req('GET', '/cms-api/redirects/backups');
  assert.ok(b.data.backups.filter(x => /CSV import/.test(x.reason)).length >= 2);
});

test('CSV export (all + filtered) re-imports without losing settings; backup restore works', async () => {
  const all = await fetch(`${W}/cms-api/redirects/export`, { headers: { Cookie: cookie } });
  assert.match(all.headers.get('content-disposition'), /attachment/);
  const csv = await all.text();
  const parsed = R.rowsToRules(R.parseCsv(csv)).rules;
  const total = (await req('GET', '/cms-api/redirects')).data.total;
  assert.equal(parsed.length, total);
  const regex = parsed.find(r => r.match === 'regex');
  assert.equal(regex.source, '^/studies/(\\d{4})/([a-z-]+)/?$');
  assert.equal(regex.code, 308);
  const filtered = await (await fetch(`${W}/cms-api/redirects/export?scope=filtered&q=/bulk/old-19`, { headers: { Cookie: cookie } })).text();
  assert.equal(R.rowsToRules(R.parseCsv(filtered)).rules.length, 101); // old-19, old-190..199, old-1900..1989
  // Re-import of the export = all duplicates, nothing changes
  const again = await req('POST', '/cms-api/redirects/import/preview', { rows: parsed });
  assert.equal(again.data.counts.valid, 0);
  assert.equal(again.data.counts.duplicate, total - again.data.counts.invalid);
  // Restore: bulk delete then restore the pre-delete backup
  const ids = (await req('GET', '/cms-api/redirects?q=/bulk/&per=500')).data.redirects.map(r => r.id);
  await req('POST', '/cms-api/redirects/bulk', { ids, action: 'delete' });
  assert.equal((await live('/bulk/old-3')).status, 404);
  const backups = (await req('GET', '/cms-api/redirects/backups')).data.backups;
  const pre = backups.find(x => /Before bulk delete/.test(x.reason));
  assert.equal((await req('POST', `/cms-api/redirects/backups/${pre.id}/restore`, { confirm: 'nope' })).status, 422);
  const rs = await req('POST', `/cms-api/redirects/backups/${pre.id}/restore`, { confirm: 'RESTORE' });
  assert.equal(rs.status, 200);
  assert.equal((await live('/bulk/old-3')).status, 301);
});

test('bulk actions', async () => {
  const ids = (await req('GET', '/cms-api/redirects?q=/bulk/old-1&per=20')).data.redirects.map(r => r.id);
  await req('POST', '/cms-api/redirects/bulk', { ids, action: 'set_code', code: 302 });
  assert.equal((await live('/bulk/old-1')).status, 302);
  await req('POST', '/cms-api/redirects/bulk', { ids, action: 'deactivate' });
  assert.equal((await live('/bulk/old-1')).status, 404);
  await req('POST', '/cms-api/redirects/bulk', { ids, action: 'activate' });
  assert.equal((await live('/bulk/old-1')).status, 302);
});

test('live verification through the checker compares real HTTP status and Location', async () => {
  const ids = (await req('GET', '/cms-api/redirects?q=/t30')).data.redirects.map(r => r.id);
  const v = await req('POST', '/cms-api/redirects/verify-live', { ids });
  assert.equal(v.status, 200);
  assert.ok(v.data.results.length >= 3);
  assert.ok(v.data.results.every(r => r.pass), JSON.stringify(v.data.results.filter(r => !r.pass)));
});

test('redirects do not shadow the CMS or site assets unless explicitly configured', async () => {
  assert.equal((await live('/admin/')).status, 200);
  assert.equal((await live('/site.css')).status, 200);
  assert.equal((await fetch(`${W}/cms-api/setup`)).status, 200);
});

/* ---------------------------------------------------------- Media ---- */

const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const fileForm = (name, bytes, type, extra = {}) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };

test('media: upload with metadata, validation of type/content/SVG safety, replace, usage check, delete', async () => {
  const up = await req('POST', '/cms-api/media', undefined, { form: fileForm('My Photo.PNG', png1x1, 'image/png', { alt: 'A pixel', title: 'Pixel', caption: 'Tiny', folder: 'studies', width: '1', height: '1' }) });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.path, 'assets/uploads/studies/my-photo.png');
  assert.equal((await live('/assets/uploads/studies/my-photo.png')).status, 200);
  const dup = await req('POST', '/cms-api/media', undefined, { form: fileForm('my-photo.png', png1x1, 'image/png', { folder: 'studies' }) });
  assert.equal(dup.data.path, 'assets/uploads/studies/my-photo-2.png', 'no silent overwrite');
  assert.equal((await req('POST', '/cms-api/media', undefined, { form: fileForm('evil.png', Buffer.from('<html>'), 'image/png') })).status, 415);
  assert.equal((await req('POST', '/cms-api/media', undefined, { form: fileForm('x.exe', Buffer.from('MZ'), 'application/octet-stream') })).status, 415);
  assert.equal((await req('POST', '/cms-api/media', undefined, { form: fileForm('x.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml') })).status, 415);
  assert.equal((await req('POST', '/cms-api/media', undefined, { form: fileForm('ok.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>'), 'image/svg+xml') })).status, 201);
  const pdf = await req('POST', '/cms-api/media', undefined, { form: fileForm('Guide.pdf', Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf') });
  assert.equal(pdf.status, 201);
  const list = await req('GET', '/cms-api/media');
  const item = list.data.media.find(m => m.path === up.data.path);
  assert.equal(item.alt, 'A pixel');
  assert.equal(item.width, 1);
  assert.equal((await req('PATCH', '/cms-api/media', { path: up.data.path, alt: 'New alt', title: 'T', caption: 'C', collection: 'Covers' })).status, 200);
  // Use it on a page (draft), then deletion must be blocked
  const pages = (await req('GET', '/cms-api/pages')).data.pages;
  const p = pages.find(x => x.url === '/crawl-budget/');
  const pg = await req('GET', `/cms-api/pages/${p.id}`);
  await req('PUT', `/cms-api/pages/${p.id}/draft`, { base_version: pg.data.page.version, body: `${pg.data.regions.body}<figure class="figure"><img src="/${up.data.path}" alt="New alt"></figure>` });
  const del = await req('DELETE', `/cms-api/media?path=${encodeURIComponent(up.data.path)}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.usedIn[0].where, 'unpublished draft');
  // Replace keeps the URL; type change refused
  assert.equal((await req('POST', '/cms-api/media/replace', undefined, { form: fileForm('other.pdf', Buffer.from('%PDF-1.4'), 'application/pdf', { path: up.data.path }) })).status, 422);
  const rep = await req('POST', '/cms-api/media/replace', undefined, { form: fileForm('new.png', png1x1, 'image/png', { path: up.data.path }) });
  assert.equal(rep.status, 200);
  await req('POST', `/cms-api/pages/${p.id}/discard-draft`, {});
  const del2 = await req('DELETE', `/cms-api/media?path=${encodeURIComponent('assets/uploads/studies/my-photo-2.png')}`);
  assert.equal(del2.status, 200);
  assert.equal((await live('/assets/uploads/studies/my-photo-2.png')).status, 404);
  // Existing SVG used by an article is detected as in use
  await req('POST', '/cms-api/media/sync', {});
  const svgDel = await req('DELETE', `/cms-api/media?path=${encodeURIComponent('seo-myths/seo-myth-proxy-cycle.svg')}`);
  assert.equal(svgDel.status, 409);
});

/* ------------------------------------------------------------ Menus ---- */

test('navigation: edit, preview, publish to every page with correct relative links', async () => {
  const menus = (await req('GET', '/cms-api/menus')).data.menus;
  const primary = menus.find(m => m.location === 'primary');
  const items = primary.items;
  // Unchanged menu re-renders byte-identical navigation on existing pages
  const homeBefore = await (await live('/')).text();
  const pubSame = await req('POST', `/cms-api/menus/${primary.id}/publish`, {});
  assert.equal(pubSame.status, 200, JSON.stringify(pubSame.data));
  const homeAfter = await (await live('/')).text();
  const navOf = h => h.match(/<nav aria-label="Main navigation">[\s\S]*?<\/nav>/)[0];
  assert.equal(navOf(homeAfter), navOf(homeBefore), 'nav markup unchanged when menu unchanged');
  // Reorder, rename, add external + nested item
  const studies = items.find(i => i.label === 'SEO Studies');
  studies.children.unshift({ label: 'Crawl Budget (pinned)', url: '/crawl-budget/', children: [] });
  items.push({ label: 'GitHub', url: 'https://github.com/', newTab: true, children: [] });
  const bad = await req('PUT', `/cms-api/menus/${primary.id}`, { items: [{ label: '', url: '/x' }] });
  assert.equal(bad.status, 422);
  assert.equal((await req('PUT', `/cms-api/menus/${primary.id}`, { items })).status, 200);
  const preview = await req('GET', `/cms-api/menus/${primary.id}/preview?path=${encodeURIComponent('seo-myths/index.html')}`);
  assert.ok(preview.data.includes('<a href="../crawl-budget/">Crawl Budget (pinned)</a>'));
  assert.ok(!(await (await live('/')).text()).includes('pinned'), 'not live before publish');
  const brokenItems = [...items, { label: 'Broken', url: '/does-not-exist/', children: [] }];
  await req('PUT', `/cms-api/menus/${primary.id}`, { items: brokenItems });
  const blocked = await req('POST', `/cms-api/menus/${primary.id}/publish`, {});
  assert.equal(blocked.status, 422);
  await req('PUT', `/cms-api/menus/${primary.id}`, { items });
  const pub = await req('POST', `/cms-api/menus/${primary.id}/publish`, {});
  assert.equal(pub.status, 200);
  const home = await (await live('/')).text();
  assert.ok(home.includes('<a href="crawl-budget/">Crawl Budget (pinned)</a>'));
  assert.ok(home.includes('href="https://github.com/" target="_blank" rel="noopener"'));
  const article = await (await live('/schema-markup/')).text();
  assert.ok(article.includes('<a href="../crawl-budget/">Crawl Budget (pinned)</a>'));
  assert.ok(article.includes('<summary class="active">SEO Studies</summary>'));
  assert.ok(article.includes('<a href="../schema-markup/" aria-current="page">'));
  const tool = await (await live('/serp-preview.html')).text();
  assert.ok(tool.includes('<a href="serp-preview.html" aria-current="page">'));
  // Second menu cannot replace the primary silently; delete protected
  assert.equal((await req('POST', '/cms-api/menus', { name: 'Footer', location: 'primary' })).status, 409);
  assert.equal((await req('DELETE', `/cms-api/menus/${primary.id}`)).status, 409);
  const footer = await req('POST', '/cms-api/menus', { name: 'Footer', items: [{ label: 'CV', url: '/Nikola_Djurkovic_CV.pdf' }] });
  assert.equal(footer.status, 201);
  assert.equal((await req('DELETE', `/cms-api/menus/${footer.data.id}`)).status, 200);
});

test('categories & tags appear as article meta on publish', async () => {
  const cat = await req('POST', '/cms-api/terms', { taxonomy: 'category', name: 'Technical SEO' });
  const tag = await req('POST', '/cms-api/terms', { taxonomy: 'tag', name: 'Schema' });
  const pages = (await req('GET', '/cms-api/pages')).data.pages;
  const p = pages.find(x => x.url === '/schema-markup/');
  const pg = await req('GET', `/cms-api/pages/${p.id}`);
  await req('PUT', `/cms-api/pages/${p.id}/draft`, { base_version: pg.data.page.version, terms: [cat.data.id, tag.data.id] });
  await req('POST', `/cms-api/pages/${p.id}/publish`, {});
  const html = await (await live('/schema-markup/')).text();
  assert.ok(html.includes('<meta property="article:section" content="Technical SEO">'));
  assert.ok(html.includes('<meta property="article:tag" content="Schema">'));
});

test('backup export contains no password hashes; audit log records actions', async () => {
  const b = await fetch(`${W}/cms-api/backup`, { headers: { Cookie: cookie } });
  const text = await b.text();
  assert.ok(!text.includes('pbkdf2$'));
  const data = JSON.parse(text);
  assert.ok(data.tables.redirects.length > 1000);
  const audit = await req('GET', '/cms-api/audit');
  assert.ok(audit.data.entries.some(e => e.action === 'redirect.import'));
  assert.ok(audit.data.entries.some(e => e.action === 'page.published'));
});

test('public site still served correctly for every original page', async () => {
  for (const p of ['/', '/seo-myths/', '/crawl-budget/', '/schema-markup/', '/seo-vs-geo-case-study/', '/serp-preview.html', '/http-status-checker.html', '/robots.txt', '/Nikola_Djurkovic_CV.pdf', '/googlec6d6026729dc585e.html']) {
    assert.equal((await live(p)).status, 200, p);
  }
});

test('pages committed straight to GitHub (writer agent) appear on their own; titles keep spaces at <br>', async () => {
  const GH = 'http://localhost:8789';
  const pages0 = (await req('GET', '/cms-api/pages')).data.pages;
  const home = pages0.find(x => x.url === '/');
  assert.ok(!/SEO\.At/.test(home.title), `home title: ${home.title}`);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent article | NikolaSEO</title><meta name="description" content="x"><link rel="canonical" href="https://nikolaseo.com/agent-article/"></head><body><main><h1>Agent<br><span>article.</span></h1><p>Body</p></main></body></html>';
  await fetch(`${GH}/_external-commit`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'agent-article/index.html', text: html }) });
  assert.ok(!(await req('GET', '/cms-api/pages')).data.pages.some(x => x.url === '/agent-article/'), 'not imported before the scheduler runs');
  await fetch(`${W}/__scheduled`);
  let p;
  for (let i = 0; i < 30 && !p; i++) { // the scheduled handler finishes in waitUntil
    p = (await req('GET', '/cms-api/pages')).data.pages.find(x => x.url === '/agent-article/');
    if (!p) await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(p, 'imported by the scheduler');
  assert.equal(p.title, 'Agent article.');
  const edit = await req('GET', `/cms-api/pages/${p.id}`);
  assert.equal(edit.status, 200);
  const audit = await req('GET', '/cms-api/audit');
  assert.ok(audit.data.entries.some(e => e.action === 'pages.auto_sync'));
  // A second run with no new commits does nothing.
  await fetch(`${W}/__scheduled`); await new Promise(r => setTimeout(r, 1500));
  const after = (await req('GET', '/cms-api/audit')).data.entries.filter(e => e.action === 'pages.auto_sync').length;
  assert.equal(after, audit.data.entries.filter(e => e.action === 'pages.auto_sync').length);
});

test('a CMS publish never drops a page the writer agent just committed from the sitemap', async () => {
  const GH = 'http://localhost:8789';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fresh | NikolaSEO</title><link rel="canonical" href="https://nikolaseo.com/fresh-agent/"></head><body><main><h1>Fresh</h1></main></body></html>';
  await fetch(`${GH}/_external-commit`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'fresh-agent/index.html', text: html }) });
  // No scheduler run in between: publish something in the CMS right away.
  const pages = (await req('GET', '/cms-api/pages')).data.pages;
  const p = pages.find(x => x.url === '/crawl-budget/');
  const pg = await req('GET', `/cms-api/pages/${p.id}`);
  const d = await req('PUT', `/cms-api/pages/${p.id}/draft`, { base_version: pg.data.page.version, seo: { ...pg.data.page.seo, description: 'Sitemap race check' } });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const pub = await req('POST', `/cms-api/pages/${p.id}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const sm = await (await live('/sitemap.xml')).text();
  assert.ok(sm.includes('https://nikolaseo.com/fresh-agent/'), 'writer page kept in the sitemap');
});
