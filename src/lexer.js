'use strict';
// A small SQL tokenizer used for three jobs: find strings, quoted names and comments (so the formatter never
// touches them), split a script into statements, and compare the tokens before and after formatting.
// Rules per dialect follow the tokenizer options of sql-formatter 15.9 (dist/cjs/languages/*/*.formatter.js).
// Pure: no VS Code, no I/O.

const MYSQL_LIKE = new Set(['mysql', 'mariadb', 'tidb', 'singlestoredb']);

/** Lexer rules for one dialect. */
function rulesFor(dialect) {
  const d = String(dialect || 'sql');
  const r = {
    dialect: d,
    sqBackslash: false, // backslash escapes in '...'
    dqString: false, // "..." is a string (else a quoted name)
    dqBackslash: false,
    backtick: false, // `name`
    brackets: false, // [name]
    hashComment: false, // # line comment
    slashComment: false, // // line comment
    nested: false, // nested /* /* */ */
    tripleQuotes: false, // '''...''' and """...""" (BigQuery)
    qQuote: false, // q'[...]' (Oracle)
    prefixes: ['N', 'E', 'B', 'X', 'U&', 'R', 'RB', 'BR', 'G', 'GX', 'BX', 'UX'],
    identQuote: '"', // quote for placeholder names
  };
  if (MYSQL_LIKE.has(d)) Object.assign(r, { dollar: false, sqBackslash: true, dqString: true, dqBackslash: true, backtick: true, hashComment: true, identQuote: '`' });
  if (d === 'bigquery') Object.assign(r, { sqBackslash: true, dqString: true, dqBackslash: true, backtick: true, hashComment: true, tripleQuotes: true, identQuote: '`' });
  if (d === 'hive' || d === 'spark') Object.assign(r, { sqBackslash: true, dqString: true, dqBackslash: true, backtick: true, identQuote: '`' });
  if (d === 'n1ql') Object.assign(r, { sqBackslash: true, dqString: true, dqBackslash: true, backtick: true, hashComment: true, identQuote: '`' });
  if (d === 'snowflake') Object.assign(r, { sqBackslash: true, slashComment: true });
  if (d === 'clickhouse') Object.assign(r, { sqBackslash: true, dqBackslash: true, backtick: true, nested: true });
  if (d === 'sql') Object.assign(r, { sqBackslash: false, backtick: true });
  if (d === 'sqlite') Object.assign(r, { backtick: true, brackets: true });
  if (d === 'transactsql' || d === 'tsql') Object.assign(r, { brackets: true, nested: true, identQuote: '[' });
  if (d === 'postgresql' || d === 'duckdb' || d === 'db2i') r.nested = true;
  if (d === 'plsql') r.qQuote = true;
  return r;
}

// Multi-character operators of all dialects. Longest first, so maximal munch picks them whole.
const OPERATORS = [
  '!~~*', '!~~', '||/', '<->', '<=>', '->>', '#>>', '!~*', '::$', '::%', '!:>', '<<=', '>>=', '&<|', '|&>', '<<|', '|>>', '?-|', '?||', '@-@',
  '=>', '<=', '>=', '<>', '!=', '||', '::', '->', ':=', '**', '<<', '>>', '#>', '@>', '<@', '?|', '?&', '~*', '!~', '&&', '|/',
  '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '~=', '!<', '!>', '==', '..', '~~', '@@', '-|-', '&<', '&>', '?#', '?-', ':>', '¬=', '¬>', '¬<',
].sort((a, b) => b.length - a.length);
const OP_CHARS = new Set('+-*/<>=~!^&|%?:@#¬.');

const isWordStart = (c) => {
  if (!c) return false;
  const x = c.charCodeAt(0);
  return (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || x === 95 || x >= 0xC0;
};
const isWordChar = (c) => {
  if (!c) return false;
  const x = c.charCodeAt(0);
  return (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || (x >= 48 && x <= 57) || x === 95 || x === 36 || x === 35 || x === 64 || x >= 0xC0;
};
const isDigit = (c) => c >= '0' && c <= '9';
const isDigitCode = (x) => x >= 48 && x <= 57;
const isSpaceCode = (x) => x === 32 || x === 9 || x === 10 || x === 13 || x === 12 || x === 11 || x === 0xA0 || x === 0xFEFF;
const PREFIX_START = new Set('NnEeBbXxUuRrGg');

/**
 * Tokens of text. Each token: { t: type, s: start, e: end }. Types:
 * ws, nl (whitespace that has a newline), line (line comment), block (block comment), str (string of any kind),
 * dollar ($tag$...$tag$), ident (quoted name), word, num, param, op, punct.
 * opts.dollar === false turns dollar quotes off (used inside a MySQL DELIMITER section, where $$ is the delimiter).
 * An unterminated string or comment runs to the end of the text and gets open: true.
 */
function tokenize(text, rules, opts = {}) {
  const r = rules || rulesFor('sql');
  const out = [];
  let i = 0;
  while (i < text.length) { const t = tokenAt(text, i, r, opts); out.push(t); i = t.e; }
  return MYSQL_LIKE.has(r.dialect) ? joinAccounts(text, out) : out;
}

// MySQL account names: 'user'@'host', `root`@`localhost`, app@'%'. One token, so no space can get in.
function joinAccounts(text, toks) {
  const out = [];
  const namey = (t) => t && (t.t === 'ident' || t.t === 'str' || t.t === 'word');
  for (let k = 0; k < toks.length; k++) {
    const a = toks[k]; const at = toks[k + 1];
    if (namey(a) && at && at.s === a.e && text[at.s] === '@' && text[at.s + 1] !== '@') {
      if (at.t === 'param' && at.e > at.s + 1) { out.push({ t: 'ident', s: a.s, e: at.e }); k += 1; continue; }
      const h = toks[k + 2];
      if (at.t === 'op' && at.e === at.s + 1 && namey(h) && h.s === at.e) { out.push({ t: 'ident', s: a.s, e: h.e }); k += 2; continue; }
    }
    out.push(a);
  }
  return out;
}

/** The one token that starts at offset i. */
function tokenAt(text, i0, rules, opts = {}) {
  const r = rules || rulesFor('sql');
  const n = text.length;
  const dollarOn = opts.dollar !== false && r.dollar !== false;
  let i = i0;
  let tok = null;
  const push = (t, s, e, extra) => { tok = extra ? Object.assign({ t, s, e }, extra) : { t, s, e }; };

  // Reads a quoted run that starts at i (text[i] === q). Doubled quotes always escape; backslash when bs.
  const quoted = (start, q, bs, close) => {
    const end = close || q;
    let j = start + 1;
    while (j < n) {
      const c = text[j];
      if (bs && c === '\\') { j += 2; continue; }
      if (c === end) {
        if (text[j + 1] === end && end === q) { j += 2; continue; }
        return { e: j + 1, open: false };
      }
      j++;
    }
    return { e: Math.min(j, n), open: true };
  };

  {
    const c = text[i];
    const c2 = text[i + 1];
    // whitespace
    if (isSpaceCode(text.charCodeAt(i))) {
      let j = i; let nl = false;
      while (j < n) { const x = text.charCodeAt(j); if (!isSpaceCode(x)) break; if (x === 10) nl = true; j++; }
      push(nl ? 'nl' : 'ws', i, j); i = j; return tok;
    }
    // line comments
    if ((c === '-' && c2 === '-') || (r.hashComment && c === '#') || (r.slashComment && c === '/' && c2 === '/')) {
      let j = i; while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
      push('line', i, j); i = j; return tok;
    }
    // block comments
    if (c === '/' && c2 === '*') {
      let j = i + 2; let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; continue; }
        if (r.nested && text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; continue; }
        j++;
      }
      push('block', i, j, depth > 0 ? { open: true } : null); i = j; return tok;
    }
    // dollar quotes: $$...$$ and $tag$...$tag$, when $ starts a token
    if (dollarOn && c === '$') {
      const m = /^\$([A-Za-z_À-￿][A-Za-z0-9_À-￿]*)?\$/.exec(text.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        if (close >= 0) { push('dollar', i, close + tag.length); i = close + tag.length; return tok; }
        if (tag === '$$' || /\n/.test(text.slice(i, i + 4000))) { push('dollar', i, n, { open: true }); i = n; return tok; }
      }
    }
    // Oracle q'[...]' (also nq'...')
    if (r.qQuote && (c === 'q' || c === 'Q' || ((c === 'n' || c === 'N') && (c2 === 'q' || c2 === 'Q'))) && !(i > 0 && isWordChar(text[i - 1]))) {
      const k = (c === 'n' || c === 'N') ? i + 1 : i;
      if (text[k + 1] === "'" && text[k + 2] && !/\s/.test(text[k + 2])) {
        const open = text[k + 2];
        const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[open] || open;
        const end = text.indexOf(close + "'", k + 3);
        if (end >= 0) { push('str', i, end + 2); i = end + 2; return tok; }
        push('str', i, n, { open: true }); i = n; return tok;
      }
    }
    // prefixed strings: N'..', E'..', X'..', B'..', U&'..', R'..', RB'..', BR'..'
    if (PREFIX_START.has(c) && !(i > 0 && isWordChar(text[i - 1]))) {
      let hit = null;
      for (const p of r.prefixes) {
        if (text.substr(i, p.length).toUpperCase() === p && (text[i + p.length] === "'" || (r.dqString && text[i + p.length] === '"' && /^[RB]+$/i.test(p)))) {
          if (!hit || p.length > hit.length) hit = p;
        }
      }
      if (hit) {
        const q = text[i + hit.length];
        const bs = hit.toUpperCase() === 'E' || (q === "'" ? r.sqBackslash : r.dqBackslash);
        const raw = /R/i.test(hit) && r.tripleQuotes;
        if (r.tripleQuotes && text.substr(i + hit.length, 3) === q.repeat(3)) {
          const end = text.indexOf(q.repeat(3), i + hit.length + 3);
          const e = end < 0 ? n : end + 3;
          push('str', i, e, end < 0 ? { open: true } : null); i = e; return tok;
        }
        const res = quoted(i + hit.length, q, bs && !raw);
        push('str', i, res.e, res.open ? { open: true } : null); i = res.e; return tok;
      }
    }
    // plain strings
    if (c === "'" || (c === '"' && r.dqString)) {
      if (r.tripleQuotes && text.substr(i, 3) === c.repeat(3)) {
        const end = text.indexOf(c.repeat(3), i + 3);
        const e = end < 0 ? n : end + 3;
        push('str', i, e, end < 0 ? { open: true } : null); i = e; return tok;
      }
      const res = quoted(i, c, c === "'" ? r.sqBackslash : r.dqBackslash);
      push('str', i, res.e, res.open ? { open: true } : null); i = res.e; return tok;
    }
    // quoted names
    if (c === '"' || (c === '`' && r.backtick) || (c === '[' && r.brackets)) {
      const res = c === '[' ? quoted(i, ']', false, ']') : quoted(i, c, false, c);
      push('ident', i, res.e, res.open ? { open: true } : null); i = res.e; return tok;
    }
    // numbers
    if (isDigit(c) || (c === '.' && isDigit(c2 || '') && !(i > 0 && isWordChar(text[i - 1])))) {
      let j = i;
      if (c === '0' && (c2 === 'x' || c2 === 'X')) { j += 2; while (j < n && /[0-9A-Fa-f_]/.test(text[j])) j++; }
      else {
        while (j < n && (isDigitCode(text.charCodeAt(j)) || text[j] === '_')) j++;
        if (text[j] === '.' && text[j + 1] !== '.') { j++; while (j < n && (isDigitCode(text.charCodeAt(j)) || text[j] === '_')) j++; }
        if ((text[j] === 'e' || text[j] === 'E') && /[0-9]/.test(text[j + 1] === '+' || text[j + 1] === '-' ? text[j + 2] || '' : text[j + 1] || '')) {
          j += (text[j + 1] === '+' || text[j + 1] === '-') ? 2 : 1;
          while (j < n && /[0-9]/.test(text[j])) j++;
        }
      }
      // 1abc is a name in MySQL (identifiers may start with a digit)
      while (j < n && isWordChar(text[j])) j++;
      push('num', i, j); i = j; return tok;
    }
    // words, including @var, @@var, #temp, $name, :bind, &subst
    if (isWordStart(c) || ((c === '@' || c === '#' || c === '$' || c === ':' || c === '&' || c === '?') && (isWordChar(c2 || '') || (c === '@' && c2 === '@')) && !(c === ':' && c2 === ':'))) {
      let j = i + 1;
      if (c === '@' && c2 === '@') j++;
      while (j < n && isWordChar(text[j])) j++;
      push(isWordStart(c) ? 'word' : 'param', i, j); i = j; return tok;
    }
    // operators
    if (OP_CHARS.has(c)) {
      let hit = c;
      for (const op of OPERATORS) { if (text.startsWith(op, i)) { hit = op; break; } }
      push(hit === '.' ? 'punct' : 'op', i, i + hit.length); i += hit.length; return tok;
    }
    push('punct', i, i + 1);
  }
  return tok;
}

const SIGNIFICANT = (t) => t.t !== 'ws' && t.t !== 'nl';

/** 1-based line number of offset in text. */
function lineAt(text, offset) {
  let line = 1;
  for (let k = text.indexOf('\n'); k >= 0 && k < offset; k = text.indexOf('\n', k + 1)) line++;
  return line;
}

/** Comment text with whitespace runs made one space, so a re-indented block comment still compares equal. */
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** The comparable value of a token. */
function keyOf(text, t) {
  const s = text.slice(t.s, t.e);
  switch (t.t) {
    case 'word': return 'w:' + s.toLowerCase();
    case 'param': return 'p:' + s.toLowerCase();
    case 'line': return 'c:' + squash(s.replace(/^(--|#|\/\/)/, ''));
    case 'block': return 'c:' + squash(s.slice(2, s.length - 2));
    default: return t.t[0] + ':' + s;
  }
}

/**
 * Compares the tokens of a and b, whitespace ignored. Names and keywords compare without case; strings, quoted
 * names, numbers and operators byte for byte; comments with their whitespace squashed.
 * opts.commentsFree: comments may move between code tokens (used by the comma-first pass); they still must
 * appear in the same order with the same text.
 * Returns null when equal, else { offsetA, offsetB, expected, found }.
 */
function compareTokens(a, b, rules, opts = {}) {
  const ta = tokenize(a, rules).filter(SIGNIFICANT);
  const tb = tokenize(b, rules).filter(SIGNIFICANT);
  const isC = (t) => t.t === 'line' || t.t === 'block';
  const seqs = opts.commentsFree
    ? [[ta.filter((t) => !isC(t)), tb.filter((t) => !isC(t))], [ta.filter(isC), tb.filter(isC)]]
    : [[ta, tb]];
  for (const [x, y] of seqs) {
    const m = Math.max(x.length, y.length);
    for (let k = 0; k < m; k++) {
      const p = x[k]; const q = y[k];
      const kp = p ? keyOf(a, p) : '<end>';
      const kq = q ? keyOf(b, q) : '<end>';
      if (kp !== kq) {
        return { offsetA: p ? p.s : a.length, offsetB: q ? q.s : b.length, expected: p ? a.slice(p.s, Math.min(p.e, p.s + 40)) : 'end of text', found: q ? b.slice(q.s, Math.min(q.e, q.s + 40)) : 'end of text' };
      }
    }
  }
  return null;
}

module.exports = { rulesFor, tokenize, tokenAt, compareTokens, lineAt, keyOf, SIGNIFICANT, MYSQL_LIKE };
