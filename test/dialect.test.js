'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/dialect');

test('per-file choice wins, then the setting, then language id and file name', () => {
  assert.deepEqual(D.pick({ override: 'mysql', setting: 'plsql', languageId: 'sql' }), { dialect: 'mysql', source: 'file' });
  assert.deepEqual(D.pick({ setting: 'plsql', languageId: 'postgres' }), { dialect: 'plsql', source: 'setting' });
  assert.deepEqual(D.pick({ setting: 'auto', languageId: 'postgres' }), { dialect: 'postgresql', source: 'language' });
  assert.deepEqual(D.pick({ languageId: 'sql', fileName: '/x/a.PGSQL' }), { dialect: 'postgresql', source: 'extension' });
  assert.deepEqual(D.pick({ fileName: 'b.tsql' }), { dialect: 'transactsql', source: 'extension' });
  assert.deepEqual(D.pick({ fileName: 'pkg.pkb' }), { dialect: 'plsql', source: 'extension' });
});

test('the text picks the dialect', () => {
  const t = (text) => D.pick({ languageId: 'sql', fileName: 'a.sql', text }).dialect;
  assert.equal(t('create function f() returns int as $$ select 1 $$ language sql;'), 'postgresql');
  assert.equal(t('DELIMITER $$\nCREATE PROCEDURE p() BEGIN END$$\nDELIMITER ;'), 'mysql');
  assert.equal(t("select [first name] from [dbo].[t] where x = N'a'\nGO"), 'transactsql');
  assert.equal(t('CREATE OR REPLACE PACKAGE p AS END;\n/'), 'plsql');
  assert.equal(t('select * from `proj.ds.events_*` where _TABLE_SUFFIX > "1"'), 'bigquery');
  assert.equal(t('select f.value from t, lateral flatten(input => t.v) f'), 'snowflake');
  assert.equal(t('create table kv(k text primary key) without rowid;'), 'sqlite');
  assert.equal(t('select 1'), 'sql');
});
