'use strict';
// Layout for stored procedures, functions, triggers, packages and anonymous blocks.
// sql-formatter formats each plain statement; this file puts BEGIN/END, IF/THEN/ELSE, loops, DECLARE and
// EXCEPTION sections on their own lines and indents the statements by block depth.
// Only whitespace changes here. The caller compares the tokens before and after, and falls back to the plain
// result when anything differs.

const { tokenize } = require('./lexer');

const STMT_KW = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'RETURN', 'EXEC', 'EXECUTE', 'PRINT', 'RAISERROR', 'THROW',
  'DECLARE', 'BREAK', 'CONTINUE', 'GOTO', 'MERGE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER', 'WITH', 'OPEN', 'FETCH', 'CLOSE',
  'DEALLOCATE', 'CALL', 'LEAVE', 'ITERATE', 'SIGNAL', 'RESIGNAL', 'COMMIT', 'ROLLBACK', 'SAVE', 'WAITFOR', 'USE', 'GRANT', 'REVOKE']);
const BLOCK_STARTERS = new Set(['BEGIN', 'END', 'IF', 'ELSE', 'ELSIF', 'ELSEIF', 'WHILE', 'LOOP', 'REPEAT', 'UNTIL', 'EXCEPTION', 'WHEN', 'FOR']);
const NOT_BLOCK_BEGIN = new Set(['TRANSACTION', 'TRAN', 'WORK', 'DISTRIBUTED', 'ISOLATION', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE']);
const CONTROL_KW = new Set(['IF', 'THEN', 'ELSE', 'ELSIF', 'ELSEIF', 'END', 'LOOP', 'WHILE', 'DO', 'BEGIN', 'REPEAT', 'UNTIL', 'FOR',
  'IN', 'REVERSE', 'EXCEPTION', 'WHEN', 'DECLARE', 'IS', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'TRY', 'CATCH', 'ATOMIC', 'EXISTS',
  'BETWEEN', 'LIKE', 'OTHERS', 'CREATE', 'REPLACE', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'BODY', 'TRIGGER', 'RETURNS', 'RETURN',
  'CASE', 'SELECT', 'FROM', 'WHERE', 'TRUE', 'FALSE', 'ALTER', 'DEFINER', 'BEFORE', 'AFTER', 'INSTEAD', 'OF', 'ON', 'EACH', 'ROW',
  'INSERT', 'UPDATE', 'DELETE', 'LANGUAGE', 'DETERMINISTIC', 'OUT', 'INOUT', 'DEFAULT', 'EVENT', 'SCHEDULE', 'EVERY', 'AT', 'BY']);

const isComment = (t) => t.t === 'line' || t.t === 'block';
const isSpace = (t) => t.t === 'ws' || t.t === 'nl';

/** True when the statement has a block body this layout can handle. */
function isProcedural(text, rules, dollar) {
  const toks = tokenize(text, rules, { dollar }).filter((t) => !isSpace(t) && !isComment(t));
  if (!toks.length) return false;
  if (toks.some((t) => t.t === 'dollar')) return false;
  const w = (k) => (toks[k] && toks[k].t === 'word' ? text.slice(toks[k].s, toks[k].e).toUpperCase() : '');
  const first = w(0);
  const d = rules.dialect;
  if (first === 'BEGIN' && !NOT_BLOCK_BEGIN.has(w(1)) && toks.length > 2) return true;
  if (first === 'DECLARE' && d === 'plsql') return true;
  if ((first === 'IF' || first === 'WHILE') && d === 'transactsql') return toks.some((t) => t.t === 'word' && text.slice(t.s, t.e).toUpperCase() === 'BEGIN');
  if (first !== 'CREATE' && first !== 'ALTER') return false;
  const head = toks.slice(0, 12).map((t) => text.slice(t.s, t.e).toUpperCase()).join(' ');
  if (!/\b(PROCEDURE|PROC|FUNCTION|TRIGGER|PACKAGE|EVENT)\b/.test(head)) return false;
  let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const s = text.slice(toks[k].s, toks[k].e);
    if (s === '(') depth++; else if (s === ')') depth--;
    if (depth !== 0 || toks[k].t !== 'word') continue;
    const u = s.toUpperCase();
    if (u === 'BEGIN' && !NOT_BLOCK_BEGIN.has(w(k + 1))) return true;
    if (d === 'plsql' && (u === 'IS' || u === 'AS')) return true;
  }
  return false;
}

/**
 * Lays out a procedural statement. fmt(sql) formats one plain statement (sql-formatter with placeholders) and
 * returns its text; it may throw, then the statement is joined on one line.
 */
function layout(text, o, rules, dollar, fmt) {
  const all = tokenize(text, rules, { dollar });
  const toks = all.filter((t) => !isSpace(t));
  const d = rules.dialect;
  const tsql = d === 'transactsql';
  const plsql = d === 'plsql';
  const unit = o.useTabs ? '\t' : ' '.repeat(o.tabWidth);
  const S = (t) => text.slice(t.s, t.e);
  const U = (k) => (toks[k] && toks[k].t === 'word' ? S(toks[k]).toUpperCase() : '');
  const isSemi = (k) => toks[k] && toks[k].t === 'punct' && S(toks[k]) === ';';
  const nlBefore = (k) => { // a newline between token k-1 and token k in the original
    if (k <= 0) return true;
    return /\n/.test(text.slice(toks[k - 1].e, toks[k].s));
  };

  const lines = []; // { depth, text }
  const stack = []; // frame types: block, decl, if, loop, exc, handler
  let oneShot = false; // T-SQL IF/ELSE/WHILE without BEGIN: the next unit is indented once

  const kwCase = (w) => (o.keywordCase === 'upper' ? w.toUpperCase() : o.keywordCase === 'lower' ? w.toLowerCase() : w);
  // Joins tokens [a, b) on one line, with keyword case for control words.
  const join = (a, b) => {
    let out = '';
    let prev = null;
    for (let k = a; k < b; k++) {
      const t = toks[k];
      let s = S(t);
      if (t.t === 'word' && CONTROL_KW.has(s.toUpperCase())) s = kwCase(s);
      if (t.t === 'line') { out += (out ? ' ' : '') + s; prev = t; continue; }
      const p = prev ? S(prev) : '';
      const tight = !prev || p === '(' || p === '.' || s === ')' || s === ',' || s === ';' || s === '.' ||
        (s === '(' && prev && (prev.t === 'word' || prev.t === 'ident') && !CONTROL_KW.has(p.toUpperCase()));
      out += (tight ? '' : ' ') + s;
      prev = t;
    }
    return out;
  };
  const hasLineComment = (a, b) => { for (let k = a; k < b; k++) if (toks[k].t === 'line') return true; return false; };
  const push = (depth, str) => {
    for (const l of String(str).split('\n')) lines.push({ depth, text: l });
  };
  const emitJoined = (a, b, depth) => {
    if (hasLineComment(a, b)) { // keep the comment's line break
      let s = a;
      for (let k = a; k < b; k++) if (toks[k].t === 'line') { push(depth, join(s, k + 1)); s = k + 1; }
      if (s < b) push(depth, join(s, b));
    } else push(depth, join(a, b));
  };
  const emitStmt = (a, b, depth) => {
    const src = text.slice(toks[a].s, toks[b - 1].e);
    let f;
    try { f = fmt(src); } catch { f = null; }
    if (f == null) { emitJoined(a, b, depth); return; }
    const fl = f.replace(/\s+$/, '').split('\n');
    if (fl.length === 2 && /^(SET|RETURN|DECLARE)$/i.test(fl[0].trim()) && !/--|#|\/\//.test(fl[1]) && fl[0].length + fl[1].trim().length < o.expressionWidth) {
      push(depth, fl[0].trim() + ' ' + fl[1].trim()); return;
    }
    push(depth, f.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, arr) => !(l === '' && (arr[i - 1] === '' || i === 0))).join('\n'));
  };
  const depthNow = () => stack.length + (oneShot ? 1 : 0);

  // scan to the first word in `words` at paren depth 0; returns its index or -1
  const scanTo = (from, words, stopAtSemi) => {
    let p = 0;
    for (let k = from; k < toks.length; k++) {
      const s = S(toks[k]);
      if (s === '(') p++; else if (s === ')') p--;
      if (p === 0 && toks[k].t === 'word' && words.has(s.toUpperCase())) return k;
      if (p === 0 && stopAtSemi && isSemi(k)) return -1;
    }
    return -1;
  };
  // end of a plain statement that starts at k: after its ';' at depth 0, or before a block keyword
  const stmtEnd = (k) => {
    let p = 0; let cs = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j]; const s = S(t); const u = t.t === 'word' ? s.toUpperCase() : '';
      if (s === '(') p++; else if (s === ')') p = Math.max(0, p - 1);
      if (u === 'CASE') cs++;
      if (j > k && p === 0 && cs === 0 && t.t === 'word' && (BLOCK_STARTERS.has(u) || (tsql && STMT_KW.has(u) && nlBefore(j) && u !== 'SET' && u !== 'SELECT'))) {
        if (!(u === 'BEGIN' && NOT_BLOCK_BEGIN.has(U(j + 1))) && !(u === 'FOR' && !plsql) && !(u === 'WHEN' && !inHandler()) && !(u === 'IF' && U(j - 1) === 'END')) return j;
      }
      if (u === 'END' && cs > 0) cs--;
      if (p === 0 && isSemi(j)) return j + 1;
    }
    return toks.length;
  };
  const inHandler = () => stack.includes('exc');

  // header: up to BEGIN (or IS/AS in PL/SQL)
  let i = 0;
  const first = U(0);
  if (first === 'CREATE' || first === 'ALTER') {
    let p = 0; let h = -1;
    for (let k = 0; k < toks.length; k++) {
      const s = S(toks[k]);
      if (s === '(') p++; else if (s === ')') p--;
      if (p !== 0 || toks[k].t !== 'word') continue;
      const u = s.toUpperCase();
      if (u === 'BEGIN' && !NOT_BLOCK_BEGIN.has(U(k + 1))) { h = k; break; }
      if (plsql && (u === 'IS' || u === 'AS')) { h = k + 1; stack.push('decl'); break; }
    }
    if (h < 0) throw new Error('no body');
    const headSrc = text.slice(toks[0].s, toks[h - 1].e);
    let head = null;
    if (!plsql && !hasLineComment(0, h)) { try { head = fmt(headSrc); } catch { head = null; } }
    if (head != null && !/--|#|\/\//.test(head)) {
      head = head.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*\n\s*/g, ' ').trim();
      push(0, head);
    } else emitJoined(0, h, 0);
    i = h;
  }

  let guard = 0;
  while (i < toks.length && guard++ < 100000) {
    const t = toks[i];
    if (isComment(t)) {
      const str = S(t);
      if (!nlBefore(i) && lines.length && t.t === 'line') lines[lines.length - 1].text += ' ' + str;
      else push(depthNow(), str.split('\n').map((l, k) => (k ? l.replace(/^\s+/, ' ') : l)).join('\n'));
      i++; continue;
    }
    const u = U(i);
    const shot = oneShot; oneShot = false;
    if (u === 'BEGIN' && !NOT_BLOCK_BEGIN.has(U(i + 1))) {
      let e = i + 1;
      if (['TRY', 'CATCH', 'ATOMIC'].includes(U(e))) e++;
      else if (U(e) === 'NOT' && U(e + 1) === 'ATOMIC') e += 2;
      const top = stack[stack.length - 1];
      const dep = stack.length - (top === 'decl' ? 1 : 0) + (shot ? 1 : 0);
      if (top === 'decl') stack.pop();
      push(dep, join(i, e));
      stack.push(shot ? 'block1' : 'block');
      i = e; continue;
    }
    if (u === 'END') {
      let e = i + 1;
      const nx = U(e);
      if (['IF', 'LOOP', 'WHILE', 'CASE', 'REPEAT', 'TRY', 'CATCH', 'FOR'].includes(nx)) e++;
      else if (toks[e] && (toks[e].t === 'word' || toks[e].t === 'ident') && !BLOCK_STARTERS.has(nx) && !STMT_KW.has(nx) && !(tsql && nlBefore(e))) e++; // END label
      if (isSemi(e)) e++;
      if (stack[stack.length - 1] === 'handler') stack.pop();
      const top = stack.pop();
      push(stack.length + (top === 'block1' ? 0 : 0), join(i, e));
      i = e; continue;
    }
    if (!tsql && (u === 'IF' || u === 'ELSIF' || u === 'ELSEIF' || (u === 'WHILE') || (u === 'FOR' && plsql))) {
      const th = scanTo(i + 1, new Set(u === 'WHILE' || u === 'FOR' ? ['DO', 'LOOP'] : ['THEN']), true);
      if (th > 0) {
        if (u === 'ELSIF' || u === 'ELSEIF') stack.pop();
        emitJoined(i, th + 1, stack.length);
        stack.push(u === 'WHILE' || u === 'FOR' ? 'loop' : 'if');
        i = th + 1; continue;
      }
    }
    if (!tsql && u === 'ELSE' && stack.length) {
      stack.pop(); push(stack.length, join(i, i + 1)); stack.push('if'); i++; continue;
    }
    if (tsql && (u === 'IF' || u === 'WHILE' || u === 'ELSE')) {
      // condition runs to BEGIN or to the next statement at paren depth 0
      let e = i + 1;
      if (u !== 'ELSE') {
        let p = 0;
        for (; e < toks.length; e++) {
          const s = S(toks[e]); const w = U(e);
          if (s === '(') p++; else if (s === ')') p--;
          if (p === 0 && e > i + 1 && (w === 'BEGIN' || (STMT_KW.has(w) && !(w === 'SELECT' && S(toks[e - 1]) === '(')) || w === 'IF' || w === 'WHILE' || w === 'RETURN' || w === 'BREAK')) break;
        }
      }
      push(depthNow() + (shot ? 1 : 0), join(i, e));
      oneShot = U(e) !== 'BEGIN';
      i = e; continue;
    }
    if (u === 'LOOP' || u === 'REPEAT') { push(stack.length, join(i, i + 1)); stack.push('loop'); i++; continue; }
    if (u === 'UNTIL') {
      const e = scanTo(i + 1, new Set(['END']), true);
      if (e > 0) { emitJoined(i, e, Math.max(0, stack.length - 1)); i = e; continue; }
    }
    if (plsql && u === 'DECLARE' && (i === 0 || !stack.length || stack[stack.length - 1] !== 'decl')) {
      push(stack.length, join(i, i + 1)); stack.push('decl'); i++; continue;
    }
    if (plsql && u === 'EXCEPTION' && stack.length) {
      stack.pop(); push(stack.length, join(i, i + 1)); stack.push('exc'); i++; continue;
    }
    if (u === 'WHEN' && inHandler()) {
      const th = scanTo(i + 1, new Set(['THEN']), true);
      if (th > 0) {
        if (stack[stack.length - 1] === 'handler') stack.pop();
        emitJoined(i, th + 1, stack.length);
        stack.push('handler'); i = th + 1; continue;
      }
    }
    if (plsql && (u === 'PROCEDURE' || u === 'FUNCTION') && stack.length) {
      const e = scanTo(i + 1, new Set(['IS', 'AS']), true);
      if (e > 0) { emitJoined(i, e + 1, stack.length); stack.push('decl'); i = e + 1; continue; }
    }
    // a plain statement
    const e = Math.max(i + 1, stmtEnd(i));
    emitStmt(i, e, stack.length + (shot ? 1 : 0));
    i = e;
  }
  return lines.map((l) => (l.text ? unit.repeat(Math.max(0, l.depth)) + l.text : '')).join('\n');
}

module.exports = { isProcedural, layout };
