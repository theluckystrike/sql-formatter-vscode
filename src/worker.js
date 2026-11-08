'use strict';
// Runs in a worker thread, never in the extension host: a slow or deep statement cannot freeze VS Code.
// Role "main" takes one job; for a large script it starts helper threads, each formatting a run of statements.
const { parentPort, workerData, Worker } = require('worker_threads');
const E = require('./engine');

const ser = (e) => ({ message: String((e && e.message) || e), line: (e && e.line) || 0, kind: (e && e.kind) || 'internal' });

if (workerData && workerData.role === 'helper') {
  parentPort.on('message', (m) => {
    try {
      parentPort.postMessage({ ok: true, pieces: E.formatParts(m.src, m.parts, m.o) });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: ser(e) });
    }
  });
} else {
  parentPort.on('message', async (job) => {
    try {
      const result = await run(job);
      parentPort.postMessage({ id: job.id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ id: job.id, ok: false, error: ser(e) });
    }
  });
}

const PARALLEL_MIN_CHARS = 256 * 1024;

/** Groups of statements of about equal size, in order. */
function groups(parts, count) {
  const total = parts.reduce((a, p) => a + (p.e - p.s), 0);
  const target = total / count;
  const out = [];
  let cur = []; let size = 0;
  for (const p of parts) {
    cur.push(p); size += p.e - p.s;
    if (size >= target && out.length < count - 1) { out.push(cur); cur = []; size = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}

function helper(src, parts, o) {
  const s0 = parts[0].s;
  const e1 = parts[parts.length - 1].e;
  const local = parts.map((p) => Object.assign({}, p, { s: p.s - s0, e: p.e - s0 }));
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { role: 'helper' }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    w.once('message', (m) => { w.terminate(); m.ok ? resolve(m.pieces) : reject(Object.assign(new E.FormatError(m.error.message, m.error.line, m.error.kind))); });
    w.once('error', (e) => { w.terminate(); reject(e); });
    w.postMessage({ src: src.slice(s0, e1), parts: local, o });
  });
}

async function run(job) {
  const t0 = Date.now();
  const progress = (done, total) => parentPort.postMessage({ id: job.id, progress: { done, total } });
  if (job.mode === 'selection') return E.formatSelection(job.text, job.options, { partial: job.partial });
  if (job.mode === 'embedded') return E.formatEmbedded(job.text, job.options, job.quote, job.indent);
  const plan = E.prepare(job.text, job.options);
  const threads = Math.max(1, Math.min(16, job.threads || 1));
  let pieces;
  if (threads > 1 && plan.src.length >= PARALLEL_MIN_CHARS && plan.parts.length >= threads * 4) {
    const gs = groups(plan.parts, threads);
    let done = 0;
    progress(0, plan.parts.length);
    const res = await Promise.all(gs.map((g) => helper(plan.src, g, plan.o).then((r) => { done += g.length; progress(done, plan.parts.length); return r; })));
    pieces = [].concat(...res);
  } else {
    pieces = E.formatParts(plan.src, plan.parts, plan.o, { onProgress: progress });
  }
  return E.assemble(plan, pieces, !!job.partial, t0);
}

module.exports = { groups };
