'use strict';
// Picks the SQL dialect for a file: per-file choice, then the setting, then the language id and file name,
// then a look at the text. Pure: no VS Code.

const NAMES = {
  sql: 'Standard SQL', postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', transactsql: 'T-SQL (SQL Server)',
  plsql: 'Oracle PL/SQL', sqlite: 'SQLite', bigquery: 'BigQuery', snowflake: 'Snowflake', redshift: 'Amazon Redshift',
  spark: 'Spark SQL', hive: 'Hive', db2: 'IBM Db2', db2i: 'IBM Db2 for i', duckdb: 'DuckDB', trino: 'Trino / Presto',
  n1ql: 'Couchbase N1QL', singlestoredb: 'SingleStore', tidb: 'TiDB', clickhouse: 'ClickHouse',
};
const SHORT = {
  sql: 'SQL', postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', transactsql: 'T-SQL', plsql: 'PL/SQL', sqlite: 'SQLite',
  bigquery: 'BigQuery', snowflake: 'Snowflake', redshift: 'Redshift', spark: 'Spark', hive: 'Hive', db2: 'Db2', db2i: 'Db2i',
  duckdb: 'DuckDB', trino: 'Trino', n1ql: 'N1QL', singlestoredb: 'SingleStore', tidb: 'TiDB', clickhouse: 'ClickHouse',
};

const BY_LANGUAGE = {
  postgres: 'postgresql', postgresql: 'postgresql', pgsql: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', tsql: 'transactsql',
  mssql: 'transactsql', plsql: 'plsql', oracle: 'plsql', 'oracle-sql': 'plsql', sqlite: 'sqlite', bigquery: 'bigquery',
  'snowflake-sql': 'snowflake', snowflake: 'snowflake', redshift: 'redshift', hql: 'hive', hive: 'hive', 'hive-sql': 'hive',
  sparksql: 'spark', 'spark-sql': 'spark', databricks: 'spark', duckdb: 'duckdb', trino: 'trino', clickhouse: 'clickhouse', db2: 'db2',
};
const BY_EXT = {
  '.pgsql': 'postgresql', '.psql': 'postgresql', '.postgres': 'postgresql', '.mysql': 'mysql', '.tsql': 'transactsql',
  '.mssql': 'transactsql', '.plsql': 'plsql', '.pls': 'plsql', '.pks': 'plsql', '.pkb': 'plsql', '.pck': 'plsql', '.prc': 'plsql',
  '.fnc': 'plsql', '.trg': 'plsql', '.bql': 'bigquery', '.hql': 'hive', '.sqlite': 'sqlite', '.ddb': 'duckdb', '.n1ql': 'n1ql',
};

// [dialect, weight, regex]. The text sample is the first 256 KB.
const HINTS = [
  ['postgresql', 4, /\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$/],
  ['postgresql', 4, /\bLANGUAGE\s+'?plpgsql\b/i],
  ['postgresql', 2, /::\s*(?:int|integer|text|bigint|numeric|jsonb?|timestamptz|date|uuid|regclass)\b/i],
  ['postgresql', 2, /\b(?:SERIAL|BIGSERIAL|JSONB|TIMESTAMPTZ|ILIKE|RETURNING|ON\s+CONFLICT)\b/i],
  ['postgresql', 3, /^\\(?:connect|c|i|set|echo|copy)\b/m],
  ['postgresql', 3, /\bCOPY\b[^;]*\bFROM\s+stdin\b/i],
  ['mysql', 5, /^\s*DELIMITER\s+\S+\s*$/im],
  ['mysql', 3, /\bAUTO_INCREMENT\b|\bENGINE\s*=\s*\w+|\bUNSIGNED\b|\bLIMIT\s+\d+\s*,\s*\d+/i],
  ['mysql', 2, /`[^`\n]+`/],
  ['mysql', 2, /\/\*!\d{5}/],
  ['transactsql', 4, /^\s*GO\s*$/im],
  ['transactsql', 3, /\[[A-Za-z_][^\]\n]*\s[^\]\n]*\]|\[dbo\]/i],
  ['transactsql', 3, /\bN'/],
  ['transactsql', 3, /\b(?:NVARCHAR|UNIQUEIDENTIFIER|DATETIME2|IDENTITY\s*\(|SET\s+NOCOUNT|RAISERROR|@@ROWCOUNT|TOP\s*\(?\d+|sp_\w+|dbo\.)/i],
  ['transactsql', 2, /\bDECLARE\s+@\w+/i],
  ['plsql', 5, /\bCREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\b/i],
  ['plsql', 3, /\b(?:VARCHAR2|NUMBER\s*\(|DBMS_OUTPUT|PLS_INTEGER|NVL\s*\(|SYSDATE|ROWNUM|FROM\s+DUAL)\b/i],
  ['plsql', 3, /^\s*\/\s*$/m],
  ['plsql', 2, /\bEXCEPTION\s+WHEN\b/i],
  ['bigquery', 5, /`[\w-]+\.[\w-]+\.[\w*-]+`/],
  ['bigquery', 3, /\b(?:SAFE_CAST|STRUCT<|ARRAY<|UNNEST\s*\(|_TABLE_SUFFIX|PARSE_DATE|FORMAT_DATE)/i],
  ['snowflake', 4, /\b(?:VARIANT|LATERAL\s+FLATTEN|FLATTEN\s*\(|TRY_TO_\w+|CREATE\s+(?:OR\s+REPLACE\s+)?(?:STAGE|WAREHOUSE|PIPE))\b/i],
  ['snowflake', 2, /\$\d+\b|:\w+::/],
  ['sqlite', 4, /\bWITHOUT\s+ROWID\b|\bAUTOINCREMENT\b|\bPRAGMA\s+\w+/i],
  ['sqlite', 2, /\bINTEGER\s+PRIMARY\s+KEY\b/i],
  ['redshift', 4, /\bDISTKEY\b|\bSORTKEY\b|\bDISTSTYLE\b|\bENCODE\s+(?:ZSTD|AZ64|LZO)\b/i],
  ['spark', 3, /\bUSING\s+(?:DELTA|PARQUET)\b|\bTBLPROPERTIES\b|\bOPTIMIZE\s+\w+\s+ZORDER\b/i],
  ['hive', 3, /\bSTORED\s+AS\s+(?:ORC|TEXTFILE|PARQUET)\b|\bROW\s+FORMAT\s+DELIMITED\b|\bPARTITIONED\s+BY\b/i],
  ['clickhouse', 4, /\bENGINE\s*=\s*(?:MergeTree|ReplacingMergeTree|SummingMergeTree|Log)\b/i],
  ['duckdb', 3, /\bread_(?:csv|parquet|json)(?:_auto)?\s*\(/i],
];

/** Scores the text; returns { dialect, score } (dialect 'sql' when nothing stands out). */
function sniff(text) {
  const sample = String(text || '').slice(0, 262144);
  const score = {};
  for (const [d, w, re] of HINTS) if (re.test(sample)) score[d] = (score[d] || 0) + w;
  let best = 'sql'; let top = 2;
  for (const [d, s] of Object.entries(score)) if (s > top) { best = d; top = s; }
  return { dialect: best, score: best === 'sql' ? 0 : top };
}

/**
 * The dialect to use. args: { override, setting, languageId, fileName, text }.
 * Returns { dialect, source } with source 'file' | 'setting' | 'language' | 'extension' | 'content' | 'default'.
 */
function pick(args) {
  const a = args || {};
  if (a.override && NAMES[a.override]) return { dialect: a.override, source: 'file' };
  if (a.setting && a.setting !== 'auto' && NAMES[a.setting]) return { dialect: a.setting, source: 'setting' };
  const lang = String(a.languageId || '').toLowerCase();
  if (BY_LANGUAGE[lang]) return { dialect: BY_LANGUAGE[lang], source: 'language' };
  const m = /(\.[A-Za-z0-9]+)$/.exec(String(a.fileName || ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (BY_EXT[ext]) return { dialect: BY_EXT[ext], source: 'extension' };
  const s = sniff(a.text);
  if (s.dialect !== 'sql') return { dialect: s.dialect, source: 'content' };
  return { dialect: 'sql', source: 'default' };
}

module.exports = { pick, sniff, NAMES, SHORT, BY_LANGUAGE, BY_EXT };
