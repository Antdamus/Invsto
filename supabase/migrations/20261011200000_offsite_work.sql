begin;

create or replace function public.offsite_is_admin() returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from employees where user_id=auth.uid() and active is true and role='admin');
$$;
create or replace function public.offsite_can_read(_employee uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and (public.offsite_is_admin() or exists(
 select 1 from employees where id=_employee and user_id=auth.uid() and active is true));
$$;

create table public.work_outings (
 id uuid primary key default gen_random_uuid(),
 employee_id uuid not null references public.employees(id),
 time_entry_id uuid not null references public.time_entries(id) on delete restrict,
 purpose text not null check(length(purpose) between 3 and 2000),
 destination text not null check(length(destination) between 2 and 300),
 started_at timestamptz not null default now(), expected_return_at timestamptz,
 ended_at timestamptz, end_kind text check(end_kind in ('returned','offsite_clockout','admin_resolved')),
 reviewed_at timestamptz, reviewed_by uuid, review_note text,
 created_by uuid not null default auth.uid(),
 check ((ended_at is null and end_kind is null) or (ended_at>=started_at and end_kind is not null))
);
create unique index work_outings_one_active on public.work_outings(employee_id) where ended_at is null;
create index work_outings_shift on public.work_outings(time_entry_id);
create index work_outings_recent on public.work_outings(started_at desc);
create table public.work_outing_events (
 id uuid primary key default gen_random_uuid(), outing_id uuid not null references public.work_outings(id) on delete restrict,
 request_id uuid not null unique, request_hash text not null,
 action text not null check(action in ('start','update','return','finish','break_start','break_end','review','resolve')),
 created_at timestamptz not null default now(), actor_user_id uuid not null, actor_name text not null,
 note text, lat numeric, lng numeric, accuracy_m numeric, store_verified boolean,
 photo_path text, attachments jsonb not null default '[]', details jsonb not null default '{}'
);
create index work_outing_events_timeline on public.work_outing_events(outing_id,created_at);
alter table public.work_outings enable row level security;
alter table public.work_outing_events enable row level security;
create policy work_outings_read on public.work_outings for select to authenticated using(public.offsite_can_read(employee_id));
create policy work_outing_events_read on public.work_outing_events for select to authenticated using(exists(
 select 1 from public.work_outings w where w.id=outing_id and public.offsite_can_read(w.employee_id)));
revoke all on public.work_outings,public.work_outing_events from anon,authenticated;
grant select on public.work_outings,public.work_outing_events to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('offsite-work-evidence','offsite-work-evidence',false,10485760,array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict(id) do nothing;
create policy offsite_files_read on storage.objects for select to authenticated using(
 bucket_id='offsite-work-evidence' and exists(select 1 from public.employees e
 where e.id::text=split_part(name,'/',1) and public.offsite_can_read(e.id)));
create policy offsite_files_insert on storage.objects for insert to authenticated with check(
 bucket_id='offsite-work-evidence' and exists(select 1 from public.employees e
 where e.id::text=split_part(name,'/',1) and e.user_id=auth.uid() and e.active is true));

-- Atomic, retry-safe transitions. Workers cannot backdate their punches or alter evidence.
create or replace function public.work_outing_action(_request_id uuid,_action text,_outing_id uuid default null,_data jsonb default '{}')
returns public.work_outings language plpgsql security definer set search_path=public as $$
declare
 v public.work_outings; t public.time_entries; e public.employees; b public.time_breaks;
 s public.store_locations; prior public.work_outing_events; f jsonb; obj record;
 h text:=md5(jsonb_build_array(_action,_outing_id,_data)::text);
 n text:=btrim(coalesce(_data->>'note','')); p text:=nullif(_data->>'photo_path','');
 lat numeric:=(_data->>'lat')::numeric; lng numeric:=(_data->>'lng')::numeric; acc numeric:=(_data->>'accuracy_m')::numeric;
 files jsonb:=coalesce(_data->'attachments','[]'); verified boolean:=false; dist numeric;
 end_at timestamptz; is_admin boolean:=public.offsite_is_admin(); meta jsonb:='{}';
begin
 if auth.uid() is null then raise exception 'Sign in to continue' using errcode='42501'; end if;
 if _request_id is null then raise exception 'Request ID required'; end if;
 select * into e from public.employees where user_id=auth.uid() and active is true limit 1;
 if e.id is null then raise exception 'Active employee required' using errcode='42501'; end if;
 -- Serialize retries even when the initial start request has not committed yet.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 7321));
 select * into prior from public.work_outing_events where request_id=_request_id;
 if prior.id is not null then
   if prior.actor_user_id<>auth.uid() or prior.request_hash<>h then raise exception 'Request ID already used for another action'; end if;
   select * into v from public.work_outings where id=prior.outing_id;
   if not public.offsite_can_read(v.employee_id) then raise exception 'Not allowed' using errcode='42501'; end if;
   return v;
 end if;
 if _action='start' then
   select * into t from public.time_entries where employee_id=e.id and clock_out is null for update;
   if t.id is null then raise exception 'Clock in before starting off-site work'; end if;
   if exists(select 1 from public.work_outings where employee_id=e.id and ended_at is null) then raise exception 'An outing is already active. Refresh to continue it.'; end if;
 else
   select * into v from public.work_outings where id=_outing_id;
   if v.id is null or not public.offsite_can_read(v.employee_id) then raise exception 'Outing not found or not allowed' using errcode='42501'; end if;
   if _action not in ('review','resolve') and v.employee_id<>e.id then raise exception 'Only the worker can record this action' using errcode='42501'; end if;
   select * into t from public.time_entries where id=v.time_entry_id for update;
   select * into v from public.work_outings where id=_outing_id for update;
 end if;
 if _action not in ('start','update','return','finish','break_start','break_end','review','resolve') then raise exception 'Unknown outing action'; end if;
 if _action not in ('return','finish','break_start','break_end') then p:=null; end if;
 if _action not in ('start','return','finish','break_start','break_end') then lat:=null;lng:=null;acc:=null; end if;
 if length(n)>4000 then raise exception 'Notes must be 4000 characters or fewer'; end if;
 if _action in ('start','return','finish','break_start','break_end','resolve') then
   perform public.assert_unlocked_for_range(t.clock_in,coalesce(t.clock_out,now()),'off-site work');
   if t.clock_out is not null then raise exception 'Shift has already ended'; end if;
   if _action<>'start' and v.ended_at is not null then raise exception 'Outing has already ended'; end if;
 end if;
 select * into b from public.time_breaks where time_entry_id=t.id and ended_at is null for update;
 if _action in ('start','return','finish','resolve') and b.id is not null then raise exception 'End the active break first'; end if;
 if _action in ('review','resolve') then
   if not is_admin then raise exception 'Administrator required' using errcode='42501'; end if;
   if length(n)<3 then raise exception 'Explain the admin decision'; end if;
 end if;
 if _action in ('start','return','finish','break_start','break_end') then
   if lat is null or lng is null or lat not between -90 and 90 or lng not between -180 and 180
     or acc is null or acc not between 0 and 150 then raise exception 'Fresh GPS required, accurate to 150 meters or better. Retry location.'; end if;
   select * into s from public.store_locations where id=t.store_id;
   dist:=public.haversine_meters(lat,lng,s.lat,s.lng);
   verified:=coalesce(s.active and dist<=s.radius_m,false);
   if _action='return' and not verified then raise exception 'Return photo must be taken at your shift store. Move inside the store and retry GPS, or ask an admin to resolve the outing.'; end if;
 end if;
 if _action in ('return','finish','break_start','break_end') then
   if p is null or split_part(p,'/',1)<>e.id::text or not exists(select 1 from storage.objects
     where bucket_id='timeclock-photos' and name=p and created_at>now()-interval '10 minutes')
     or exists(select 1 from public.work_outing_events where photo_path=p)
     then raise exception 'A new camera photo is required'; end if;
 end if;
 if jsonb_typeof(files)<>'array' or jsonb_array_length(files)>8 then raise exception 'Attach up to 8 files per update'; end if;
 for f in select * from jsonb_array_elements(files) loop
   select name,metadata into obj from storage.objects where bucket_id='offsite-work-evidence' and name=f->>'path';
   if obj.name is null or split_part(obj.name,'/',1)<>e.id::text then raise exception 'Evidence file not found or belongs to another worker'; end if;
   if length(coalesce(f->>'name',''))>200 then raise exception 'File name too long'; end if;
 end loop;
 if _action='start' then
   if length(btrim(coalesce(_data->>'purpose',''))) not between 3 and 2000 or length(btrim(coalesce(_data->>'destination',''))) not between 2 and 300 then raise exception 'Enter the assignment and destination'; end if;
   if nullif(_data->>'expected_return_at','')::timestamptz<=now() then raise exception 'Expected return must be in the future'; end if;
   insert into public.work_outings(employee_id,time_entry_id,purpose,destination,expected_return_at)
     values(e.id,t.id,btrim(_data->>'purpose'),btrim(_data->>'destination'),nullif(_data->>'expected_return_at','')::timestamptz) returning * into v;
 elsif _action='update' then
   if n='' and jsonb_array_length(files)=0 then raise exception 'Add a note or evidence'; end if;
 elsif _action in ('return','finish') then
   if _action='finish' and length(n)<3 then raise exception 'Add a short delivery or completion note'; end if;
   update public.work_outings set ended_at=now(),end_kind=case when _action='return' then 'returned' else 'offsite_clockout' end where id=v.id returning * into v;
   if _action='finish' then
     update public.time_entries set clock_out=now(),photo_out_path=p,clock_out_lat=lat,clock_out_lng=lng,
       clock_out_accuracy_m=acc,clock_out_distance_m=dist,geo_ok_out=verified,
       schedule_codes=array(select distinct x from unnest(coalesce(schedule_codes,'{}')||array['OFFSITE_CLOCK_OUT']) x),
       schedule_note=concat_ws(' ',schedule_note,'Shift finished during off-site work; GPS and evidence saved for admin review.') where id=t.id;
     delete from public.shift_approvals where time_entry_id=t.id;
     perform public.sync_shift_anomalies(t.id);
   end if;
 elsif _action='break_start' then
   if b.id is not null then raise exception 'Break already active'; end if;
   insert into public.time_breaks(time_entry_id,start_lat,start_lng,start_accuracy_m,geo_ok_start,photo_start_path,break_codes)
     values(t.id,lat,lng,acc,verified,p,array['OFFSITE_BREAK']) returning * into b;
   meta:=jsonb_build_object('break_id',b.id);
 elsif _action='break_end' then
   if b.id is null then raise exception 'No active break'; end if;
   update public.time_breaks set ended_at=now(),end_lat=lat,end_lng=lng,end_accuracy_m=acc,geo_ok_end=verified,photo_end_path=p where id=b.id;
   meta:=jsonb_build_object('break_id',b.id);
 elsif _action='review' then
   if v.ended_at is null then raise exception 'This outing is still active'; end if;
   if v.reviewed_at is not null then raise exception 'Already reviewed. Refresh to see the decision.'; end if;
   update public.work_outings set reviewed_at=now(),reviewed_by=auth.uid(),review_note=n where id=v.id returning * into v;
 elsif _action='resolve' then
   end_at:=(_data->>'ended_at')::timestamptz;
   if end_at is null or not isfinite(end_at) or end_at<v.started_at or end_at>now() then raise exception 'Resolution time must be between departure and now'; end if;
   if exists(select 1 from public.time_breaks where time_entry_id=t.id and (ended_at is null or ended_at>end_at)) then raise exception 'Resolution time cannot exclude recorded breaks'; end if;
   meta:=jsonb_build_object('original_outing',to_jsonb(v),'original_shift',to_jsonb(t),'resolved_end',end_at,'finish_shift',coalesce((_data->>'finish_shift')::boolean,false),'location_verified',false);
   update public.work_outings set ended_at=end_at,end_kind='admin_resolved' where id=v.id returning * into v;
   update public.time_entries set schedule_codes=array(select distinct x from unnest(coalesce(schedule_codes,'{}')||array['OFFSITE_ADMIN_RESOLVED']) x) where id=t.id;
   if coalesce((_data->>'finish_shift')::boolean,false) then
     update public.time_entries set clock_out=end_at,geo_ok_out=false,
       schedule_codes=array(select distinct x from unnest(coalesce(schedule_codes,'{}')||array['OFFSITE_CLOCK_OUT','OFFSITE_LOCATION_UNVERIFIED']) x) where id=t.id;
     perform public.sync_shift_anomalies(t.id);
   end if;
   delete from public.shift_approvals where time_entry_id=t.id;
 end if;
 insert into public.work_outing_events(outing_id,request_id,request_hash,action,actor_user_id,actor_name,note,lat,lng,accuracy_m,store_verified,photo_path,attachments,details)
 values(v.id,_request_id,h,_action,auth.uid(),coalesce(e.display_name,'Employee'),nullif(n,''),lat,lng,acc,
 case when _action in ('start','return','finish','break_start','break_end') then verified else null end,p,files,meta);
 if _action in ('finish','resolve') then
   perform public.refresh_monthly_hours_all(); perform public.refresh_payroll_period_hours();
 end if;
 return v;
end;
$$;
revoke all on function public.work_outing_action(uuid,text,uuid,jsonb) from public;
grant execute on function public.work_outing_action(uuid,text,uuid,jsonb) to authenticated;
revoke all on function public.offsite_is_admin(),public.offsite_can_read(uuid) from public;
grant execute on function public.offsite_is_admin(),public.offsite_can_read(uuid) to authenticated;

-- Old clients and admin time edits cannot strand an outing or erase its time boundaries.
create or replace function public.guard_shift_outings() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.clock_in is distinct from old.clock_in or new.clock_out is distinct from old.clock_out then
   if exists(select 1 from public.work_outings w where w.time_entry_id=new.id and
     (w.started_at<new.clock_in or (new.clock_out is not null and (w.ended_at is null or w.ended_at>new.clock_out)))) then
     raise exception 'Finish or resolve off-site work first. Shift times must include every recorded outing.';
   end if;
 end if;
 return new;
end; $$;
create trigger time_entries_guard_outings before update on public.time_entries for each row execute function public.guard_shift_outings();
create or replace function public.guard_outing_breaks() returns trigger language plpgsql security definer set search_path=public as $$
declare t public.time_entries;
begin
 select * into t from public.time_entries where id=new.time_entry_id for update;
 if exists(select 1 from public.work_outings where time_entry_id=t.id) and
   (new.started_at<t.clock_in or (t.clock_out is not null and (new.ended_at is null or new.ended_at>t.clock_out or new.started_at>t.clock_out))) then
   raise exception 'Break times must stay inside the shift. Refresh to see the current shift status.';
 end if;
 return new;
end; $$;
create trigger time_breaks_guard_outings before insert or update on public.time_breaks for each row execute function public.guard_outing_breaks();
notify pgrst,'reload schema';
commit;
