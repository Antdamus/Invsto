begin;
set local lock_timeout='5s';

-- A null start requests the saved catalog's full history. Explicit date ranges
-- retain their existing bound. The admin gate remains before either path.
do $$declare f text:=pg_get_functiondef('public.get_streamer_performance_history(date,date)'::regprocedure);
 old_validation text:=$old$if _from is null or _until is null or _until<=_from or _until-_from>370 or _from<'2000-01-01' then
  raise exception 'Choose a history range of at most 370 days';end if;$old$;
 new_validation text:=$new$if _until is null or _until<'2000-01-02' then
  raise exception 'Choose a valid history end date';end if;
 if _from is null then
  select coalesce(min((starts_at at time zone 'America/New_York')::date),_until-1) into _from
  from public.weekly_ebay_production_shows()
  where starts_at>=timestamptz '2000-01-01 00:00:00+00'
   and starts_at<_until::timestamp at time zone 'America/New_York';
 elsif _until<=_from or _until-_from>370 or _from<'2000-01-01' then
  raise exception 'Choose a history range of at most 370 days';end if;$new$;
begin
 if strpos(f,old_validation)=0 then raise exception 'Unexpected history range validation';end if;
 f:=replace(f,old_validation,new_validation);
 -- Overnight buffer orders contribute to their show's totals, but coverage
 -- counts use only the requested purchase dates so adjacent batches add once.
 if strpos(f,'"show" text,seller text')=0 then raise exception 'Unexpected history order schema';end if;
 f:=replace(f,'"show" text,seller text','day date,"show" text,seller text');
 f:=replace(f,'(select count(*) from orders)','(select count(*) from orders where day>=_from and day<_until)');
 f:=replace(f,'from orders where "show" is null','from orders where "show" is null and day>=_from and day<_until');
 execute f;
end$$;
notify pgrst,'reload schema';
commit;
