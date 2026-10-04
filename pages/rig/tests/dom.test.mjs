// DOM wiring check: every id referenced in js/app.js must exist in index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, '..', 'index.html'), 'utf8');
const js = readFileSync(path.join(dir, '..', 'js', 'app.js'), 'utf8');

test('all $("id") lookups resolve to an element in index.html', () => {
  const ids = new Set();
  for (const m of js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], 'missing ids: ' + missing.join(', '));
});

test('footer carries donation address and @kshot9000', () => {
  assert.ok(html.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d'));
  assert.ok(html.includes('x.com/kshot9000'));
});

test('cache-buster keys present on css + js', () => {
  assert.ok(html.includes('styles.css?v='));
  assert.ok(html.includes('js/app.js?v='));
});


test('core module import is cache-versioned (structural ?v= gap)', () => {
  assert.ok(js.includes("from './rig-core.js?v=1'"), 'rig-core import carries ?v=');
  assert.ok(!js.includes("from './rig-core.js';"), 'no unversioned core import remains');
  assert.ok(html.includes('js/app.js?v=1.0.3'));
});
