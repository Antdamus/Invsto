-- Named, paired print stations. Clients use RPCs; station credentials and label XML are never table-readable.
begin;
create table public.print_stations (
 id uuid primary key default gen_random_uuid(), name text not null check (length(name) between 1 and 80),
 created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(),
 active boolean not null default true, token_hash text, paired_at timestamptz, last_seen_at timestamptz,
 computer_name text, printer_name text, printer_model text, printer_connected boolean not null default false,
 agent_version text, last_error text
);
create unique index print_stations_active_name on public.print_stations(lower(name)) where active;
create table public.print_station_pairings (
 code_hash text primary key, station_id uuid not null references public.print_stations(id),
 expires_at timestamptz not null default now() + interval '15 minutes', used_at timestamptz
);
create table public.label_print_jobs (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.print_stations(id),
 requested_by uuid references auth.users(id) on delete set null, request_id uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 title text not null default '', barcode text not null default '', label_xml text not null,
 printer_name text not null, copies integer not null check (copies between 1 and 100),
 status text not null default 'queued' check (status in ('queued','claimed','submitted','failed','uncertain','cancelled')),
 submitted_copies integer not null default 0 check (submitted_copies between 0 and copies),
 claim_token uuid, lease_until timestamptz, detail text, retry_of uuid references public.label_print_jobs(id),
 unique (requested_by, request_id)
);
create index label_print_jobs_queue on public.label_print_jobs(station_id,created_at,id) where status='queued';
create index label_print_jobs_recent on public.label_print_jobs(created_at desc);
create unique index label_print_jobs_one_claim on public.label_print_jobs(station_id) where status='claimed';
alter table public.print_stations enable row level security;
alter table public.print_station_pairings enable row level security;
alter table public.label_print_jobs enable row level security;
revoke all on public.print_stations, public.print_station_pairings, public.label_print_jobs from anon, authenticated;

create function public.can_manage_print_stations() returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.employees where user_id=auth.uid() and role='admin' and active is distinct from false);
$$;
revoke all on function public.can_manage_print_stations() from public,anon,authenticated;
grant execute on function public.can_manage_print_stations() to authenticated;

create function public._print_station_authorize(_station_id uuid, _token text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 perform 1 from public.print_stations where id=_station_id and active and length(_token)=64
 and token_hash=encode(extensions.digest(_token,'sha256'),'hex') for update;
 if not found then raise exception 'Print station is not paired or has been disconnected' using errcode='42501'; end if;
end $$;
revoke all on function public._print_station_authorize(uuid,text) from public,anon,authenticated;

create function public.register_print_station(_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_station uuid; v_code text := upper(encode(extensions.gen_random_bytes(8),'hex'));
begin
 if not public.can_manage_print_stations() then raise exception 'An administrator must pair a print station' using errcode='42501'; end if;
 if length(btrim(coalesce(_name,''))) not between 1 and 80 then raise exception 'Enter a station name (1–80 characters)'; end if;
 insert into public.print_stations(name,created_by) values(btrim(_name),auth.uid()) returning id into v_station;
 insert into public.print_station_pairings(code_hash,station_id) values(encode(extensions.digest(v_code,'sha256'),'hex'),v_station);
 return jsonb_build_object('station_id',v_station,'code',v_code,'expires_at',now()+interval '15 minutes');
end $$;

create function public.renew_print_station_pairing(_station_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(encode(extensions.gen_random_bytes(8),'hex'));
begin
 if not public.can_manage_print_stations() then raise exception 'Administrator access required' using errcode='42501'; end if;
 perform 1 from public.print_stations where id=_station_id and active and token_hash is null for update;
 if not found then raise exception 'Station is already paired or disconnected'; end if;
 delete from public.print_station_pairings where station_id=_station_id;
 insert into public.print_station_pairings(code_hash,station_id) values(encode(extensions.digest(v_code,'sha256'),'hex'),_station_id);
 return jsonb_build_object('station_id',_station_id,'code',v_code,'expires_at',now()+interval '15 minutes');
end $$;

create function public.pair_print_station(_code text,_token text,_computer text,_printer text,_model text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pair public.print_station_pairings; v_station public.print_stations; v_hash text;
begin
 if _token is null or _token !~ '^[a-f0-9]{64}$' or length(btrim(coalesce(_printer,''))) not between 1 and 200 then raise exception 'Invalid station setup'; end if;
 select * into v_pair from public.print_station_pairings
 where code_hash=encode(extensions.digest(upper(regexp_replace(coalesce(_code,''),'[^a-zA-Z0-9]','','g')),'sha256'),'hex')
 and expires_at>now();
 if not found then raise exception 'Pairing code is invalid or expired' using errcode='42501'; end if;
 select * into v_station from public.print_stations where id=v_pair.station_id and active for update;
 if not found then raise exception 'Station was disconnected' using errcode='42501'; end if;
 select * into v_pair from public.print_station_pairings where code_hash=v_pair.code_hash and expires_at>now() for update;
 if not found then raise exception 'Pairing code is invalid or expired' using errcode='42501'; end if;
 v_hash := encode(extensions.digest(_token,'sha256'),'hex');
 if v_pair.used_at is not null and v_station.token_hash is distinct from v_hash then raise exception 'Pairing code already used' using errcode='42501'; end if;
 update public.print_stations set token_hash=v_hash,paired_at=coalesce(paired_at,now()),computer_name=left(_computer,120),printer_name=btrim(_printer),printer_model=left(_model,120) where id=v_station.id;
 update public.print_station_pairings set used_at=now() where code_hash=v_pair.code_hash;
 return jsonb_build_object('station_id',v_station.id,'name',v_station.name,'printer_name',btrim(_printer));
end $$;

create function public.list_print_stations() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'paired',paired_at is not null,
 'computer_name',computer_name,'printer_name',printer_name,'printer_model',printer_model,'printer_connected',printer_connected,
 'last_seen_at',last_seen_at,'online',coalesce(last_seen_at>now()-interval '45 seconds',false),'last_error',last_error,'agent_version',agent_version) order by name)
 from public.print_stations where active),'[]'::jsonb);
end $$;

create function public.enqueue_label_print(_station_id uuid,_request_id uuid,_label_xml text,_copies integer,_title text default '',_barcode text default '',_retry_of uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_station public.print_stations; v_job public.label_print_jobs;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _request_id is null or _copies is null or _copies not between 1 and 100 then raise exception 'Choose between 1 and 100 copies'; end if;
 if _label_xml is null or octet_length(_label_xml)>2000000 or _label_xml !~ '<(DesktopLabel|DieCutLabel|ContinuousLabel)([ >])' or _label_xml ~* '<!(DOCTYPE|ENTITY)' then raise exception 'A valid DYMO label is required'; end if;
 -- Serialize retries with the same id, including concurrent requests from a slow mobile connection.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||_request_id::text,0));
 select * into v_job from public.label_print_jobs where requested_by=auth.uid() and request_id=_request_id;
 if found then
   if v_job.station_id<>_station_id or v_job.label_xml<>_label_xml or v_job.copies<>_copies then raise exception 'This print request already has a different destination or content'; end if;
   return jsonb_build_object('id',v_job.id,'status',v_job.status,'station_id',v_job.station_id);
 end if;
 select * into v_station from public.print_stations where id=_station_id and active and paired_at is not null for share;
 if not found then raise exception 'Select a paired print station'; end if;
 if _retry_of is not null and not exists(select 1 from public.label_print_jobs where id=_retry_of and status in ('submitted','failed','uncertain','cancelled')) then raise exception 'The original job is still active'; end if;
 insert into public.label_print_jobs(station_id,requested_by,request_id,label_xml,copies,title,barcode,printer_name,retry_of)
 values(_station_id,auth.uid(),_request_id,_label_xml,_copies,left(coalesce(_title,''),240),left(coalesce(_barcode,''),160),v_station.printer_name,_retry_of)
 returning * into v_job;
 return jsonb_build_object('id',v_job.id,'status',v_job.status,'station_id',v_station.id,'station_name',v_station.name);
end $$;

create function public.poll_print_station(_station_id uuid,_token text,_connected boolean,_error text default '',_version text default '') returns jsonb
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
 update public.label_print_jobs set status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
 where id=v_job.id returning * into v_job;
 return jsonb_build_object('id',v_job.id,'claim_token',v_job.claim_token,'label_xml',v_job.label_xml,'copies',v_job.copies,'printer_name',v_job.printer_name,'title',v_job.title);
end $$;

create function public.report_label_print(_station_id uuid,_token text,_job_id uuid,_claim_token uuid,_status text,_submitted integer,_detail text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_job public.label_print_jobs;
begin
 perform public._print_station_authorize(_station_id,_token);
 select * into v_job from public.label_print_jobs where id=_job_id and station_id=_station_id and claim_token=_claim_token for update;
 if not found then raise exception 'Print claim does not belong to this station' using errcode='42501'; end if;
 if _status not in ('claimed','submitted','failed','uncertain') or _submitted is null or _submitted not between v_job.submitted_copies and v_job.copies then raise exception 'Invalid print result'; end if;
 if _status='submitted' and _submitted<>v_job.copies then raise exception 'Not all copies were submitted'; end if;
 if v_job.status in ('submitted','failed','cancelled') then return jsonb_build_object('status',v_job.status); end if;
 if _status='claimed' and (v_job.status<>'claimed' or v_job.lease_until<now()) then raise exception 'Print claim expired. Check the printer before retrying'; end if;
 update public.label_print_jobs set status=_status,submitted_copies=_submitted,detail=left(coalesce(_detail,''),1000),updated_at=now(),
 lease_until=case when _status='claimed' then now()+interval '90 seconds' else null end where id=v_job.id;
 update public.print_stations set last_seen_at=now() where id=_station_id;
 return jsonb_build_object('status',_status);
end $$;

create function public.list_label_print_jobs(_station_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 update public.label_print_jobs set status='uncertain',detail='Computer stopped reporting. Check the printer before requesting another copy.',updated_at=now()
 where status='claimed' and lease_until<now();
 return coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at desc) from (
 select j.id,j.request_id,j.station_id,s.name as station_name,j.title,j.barcode,j.copies,j.submitted_copies,j.status,j.detail,j.created_at,j.printer_name,j.retry_of
 from public.label_print_jobs j join public.print_stations s on s.id=j.station_id
 where _station_id is null or j.station_id=_station_id order by j.created_at desc limit 100) j),'[]'::jsonb);
end $$;

create function public.cancel_label_print(_job_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 update public.label_print_jobs set status='cancelled',updated_at=now(),detail='Cancelled before sending to the printer.' where id=_job_id and status='queued';
 if not found then raise exception 'This job has already been picked up. It cannot be cancelled safely.'; end if;
end $$;

create function public.retry_label_print(_job_id uuid,_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_job public.label_print_jobs;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into v_job from public.label_print_jobs where id=_job_id and status in ('submitted','failed','uncertain','cancelled');
 if not found then raise exception 'Job is still active'; end if;
 return public.enqueue_label_print(v_job.station_id,_request_id,v_job.label_xml,v_job.copies,v_job.title,v_job.barcode,v_job.id);
end $$;

create function public.disconnect_print_station(_station_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_print_stations() then raise exception 'Administrator access required' using errcode='42501'; end if;
 perform 1 from public.print_stations where id=_station_id for update;
 update public.print_stations set active=false,token_hash=null,printer_connected=false where id=_station_id;
 delete from public.print_station_pairings where station_id=_station_id;
 update public.label_print_jobs set status=case when status='queued' then 'cancelled' else 'uncertain' end,updated_at=now(),detail='Print station disconnected. Check any label already sent to the printer.'
 where station_id=_station_id and status in ('queued','claimed');
end $$;

revoke all on function public.register_print_station(text),public.renew_print_station_pairing(uuid),public.pair_print_station(text,text,text,text,text),public.list_print_stations(),public.enqueue_label_print(uuid,uuid,text,integer,text,text,uuid),public.poll_print_station(uuid,text,boolean,text,text),public.report_label_print(uuid,text,uuid,uuid,text,integer,text),public.list_label_print_jobs(uuid),public.cancel_label_print(uuid),public.retry_label_print(uuid,uuid),public.disconnect_print_station(uuid) from public,anon,authenticated;
grant execute on function public.register_print_station(text),public.renew_print_station_pairing(uuid),public.list_print_stations(),public.enqueue_label_print(uuid,uuid,text,integer,text,text,uuid),public.list_label_print_jobs(uuid),public.cancel_label_print(uuid),public.retry_label_print(uuid,uuid),public.disconnect_print_station(uuid) to authenticated;
grant execute on function public.pair_print_station(text,text,text,text,text),public.poll_print_station(uuid,text,boolean,text,text),public.report_label_print(uuid,text,uuid,uuid,text,integer,text) to anon,authenticated;
commit;
