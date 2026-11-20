import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../admin/js/shared/redirects.js';
const S = 'https://nikolaseo.com';
const rules = [
  { id: 1, source: '/old/', target: '/new/', code: 301 },
  { id: 2, source: '/promo?id=5', target: '/landing/', code: 302, query: 'exact' },
  { id: 3, source: '/drop', target: '/kept/', code: 307, query: 'ignore' },
  { id: 4, source: '/blog/*', target: '/studies/*', code: 308, match: 'wildcard' },
  { id: 5, source: '^/tools/([a-z-]+)\\.php$', target: '/$1.html', code: 303, match: 'regex' },
  { id: 6, source: '/ext', target: 'https://example.com/x?a=1', code: 301 },
  { id: 7, source: '/off', target: '/x/', active: false },
  { id: 8, source: '/CaseSensitive', target: '/cs/', ignore_case: false },
];
const c = R.compile(rules);
const m = u => R.match(c, S + u);
test('exact + trailing slash + case + query pass', () => {
  assert.deepEqual([m('/old/').code, m('/old/').location], [301, S + '/new/']);
  assert.equal(m('/OLD').location, S + '/new/');
  assert.equal(m('/old/?utm=a&b=2').location, S + '/new/?utm=a&b=2');
});
test('query exact (any order) vs not', () => {
  assert.equal(m('/promo?id=5').location, S + '/landing/');
  assert.equal(m('/promo?id=6'), null);
  assert.equal(m('/promo'), null);
});
test('query ignore drops query', () => assert.equal(m('/drop?x=1').location, S + '/kept/'));
test('wildcard capture', () => assert.deepEqual([m('/blog/a/b').code, m('/blog/a/b').location], [308, S + '/studies/a/b']));
test('regex capture', () => assert.deepEqual([m('/tools/serp.php').code, m('/tools/serp.php').location], [303, S + '/serp.html']));
test('cross-domain with query merge', () => assert.equal(m('/ext?z=9').location, 'https://example.com/x?a=1&z=9'));
test('inactive not live', () => assert.equal(m('/off'), null));
test('case sensitive', () => { assert.equal(m('/casesensitive'), null); assert.ok(m('/CaseSensitive')); });
test('no match', () => assert.equal(m('/seo-myths/'), null));
test('validation', () => {
  assert.ok(R.validateRule({ source: '/a', target: '/a' }).errors.some(e => /self/.test(e)));
  assert.ok(R.validateRule({ source: 'a', target: '/b' }).errors.length);
  assert.ok(R.validateRule({ source: '/a', target: 'javascript:alert(1)' }).errors.length);
  assert.ok(R.validateRule({ source: '/a', target: '/b', code: 304 }).errors.length);
  assert.ok(R.validateRule({ source: '/admin/x', target: '/b' }).errors.length);
  assert.ok(R.validateRule({ source: '([', target: '/b', match: 'regex' }).errors.length);
  assert.ok(R.validateRule({ source: 'https://other.com/a', target: '/b' }).errors.length);
  assert.equal(R.validateRule({ source: 'https://nikolaseo.com/a', target: '/b' }).errors.length, 0);
});
test('diagnose loop, chain, duplicate, conflict, shadow, target', () => {
  const set = [
    { id: 1, source: '/a', target: '/b' }, { id: 2, source: '/b', target: '/a' },
    { id: 3, source: '/c', target: '/d' }, { id: 4, source: '/d', target: '/e/' },
    { id: 5, source: '/x', target: '/y/' }, { id: 6, source: '/x/', target: '/z/' },
    { id: 7, source: '/p', target: '/q/' }, { id: 8, source: '/P/', target: '/q/' },
    { id: 9, source: '/s/*', target: '/t/', match: 'wildcard', position: -1 }, { id: 10, source: '/s/1', target: '/u/' },
  ];
  const d = R.diagnose(set, { knownPaths: new Set(['/b', '/a', '/d', '/e/', '/q/', '/t/', '/u/', '/y/']) });
  const types = id => (d.get(id) || []).map(i => i.type);
  assert.ok(types(1).includes('loop'));
  assert.ok(types(3).includes('chain'));
  assert.ok(types(5).includes('conflict') && types(6).includes('conflict'));
  assert.ok(types(7).includes('duplicate'));
  assert.ok(types(10).includes('conflict'));
  assert.ok(types(6).includes('target'));
  const t = R.trace(set, '/c'); assert.equal(t.hops.length, 2); assert.equal(t.final, S + '/e/');
});
test('CSV round trip keeps every setting', () => {
  const csv = R.toCsv(rules);
  const back = R.rowsToRules(R.parseCsv(csv)).rules;
  assert.equal(back.length, rules.length);
  for (let i = 0; i < rules.length; i++) {
    const a = R.coerceRule(rules[i]), b = R.coerceRule(back[i]);
    for (const k of ['source', 'target', 'code', 'match', 'query', 'ignore_case', 'ignore_slash', 'active', 'position']) assert.equal(b[k], a[k], `${k} row ${i}`);
  }
});
test('CSV aliases, headerless, bad values, formula safety', () => {
  const r1 = R.rowsToRules(R.parseCsv('Source URL;Target URL;Redirect Type;Regex\n/a;/b;302;no\n^/r(.*);/s$1;301;yes\n/c;/d;3O1;no\n'));
  assert.equal(r1.rules[0].code, 302); assert.equal(r1.rules[1].match, 'regex'); assert.ok(r1.rules[2]._parseErrors.length);
  const r2 = R.rowsToRules(R.parseCsv('/a,/b,301\n/c,/d\n')); assert.equal(r2.rules.length, 2); assert.equal(r2.rules[0]._row, 1);
  assert.ok(R.toCsv([{ source: '/a', target: '/b', notes: '=HYPERLINK("x")' }]).includes("'=HYPERLINK"));
  assert.equal(R.rowsToRules(R.parseCsv('foo,bar\n1,2')).headerErrors.length, 1);
});
test('template parses cleanly', () => {
  const t = R.rowsToRules(R.parseCsv(R.csvTemplate())).rules;
  assert.equal(t.length, 4); t.forEach(r => assert.equal(R.validateRule(r).errors.length, 0, r.source));
});
test('performance: 5000 rules', () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, source: `/old-${i}/`, target: `/new-${i}/` }));
  const t0 = Date.now(); const cc = R.compile(big); for (let i = 0; i < 5000; i++) R.match(cc, `${S}/old-${i}`); 
  const t1 = Date.now(); R.diagnose(big); const t2 = Date.now();
  console.log(`compile+5000 matches ${t1 - t0}ms, diagnose ${t2 - t1}ms`);
  assert.ok(t1 - t0 < 2000);
});
test('shadowing a live page is flagged', () => {
  const d = R.diagnose([{ id: 1, source: '/seo-myths', target: '/x/' }], { knownPaths: new Set(['/seo-myths/', '/seo-myths', '/x/']) });
  assert.ok((d.get(1) || []).some(i => i.type === 'shadow'));
});
