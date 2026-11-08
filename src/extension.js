'use strict';
// SQL Safe Formatter. Formats SQL with sql-formatter in a worker thread and checks every result: when the
// tokens before and after differ in anything but whitespace and keyword case, the file stays as it is.
// No network, no telemetry.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { Runner } = require('./runner');
const dialects = require('./dialect');
const { DEFAULTS } = require('./engine');
const { createRatingPrompt } = require('./rate');
const { registerSupport, footerMarkdown, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-sql-formatter';
const SECTION = 'sqlFormatter';
const NAME = 'SQL Safe Formatter';
const OVERRIDES_KEY = 'sqlFormatter.dialectByFile.v1';
const LANGS = ['sql', 'mysql', 'postgres', 'postgresql', 'pgsql', 'plsql', 'oracle', 'oracle-sql', 'tsql', 'mssql', 'sqlite', 'bigquery',
  'snowflake-sql', 'snowflake', 'hql', 'hive-sql', 'sparksql', 'spark-sql', 'redshift', 'duckdb', 'clickhouse', 'db2', 'mariadb'];
const PROGRESS_MIN_CHARS = 200 * 1024;

let rating = { success() {}, failure() {} };
let runner = null;
let status = null;
let context = null;
const lastError = new Map(); // uri -> { key, at }
const samples = new Set(); // walkthrough sample documents: they do not count for the rating ask
const good = (uri) => (samples.has(uri.toString()) ? rating.success({ sample: true }) : rating.success(uri));

const cfg = (uri) => vscode.workspace.getConfiguration(SECTION, uri);

function overrides() { return context.workspaceState.get(OVERRIDES_KEY, {}); }

function dialectFor(doc) {
  const c = cfg(doc.uri);
  return dialects.pick({
    override: overrides()[doc.uri.toString()],
    setting: c.get('dialect', 'auto'),
    languageId: doc.languageId,
    fileName: doc.fileName,
    text: doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 4000), 0)),
  });
}

/** Formatter options for a document: settings, plus the editor's indent when the setting says so. */
function optionsFor(doc, fmt) {
  const c = cfg(doc.uri);
  const useEditor = c.get('useEditorIndent', true);
  const o = {
    dialect: dialectFor(doc).dialect,
    keywordCase: c.get('keywordCase', DEFAULTS.keywordCase),
    dataTypeCase: c.get('dataTypeCase', DEFAULTS.dataTypeCase),
    functionCase: c.get('functionCase', DEFAULTS.functionCase),
    identifierCase: 'preserve',
    indentStyle: c.get('indentStyle', DEFAULTS.indentStyle),
    tabWidth: useEditor && fmt ? fmt.tabSize : c.get('tabWidth', DEFAULTS.tabWidth),
    useTabs: useEditor && fmt ? !fmt.insertSpaces : c.get('useTabs', DEFAULTS.useTabs),
    logicalOperatorNewline: c.get('logicalOperatorNewline', DEFAULTS.logicalOperatorNewline),
    expressionWidth: c.get('maxLineWidth', DEFAULTS.expressionWidth),
    linesBetweenQueries: c.get('linesBetweenQueries', DEFAULTS.linesBetweenQueries),
    denseOperators: c.get('denseOperators', DEFAULTS.denseOperators),
    newlineBeforeSemicolon: c.get('newlineBeforeSemicolon', DEFAULTS.newlineBeforeSemicolon),
    commaPosition: c.get('commaPosition', DEFAULTS.commaPosition),
    procedureLayout: c.get('procedureLayout', true),
  };
  return o;
}

function threads() {
  const n = Number(cfg().get('threads', 0)) || 0;
  if (n > 0) return Math.min(16, n);
  const cpus = (os.cpus() || []).length || 2;
  return Math.max(1, Math.min(4, cpus - 1));
}

function timeLimitMs() { return Math.max(2, Math.min(600, Number(cfg().get('timeLimitSeconds', 30)) || 30)) * 1000; }
function maxChars() { return Math.max(1, Math.min(200, Number(cfg().get('maxFileSizeMB', 16)) || 16)) * 1024 * 1024; }

/** The smallest single edit that turns a into b: common first and last lines are left alone. */
function minimalEdit(doc, a, b) {
  if (a === b) return [];
  let s = 0;
  const n = Math.min(a.length, b.length);
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length; let eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  // whole lines, so the edit never splits a CRLF pair
  const ls = a.lastIndexOf('\n', s - 1) + 1;
  const sB = ls;
  const leA = a.indexOf('\n', ea); const leB = b.indexOf('\n', eb);
  const endA = leA < 0 ? a.length : leA;
  const endB = leB < 0 ? b.length : leB;
  if (a.length - endA !== b.length - endB) return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(a.length)), b)];
  return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(ls), doc.positionAt(endA)), b.slice(sB, endB))];
}

/** Runs a job with a progress notification (Cancel button) for large texts. */
async function runJob(job, token, title) {
  const big = job.text.length >= PROGRESS_MIN_CHARS;
  const listeners = [];
  const cancelSignal = { onCancel: (fn) => listeners.push(fn) };
  const fire = () => listeners.splice(0).forEach((fn) => fn());
  if (token) token.onCancellationRequested(fire);
  const go = (onProgress) => runner.run(Object.assign({ threads: threads() }, job), { timeoutMs: timeLimitMs(), onProgress, cancelSignal });
  if (!big) return go();
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, ptoken) => {
    ptoken.onCancellationRequested(fire);
    let last = 0;
    return go((done, total) => {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct > last) { progress.report({ increment: pct - last, message: `${done.toLocaleString()} of ${total.toLocaleString()} statements` }); last = pct; }
    });
  });
}

function sizeText(chars) { return chars >= 1048576 ? `${(chars / 1048576).toFixed(1)} MB` : `${Math.round(chars / 1024)} KB`; }

/** Explains a failure. Nothing was changed. */
async function report(doc, err, retry) {
  if (err.kind === 'cancelled') { vscode.window.setStatusBarMessage('SQL formatting cancelled. The file is unchanged.', 4000); return; }
  rating.failure();
  const where = err.line ? ` at line ${err.line}` : '';
  const d = dialects.NAMES[dialectFor(doc).dialect] || 'SQL';
  const reason = /^unterminated/.test(err.message)
    ? `Not formatted: ${err.message}${where}. The file is unchanged.`
    : err.kind === 'verify'
    ? `Not formatted: ${err.message}${where}. The file is unchanged.`
    : err.kind === 'timeout' || err.kind === 'crash' || err.kind === 'deep'
      ? `Not formatted: ${err.message}${where}. The file is unchanged.`
      : `Not formatted: ${d} could not read the SQL${where} (${err.message}). The file is unchanged.`;
  // the same error on the same file within a minute (format on save): status bar only
  const key = `${err.kind}|${err.line}|${err.message}`;
  const prev = lastError.get(doc.uri.toString());
  lastError.set(doc.uri.toString(), { key, at: Date.now() });
  if (prev && prev.key === key && Date.now() - prev.at < 60000) { vscode.window.setStatusBarMessage('$(warning) ' + reason, 8000); return; }
  const buttons = [];
  if (err.line) buttons.push('Go to Line');
  if (err.kind === 'parse' || err.kind === 'verify') buttons.push('Pick Dialect');
  if (retry && (err.kind === 'parse' || err.kind === 'verify' || err.kind === 'deep')) buttons.push('Format the Rest');
  const pick = await vscode.window.showWarningMessage(reason, ...buttons);
  if (pick === 'Go to Line') {
    const ed = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(Math.max(0, err.line - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } else if (pick === 'Pick Dialect') {
    await pickDialect(doc);
  } else if (pick === 'Format the Rest' && retry) {
    await retry();
  }
}

/** Formats a whole document; returns the edits (or [] and a message). */
async function documentEdits(doc, fmt, token, partial) {
  const text = doc.getText();
  if (text.length > maxChars()) {
    const pick = await vscode.window.showWarningMessage(
      `This SQL file is ${sizeText(text.length)}, above the ${cfg(doc.uri).get('maxFileSizeMB', 16)} MB limit for formatting a whole file. Select a part and run Format Selection, or raise the limit.`,
      'Open Setting');
    if (pick === 'Open Setting') vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.maxFileSizeMB`);
    return [];
  }
  const o = optionsFor(doc, fmt);
  const version = doc.version;
  try {
    const res = await runJob({ mode: 'document', text, options: o, partial: !!partial }, token, `Formatting ${sizeText(text.length)} of ${dialects.SHORT[o.dialect]}`);
    if (doc.version !== version) return [];
    lastError.delete(doc.uri.toString());
    if (res.kept && res.kept.length) {
      vscode.window.showInformationMessage(`Formatted ${res.statements - res.kept.length} of ${res.statements} statements. Kept as written: line${res.kept.length > 1 ? 's' : ''} ${res.kept.slice(0, 8).join(', ')}${res.kept.length > 8 ? '…' : ''}.`);
    } else good(doc.uri);
    if (text.length >= PROGRESS_MIN_CHARS) vscode.window.setStatusBarMessage(`$(check) ${res.statements.toLocaleString()} SQL statements formatted in ${(res.ms / 1000).toFixed(1)} s`, 6000);
    return minimalEdit(doc, text, res.text);
  } catch (e) {
    report(doc, e, partial ? null : async () => {
      const ed = await editsApply(doc, () => documentEdits(doc, fmt, undefined, true));
      return ed;
    });
    return [];
  }
}

async function editsApply(doc, make) {
  const edits = await make();
  if (!edits.length) return false;
  const we = new vscode.WorkspaceEdit();
  we.set(doc.uri, edits);
  return vscode.workspace.applyEdit(we);
}

async function rangeEdits(doc, range, fmt, token, partial) {
  const full = new vscode.Range(range.start.line, 0, range.end.line, range.end.character);
  const r = range.start.character > 0 && doc.getText(new vscode.Range(range.start.line, 0, range.start.line, range.start.character)).trim() ? range : full;
  const text = doc.getText(r);
  if (!text.trim()) return [];
  const o = optionsFor(doc, fmt);
  try {
    const res = await runJob({ mode: 'selection', text, options: o, partial: !!partial }, token, 'Formatting the selection');
    if (res.text === text) return [];
    if (!partial) good(doc.uri);
    return [vscode.TextEdit.replace(r, res.text)];
  } catch (e) {
    const line = e.line ? e.line + r.start.line : 0;
    report(doc, Object.assign(e, { line }), partial ? null : () => editsApply(doc, () => rangeEdits(doc, range, fmt, undefined, true)));
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

async function formatInString() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  let sel = ed.selection;
  if (sel.isEmpty) {
    const found = stringAround(doc, sel.active);
    if (!found) { vscode.window.showInformationMessage('Select the SQL inside a string first (or put the cursor in the string).'); return; }
    sel = found;
  }
  const before = doc.getText(new vscode.Range(sel.start.line, 0, sel.start.line, sel.start.character));
  const after = doc.getText(new vscode.Range(sel.end, doc.lineAt(sel.end.line).range.end));
  const quote = quoteOf(before, after);
  const indent = /^[ \t]*/.exec(doc.lineAt(sel.start.line).text)[0] + (ed.options.insertSpaces === false ? '\t' : ' '.repeat(Number(ed.options.tabSize) || 2));
  const text = doc.getText(sel);
  const o = optionsFor(doc, null);
  o.dialect = dialects.pick({ setting: cfg(doc.uri).get('dialect', 'auto'), text }).dialect;
  try {
    const res = await runJob({ mode: 'embedded', text, options: o, quote: quote.multi ? 'multi' : quote.q, indent }, undefined, 'Formatting SQL');
    let out = res.text;
    if (quote.multi && !/^\s*\n/.test(text) && /\n/.test(out.trim())) out = '\n' + indent + out.trim() + '\n' + /^[ \t]*/.exec(doc.lineAt(sel.start.line).text)[0];
    if (out === text) { vscode.window.setStatusBarMessage('SQL is already formatted', 3000); return; }
    await ed.edit((b) => b.replace(sel, out));
    good(doc.uri);
  } catch (e) {
    report(doc, Object.assign(e, { line: e.line ? e.line + sel.start.line : 0 }), null);
  }
}

function quoteOf(before, after) {
  const b = before.trimEnd(); const a = after.trimStart();
  for (const q of ['"""', "'''", '`']) if (b.endsWith(q) && a.startsWith(q)) return { q, multi: true };
  if (b.endsWith('`') || a.startsWith('`')) return { q: '`', multi: true };
  if (/(?:@|[rRbBfF]{0,2})"""$/.test(b) || /'''$/.test(b)) return { q: '"""', multi: true };
  if (/@"$/.test(b)) return { q: '"', multi: true }; // C# verbatim string
  if (b.endsWith('"') || b.endsWith("'")) return { q: b.slice(-1), multi: false };
  return { q: '', multi: true };
}

/** The text of the string literal around pos, for "Format SQL in String" with no selection. */
function stringAround(doc, pos) {
  const text = doc.getText();
  const at = doc.offsetAt(pos);
  for (const q of ['"""', "'''", '`', '"', "'"]) {
    const open = text.lastIndexOf(q, at - 1);
    if (open < 0) continue;
    const close = text.indexOf(q, Math.max(at, open + q.length));
    if (close < 0) continue;
    const inner = text.slice(open + q.length, close);
    if (q.length === 1 && q !== '`' && inner.includes('\n')) continue;
    if (!/\b(select|insert|update|delete|with|create|alter|merge)\b/i.test(inner)) continue;
    return new vscode.Selection(doc.positionAt(open + q.length), doc.positionAt(close));
  }
  return null;
}

async function pickDialect(docArg) {
  const ed = vscode.window.activeTextEditor;
  const doc = docArg || (ed && ed.document);
  if (!doc) return;
  const cur = dialectFor(doc);
  const sniffed = dialects.pick({ languageId: doc.languageId, fileName: doc.fileName, text: doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 4000), 0)) });
  const items = [{ label: `$(sparkle) Auto: ${dialects.NAMES[sniffed.dialect]}`, description: `from the ${sniffed.source === 'default' ? 'default' : sniffed.source}`, id: '' }];
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  for (const id of Object.keys(dialects.NAMES)) {
    items.push({ label: dialects.NAMES[id], description: id === cur.dialect ? 'current' : '', id });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `SQL dialect for ${path.basename(doc.fileName)} (only this file; the setting ${SECTION}.dialect sets all files)` });
  if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return;
  const map = Object.assign({}, overrides());
  if (pick.id) map[doc.uri.toString()] = pick.id; else delete map[doc.uri.toString()];
  const keys = Object.keys(map);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete map[k];
  await context.workspaceState.update(OVERRIDES_KEY, map);
  updateStatus();
}

function isSqlDoc(doc) {
  if (!doc) return false;
  if (LANGS.includes(doc.languageId)) return true;
  return /\.(sql|pgsql|psql|mysql|tsql|plsql|pks|pkb|pls|ddl|dml|hql|bql)$/i.test(doc.fileName);
}

function updateStatus() {
  const ed = vscode.window.activeTextEditor;
  if (!status) return;
  if (!ed || !isSqlDoc(ed.document) || !cfg(ed.document.uri).get('showStatusBar', true)) { status.hide(); return; }
  const d = dialectFor(ed.document);
  status.text = `$(database) ${dialects.SHORT[d.dialect]}`;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  const why = { file: 'picked for this file', setting: `from the setting ${SECTION}.dialect`, language: 'from the language mode', extension: 'from the file name', content: 'detected from the text', default: 'no dialect detected' }[d.source];
  md.appendMarkdown(`**SQL dialect: ${dialects.NAMES[d.dialect]}** (${why})\n\nClick to pick another dialect for this file.`);
  if (showLinks(vscode, SECTION)) md.appendMarkdown(`\n\n---\n\n${footerMarkdown(SECTION)}`);
  status.tooltip = md;
  status.show();
}

// ---------------------------------------------------------------------------------------------------------------

function activate(ctx) {
  context = ctx;
  runner = new Runner(path.join(__dirname, 'worker.js'));
  rating = createRatingPrompt({ vscode, context: ctx, extensionId: EXT_ID, section: SECTION, name: NAME });
  registerSupport({ vscode, context: ctx, prefix: SECTION, selfId: EXT_ID });

  const selector = LANGS.map((language) => ({ language }));
  ctx.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits: (doc, fmt, token) => documentEdits(doc, fmt, token),
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
      provideDocumentRangeFormattingEdits: (doc, range, fmt, token) => rangeEdits(doc, range, fmt, token),
    }),
    vscode.commands.registerCommand(`${SECTION}.format`, async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const fmt = { tabSize: Number(ed.options.tabSize) || 2, insertSpaces: ed.options.insertSpaces !== false };
      if (!ed.selection.isEmpty) await editsApply(ed.document, () => rangeEdits(ed.document, ed.selection, fmt));
      else await editsApply(ed.document, () => documentEdits(ed.document, fmt));
    }),
    vscode.commands.registerCommand(`${SECTION}.formatInString`, formatInString),
    vscode.commands.registerCommand(`${SECTION}.pickDialect`, () => pickDialect()),
    vscode.commands.registerCommand(`${SECTION}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#sqlFormatter.start`, false)),
    vscode.commands.registerCommand(`${SECTION}.openSample`, async () => {
      const uri = vscode.Uri.joinPath(ctx.extensionUri, 'samples', 'walkthrough.sql');
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') });
      samples.add(doc.uri.toString());
      await vscode.window.showTextDocument(doc);
    }),
    { dispose: () => runner && runner.dispose() },
  );

  status = vscode.window.createStatusBarItem(`${SECTION}.dialect`, vscode.StatusBarAlignment.Right, 100);
  status.name = 'SQL Dialect';
  status.command = `${SECTION}.pickDialect`;
  ctx.subscriptions.push(status,
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(SECTION)) updateStatus(); }),
    vscode.workspace.onDidOpenTextDocument(() => updateStatus()));
  updateStatus();

  return { _test: { minimalEdit, quoteOf, optionsFor, dialectFor } };
}

function deactivate() { if (runner) runner.dispose(); }

module.exports = { activate, deactivate, _internal: { quoteOf } };
