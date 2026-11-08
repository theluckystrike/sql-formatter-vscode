'use strict';
// minimalSpan and quoteOf, with a stub vscode module.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? {} : orig.call(this, r, ...a); };
const { _internal } = require('../src/extension.js');
Module._load = orig;

const apply = (a, sp) => (sp ? a.slice(0, sp.start) + sp.text + a.slice(sp.end) : a);

test('minimalSpan gives exactly the new text (leading newline, CRLF, empty, same)', () => {
  const cases = [
    ['\n-- Sakila\nselect 1;\n', '-- Sakila\nSELECT\n  1;\n'],
    ['select 1;\r\nselect 2;\r\n', 'select 1;\r\nSELECT\r\n  2;\r\n'],
    ['', 'SELECT\n  1\n'],
    ['select 1', ''],
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['\n\n\nx', 'x'],
    ['same\n', 'same\n'],
  ];
  for (const [a, b] of cases) assert.equal(apply(a, _internal.minimalSpan(a, b)), b, JSON.stringify([a, b]));
});

test('minimalSpan keeps unchanged first and last lines out of the edit', () => {
  const a = '-- head\nselect a,b from t;\n-- tail\n';
  const b = '-- head\nSELECT\n  a,\n  b\nFROM\n  t;\n-- tail\n';
  const sp = _internal.minimalSpan(a, b);
  assert.equal(sp.start, 8);
  assert.equal(a.slice(sp.end), '\n-- tail\n');
});

test('random edits always give the new text', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const chars = ['a', '\n', ' ', '-', '\r\n', 'S'];
  const gen = () => { let s = ''; const n = rnd(30); for (let i = 0; i < n; i++) s += chars[rnd(chars.length)]; return s; };
  for (let k = 0; k < 3000; k++) { const a = gen(); const b = gen(); assert.equal(apply(a, _internal.minimalSpan(a, b)), b); }
});

test('quoteOf tells one-line and multi-line strings', () => {
  assert.deepEqual(_internal.quoteOf('q = "', '"'), { q: '"', multi: false });
  assert.deepEqual(_internal.quoteOf('q = """', '"""'), { q: '"""', multi: true });
  assert.deepEqual(_internal.quoteOf('const q = `', '`;'), { q: '`', multi: true });
  assert.deepEqual(_internal.quoteOf('var q = @"', '";'), { q: '"', multi: true });
});
