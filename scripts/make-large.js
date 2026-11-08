// Generates a realistic SQL script of about N MB: DDL, inserts, joins, CTEs, updates.
const fs = require('fs');
const [out, mb] = [process.argv[2], Number(process.argv[3] || 5)];
const parts = []; let size = 0; let i = 0;
while (size < mb * 1024 * 1024) {
  let s;
  switch (i % 5) {
    case 0: s = `create table if not exists t${i} (id int primary key, name varchar(100) not null, created_at timestamp default current_timestamp, amount decimal(10,2));`; break;
    case 1: s = `insert into t${i - 1} (id, name, amount) values (${i}, 'name ${i}, with comma', ${i}.5), (${i + 1}, 'it''s ${i}', 0.25);`; break;
    case 2: s = `select a.id, a.name, sum(b.amount) as total, count(*) cnt from t${i - 2} a left join orders b on b.customer_id = a.id and b.status in ('paid','shipped') where a.created_at >= '2026-01-01' -- recent\n group by a.id, a.name having sum(b.amount) > 100 order by total desc limit 50;`; break;
    case 3: s = `with recent as (select customer_id, max(created_at) last_at from orders where amount > ${i} group by customer_id) select c.*, r.last_at, case when r.last_at > now() - interval '30 days' then 'active' else 'idle' end status from customers c join recent r on r.customer_id = c.id;`; break;
    default: s = `update t${i - 4} set amount = amount * 1.1, name = upper(name) where id between ${i} and ${i + 100} and name not like '%test%';`;
  }
  parts.push(s); size += s.length + 1; i++;
}
fs.writeFileSync(out, parts.join('\n') + '\n');
console.log(out, size, 'bytes', i, 'statements');
