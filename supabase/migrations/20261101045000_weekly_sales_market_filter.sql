begin;
-- The filtered and combined reports share one calculation, including the prior
-- week when it falls outside the selected month.
do $$declare
 definition text:=pg_get_functiondef('public.get_weekly_marketplace_sales(date)'::regprocedure);
begin
 if strpos(definition,'where purchased<=cutoff')=0 or strpos(definition,'group by s.week,s.first_day')=0 then raise exception 'Unexpected weekly report definition';end if;
 definition:=replace(definition,split_part(definition,' RETURNS jsonb',1),
  'CREATE OR REPLACE FUNCTION public.get_weekly_sales_for_market(_month date, _market text)'||chr(10));
 definition:=replace(definition,'if m>clock_et::date',
  'if _market is null or _market not in (''all'',''ebay'',''tiktok'',''whatnot'') then raise exception ''Unknown marketplace'';end if;
 if m>clock_et::date');
 definition:=replace(definition,'where purchased<=cutoff','where purchased<=cutoff and (_market=''all'' or o.market=_market)');
 definition:=replace(definition,'group by s.week,s.first_day','where _market=''all'' or mk.market=_market group by s.week,s.first_day');
 execute definition;
end$$;
revoke all on function public.get_weekly_sales_for_market(date,text) from public,anon;
grant execute on function public.get_weekly_sales_for_market(date,text) to authenticated;
create or replace function public.get_weekly_marketplace_sales(_month date default null) returns jsonb
language sql stable security definer set search_path='' as $$select public.get_weekly_sales_for_market(_month,'all')$$;
notify pgrst,'reload schema';
commit;
