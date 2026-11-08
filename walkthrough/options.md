# Keyword case, commas and width

| Setting | Values |
| --- | --- |
| `sqlFormatter.keywordCase` | upper, lower, preserve |
| `sqlFormatter.commaPosition` | trailing (`a,`), leading (`, b`) |
| `sqlFormatter.maxLineWidth` | lists shorter than this stay on one line (default 60) |
| `sqlFormatter.indentStyle` | standard, tabularLeft, tabularRight |
| `sqlFormatter.linesBetweenQueries` | empty lines between statements |
| `sqlFormatter.procedureLayout` | indent procedures by BEGIN/END, IF and loops |

The editor's tab size and tabs or spaces are used unless you turn off `sqlFormatter.useEditorIndent`.
