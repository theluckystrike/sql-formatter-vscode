# Pick the dialect

The status bar shows the dialect of the SQL file, for example PostgreSQL. It comes from, in this order:

1. your choice for this file (click the status bar item),
2. the setting `sqlFormatter.dialect`,
3. the language mode (for example `postgres`, `mysql`, `plsql`),
4. the file name (`.pgsql`, `.psql`, `.tsql`, `.plsql`, `.pks`, `.pkb`),
5. the text: `$$` bodies, `DELIMITER`, `GO`, `[names]`, `N'...'`, `CREATE PACKAGE` and more.

20 dialects: Standard SQL, PostgreSQL, MySQL, MariaDB, T-SQL, Oracle PL/SQL, SQLite, BigQuery, Snowflake, Redshift, Spark, Hive, Db2, Db2 for i, DuckDB, Trino, N1QL, SingleStore, TiDB and ClickHouse.
