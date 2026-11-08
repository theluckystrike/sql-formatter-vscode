'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Runner } = require('../src/runner');
const E = require('../src/engine');

function script(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`select a.id, b.name, sum(c.v) as total from t${i} a join u b on b.id = a.id left join w c on c.k = a.id where a.x > ${i} and b.s in ('p', 'q') group by a.id, b.name;`);
  return out.join('\n') + '\n';
}

test('threads give the same text as one thread', async () => {
  const r = new Runner();
  const text = script(3000);
  assert.ok(text.length > 256 * 1024);
  const one = await r.run({ mode: 'document', text, options: { dialect: 'sql' }, threads: 1 }, { timeoutMs: 120000 });
  const four = await r.run({ mode: 'document', text, options: { dialect: 'sql' }, threads: 4 }, { timeoutMs: 120000 });
  assert.equal(four.text, one.text);
  assert.equal(one.text, E.formatDocument(text, { dialect: 'sql' }).text);
  r.dispose();
});

test('the time limit stops the worker, and the next job still runs', async () => {
  const r = new Runner();
  await assert.rejects(r.run({ mode: 'document', text: script(4000), options: { dialect: 'sql' }, threads: 1 }, { timeoutMs: 300 }), (e) => e.kind === 'timeout');
  const ok = await r.run({ mode: 'document', text: 'select 1', options: { dialect: 'sql' } }, {});
  assert.equal(ok.text, 'SELECT\n  1');
  r.dispose();
});

test('cancel stops the run', async () => {
  const r = new Runner();
  let cancel;
  const p = r.run({ mode: 'document', text: script(4000), options: { dialect: 'sql' }, threads: 2 }, { timeoutMs: 60000, cancelSignal: { onCancel: (fn) => { cancel = fn; } } });
  setTimeout(() => cancel(), 100);
  await assert.rejects(p, (e) => e.kind === 'cancelled');
  r.dispose();
});

test('a parse error comes back with its line', async () => {
  const r = new Runner();
  await assert.rejects(r.run({ mode: 'document', text: "select 1;\n\nselect 'x;", options: { dialect: 'sql' } }, {}), (e) => e.kind === 'parse' && e.line === 3);
  r.dispose();
});
