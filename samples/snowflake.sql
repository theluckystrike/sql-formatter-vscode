-- Snowflake: FLATTEN with =>, VARIANT paths, a JavaScript UDF in $$
create or replace function js_upper(s string) returns string language javascript as $$
  return S.toUpperCase();   // body kept as written
$$;
select f.value:name::string as name, f.index, t.raw:meta.source::string src from raw_events t, lateral flatten(input => t.raw:items, outer => true) f where t.loaded_at > dateadd(day, -1, current_timestamp()) qualify row_number() over (partition by f.value:id order by t.loaded_at desc) = 1;
