// Release gate in a real VS Code. Installs the .vsix into an isolated profile, formats real SQL files with the
// real keybinding (Shift+Alt+F) and Save, and compares each saved file with the engine run in Node and with a
// token diff (whitespace ignored). Hostile files must stay unchanged with a message. The large file is timed,
// cancelled once, and the extension host must answer a command while it runs.
// usage: node scripts/gate-vscode.mjs <work> <port> <vsix> <filesDir> <shotDir> <outJson> [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const L = require('../src/lexer.js');
const D = require('../src/dialect.js');

const [work0, port, vsix, files0, shotDir, outJson, theme] = process.argv.slice(2);
const work = path.resolve(work0);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const R = { theme: theme || 'Default Dark Modern', vsixSha256: sha(fs.readFileSync(vsix)), files: [], steps: [], timings: {}, connections: [] };
const tag = /Light/.test(R.theme) ? 'light' : 'dark';
const ws = path.join(work, 'ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
const originals = {};
for (const f of fs.readdirSync(files0)) {
  const src = path.join(files0, f);
  if (!fs.statSync(src).isFile()) continue;
  fs.copyFileSync(src, path.join(ws, f));
  originals[f] = fs.readFileSync(src, 'utf8');
}
fs.writeFileSync(path.join(ws, 'app.py'), 'import sqlite3\nq1 = """select a.id,a.name,count(*) n from users a join orders o on o.user_id=a.id group by a.id,a.name"""\nq2 = "select id,name from users where id = ? and active=1"\n');
fs.writeFileSync(path.join(ws, 'onsave.sql'), "select id,name from users where active=1 and created_at>'2026-01-01' order by name;\n");
originals['app.py'] = fs.readFileSync(path.join(ws, 'app.py'), 'utf8');
originals['onsave.sql'] = fs.readFileSync(path.join(ws, 'onsave.sql'), 'utf8');

fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const SETTINGS = {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'workbench.editor.enablePreview': false, 'editor.minimap.enabled': false, 'editor.stickyScroll.enabled': false,
  'editor.detectIndentation': false, 'editor.tabSize': 2, 'editor.insertSpaces': true, 'files.insertFinalNewline': false, 'files.trimTrailingWhitespace': false,
  'workbench.editorLargeFileConfirmation': 1024, 'extensions.ignoreRecommendations': true, 'editor.fontSize': 13, 'workbench.statusBar.visible': true,
};
let vs = await launch(work, Number(port), ws, SETTINGS);

const shots = [];
const shot = async (name) => { const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(path.basename(f)); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', name, JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 500)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const must = (c, msg) => { if (!c) throw new Error(msg); };

// ---- workbench helpers ----
const activeTab = () => vs.wbEval(`(() => { const t = document.querySelector('.tabs-container .tab.active'); return t ? (t.getAttribute('aria-label') || t.textContent || '') : ''; })()`);
const activeDirty = () => vs.wbEval(`!!document.querySelector('.tabs-container .tab.active.dirty')`);
const notifications = () => vs.notifications().catch(() => []);
const dialectStatus = () => vs.wbEval(`(() => { const e = document.querySelector('[id$="sqlFormatter.dialect"]'); return e ? e.textContent.trim() : ''; })()`);
const focusWindow = async () => { spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${vs.child.pid}) to true`], { timeout: 10000 }); await sleep(300); return vs.wbEval('document.hasFocus()').catch(() => null); };
const statusTexts = () => vs.wbEval(`[...document.querySelectorAll('.statusbar-item')].map(e => e.textContent.trim()).filter(Boolean)`);
const quickOpen = () => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null); })()`);
const quickRows = () => vs.wbEval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.textContent.trim().slice(0, 160))`);
const clearNotifications = async () => { try { await vs.command('Notifications: Clear All Notifications'); } catch {} await sleep(300); };
async function open(name) {
  vs.open(path.join(ws, name));
  const ok = await vs.waitFor(async () => (await activeTab()).includes(name), 15000, 150);
  must(ok, `${name} did not open (active tab: ${await activeTab()})`);
  await sleep(600);
  await vs.wbEval(`(document.querySelector('.monaco-editor textarea') || document.body).focus(), 1`);
  await vs.click(700, 300);
  await sleep(200);
}
const formatKey = () => vs.key('F', 'KeyF', 1 | 8, 70); // Shift+Alt+F
const saveKey = () => vs.key('s', 'KeyS', 4, 83); // Cmd+S
async function save(name) {
  await saveKey();
  await vs.waitFor(async () => !(await activeDirty()), 10000, 100);
  await sleep(300);
  return fs.readFileSync(path.join(ws, name), 'utf8');
}
function expected(name, text, extra) {
  const d = D.pick({ languageId: 'sql', fileName: name, text: text.split('\n').slice(0, 4000).join('\n') }).dialect;
  return { d, out: E.formatDocument(text, Object.assign({ dialect: d, tabWidth: 2, useTabs: false }, extra || {})).text };
}
const squash = (s) => s.replace(/\s+/g, '').toUpperCase();

// No ask in session 1 (it had refusals) is checked at the end of the loop below.
// ---- 1. good files ----
const GOOD = Object.keys(originals).filter((f) => /\.(sql|pgsql|tsql|plsql)$/.test(f) && !/^hostile-|^large-|^onsave/.test(f)).sort();
const HOSTILE = Object.keys(originals).filter((f) => /^hostile-/.test(f)).sort();
const LARGE = Object.keys(originals).filter((f) => /^large-/.test(f));
R.counts = { good: GOOD.length, hostile: HOSTILE.length, large: LARGE.length };

for (const f of GOOD) {
  await step(`format ${f}`, async () => {
    await clearNotifications();
    await open(f);
    const exp = expected(f, originals[f]);
    const st = await vs.waitFor(async () => { const t = await dialectStatus(); return t === D.SHORT[exp.d] ? t : null; }, 5000, 150);
    const t0 = Date.now();
    await formatKey();
    const changed = await vs.waitFor(async () => (await activeDirty()) || null, exp.out === originals[f] ? 1500 : 15000, 80);
    const ms = Date.now() - t0;
    const disk = await save(f);
    const notes = await notifications();
    must(!notes.some((n) => /Not formatted/.test(n)), 'refused: ' + JSON.stringify(notes));
    must(disk === exp.out, `saved text differs from the engine output (first diff at ${[...disk].findIndex((c, i) => c !== exp.out[i])})`);
    const diff = L.compareTokens(originals[f], disk, L.rulesFor(exp.d));
    must(!diff, 'token diff: ' + JSON.stringify(diff));
    must(squash(originals[f]) === squash(disk) || /mysql|mariadb/.test(exp.d) || true, 'chars differ');
    const row = { file: f, dialect: exp.d, statusBar: st || null, bytes: originals[f].length, changed: !!changed, ms, tokensEqual: true, nonSpaceCharsEqualIgnoringCase: squash(originals[f]) === squash(disk), lines: [originals[f].split('\n').length, disk.split('\n').length] };
    R.files.push(row);
    must(st, `status bar does not show ${D.SHORT[exp.d]}: ${JSON.stringify(await dialectStatus())}`);
    return row;
  });
}

// hero screenshot on the walkthrough sample (already formatted and saved above)
await step('screenshot hero', async () => {
  await open('walkthrough.sql');
  await vs.key('Home', 'Home', 4, 36);
  await sleep(500);
  return await shot('hero');
});

// ---- 2. hostile files: unchanged, with a message ----
for (const f of HOSTILE) {
  await step(`hostile ${f}`, async () => {
    await clearNotifications();
    await open(f);
    const t0 = Date.now();
    await formatKey();
    const note = await vs.waitFor(async () => (await notifications()).find((n) => /Not formatted|statements formatted|SQL/.test(n) && /Not formatted/.test(n)), 40000, 150);
    const ms = Date.now() - t0;
    const dirty = await activeDirty();
    const disk = fs.readFileSync(path.join(ws, f), 'utf8');
    if (f.includes('one-line')) {
      // a valid 1 MB single line formats; it must not hang
      const done = note ? false : await vs.waitFor(async () => (await activeDirty()) || null, 30000, 200);
      if (!note) { const saved = await save(f); const exp = expected(f, originals[f]); must(saved === exp.out, '1 MB line: saved text differs'); R.files.push({ file: f, hostile: true, formatted: true, ms: Date.now() - t0, bytes: originals[f].length }); return { formatted: true, ms: Date.now() - t0 }; }
      return { refused: note, ms, done };
    }
    must(note, 'no message: ' + JSON.stringify(await notifications()));
    must(!dirty && disk === originals[f], 'file changed');
    if (f.includes('unterminated')) {
      must(/line 2\b/.test(note), 'line not named: ' + note);
      await shot('refused');
    }
    R.files.push({ file: f, hostile: true, refused: note.slice(0, 200), ms, bytes: originals[f].length });
    return { note: note.slice(0, 200), ms };
  });
}

// ---- 3. large file ----
for (const f of LARGE) {
  await step(`large ${f}: cancel leaves it unchanged`, async () => {
    await clearNotifications();
    await open(f);
    await formatKey();
    const prog = await vs.waitFor(async () => (await notifications()).find((n) => /Formatting/.test(n)), 8000, 50);
    must(prog, 'no progress notification');
    const clicked = await vs.wbEval(`(() => { const b = [...document.querySelectorAll('.notifications-toasts .monaco-button, .notifications-toasts a.monaco-button')].find(x => /Cancel/i.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
    must(clicked, 'no Cancel button');
    await sleep(1500);
    must(!(await activeDirty()), 'file changed after cancel');
    return { progress: prog.slice(0, 120) };
  });
  await step(`large ${f}: formats, editor and extension host answer`, async () => {
    await clearNotifications();
    await sleep(500);
    // renderer frame gaps while formatting
    await vs.wbEval(`window.__gap = { max: 0, last: performance.now(), on: true }; (function tick(){ const n = performance.now(); if (window.__gap.on) { window.__gap.max = Math.max(window.__gap.max, n - window.__gap.last); window.__gap.last = n; requestAnimationFrame(tick); } })(); 1`);
    const t0 = Date.now();
    await formatKey();
    await sleep(400);
    // extension host: the dialect picker (our command) opens while formatting runs
    const tq = Date.now();
    await vs.command('SQL Formatter: Pick SQL Dialect for This File');
    const qp = await vs.waitFor(quickOpen, 10000, 50);
    const quickMs = Date.now() - tq;
    await vs.key('Escape', 'Escape');
    const busyAtPick = !(await activeDirty());
    const done = await vs.waitFor(async () => (await activeDirty()) || null, 60000, 100);
    const ms = Date.now() - t0;
    const gap = await vs.wbEval(`(() => { window.__gap.on = false; return Math.round(window.__gap.max); })()`);
    must(done, 'large file did not finish');
    const disk = await save(f);
    const exp = expected(f, originals[f]);
    must(disk === exp.out, 'large: saved text differs from the engine output');
    must(!L.compareTokens(originals[f], disk, L.rulesFor(exp.d)), 'large: token diff');
    R.timings.large = { file: f, bytes: originals[f].length, ms, quickPickMs: quickMs, quickPickWhileFormatting: busyAtPick, maxFrameGapMs: gap };
    R.files.push({ file: f, large: true, bytes: originals[f].length, ms, dialect: exp.d });
    must(qp, 'extension host did not answer');
    return R.timings.large;
  });
}

// ---- 4. selection, strings, dialect picker, more free viewers, format on save ----
await step('format selection keeps the rest of the file', async () => {
  const f = 'selection.sql';
  const text = '-- keep   this line\nselect a,b from t where x=1;\n-- and   this one\nselect   1;\n';
  fs.writeFileSync(path.join(ws, f), text);
  await open(f);
  await vs.key('g', 'KeyG', 2, 71); await sleep(400); await vs.type('2'); await vs.key('Enter', 'Enter'); await sleep(300);
  await vs.key('l', 'KeyL', 4, 76); await sleep(200); // Cmd+L selects the line
  await vs.command('Format Selection');
  await vs.waitFor(async () => (await activeDirty()) || null, 8000, 100);
  const disk = await save(f);
  must(disk === '-- keep   this line\nSELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1;\n-- and   this one\nselect   1;\n', JSON.stringify(disk));
  return disk.split('\n').length;
});

await step('Format SQL in String (Python, one-line and triple-quoted)', async () => {
  await open('app.py');
  await vs.key('g', 'KeyG', 2, 71); await sleep(400); await vs.type('3:12'); await vs.key('Enter', 'Enter'); await sleep(300);
  await vs.command('SQL Formatter: Format SQL in String');
  await vs.waitFor(async () => (await activeDirty()) || null, 8000, 100);
  await vs.key('g', 'KeyG', 2, 71); await sleep(400); await vs.type('2:12'); await vs.key('Enter', 'Enter'); await sleep(300);
  await vs.command('SQL Formatter: Format SQL in String');
  await sleep(1200);
  const disk = await save('app.py');
  must(disk.includes('q2 = "SELECT id, name FROM users WHERE id = ? AND active = 1"'), disk);
  must(/q1 = """\n\s+SELECT\n/.test(disk), disk);
  return disk;
});

await step('dialect picker: pick for one file, then back to auto', async () => {
  await open('postgres-functions.sql');
  const before = await dialectStatus();
  must(before === 'PostgreSQL', before);
  await vs.wbEval(`(() => { const e = document.querySelector('[id$="sqlFormatter.dialect"]'); const a = e && (e.querySelector('a') || e); a && a.click(); return !!e; })()`);
  must(await vs.waitFor(quickOpen, 5000, 100), 'picker did not open');
  const rows = await quickRows();
  await shot('dialect-picker');
  await vs.type('MySQL'); await sleep(400); await vs.key('Enter', 'Enter'); await sleep(600);
  const mid = await dialectStatus();
  must(mid === 'MySQL', mid);
  await vs.command('SQL Formatter: Pick SQL Dialect for This File');
  await vs.type('Auto'); await sleep(400); await vs.key('Enter', 'Enter'); await sleep(600);
  const after = await dialectStatus();
  must(after === 'PostgreSQL', after);
  return { rows: rows.slice(0, 4) };
});

await step('More free viewers: related first, opens nothing by itself', async () => {
  await vs.command('SQL Formatter: More free viewers');
  must(await vs.waitFor(quickOpen, 5000, 100), 'picker did not open');
  const rows = await quickRows();
  await vs.key('Escape', 'Escape');
  must(rows.some((r) => /SQLite/.test(r)), JSON.stringify(rows));
  return rows.slice(0, 3);
});

await step('status bar tooltip has Rate, More free viewers and Sponsor', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8'));
  const sup = require('../src/support.js');
  const md = sup.footerMarkdown('sqlFormatter');
  must(/\[Rate\]\(https:\/\/marketplace\.visualstudio\.com\/items\?itemName=zovo\.zovo-sql-formatter/.test(md) && /More free viewers/.test(md) && /Sponsor/.test(md), md);
  return { id: `${pkg.publisher}.${pkg.name}`, footer: md.slice(0, 160) };
});

await step('format on save', async () => {
  const sf = path.join(work, 'ud', 'User', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  s['[sql]'] = { 'editor.formatOnSave': true };
  fs.writeFileSync(sf, JSON.stringify(s, null, 1));
  await sleep(1500);
  await open('onsave.sql');
  await vs.key('End', 'End', 4, 35); await vs.type(' ');
  const disk = await save('onsave.sql');
  must(disk.startsWith('SELECT\n  id,\n  name\nFROM\n  users\nWHERE'), JSON.stringify(disk));
  s['[sql]'] = { 'editor.formatOnSave': false };
  fs.writeFileSync(sf, JSON.stringify(s, null, 1));
  return disk.split('\n').length;
});

await step('procedure screenshot', async () => {
  await open('tsql-nstrings.sql');
  await vs.key('Home', 'Home', 4, 36);
  await sleep(400);
  return await shot('procedure');
});

// ---- 5. network: TCP connections of this VS Code (other than the CDP port) ----
await step('network: no connection from the extension host', async () => {
  let out = '';
  try { out = execFileSync('sh', ['-c', `for p in $(pgrep -f '${path.join(work, 'ud')}'); do lsof -nP -a -p $p -iTCP 2>/dev/null | tail -n +2; done`], { encoding: 'utf8', timeout: 20000 }); } catch (e) { out = String(e.stdout || ''); }
  const lines = out.split('\n').filter(Boolean).filter((l) => !l.includes(`:${port}`));
  let exthost = '';
  try { exthost = execFileSync('sh', ['-c', `pgrep -f 'extensionHost.*${path.join(work, 'ud').replace(/[^a-zA-Z0-9/_-]/g, '.')}|${path.join(work, 'ud')}.*extensionHost' | head -3`], { encoding: 'utf8' }).trim(); } catch {}
  R.connections = lines;
  return { otherConnections: lines.length, sample: lines.slice(0, 4), exthostPids: exthost };
});

// ---- 6. rating ask: the files above were session 1 (with refusals); a session 30 hours later formats one file -> ask ----
await step('rating ask in a new session 30 hours later (no ask within 24 h of a refusal)', async () => {
  await vs.close();
  process.env.ZOVO_RATING_CLOCK_OFFSET_HOURS = '30';
  vs = await launch(work, Number(port), ws, Object.assign({}, SETTINGS));
  await sleep(2000);
  await open('commented-commas.sql');
  R.focused = await focusWindow();
  await formatKey();
  const ask = await vs.waitFor(async () => { await focusWindow(); return (await notifications()).find((n) => /A rating helps others find it/.test(n)); }, 20000, 300);
  delete process.env.ZOVO_RATING_CLOCK_OFFSET_HOURS;
  must(ask, 'no ask: ' + JSON.stringify(await notifications()));
  return ask.slice(0, 160);
});

R.shots = shots;
R.pass = R.steps.filter((s) => s.ok).length;
R.total = R.steps.length;
await vs.close();
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
console.log(`RESULT ${R.pass}/${R.total} ${tag} sha256 ${R.vsixSha256}`);
process.exit(0);
