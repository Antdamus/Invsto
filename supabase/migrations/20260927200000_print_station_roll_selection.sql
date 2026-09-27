-- Pin every remote label to a specific Twin Turbo roll. Old workers must not ignore it.
begin;
alter table public.print_stations
 add column default_roll text check (default_roll in ('Left','Right')),
 add column left_roll_label text not null default '' check (length(left_roll_label)<=80),
 add column right_roll_label text not null default '' check (length(right_roll_label)<=80);
alter table public.label_print_jobs add column printer_roll text not null default 'default'
 check (printer_roll in ('default','Left','Right'));

create function public._print_helper_supports_roll(_version text) returns boolean
language sql immutable set search_path = '' as $$
 select case when _version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
 then split_part(_version,'.',1)::integer>1 or (split_part(_version,'.',1)::integer=1 and split_part(_version,'.',2)::integer>=1)
 else false end;
$$;
revoke all on function public._print_helper_supports_roll(text) from public,anon,authenticated;

create function public.configure_print_station_rolls(_station_id uuid,_default_roll text default null,_left_label text default '',_right_label text default '') returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_print_stations() then raise exception 'Administrator access required' using errcode='42501'; end if;
 if (_default_roll is not null and _default_roll not in ('Left','Right')) or length(coalesce(_left_label,''))>80 or length(coalesce(_right_label,''))>80 then raise exception 'Choose Left or Right and keep roll names under 81 characters'; end if;
 update public.print_stations set default_roll=_default_roll,left_roll_label=btrim(coalesce(_left_label,'')),right_roll_label=btrim(coalesce(_right_label,''))
 where id=_station_id and active and paired_at is not null and (coalesce(printer_model,'')||' '||coalesce(printer_name,'')) ~* 'twin\s*turbo';
 if not found then raise exception 'Select a paired Twin Turbo printer'; end if;
end $$;
revoke all on function public.configure_print_station_rolls(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.configure_print_station_rolls(uuid,text,text,text) to authenticated;

create or replace function public.list_print_stations() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'paired',paired_at is not null,
 'computer_name',computer_name,'printer_name',printer_name,'printer_model',printer_model,'printer_connected',printer_connected,
 'last_seen_at',last_seen_at,'online',coalesce(last_seen_at>now()-interval '45 seconds',false),'last_error',last_error,'agent_version',agent_version,'default_roll',default_roll,'left_roll_label',left_roll_label,'right_roll_label',right_roll_label,
 'roll_selection_ready',public._print_helper_supports_roll(agent_version)) order by name)
 from public.print_stations where active),'[]'::jsonb);
end $$;
drop function public.enqueue_label_print(uuid,uuid,text,integer,text,text,uuid);
create or replace function public.enqueue_label_print(_station_id uuid,_request_id uuid,_label_xml text,_copies integer,_title text default '',_barcode text default '',_retry_of uuid default null,_printer_roll text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_station public.print_stations; v_job public.label_print_jobs; v_roll text; v_twin boolean;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _request_id is null or _copies is null or _copies not between 1 and 100 then raise exception 'Choose between 1 and 100 copies'; end if;
 if _label_xml is null or octet_length(_label_xml)>2000000 or _label_xml !~ '<(DesktopLabel|DieCutLabel|ContinuousLabel)([ >])' or _label_xml ~* '<!(DOCTYPE|ENTITY)' then raise exception 'A valid DYMO label is required'; end if;
 -- Serialize retries with the same id, including concurrent requests from a slow mobile connection.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||_request_id::text,0));
 select * into v_job from public.label_print_jobs where requested_by=auth.uid() and request_id=_request_id;
 if found then
   if v_job.printer_roll<>coalesce(_printer_roll,v_job.printer_roll) or v_job.station_id<>_station_id or v_job.label_xml<>_label_xml or v_job.copies<>_copies then raise exception 'This print request already has a different destination or content'; end if;
   return jsonb_build_object('id',v_job.id,'status',v_job.status,'station_id',v_job.station_id);
 end if;
 select * into v_station from public.print_stations where id=_station_id and active and paired_at is not null for share;
 if not found then raise exception 'Select a paired print station'; end if;
 v_twin := (coalesce(v_station.printer_model,'')||' '||coalesce(v_station.printer_name,'')) ~* 'twin\s*turbo';
 v_roll := coalesce(_printer_roll,case when v_twin then v_station.default_roll else 'default' end);
 if v_roll is null or v_roll not in ('default','Left','Right') or (v_twin and v_roll='default' and not exists(select 1 from public.label_print_jobs where id=_retry_of and station_id=_station_id and label_xml=_label_xml and copies=_copies and printer_roll='default')) then raise exception 'Choose Left or Right for this Twin Turbo printer'; end if;
 if not v_twin and v_roll<>'default' then raise exception 'Left/right roll selection requires a Twin Turbo printer'; end if;
 if _retry_of is not null and not exists(select 1 from public.label_print_jobs where id=_retry_of and status in ('submitted','failed','uncertain','cancelled')) then raise exception 'The original job is still active'; end if;
 insert into public.label_print_jobs(station_id,requested_by,request_id,label_xml,copies,title,barcode,printer_name,retry_of,printer_roll)
 values(_station_id,auth.uid(),_request_id,_label_xml,_copies,left(coalesce(_title,''),240),left(coalesce(_barcode,''),160),v_station.printer_name,_retry_of,v_roll)
 returning * into v_job;
 return jsonb_build_object('id',v_job.id,'status',v_job.status,'station_id',v_station.id,'station_name',v_station.name);
end $$;
create or replace function public.poll_print_station(_station_id uuid,_token text,_connected boolean,_error text default '',_version text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_job public.label_print_jobs;
begin
 perform public._print_station_authorize(_station_id,_token);
 perform 1 from public.print_stations where id=_station_id for update;
 update public.print_stations set last_seen_at=now(),printer_connected=coalesce(_connected,false),last_error=left(coalesce(_error,''),500),agent_version=left(_version,40) where id=_station_id;
 update public.label_print_jobs set status='uncertain',detail='Computer stopped reporting. Check the printer before requesting another copy.',updated_at=now()
 where station_id=_station_id and status='claimed' and lease_until<now();
 if not coalesce(_connected,false) or exists(select 1 from public.label_print_jobs where station_id=_station_id and status='claimed') then return null; end if;
 select * into v_job from public.label_print_jobs where station_id=_station_id and status='queued' order by created_at,id limit 1 for update skip locked;
 if not found then return null; end if;
 if v_job.printer_roll<>'default' and not public._print_helper_supports_roll(_version) then
  update public.print_stations set last_error='Update the Windows helper to select Left or Right. Your queued labels will wait.' where id=_station_id;
  return null;
 end if;
 update public.label_print_jobs set status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
 where id=v_job.id returning * into v_job;
 return jsonb_build_object('id',v_job.id,'claim_token',v_job.claim_token,'label_xml',v_job.label_xml,'copies',v_job.copies,'printer_name',v_job.printer_name,'title',v_job.title,'printer_roll',v_job.printer_roll);
end $$;
create or replace function public.list_label_print_jobs(_station_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 update public.label_print_jobs set status='uncertain',detail='Computer stopped reporting. Check the printer before requesting another copy.',updated_at=now()
 where status='claimed' and lease_until<now();
 return coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at desc) from (
 select j.id,j.request_id,j.station_id,s.name as station_name,j.title,j.barcode,j.copies,j.submitted_copies,j.status,j.detail,j.created_at,j.printer_name,j.retry_of,j.printer_roll
 from public.label_print_jobs j join public.print_stations s on s.id=j.station_id
 where _station_id is null or j.station_id=_station_id order by j.created_at desc limit 100) j),'[]'::jsonb);
end $$;
create or replace function public.retry_label_print(_job_id uuid,_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_job public.label_print_jobs;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into v_job from public.label_print_jobs where id=_job_id and status in ('submitted','failed','uncertain','cancelled');
 if not found then raise exception 'Job is still active'; end if;
 return public.enqueue_label_print(v_job.station_id,_request_id,v_job.label_xml,v_job.copies,v_job.title,v_job.barcode,v_job.id,v_job.printer_roll);
end $$;
revoke all on function public.enqueue_label_print(uuid,uuid,text,integer,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.enqueue_label_print(uuid,uuid,text,integer,text,text,uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
