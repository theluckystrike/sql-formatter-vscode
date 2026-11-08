'use strict';
// The format pipeline. Pure (no VS Code): it runs in a worker thread, and the tests call it directly.
//
// 1. Split the script into statements, and keep client lines byte for byte: MySQL DELIMITER lines, T-SQL GO,
//    the Oracle "/" line and SQL*Plus commands, psql backslash commands and COPY ... FROM stdin data.
// 2. Swap every string, dollar-quoted body and quoted name for a short placeholder, so the formatter cannot
//    change a byte inside them ($$ stays $$, N'x' stays N'x', [name with spaces] stays as it is).
// 3. Format each statement with sql-formatter, put the originals back, and compare the tokens before and after.
//    Any difference other than whitespace and keyword case stops the run: the text stays unchanged.

const { isProcedural, layout } = require('./procedural');
const { rulesFor, tokenize, tokenAt, compareTokens, lineAt, SIGNIFICANT, MYSQL_LIKE } = require('./lexer');

let sqlFormatter = null;
function engine() {
  if (!sqlFormatter) sqlFormatter = require('../vendor/sql-formatter.min.cjs');
  return sqlFormatter;
}

const DIALECTS = ['sql', 'postgresql', 'mysql', 'mariadb', 'transactsql', 'plsql', 'sqlite', 'bigquery', 'snowflake', 'redshift',
  'spark', 'hive', 'db2', 'db2i', 'duckdb', 'trino', 'n1ql', 'singlestoredb', 'tidb', 'clickhouse'];

class FormatError extends Error {
  constructor(message, line, kind) { super(message); this.line = line; this.kind = kind || 'parse'; }
}

const DEFAULTS = {
  dialect: 'sql',
  keywordCase: 'upper',
  dataTypeCase: 'preserve',
  functionCase: 'preserve',
  identifierCase: 'preserve',
  indentStyle: 'standard',
  tabWidth: 2,
  useTabs: false,
  logicalOperatorNewline: 'before',
  expressionWidth: 60,
  linesBetweenQueries: 1,
  denseOperators: false,
  newlineBeforeSemicolon: false,
  commaPosition: 'trailing',
  procedureLayout: true,
};

function options(o) {
  const x = Object.assign({}, DEFAULTS, o || {});
  if (!DIALECTS.includes(x.dialect)) x.dialect = x.dialect === 'tsql' ? 'transactsql' : 'sql';
  x.tabWidth = Math.max(1, Math.min(8, Math.floor(Number(x.tabWidth) || 2)));
  x.expressionWidth = Math.max(20, Math.min(400, Math.floor(Number(x.expressionWidth) || 60)));
  x.linesBetweenQueries = Math.max(0, Math.min(5, Math.floor(Number(x.linesBetweenQueries) || 0)));
  return x;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Splitting

const RE_DELIMITER = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*$/i;
const RE_GO = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*;?[ \t]*$/i;
const RE_SLASH = /^[ \t]*\/[ \t]*$/;
const RE_PSQL = /^[ \t]*\\/;
const RE_SQLPLUS = /^[ \t]*(?:SET[ \t]+(?:SERVEROUTPUT|ECHO|FEEDBACK|DEFINE|VERIFY|TIMING|LINESIZE|PAGESIZE|HEADING|TERMOUT|SQLBLANKLINES|TRIMSPOOL|TRIMOUT|LONG|NEWPAGE|SCAN|AUTOCOMMIT|COLSEP|WRAP|ARRAYSIZE|SQLPROMPT)\b|PROMPT\b|SPOOL\b|WHENEVER\b|REM(?:ARK)?\b|@@?|SHOW[ \t]+ERR|EXEC(?:UTE)?[ \t]|DEFINE\b|UNDEFINE\b|CONNECT\b|COL(?:UMN)?[ \t]|TTITLE\b|BTITLE\b|BREAK[ \t]+ON|CLEAR[ \t]|VAR(?:IABLE)?[ \t]|PRINT[ \t])/i;
const RE_PLSQL_BLOCK = /^(?:CREATE(?:\s+OR\s+REPLACE)?(?:\s+(?:NON)?EDITIONABLE)?\s+(?:PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\s+BODY|TYPE|LIBRARY|JAVA)\b|DECLARE\b|BEGIN\b)/i;
const RE_COPY_STDIN = /\bCOPY\b[\s\S]*\bFROM\s+STDIN\b/i;

const lineEnd = (text, i) => { const k = text.indexOf('\n', i); return k < 0 ? text.length : k; };

/**
 * Splits text into parts: { kind: 'sql' | 'raw', s, e, term, termGap, tail }.
 * sql parts are formatted; raw parts (client lines, COPY data, statements we do not touch) are kept as they are.
 * term: a custom delimiter after the statement ($$ in a DELIMITER section); tail: a comment on the same line
 * after the statement's semicolon.
 */
function split(text, dialect) {
  const rules = rulesFor(dialect);
  const parts = [];
  const n = text.length;
  const isPlsql = dialect === 'plsql';
  const allowGo = dialect === 'transactsql' || dialect === 'sql';
  const allowSlash = isPlsql || dialect === 'sql';
  const allowPsql = dialect === 'postgresql' || dialect === 'sql' || dialect === 'redshift';
  let delim = ';';
  let start = 0; // start of the current statement
  let i = 0;
  let depth = 0; // BEGIN/CASE ... END
  let block = false; // PL/SQL unit: runs to the "/" line
  let sig = 0; // significant tokens in the current statement
  let firstWords = '';
  let prevWord = '';

  const flush = (end, extra) => {
    if (end > start && text.slice(start, end).trim()) parts.push(Object.assign({ kind: 'sql', s: start, e: end, term: '', termGap: '', tail: '' }, extra || {}));
    depth = 0; block = false; sig = 0; firstWords = ''; prevWord = '';
  };
  const raw = (s, e) => { if (e > s) parts.push({ kind: 'raw', s, e }); };

  while (i < n) {
    // at a line start, outside any token: client lines
    if (i === 0 || text[i - 1] === '\n') {
      const le = lineEnd(text, i);
      const line = text.slice(i, le).replace(/\r$/, '');
      let m;
      if ((m = RE_DELIMITER.exec(line)) && depth === 0 && (sig === 0 || delim !== ';' || MYSQL_LIKE.has(dialect) || dialect === 'sql')) {
        flush(i); raw(i, le); delim = m[1]; i = le; start = i; continue;
      }
      if (allowGo && RE_GO.test(line) && (depth === 0 || dialect === 'transactsql')) { flush(i); raw(i, le); i = le; start = i; continue; }
      if (allowSlash && RE_SLASH.test(line) && (block || sig > 0 || isPlsql)) { flush(i); raw(i, le); i = le; start = i; continue; }
      if (sig === 0 && allowPsql && RE_PSQL.test(line)) { flush(i); raw(i, le); i = le; start = i; continue; }
      if (sig === 0 && isPlsql && RE_SQLPLUS.test(line)) { flush(i); raw(i, le); i = le; start = i; continue; }
    }
    // custom delimiter (DELIMITER $$): ends the statement wherever it shows up outside a string or comment
    if (delim !== ';' && text.startsWith(delim, i)) {
      let k = i; while (k > start && /[ \t]/.test(text[k - 1])) k--;
      const gap = text.slice(k, i);
      flush(k, { term: delim, termGap: gap });
      i += delim.length; start = i; continue;
    }
    const t = nextToken(text, i, rules, delim);
    if (t.t === 'ws' || t.t === 'nl' || t.t === 'line' || t.t === 'block') { i = t.e; continue; }
    sig++;
    const w = t.t === 'word' ? text.slice(t.s, t.e).toUpperCase() : '';
    if (sig <= 6 && (t.t === 'word' || t.t === 'op')) firstWords += (firstWords ? ' ' : '') + text.slice(t.s, t.e);
    if (sig <= 6 && isPlsql && !block && RE_PLSQL_BLOCK.test(firstWords)) block = true;
    if (w === 'BEGIN') {
      const after = nextSig(text, t.e, rules, delim);
      const aw = after ? text.slice(after.s, after.e).toUpperCase() : ';';
      if (!['TRANSACTION', 'TRAN', 'WORK', ';', 'DISTRIBUTED', 'ISOLATION', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(aw) && !(dialect === 'postgresql' && sig === 1 && aw === ';')) depth++;
    } else if (w === 'CASE' && prevWord !== 'END') depth++;
    else if (w === 'END') {
      const after = nextSig(text, t.e, rules, delim);
      const aw = after ? text.slice(after.s, after.e).toUpperCase() : '';
      if (!['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(aw)) depth = Math.max(0, depth - 1);
    }
    if (t.t === 'word') prevWord = w;
    if (delim === ';' && t.t === 'punct' && text[t.s] === ';' && depth === 0 && !block) {
      // a comment on the same line after the semicolon stays with this statement
      let k = t.e; let tail = '';
      const ws = /^[ \t]*/.exec(text.slice(k, k + 200))[0];
      const c = nextToken(text, k + ws.length, rules, delim);
      if (c && c.t === 'line' && c.s === k + ws.length) { tail = text.slice(c.s, c.e); }
      const stmt = text.slice(start, t.e);
      flush(t.e, { tail });
      i = tail ? c.e : t.e;
      start = i;
      // COPY ... FROM stdin; rows follow up to a "\." line
      if (RE_COPY_STDIN.test(stmt)) {
        let k2 = i;
        while (k2 < n) {
          const le = lineEnd(text, k2);
          if (/^\\\.\s*$/.test(text.slice(k2, le))) { k2 = le; break; }
          k2 = le + 1;
        }
        const ds = text.indexOf('\n', i) + 1 || n;
        raw(ds, Math.min(k2, n)); i = Math.min(k2, n); start = i;
      }
      continue;
    }
    i = t.e;
  }
  flush(n);
  return parts;
}

// One token at i.
function nextToken(text, i, rules, delim) {
  const t = tokenAt(text, i, rules, { dollar: delim === ';' });
  // In a DELIMITER section the delimiter ends a name or an operator: END$$ is END, then $$.
  if (delim !== ';' && t.t !== 'str' && t.t !== 'ident' && t.t !== 'line' && t.t !== 'block' && t.t !== 'dollar') {
    const k = text.indexOf(delim, t.s + 1);
    if (k > t.s && k < t.e) return Object.assign({}, t, { e: k });
  }
  return t;
}

function nextSig(text, i, rules, delim) {
  let k = i;
  for (let guard = 0; guard < 200 && k < text.length; guard++) {
    const t = nextToken(text, k, rules, delim);
    if (SIGNIFICANT(t) && t.t !== 'line' && t.t !== 'block') return t;
    k = t.e;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Placeholders

function makeNonce(text) {
  for (let k = 0; k < 50; k++) {
    const nonce = 'zq' + Math.random().toString(36).slice(2, 8);
    if (!text.includes(nonce)) return nonce;
  }
  throw new FormatError('could not make a placeholder', 0, 'internal');
}

/** Replaces strings and quoted names with placeholders. Returns { text, map } or throws on an open string. */
function protect(text, rules, dollar, nonce) {
  const toks = tokenize(text, rules, { dollar });
  const map = new Map();
  let out = '';
  let last = 0;
  let k = 0;
  for (const t of toks) {
    if (t.open && (t.t === 'str' || t.t === 'dollar' || t.t === 'ident' || t.t === 'block')) {
      const what = t.t === 'block' ? 'comment' : t.t === 'ident' ? 'quoted name' : 'string';
      throw new FormatError(`unterminated ${what}`, lineAt(text, t.s), 'parse');
    }
    const acct = t.t === 'word' && MYSQL_LIKE.has(rules.dialect) && text.slice(t.s + 1, t.e).includes('@');
    if (t.t !== 'str' && t.t !== 'dollar' && t.t !== 'ident' && !acct) continue;
    const orig = text.slice(t.s, t.e);
    const nl = (orig.match(/\n/g) || []).length;
    let key = nonce + (k++).toString(36);
    const visible = Math.min(orig.split('\n')[0].length, 120) - 2;
    if (visible > key.length) key += '_'.repeat(visible - key.length);
    let ph;
    if (t.t === 'ident' || acct) {
      const q = rules.identQuote;
      ph = q === '[' ? `[${key}]` : `${q}${key}${q}`;
    } else ph = `'${key}${'\n'.repeat(nl)}'`;
    map.set(ph, orig);
    out += text.slice(last, t.s) + ph;
    last = t.e;
  }
  out += text.slice(last);
  return { text: out, map };
}

function restore(text, map) {
  let out = text;
  for (const [ph, orig] of map) {
    const at = out.indexOf(ph);
    if (at < 0 || out.indexOf(ph, at + ph.length) >= 0) throw new FormatError('a string or quoted name was changed by the formatter', 0, 'verify');
    out = out.slice(0, at) + orig + out.slice(at + ph.length);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Formatting one statement

function sfOptions(o) {
  return {
    language: o.dialect,
    keywordCase: o.keywordCase,
    dataTypeCase: o.dataTypeCase,
    functionCase: o.functionCase,
    identifierCase: o.identifierCase,
    indentStyle: o.indentStyle,
    tabWidth: o.tabWidth,
    useTabs: o.useTabs,
    logicalOperatorNewline: o.logicalOperatorNewline,
    expressionWidth: o.expressionWidth,
    linesBetweenQueries: o.linesBetweenQueries,
    denseOperators: o.denseOperators,
    newlineBeforeSemicolon: o.newlineBeforeSemicolon,
  };
}

function parseLine(msg) {
  const m = /at line (\d+)/i.exec(String(msg || ''));
  return m ? Number(m[1]) : 0;
}

/** sql-formatter on text, with strings and quoted names swapped for placeholders. Throws FormatError. */
function plainFormat(text, o, rules, dollar, lbq) {
  const nonce = makeNonce(text);
  const prot = protect(text, rules, dollar, nonce);
  let out;
  try {
    out = engine().format(prot.text, Object.assign(sfOptions(o), lbq == null ? {} : { linesBetweenQueries: lbq }));
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    if (e instanceof RangeError || /call stack/i.test(msg)) throw new FormatError('the statement is nested too deep to format', 1, 'deep');
    throw new FormatError(msg.replace(/^Parse error:\s*/i, '').replace(/\s*at line \d+ column \d+\.?/, ''), parseLine(msg) || 1, 'parse');
  }
  return restore(out, prot.map);
}

/** Formats one statement (or any SQL text without client lines). Throws FormatError. */
function formatStatement(text, o, dollar = true) {
  const rules = rulesFor(o.dialect);
  const check = (out) => compareTokens(text, out, rules, { commentsFree: o.commaPosition === 'leading' });
  const finish = (out) => (o.commaPosition === 'leading' ? commaFirst(out, rules, dollar) : out);
  // stored procedures and blocks: our block layout, plain statements by sql-formatter
  if (o.procedureLayout !== false && isProcedural(text, rules, dollar)) {
    try {
      const out = finish(layout(text, o, rules, dollar, (src) => plainFormat(src, o, rules, dollar, 0)));
      if (!check(out)) return out;
    } catch (e) {
      if (e instanceof FormatError && e.kind === 'parse' && /unterminated/.test(e.message)) throw e;
    }
  }
  const out = finish(plainFormat(text, o, rules, dollar));
  const diff = check(out);
  if (diff) {
    throw new FormatError(`the result would change "${diff.expected}" into "${diff.found}"`, lineAt(text, diff.offsetA), 'verify');
  }
  return out;
}

/** Moves a comma at the end of a line to the start of the next code line: "a,\n  b" -> "a\n  , b". */
function commaFirst(text, rules, dollar) {
  const toks = tokenize(text, rules, { dollar });
  const moves = []; // [commaStart, commaEnd, insertAt]
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'punct' || text[t.s] !== ',') continue;
    let j = k + 1; let sawNl = false;
    while (j < toks.length && (toks[j].t === 'ws' || toks[j].t === 'nl' || toks[j].t === 'line' || toks[j].t === 'block')) {
      if (toks[j].t === 'nl' || toks[j].t === 'line') sawNl = sawNl || toks[j].t === 'nl';
      if (toks[j].t === 'block' && !sawNl) break;
      j++;
    }
    if (!sawNl || j >= toks.length || (toks[j].t === 'punct' && text[toks[j].s] === ')')) continue;
    if (toks[j].t === 'block') continue;
    moves.push([t.s, t.e, toks[j].s]);
  }
  let out = text;
  for (let m = moves.length - 1; m >= 0; m--) {
    const [cs, ce, at] = moves[m];
    out = out.slice(0, at) + ', ' + out.slice(at);
    // drop the comma and the spaces before it
    let s = cs; while (s > 0 && out[s - 1] === ' ') s--;
    const keep = out.slice(ce, ce + 1) === ' ' && /^[ \t]*(--|#|\/\/)/.test(out.slice(ce)) ? ' ' : '';
    out = out.slice(0, s) + keep + out.slice(ce).replace(/^[ \t]+(?=(--|#|\/\/))/, '');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The whole document

/** Splits the input and notes, per statement, whether dollar quotes are on (they are off in a DELIMITER section). */
function prepare(input, o0) {
  const o = options(o0);
  const text = input.replace(/^\uFEFF/, '');
  const bom = text.length !== input.length ? '\uFEFF' : '';
  const eol = /\r\n/.test(text.slice(0, 100000)) ? '\r\n' : '\n';
  const src = eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text;
  const parts = split(src, o.dialect);
  let delimSection = false;
  for (const part of parts) {
    if (part.kind === 'raw') {
      const piece = src.slice(part.s, part.e);
      if (/^[ \t]*DELIMITER[ \t]+(\S+)/i.test(piece)) delimSection = !/^[ \t]*DELIMITER[ \t]+;[ \t]*$/i.test(piece);
    } else part.dollar = !delimSection;
  }
  return { o, src, bom, eol, parts };
}

/**
 * Formats parts[from..to) of a plan. Returns an array of { text } or { error: { message, line, kind } }.
 * The error line is counted inside the statement (1 = its first line).
 */
function formatParts(src, parts, o, opts = {}) {
  const res = [];
  for (let p = 0; p < parts.length; p++) {
    if (opts.shouldStop && (p & 15) === 0 && opts.shouldStop()) throw new FormatError('cancelled', 0, 'cancelled');
    const part = parts[p];
    if (part.kind === 'raw') { res.push({ text: src.slice(part.s, part.e).replace(/[ \t\r]+$/, '') }); continue; }
    const body = src.slice(part.s, part.e).trim();
    try {
      let piece = formatStatement(body, o, part.dollar !== false).replace(/\s+$/, '');
      if (part.term) piece += (part.termGap ? ' ' : '') + part.term;
      if (part.tail) piece += ' ' + part.tail.replace(/\s+$/, '');
      res.push({ text: piece });
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      if (e.kind === 'cancelled' || e.kind === 'internal') throw e;
      let piece = body;
      if (part.term) piece += part.termGap + part.term;
      if (part.tail) piece += ' ' + part.tail.replace(/\s+$/, '');
      res.push({ text: piece, error: { message: e.message, line: e.line || 1, kind: e.kind } });
    }
    if (opts.onProgress && (p % 200 === 0)) opts.onProgress(p, parts.length);
  }
  return res;
}

/** Joins formatted parts. Throws the first error unless partial. Returns { text, statements, kept, ms }. */
function assemble(plan, pieces, partial, t0) {
  const { o, src, bom, eol, parts } = plan;
  const out = [];
  const kept = [];
  let lastEnd = 0;
  let prevKind = '';
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const pc = pieces[p];
    if (pc.error) {
      const line = lineAt(src, part.s + src.slice(part.s, part.e).search(/\S/)) + Math.max(0, pc.error.line - 1);
      if (!partial) throw new FormatError(pc.error.message, line, pc.error.kind);
      kept.push(line);
    }
    const gapNl = (src.slice(lastEnd, part.s).match(/\n/g) || []).length;
    if (out.length) {
      const nl = part.kind === 'sql' && prevKind === 'sql' ? o.linesBetweenQueries + 1 : Math.max(1, Math.min(o.linesBetweenQueries + 1, gapNl));
      out.push('\n'.repeat(nl));
    }
    out.push(pc.text);
    prevKind = part.kind;
    lastEnd = part.e;
  }
  let res = out.join('');
  if (/\n\s*$/.test(src) || src.length === 0) res += '\n';
  if (eol === '\r\n') res = res.replace(/\n/g, '\r\n');
  return { text: bom + res, statements: parts.filter((x) => x.kind === 'sql').length, kept, ms: Date.now() - (t0 || Date.now()) };
}

/**
 * Formats a whole script on this thread. Returns { text, statements, kept, ms }.
 * opts.partial: a statement that fails is kept as it is (its line is in kept) instead of stopping the run.
 */
function formatDocument(input, o0, opts = {}) {
  const t0 = Date.now();
  const plan = prepare(input, o0);
  const pieces = formatParts(plan.src, plan.parts, plan.o, opts);
  return assemble(plan, pieces, !!opts.partial, t0);
}

/** Formats a selection: the result keeps the indent of the first line, and the text around it. */
function formatSelection(text, o0, opts = {}) {
  const lead = /^\s*/.exec(text)[0];
  const trail = /\s*$/.exec(text.slice(lead.length))[0];
  const core = text.slice(lead.length, text.length - trail.length);
  if (!core) return { text, statements: 0, kept: [], ms: 0 };
  const indent = opts.indent != null ? opts.indent : /[ \t]*$/.exec(lead)[0];
  const r = formatDocument(core, o0, opts);
  const eol = /\r\n/.test(r.text) ? '\r\n' : '\n';
  const body = r.text.replace(/\s+$/, '').split(eol).map((l, k) => (k === 0 || !l ? l : indent + l)).join(eol);
  return Object.assign(r, { text: lead + body + trail });
}

/**
 * SQL inside a string of another language. text is the selection, quote the string's quote ('' if unknown).
 * Multi-line strings (`...`, """...""", '''...''', @"..." and r"...") get the formatted lines; a one-line
 * string gets the formatted SQL on one line.
 */
function formatEmbedded(text, o0, quote, indent) {
  const multi = ['`', '"""', "'''"].includes(quote) || quote === 'multi';
  if (multi) return formatSelection(text, o0, { indent: indent || '' });
  const r = formatDocument(text.trim(), o0);
  const rules = rulesFor(options(o0).dialect);
  const toks = tokenize(r.text, rules).filter(SIGNIFICANT);
  if (toks.some((t) => t.t === 'line')) throw new FormatError('a -- comment cannot go on one line', 1, 'verify');
  let one = '';
  let prev = null;
  for (const t of toks) {
    const s = r.text.slice(t.s, t.e);
    const glue = prev && !(prev.t === 'punct' && /[(.]/.test(r.text[prev.s])) && !(t.t === 'punct' && /[),.;]/.test(s)) ? ' ' : '';
    one += glue + (t.t === 'block' ? s.replace(/\s+/g, ' ') : s);
    prev = t;
  }
  const lead = /^\s*/.exec(text)[0];
  const trail = /\s*$/.exec(text)[0];
  const diff = compareTokens(text, one, rules);
  if (diff) throw new FormatError(`the result would change "${diff.expected}"`, 1, 'verify');
  return { text: lead + one + trail, statements: r.statements, kept: [], ms: r.ms };
}

module.exports = { prepare, formatParts, assemble, formatDocument, formatSelection, formatEmbedded, formatStatement, split, protect, restore, commaFirst, options, FormatError, DIALECTS, DEFAULTS };
