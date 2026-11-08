-- PostgreSQL: dollar-quoted bodies must stay byte for byte
create or replace function public.add_tax(amount numeric, rate numeric default 0.07) returns numeric
language plpgsql immutable as $$
begin
    if amount is null then return null; end if;
    return round(amount * (1 + rate), 2);   -- keep  two  spaces here
end;
$$;

CREATE FUNCTION audit.log_change() RETURNS trigger AS $BODY$
BEGIN
  INSERT INTO audit.changes(tbl, op, row_data, changed_at) VALUES (TG_TABLE_NAME, TG_OP, row_to_json(NEW)::jsonb, now());
  RETURN NEW;
END
$BODY$ LANGUAGE plpgsql;

create function slugify(t text) returns text as $fn$ select lower(regexp_replace(t, '[^a-z0-9]+', '-', 'gi')) $fn$ language sql;

select id, payload->>'email' as email, created_at::date, E'tab\there' as esc from users where tags @> array['vip'] and created_at >= now() - interval '7 days' order by created_at desc limit 20;

insert into settings(key, value) values ('theme', 'dark') on conflict (key) do update set value = excluded.value returning *;
