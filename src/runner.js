'use strict';
// Host side of the worker: one warm worker for small jobs, a time limit, and cancel. A worker that runs over
// its time or is cancelled is terminated (its helpers end with it) and a fresh one starts on the next job.
const path = require('path');
const { Worker } = require('worker_threads');

class RunError extends Error {
  constructor(message, line, kind) { super(message); this.line = line || 0; this.kind = kind || 'internal'; }
}

class Runner {
  constructor(file) {
    this.file = file || path.join(__dirname, 'worker.js');
    this.worker = null;
    this.seq = 0;
    this.busy = false;
  }

  spawn() {
    const w = new Worker(this.file, { workerData: { role: 'main' }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    w.unref();
    return w;
  }

  /**
   * job: { mode: 'document' | 'selection' | 'embedded', text, options, partial, threads, quote, indent }.
   * opts: { timeoutMs, onProgress(done, total), isCancelled() (polled), cancelSignal: { onCancel(fn) } }.
   */
  run(job, opts = {}) {
    // a second job while one runs gets its own worker, so format-on-save of two files never waits
    const own = this.busy || !this.worker;
    const w = own && this.busy ? this.spawn() : (this.worker || (this.worker = this.spawn()));
    const shared = w === this.worker;
    if (shared) this.busy = true;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => stop(new RunError(`formatting took longer than ${((opts.timeoutMs || 30000) / 1000).toFixed((opts.timeoutMs || 30000) < 10000 ? 1 : 0)} s`, 0, 'timeout')), opts.timeoutMs || 30000);
      const end = () => {
        settled = true; clearTimeout(timer);
        w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit);
        if (shared) this.busy = false;
      };
      const stop = (err) => {
        if (settled) return;
        end();
        w.terminate().catch(() => {});
        if (shared) this.worker = null;
        reject(err);
      };
      const onMsg = (m) => {
        if (!m || m.id !== id) return;
        if (m.progress) { if (opts.onProgress) opts.onProgress(m.progress.done, m.progress.total); return; }
        end();
        if (!shared) w.terminate().catch(() => {});
        if (m.ok) resolve(m.result);
        else reject(new RunError(m.error.message, m.error.line, m.error.kind));
      };
      const onErr = (e) => stop(new RunError(/memory|heap/i.test(String(e && e.message)) ? 'the formatter ran out of memory on this text' : String((e && e.message) || e), 0, 'crash'));
      const onExit = () => stop(new RunError('the formatter stopped', 0, 'crash'));
      w.on('message', onMsg); w.on('error', onErr); w.on('exit', onExit);
      if (opts.cancelSignal) opts.cancelSignal.onCancel(() => stop(new RunError('cancelled', 0, 'cancelled')));
      w.postMessage(Object.assign({ id }, job));
    });
  }

  dispose() { if (this.worker) { this.worker.terminate().catch(() => {}); this.worker = null; } }
}

module.exports = { Runner, RunError };
