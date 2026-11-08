-- Press Shift+Alt+F (Shift+Option+F on a Mac) to format this file.
-- The $$ body, the N'' string and the comments stay exactly as written.
create or replace function order_total(p_order int) returns numeric language plpgsql as $$
begin
  return (select sum(qty * price) from order_items where order_id = p_order);
end;
$$;

select c.id, c.name, count(o.id) as orders, sum(o.total) as revenue -- , avg(o.total)
from customers c left join orders o on o.customer_id = c.id and o.status in ('paid', 'shipped')
where c.created_at >= '2026-01-01' and c.country = 'DE' group by c.id, c.name having sum(o.total) > 1000 order by revenue desc;
