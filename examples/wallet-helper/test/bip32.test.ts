/** BIP-32 derivation-path parser tests. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath } from '../src/index.js';

const H = 0x80000000;

describe('parsePath', () => {
  it('parses canonical paths exactly', () => {
    assert.deepEqual(parsePath("m/86'/808276'/0'/0/0"), [86 + H, 808276 + H, 0 + H, 0, 0]);
    assert.deepEqual(parsePath('M/0h/1H/2'), [0 + H, 1 + H, 2]);
    assert.deepEqual(parsePath('0/0'), [0, 0]);
  });

  it('refuses malformed components instead of silently deriving a different key', () => {
    // Bare parseInt coerced every one of these to a valid-looking index.
    assert.throws(() => parsePath('m/86abc/0'), /invalid path component/);
    assert.throws(() => parsePath('m/1.5/0'), /invalid path component/);
    assert.throws(() => parsePath('m/0x10/0'), /invalid path component/);
    assert.throws(() => parsePath("m/86''/0"), /invalid path component/);
    assert.throws(() => parsePath('m//0'), /invalid path component/);
    assert.throws(() => parsePath('m/-1/0'), /invalid path component/);
    assert.throws(() => parsePath('m/2147483648/0'), /invalid path component/);
  });
});
