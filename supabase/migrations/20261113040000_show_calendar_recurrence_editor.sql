-- Create weekly patterns from the calendar, atomically and safely on retries.
begin;
alter table public.seller_show_recurrences
  add column schedule_timezone text,
  add column creation_request_id uuid unique;

create or replace function public.materialize_seller_show_pattern(
  _id uuid,_from date,_through date,_strict boolean default false
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare r record;v_day date;v_start timestamptz;v_end timestamptz;v_count integer:=0;v_conflicts integer:=0;
begin
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));
  select sr.*,e.user_id,coalesce(sr.schedule_timezone,nullif(sl.timezone,''),'America/New_York') as timezone into r
    from public.seller_show_recurrences sr
    join public.employees e on e.id=sr.seller_employee_id and e.active is distinct from false
    join public.store_locations sl on sl.id=sr.store_id and sl.active
    where sr.id=_id and sr.active;
  if not found then return jsonb_build_object('created',0,'conflicts',0);end if;
  for v_day in select d::date from generate_series(greatest(_from,r.effective_from)::timestamp,
    least(_through,_from+180,coalesce(r.effective_to,_through))::timestamp,interval '1 day') d
  loop
    if not(extract(dow from v_day)::integer=any(r.weekdays)) then continue;end if;
    if exists(select 1 from public.seller_sale_shifts s where s.recurrence_id=r.id and s.recurrence_date=v_day) then
      delete from public.seller_show_recurrence_conflicts where recurrence_id=r.id and show_date=v_day;
      continue;
    end if;
    v_start:=(v_day+r.start_local) at time zone r.timezone;
    v_end:=((v_day+case when r.ends_next_day then 1 else 0 end)+r.end_local) at time zone r.timezone;
    if v_start<=now() then continue;end if;
    begin
      if v_end-v_start not between interval '2 hours' and interval '24 hours' then
        raise exception 'Show duration falls outside 2–24 hours on this timezone transition' using errcode='22023';
      end if;
      perform public.ensure_seller_sale_shift_available(r.seller_employee_id,r.channel,r.store_id,v_start,v_end,null);
      insert into public.seller_sale_shifts(seller_employee_id,seller_user_id,channel,store_id,start_at,end_at,notes,created_by,recurrence_id,recurrence_date,metadata)
      values(r.seller_employee_id,r.user_id,r.channel,r.store_id,v_start,v_end,r.notes,r.created_by,r.id,v_day,
        jsonb_build_object('scheduled_by_management',true,'recurrence_id',r.id,'recurrence_date',v_day,
          'recurrence_label',case when cardinality(r.weekdays)=7 then 'Repeats daily' when r.weekdays=array[1,2,3,4,5] then 'Every weekday' else 'Repeats weekly' end,'commission_rate',0.05,
          'commission_basis','net_store_proceeds_after_shipping_tax_platform_fees_returns','payout_day','friday'));
      v_count:=v_count+1;
      delete from public.seller_show_recurrence_conflicts where recurrence_id=r.id and show_date=v_day;
    exception when unique_violation or invalid_parameter_value then
      if _strict then raise exception 'Cannot schedule %: %',to_char(v_day,'Mon DD, YYYY'),sqlerrm using errcode='22023';end if;
      insert into public.seller_show_recurrence_conflicts(recurrence_id,show_date,reason) values(r.id,v_day,sqlerrm)
        on conflict(recurrence_id,show_date) do update set reason=excluded.reason,checked_at=now();
      v_conflicts:=v_conflicts+1;
    end;
  end loop;
  return jsonb_build_object('created',v_count,'conflicts',v_conflicts);
end;
$$;

create or replace function public.materialize_seller_show_recurrences(_through date default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare r record;v_today date;v_result jsonb;v_count integer:=0;v_conflicts integer:=0;
begin
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));
  for r in select sr.id,coalesce(sr.schedule_timezone,nullif(sl.timezone,''),'America/New_York') as timezone
    from public.seller_show_recurrences sr join public.store_locations sl on sl.id=sr.store_id where sr.active
    order by sr.created_at,sr.id
  loop
    v_today:=(now() at time zone r.timezone)::date;
    v_result:=public.materialize_seller_show_pattern(r.id,v_today,least(coalesce(_through,v_today+90),v_today+180),false);
    v_count:=v_count+(v_result->>'created')::integer;
    v_conflicts:=v_conflicts+(v_result->>'conflicts')::integer;
  end loop;
  return jsonb_build_object('created',v_count,'conflicts',v_conflicts,'window_days',90);
end;
$$;

create or replace function public.admin_create_seller_show_recurrence(
  _request_id uuid,_seller_employee_id uuid,_channel text,_start_date date,
  _start_local time,_end_local time,_ends_next_day boolean,_weekdays integer[],_timezone text,
  _effective_to date default null,_notes text default null
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_rule public.seller_show_recurrences;v_store uuid;v_days integer[];v_result jsonb;v_count integer;v_existing uuid;
begin
  if not public.current_user_can_manage_sellers() then raise exception 'Only managers can create repeating shows' using errcode='42501';end if;
  if _request_id is null then raise exception 'A save request identifier is required' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtext('seller_schedule_capacity'));
  select array_agg(distinct d order by d) into v_days from unnest(_weekdays) d;
  if v_days is null or array_position(v_days,null) is not null or not(v_days<@array[0,1,2,3,4,5,6]) then
    raise exception 'Choose at least one valid repeat day' using errcode='22023';end if;
  if _timezone is null or not exists(select 1 from pg_timezone_names where name=_timezone) then
    raise exception 'Choose a valid schedule timezone' using errcode='22023';end if;
  if _start_date is null or _start_local is null or _end_local is null or _ends_next_day is null or
    _channel is null or _channel not in('ebay','whatnot','tiktok') then
    raise exception 'Choose a platform, date, and start/end time' using errcode='22023';end if;
  if not(extract(dow from _start_date)::integer=any(v_days)) then
    raise exception 'The start date must be one of the selected repeat days' using errcode='22023';end if;
  if _effective_to<_start_date then raise exception 'The repeat end date must be on or after the start date' using errcode='22023';end if;
  if extract(minute from _start_local) not in(0,30) or extract(second from _start_local)<>0
    or extract(minute from _end_local) not in(0,30) or extract(second from _end_local)<>0 then
    raise exception 'Use 30-minute intervals' using errcode='22023';end if;
  if (_end_local-_start_local+case when _ends_next_day then interval '1 day' else interval '0 days' end)
    not between interval '2 hours' and interval '24 hours' then
    raise exception 'Shows must run between 2 and 24 hours' using errcode='22023';end if;

  select * into v_rule from public.seller_show_recurrences where creation_request_id=_request_id;
  if found then
    if v_rule.created_by is distinct from auth.uid() or v_rule.seller_employee_id is distinct from _seller_employee_id
      or v_rule.channel<>_channel or v_rule.effective_from<>_start_date or v_rule.start_local<>_start_local
      or v_rule.end_local<>_end_local or v_rule.ends_next_day<>_ends_next_day or v_rule.weekdays<>v_days
      or v_rule.schedule_timezone<>_timezone or v_rule.effective_to is distinct from _effective_to
      or v_rule.notes is distinct from nullif(btrim(_notes),'') then
      raise exception 'This save request was already used for different show details. Please reopen the editor.' using errcode='22023';end if;
    select count(*) into v_count from public.seller_sale_shifts where recurrence_id=v_rule.id;
    return jsonb_build_object('status','scheduled','recurrence_id',v_rule.id,'created',v_count,'replayed',true);
  end if;
  if ((_start_date+_start_local) at time zone _timezone)<=now() then
    raise exception 'Repeating shows must start in the future' using errcode='22023';end if;
  if not exists(select 1 from public.employees where id=_seller_employee_id and active is distinct from false) then
    raise exception 'Choose an active seller' using errcode='22023';end if;
  select id into v_store from public.store_locations where lower(btrim(name))='airport store' and active order by created_at limit 1;
  if v_store is null then raise exception 'Airport Store is unavailable' using errcode='22023';end if;

  -- Include already-promised patterns even when booking beyond the rolling window.
  -- Adjacent dates cover overnight shows and differences between timezones.
  for v_existing in select id from public.seller_show_recurrences where active order by created_at,id loop
    perform public.materialize_seller_show_pattern(v_existing,_start_date-2,
      least(_start_date+90,coalesce(_effective_to,_start_date+90))+2,false);
  end loop;

  insert into public.seller_show_recurrences(seller_employee_id,channel,store_id,weekdays,start_local,end_local,
    ends_next_day,effective_from,effective_to,notes,schedule_timezone,creation_request_id)
  values(_seller_employee_id,_channel,v_store,v_days,_start_local,_end_local,_ends_next_day,_start_date,
    _effective_to,nullif(btrim(_notes),''),_timezone,_request_id) returning * into v_rule;
  -- Any conflict in the initial window rolls back the entire pattern and its shows.
  v_result:=public.materialize_seller_show_pattern(v_rule.id,_start_date,least(_start_date+90,coalesce(_effective_to,_start_date+90)),true);
  return jsonb_build_object('status','scheduled','recurrence_id',v_rule.id,'created',(v_result->>'created')::integer,'replayed',false);
end;
$$;
revoke all on function public.materialize_seller_show_pattern(uuid,date,date,boolean) from public,anon,authenticated;
grant execute on function public.materialize_seller_show_pattern(uuid,date,date,boolean) to service_role;
revoke all on function public.admin_create_seller_show_recurrence(uuid,uuid,text,date,time,time,boolean,integer[],text,date,text) from public,anon;
grant execute on function public.admin_create_seller_show_recurrence(uuid,uuid,text,date,time,time,boolean,integer[],text,date,text) to authenticated;
notify pgrst,'reload schema';
commit;
