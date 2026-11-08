begin;
set local lock_timeout='5s';
-- Report attribution only: user-confirmed start date and overnight boundary.
-- Saved show and seller assignments still take precedence.
do $$declare f text; sig text; marker text;
begin
 foreach sig in array array['public.weekly_ebay_production(jsonb)','public.streamer_performance_orders(jsonb)'] loop
  f:=pg_get_functiondef(sig::regprocedure);
  marker:='case when extract(hour from coalesce(s.starts_at at time zone ''America/New_York'',b.purchased))>=18';
  if strpos(f,marker)=0 then raise exception 'Unexpected attribution function %',sig;end if;
  f:=replace(f,marker,'case when coalesce(s.starts_at at time zone ''America/New_York'',b.purchased)::date<''2026-09-23'' then ''Otello'' when extract(hour from coalesce(s.starts_at at time zone ''America/New_York'',b.purchased))>=18');
  f:=replace(f,'b.purchased))<8 then','b.purchased))<6 then');execute f;
 end loop;
 f:=pg_get_functiondef('public.get_streamer_performance_history(date,date)'::regprocedure);
 marker:='when extract(hour from s.starts_at at time zone ''America/New_York'')>=18';
 if strpos(f,marker)=0 then raise exception 'Unexpected historical attribution';end if;
 f:=replace(f,marker,'when (s.starts_at at time zone ''America/New_York'')::date<''2026-09-23'' then ''Otello'' '||marker);
 f:=replace(f,'America/New_York'')<8 then','America/New_York'')<6 then');
 f:=replace(f,'when (s.starts_at at time zone ''America/New_York'')::date<''2026-09-15'' then ''Historical seller unassigned''','');
 f:=replace(f,'''sydney_estimated_start'',''2026-09-15''','''sydney_estimated_start'',''2026-09-23''');
 execute f;
end$$;
notify pgrst,'reload schema';
commit;
