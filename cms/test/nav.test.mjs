import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../worker/src/html.js';

const items = [
  { label: 'About', url: '/#about', children: [] },
  { label: 'Home', url: '/', children: [] },
  { label: 'Tool', url: '/serp-preview/', children: [] }
];
const hrefs = path => [...H.renderNav(items, path).matchAll(/href="([^"]+)"/g)].map(m => m[1]);

test('nav links never point at index.html', () => {
  assert.deepEqual(hrefs('index.html'), ['./#about', './', 'serp-preview/']);
  assert.deepEqual(hrefs('seo-myths/index.html'), ['../#about', '../', '../serp-preview/']);
  for (const p of ['index.html', 'a/index.html', 'a/b/index.html']) assert.ok(!hrefs(p).some(h => /\.html/.test(h)), p);
});

test('a menu read back from a rendered header matches the menu that rendered it', () => {
  const menu = [
    { label: 'About', url: '/#about', newTab: false, children: [] },
    { label: 'SEO Studies', url: '', newTab: false, children: [
      { label: 'Crawl Budget', url: '/crawl-budget/', newTab: false, children: [] },
      { label: 'Crawlability vs. Indexability', url: '/crawlability-vs-indexability/', newTab: false, children: [] }
    ] }
  ];
  for (const path of ['index.html', 'crawl-budget/index.html']) {
    const page = `<html><body><header><nav aria-label="Main navigation">${H.renderNav(menu, path)}</nav></header></body></html>`;
    assert.ok(H.sameMenu(H.readMenuFromHtml(page), menu), path);
  }
});

test('sameMenu ignores storage-only differences but sees a new or changed entry', () => {
  const base = [{ label: 'SEO Studies', url: '', children: [{ label: 'A', url: '/a/', children: [] }] }];
  assert.ok(H.sameMenu(base, [{ label: 'SEO Studies', url: '', newTab: false, external: false, children: [{ label: 'A', url: '/a/', newTab: false }] }]));
  assert.ok(!H.sameMenu(base, [{ label: 'SEO Studies', url: '', children: [{ label: 'A', url: '/a/', children: [] }, { label: 'B', url: '/b/', children: [] }] }]));
  assert.ok(!H.sameMenu(base, [{ label: 'SEO Studies', url: '', children: [{ label: 'A2', url: '/a/', children: [] }] }]));
  assert.ok(!H.sameMenu(base, null));
});
