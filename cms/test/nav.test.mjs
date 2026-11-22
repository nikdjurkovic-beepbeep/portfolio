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
