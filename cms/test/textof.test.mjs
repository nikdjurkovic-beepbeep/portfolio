import test from 'node:test'; import assert from 'node:assert/strict';
import * as H from '../worker/src/html.js';
test('textOf treats <br> as a space', () => {
  const d = H.parse('<main><h1>AI crawler access<br><span>checker.</span></h1><h2>A  \n  b</h2></main>');
  assert.equal(H.textOf(d.querySelector('h1')), 'AI crawler access checker.');
  assert.equal(H.textOf(d.querySelector('h2')), 'A b');
  assert.equal(H.textOf(null), '');
});
