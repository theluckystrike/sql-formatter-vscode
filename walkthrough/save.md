# Format on save

Add this to your settings to format SQL files each time you save:

```json
"[sql]": {
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "zovo.zovo-sql-formatter"
}
```

When the SQL cannot be read, or when the result would change anything but whitespace and keyword case, the file is saved as it is. The status bar names the line.
