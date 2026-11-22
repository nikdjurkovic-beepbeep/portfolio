#!/usr/bin/env node
// Post-deploy verification against the LIVE site (run from any machine that can reach it).
//
//   node cms/scripts/verify-deploy.mjs https://nikolaseo.com [redirects-export.csv]
//
// Checks every sitemap URL (200, single canonical, robots meta), the admin/API wiring and
// security headers, and — when given a CSV exported from the CMS — the real HTTP status code
// and Location header of every active exact-match redirect.
import fs from 'node:fs';
import * as R from '../../admin/js/shared/redirects.js';

const args = process.argv.slice(2);
const setupMayBePending = args.includes('--setup-may-be-pending');
const positional = args.filter(a => !a.startsWith('--'));
const base = (positional[0] || 'https://nikolaseo.com').replace(/\/$/, '');
const csvPath = positional[1];

// Right after a deploy the route can take a few seconds to attach: wait for the CMS API.
for (let i = 0; i < 24; i++) {
  const r = await fetch(`${base}/cms-api/setup`).catch(() => null);
  if (r && (r.headers.get('content-type') || '').includes('json')) break;
  if (i === 23) console.log('WARN  CMS API did not answer within 2 minutes');
  await new Promise(res => setTimeout(res, 5000));
}
let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const get = (path, opts = {}) => fetch(path.startsWith('http') ? path : base + path, { redirect: 'manual', ...opts });

const sm = await (await get('/sitemap.xml')).text();
const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace('https://nikolaseo.com', base));
ok(urls.length > 0, 'sitemap.xml lists URLs', `${urls.length}`);
for (const u of urls) {
  const res = await get(u);
  const html = res.status === 200 ? await res.text() : '';
  const canon = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map(m => m[1]);
  const robots = html.match(/<meta name="robots" content="([^"]+)"/)?.[1] || '';
  ok(res.status === 200 && canon.length === 1 && !/noindex/.test(robots), `page ${u}`, `status ${res.status}, canonical ×${canon.length}${robots ? `, robots "${robots}"` : ''}`);
}
const admin = await get('/admin/');
ok(admin.status === 200 && admin.headers.get('x-frame-options') === 'DENY' && /noindex/.test(admin.headers.get('x-robots-tag') || ''), 'admin served through the Worker with security headers', `status ${admin.status}, XFO ${admin.headers.get('x-frame-options')}`);
const setup = await get('/cms-api/setup');
ok(setup.status === 200 && (setup.headers.get('content-type') || '').includes('json'), 'CMS API reachable', `status ${setup.status}`);
const needs = setup.status === 200 ? (await setup.json()).needsSetup : null;
if (needs && setupMayBePending) console.log('NOTE  first-time setup is pending: open /admin/ to create the administrator');
else ok(needs === false, 'first administrator exists (setup closed)', needs ? 'run setup in /admin/ now and then remove SETUP_TOKEN' : '');
const unauth = await get('/cms-api/pages');
ok(unauth.status === 401, 'API rejects anonymous requests', `status ${unauth.status}`);
const missing = await get('/this-page-should-not-exist-cms-check/');
ok(missing.status === 404, 'unknown URL still returns 404 from the origin', `status ${missing.status}`);

if (csvPath) {
  const rules = R.rowsToRules(R.parseCsv(fs.readFileSync(csvPath, 'utf8'))).rules.map((r, i) => ({ ...r, id: i + 1 }));
  const compiled = R.compile(rules);
  const exact = rules.filter(r => r.active !== false && (r.match || 'exact') === 'exact');
  console.log(`\nChecking ${exact.length} active exact-match redirects…`);
  for (const r of exact) {
    const { path, query } = R.splitSource(r.source);
    const url = `https://nikolaseo.com${path}${query ? `?${query}` : ''}`;
    const expected = R.match(compiled, url);
    const res = await get(url.replace('https://nikolaseo.com', base));
    const loc = res.headers.get('location');
    const want = expected?.location.replace('https://nikolaseo.com', base);
    ok(expected && res.status === expected.code && loc === want, `${r.source}`, `expected ${expected?.code} → ${want}, got ${res.status} → ${loc}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
