'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine');
const L = require('../src/lexer');

const fmt = (sql, o) => E.formatDocument(sql, Object.assign({ dialect: 'sql' }, o)).text;
const strings = (text, d) => L.tokenize(text, L.rulesFor(d), { dollar: !L.MYSQL_LIKE.has(d) }).filter((t) => ['str', 'dollar', 'ident', 'line', 'block'].includes(t.t)).map((t) => text.slice(t.s, t.e));

// Rival review cases (links in README "Why this one")
test('$$ bodies stay byte for byte, in PostgreSQL and in other dialects', () => {
  const body = '$$ begin  return a+1;   -- note\nend; $$';
  // MySQL has no dollar quotes ($$ is a DELIMITER there): only whitespace and keyword case may change, $$ is never split
  try { const m = fmt(`create function f(a int) returns int as ${body} language plpgsql;`, { dialect: 'mysql' }); assert.ok(!m.includes('$ $') && m.includes('-- note')); } catch (e) { assert.ok(e instanceof E.FormatError); }
  for (const d of ['postgresql', 'plsql', 'sql', 'transactsql', 'snowflake', 'bigquery']) {
    const out = fmt(`create function f(a int) returns int as ${body} language plpgsql;`, { dialect: d });
    assert.ok(out.includes(body), `${d}: ${out}`);
    assert.ok(!out.includes('$ $'));
  }
});

test('$BODY$ and $tag$ quotes are kept', () => {
  const sql = "CREATE FUNCTION f() RETURNS trigger AS $BODY$ BEGIN RETURN NEW; END $BODY$ LANGUAGE plpgsql;\nselect $fn$x  y$fn$;";
  const out = fmt(sql, { dialect: 'postgresql' });
  assert.ok(out.includes('$BODY$ BEGIN RETURN NEW; END $BODY$'));
  assert.ok(out.includes('$fn$x  y$fn$'));
});

test('DELIMITER $$ lines and the $$ after END are kept', () => {
  const sql = "DELIMITER $$\nCREATE PROCEDURE p(IN x INT)\nBEGIN\n  select x; select 'a$$b';\nEND$$\nDELIMITER ;\nselect 1;\n";
  for (const d of ['mysql', 'mariadb', 'sql']) {
    const out = fmt(sql, { dialect: d });
    assert.match(out, /^DELIMITER \$\$\n/m, d);
    assert.match(out, /^END\$\$$/m, d);
    assert.match(out, /^DELIMITER ;$/m, d);
    assert.ok(out.includes("'a$$b'"));
    assert.ok(!out.includes('$ $'));
  }
});

test("N'...' strings keep the N next to the quote", () => {
  const out = fmt("EXEC sp_addextendedproperty @name=N'MS_Description', @level2type = N'COLUMN', @level2name=N'id'", { dialect: 'transactsql' });
  assert.ok(out.includes("@level2type = N'COLUMN'") && !/N '/.test(out), out);
  for (const d of ['sql', 'postgresql', 'mysql', 'plsql', 'bigquery']) {
    const o2 = fmt("select N'COLUMN' as a, n'x' b from t", { dialect: d });
    assert.ok(o2.includes("N'COLUMN'") && o2.includes("n'x'") && !/N '/i.test(o2), `${d}: ${o2}`);
  }
});

test('MySQL account names stay together (DEFINER=`root`@`localhost`)', () => {
  const out = fmt("CREATE DEFINER=`root`@`localhost` VIEW v AS SELECT 1; GRANT SELECT ON db.* TO 'app'@'%'; DROP USER app@localhost;", { dialect: 'mysql' });
  assert.ok(out.includes('`root`@`localhost`'), out);
  assert.ok(out.includes("'app'@'%'"), out);
  assert.ok(out.includes('app@localhost'), out);
});

test('[bracket names] with spaces and ]] escapes are kept', () => {
  const out = fmt('select [first name], [x]]y] from [dbo].[my table] where [last name] = 1', { dialect: 'transactsql' });
  for (const s of ['[first name]', '[x]]y]', '[dbo].[my table]', '[last name]']) assert.ok(out.includes(s), s);
});

test('=> stays one operator (Snowflake FLATTEN, named arguments)', () => {
  const out = fmt('select * from table(flatten(input => parse_json(x)))', { dialect: 'snowflake' });
  assert.ok(out.includes('input => parse_json'));
});

test('commented-out code with commas stays commented out, in both comma modes', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'samples', 'commented-commas.sql'), 'utf8');
  for (const commaPosition of ['trailing', 'leading']) {
    const out = fmt(sql, { commaPosition });
    assert.deepEqual(strings(out, 'sql'), strings(sql, 'sql'), commaPosition);
    assert.ok(out.includes('-- o.old_total, o.old_tax,'));
    assert.ok(out.includes('/* o.discount, */'));
    assert.ok(/-- , o\.updated_at$/m.test(out));
  }
});

test('leading commas', () => {
  assert.equal(fmt('select a, b, c from t', { commaPosition: 'leading' }), 'SELECT\n  a\n  , b\n  , c\nFROM\n  t');
});

test('procedures are indented by block', () => {
  const sql = 'DELIMITER $$\nCREATE PROCEDURE p(IN amt INT)\nBEGIN\nDECLARE t INT DEFAULT 0;\nIF amt > 100 THEN SET t = 1; ELSE SET t = 2; END IF;\nWHILE t > 0 DO SET t = t - 1; END WHILE;\nEND$$\nDELIMITER ;\n';
  const out = fmt(sql, { dialect: 'mysql' });
  assert.match(out, /\)\nBEGIN\n  DECLARE t INT DEFAULT 0;\n  IF amt > 100 THEN\n    SET t = 1;\n  ELSE\n    SET t = 2;\n  END IF;\n  WHILE t > 0 DO\n    SET t = t - 1;\n  END WHILE;\nEND\$\$/);
});

test('PL/SQL package body: IS sections, EXCEPTION handlers and the / line', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'samples', 'oracle-package.sql'), 'utf8');
  const out = fmt(sql, { dialect: 'plsql' });
  assert.match(out, /^SET SERVEROUTPUT ON$/m);
  assert.match(out, /^PROMPT Creating package emp_pkg$/m);
  assert.equal((out.match(/^\/$/gm) || []).length, 2);
  assert.match(out, /\n  EXCEPTION\n    WHEN NO_DATA_FOUND THEN\n      dbms_output\.put_line/);
  assert.ok(out.includes("q'[Raised by ']'"));
});

test('T-SQL GO lines are kept and split batches', () => {
  const out = fmt('select 1\nGO\nselect 2\ngo 5\n', { dialect: 'transactsql' });
  assert.match(out, /^GO$/m);
  assert.match(out, /^go 5$/m);
});

test('psql backslash commands and COPY ... FROM stdin rows are kept as written', () => {
  const sql = "\\connect shop\nCOPY public.t (a, b) FROM stdin;\n1\tx,  y\n2\tz\n\\.\nselect  1;\n";
  const out = fmt(sql, { dialect: 'postgresql' });
  assert.ok(out.startsWith('\\connect shop\n'));
  assert.ok(out.includes('1\tx,  y\n2\tz\n\\.'));
  assert.match(out, /SELECT\n  1;\n$/);
});

// Refusals: the text stays unchanged
test('an unterminated string stops the run with its line', () => {
  assert.throws(() => fmt("select 1;\nselect 'oops from t;\nselect 3;"), (e) => e.kind === 'parse' && e.line === 2 && /unterminated string/.test(e.message));
});

test('a parse error names the line in the file', () => {
  assert.throws(() => fmt('select 1;\n\nselect from where (;\n', { dialect: 'postgresql' }), (e) => e instanceof E.FormatError && e.line >= 3);
});

test('10,000 nested parentheses are refused, not a crash', () => {
  const deep = 'select ' + '('.repeat(10000) + '1' + ')'.repeat(10000) + ';';
  assert.throws(() => fmt(deep), (e) => e.kind === 'deep' || e.kind === 'parse');
});

test('partial: the statement that fails is kept, the others are formatted', () => {
  const r = E.formatDocument("select a,b from t;\nselect 'open from x;\n", { dialect: 'sql' }, { partial: true });
  assert.deepEqual(r.kept, [2]);
  assert.ok(r.text.startsWith('SELECT\n  a,\n  b\nFROM\n  t;'));
  assert.ok(r.text.includes("select 'open from x;"));
});

test('the token check catches a changed token', () => {
  const rules = L.rulesFor('sql');
  assert.equal(L.compareTokens('select a , b', 'SELECT\n  a,\n  b', rules), null);
  assert.ok(L.compareTokens("select 'a  b'", "select 'a b'", rules));
  assert.ok(L.compareTokens('select a => b', 'select a = > b', rules));
  assert.ok(L.compareTokens('select a -- x\n, b', 'select a -- x , b', rules));
  assert.ok(L.compareTokens("select N'x'", "select N 'x'", rules));
  assert.ok(L.compareTokens('select $$a$$', 'select $ $a$ $', rules));
});

test('placeholders cannot leak: a changed placeholder is an error', () => {
  const p = E.protect("select 'x'", L.rulesFor('sql'), true, 'zqtest');
  assert.throws(() => E.restore(p.text.replace('zqtest', 'ZQTEST'), p.map), /changed/);
});

// Text details
test('CRLF, BOM and the final newline are kept', () => {
  const out = E.formatDocument('﻿select a,b from t;\r\nselect 2;\r\n', { dialect: 'sql' }).text;
  assert.ok(out.startsWith('﻿'));
  assert.ok(!/[^\r]\n/.test(out));
  assert.ok(out.endsWith(';\r\n'));
});

test('selection keeps its indent', () => {
  const r = E.formatSelection('    select a, b from t where x = 1', { dialect: 'sql' });
  assert.equal(r.text, '    SELECT\n      a,\n      b\n    FROM\n      t\n    WHERE\n      x = 1');
});

test('SQL in a one-line string stays on one line', () => {
  const r = E.formatEmbedded('select a,b from t where id=?', { dialect: 'sql' }, '"');
  assert.equal(r.text, 'SELECT a, b FROM t WHERE id = ?');
});

test('SQL in a multi-line string gets lines', () => {
  const r = E.formatEmbedded('select a,b from t', { dialect: 'sql' }, '`', '  ');
  assert.equal(r.text, 'SELECT\n    a,\n    b\n  FROM\n    t');
});

test('options: keyword case, lines between queries, tabs', () => {
  assert.equal(fmt('SELECT a FROM t', { keywordCase: 'lower' }), 'select\n  a\nfrom\n  t');
  assert.equal(fmt('select 1; select 2;', { linesBetweenQueries: 0 }), 'SELECT\n  1;\nSELECT\n  2;');
  assert.equal(fmt('select a from t', { useTabs: true }), 'SELECT\n\ta\nFROM\n\tt');
});

test('every sample formats, keeps its strings and comments, and a second run changes nothing', () => {
  const dir = path.join(__dirname, '..', 'samples');
  const D = require('../src/dialect');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const d = D.pick({ fileName: f, text }).dialect;
    const out = E.formatDocument(text, { dialect: d }).text;
    assert.deepEqual(strings(out, d).map((s) => s.replace(/\s+/g, ' ')), strings(text, d).map((s) => s.replace(/\s+/g, ' ')), f);
    assert.equal(E.formatDocument(out, { dialect: d }).text, out, `${f} is not stable`);
  }
});
