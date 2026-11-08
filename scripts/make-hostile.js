// Writes the hostile gate files into a folder: an unterminated string, 10,000 nested parentheses and a 1 MB line.
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'hostile-unterminated.sql'), "select 1;\nselect 'oops from orders where id = 1;\nselect 3;\n");
fs.writeFileSync(path.join(dir, 'hostile-nested.sql'), 'select ' + '('.repeat(10000) + '1' + ')'.repeat(10000) + ' from t;\n');
const cols = [];
for (let i = 0; i < 60000; i++) cols.push(`col_${i} * ${i}`);
fs.writeFileSync(path.join(dir, 'hostile-one-line-1mb.sql'), 'select ' + cols.join(', ') + " from big where name = 'x';\n");
console.log('written to', dir);
