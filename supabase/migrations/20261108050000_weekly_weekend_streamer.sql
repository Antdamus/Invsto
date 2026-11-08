begin;
set local lock_timeout='5s';

-- Report fallback only. Explicit assignments and recorded sellers still win.
-- Use the show's Eastern start day, even if its orders cross midnight.
do $$declare f text:=pg_get_functiondef('public.weekly_ebay_production(jsonb)'::regprocedure);
 marker text:='then ''Otello'' else ''Sydney'' end rule_name';
begin
 if strpos(f,marker)=0 then raise exception 'Unexpected weekly seller rule definition';end if;
 execute replace(f,marker,$rule$then 'Otello'
     when extract(isodow from coalesce(s.starts_at at time zone 'America/New_York',b.purchased)) in (6,7)
     then 'Manuella' else 'Sydney' end rule_name$rule$);
end$$;

notify pgrst,'reload schema';
commit;
