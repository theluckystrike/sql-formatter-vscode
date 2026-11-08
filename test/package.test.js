'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('engine floor for Cursor, Windsurf and VSCodium (OVX1)', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
});

test('display name has every search word and is not another listing\'s name', () => {
  const n = pkg.displayName.toLowerCase();
  for (const w of ['sql', 'format', 'formatter']) assert.ok(n.split(/[^a-z]+/).includes(w), w);
  for (const other of ['sql formatter', 'format sql', 'sql format', 'prettier sql vscode', 'sql beautify']) assert.notEqual(n, other);
  assert.ok(!/prettier/.test(n));
});

test('no network code in the extension', () => {
  for (const f of fs.readdirSync(path.join(root, 'src'))) {
    const s = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram|child_process)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket/.test(s), f);
  }
});

test('every setting the code reads is declared', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
  const props = pkg.contributes.configuration.properties;
  for (const m of src.matchAll(/(?:cfg\([^)]*\)|c)\.get\('([A-Za-z]+)'/g)) assert.ok(props[`sqlFormatter.${m[1]}`], m[1]);
});

test('walkthrough media files exist', () => {
  for (const s of pkg.contributes.walkthroughs[0].steps) {
    const f = s.media.image || s.media.markdown;
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});
