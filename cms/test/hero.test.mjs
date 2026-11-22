import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as H from '../worker/src/html.js';
const path = 'crawl-budget/index.html';
const base = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const marked = base.replace(/(<section class="hero"[\s\S]*?<h1[^>]*>)([\s\S]*?)(<\/h1>)/, '$1Crawl Budget:<br><span>When Does It Matter?</span>$3');
test('hero headline with inline markup survives an unchanged save', () => {
  const { body, hero } = H.extractEditable(marked, path);
  assert.equal(hero.headline, 'Crawl Budget: When Does It Matter?');
  const out = H.composeEditable(marked, path, { body, hero });
  assert.match(out, /<h1[^>]*>Crawl Budget:<br><span>When Does It Matter\?<\/span><\/h1>/);
});
test('a changed headline is written', () => {
  const { body, hero } = H.extractEditable(marked, path);
  const out = H.composeEditable(marked, path, { body, hero: { ...hero, headline: 'New headline' } });
  assert.match(out, /<h1[^>]*>New headline<\/h1>/);
});
