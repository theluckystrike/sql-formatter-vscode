# Changelog

## 0.1.0

- First release: SQL formatting in 20 dialects with a token check before and after, so a result that would change your code is never applied.
- Keeps `$$` bodies, `DELIMITER` sections, `N'...'` strings, bracket names, account names, comments, `GO` and `/` lines, psql commands and `COPY` rows.
- Stored procedures, functions, triggers and packages indented by block.
- Dialect from the language mode, the file name or the text, with a status bar picker per file.
- Large files on up to 4 threads with a Cancel button; a time limit; Format the Rest after an error.
- Format SQL in String for SQL inside code.
