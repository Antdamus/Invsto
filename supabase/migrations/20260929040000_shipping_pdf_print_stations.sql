-- Multi-printer helper 1.2: immutable saved shipping PDF requests on a separate 5XL destination.
begin;
alter table public.label_print_jobs
 add column document_type text not null default 'dymo' check(document_type in ('dymo','pdf')),
 add column pdf_base64 text,
 add column pdf_sha256 text,
 add column pdf_page_count integer,
 add column source_path text,
 add column source_pages integer[];
alter table public.label_print_jobs add constraint shipping_pdf_payload check(
 document_type='dymo' or (pdf_base64 is not null and octet_length(pdf_base64)<=13981016
 and pdf_sha256 ~ '^[a-f0-9]{64}$' and pdf_page_count between 1 and 100
 and copies*pdf_page_count<=100 and printer_roll='default' and label_xml=''
 and source_path is not null and cardinality(source_pages)=pdf_page_count));
create function public._print_helper_supports_pdf(_version text) returns boolean
language sql immutable set search_path = '' as $$
 select case when _version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
 then split_part(_version,'.',1)::integer>1 or (split_part(_version,'.',1)::integer=1 and split_part(_version,'.',2)::integer>=2)
 else false end;
$$;
revoke all on function public._print_helper_supports_pdf(text) from public,anon,authenticated;

create function public.enqueue_shipping_label_print(_station_id uuid,_request_id uuid,_pdf_base64 text,_copies integer,
 _source_path text,_source_pages integer[],_title text default '',_retry_of uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_station public.print_stations; v_job public.label_print_jobs; v_bytes bytea; v_hash text; v_pages integer;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 v_pages:=cardinality(_source_pages);
 if _request_id is null or _copies is null or _copies not between 1 and 100 or v_pages is null or v_pages not between 1 and 100 or v_pages*_copies>100
 or exists(select 1 from unnest(_source_pages) p where p is null or p not between 1 and 100)
 or (select count(distinct p) from unnest(_source_pages) p)<>v_pages then raise exception 'Choose valid pages and copies, up to 100 shipping labels per request'; end if;
 if _pdf_base64 is null or octet_length(_pdf_base64)>13981016 or _pdf_base64 !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'A shipping PDF under 10 MB is required'; end if;
 v_bytes:=decode(_pdf_base64,'base64');
 if octet_length(v_bytes)>10485760 or substring(v_bytes from 1 for 5)<>decode('255044462d','hex') then raise exception 'A valid shipping PDF is required'; end if;
 v_hash:=encode(extensions.digest(v_bytes,'sha256'),'hex');
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||_request_id::text,0));
 select * into v_job from public.label_print_jobs where requested_by=auth.uid() and request_id=_request_id;
 if found then
  if v_job.document_type<>'pdf' or v_job.station_id<>_station_id or v_job.pdf_sha256<>v_hash or v_job.copies<>_copies or v_job.source_path is distinct from _source_path or v_job.source_pages is distinct from _source_pages
  then raise exception 'This print request already has a different destination or content'; end if;
  return jsonb_build_object('id',v_job.id,'status',v_job.status,'station_id',v_job.station_id);
 end if;
 if not exists(select 1 from storage.objects where bucket_id='ebay-labels' and name=_source_path) then raise exception 'Attach the shipping PDF to this order before printing'; end if;
 select * into v_station from public.print_stations where id=_station_id and active and paired_at is not null for share;
 if not found or (coalesce(v_station.printer_name,'')||' '||coalesce(v_station.printer_model,'')) !~* '\m5XL\M' then raise exception 'Choose a paired DYMO 5XL shipping printer'; end if;
 if _retry_of is not null and not exists(select 1 from public.label_print_jobs where id=_retry_of and document_type='pdf' and status in ('submitted','failed','uncertain','cancelled') and station_id=_station_id and pdf_sha256=v_hash and copies=_copies) then raise exception 'The original job is still active or has different content'; end if;
 insert into public.label_print_jobs(station_id,requested_by,request_id,label_xml,copies,title,printer_name,retry_of,document_type,pdf_base64,pdf_sha256,pdf_page_count,source_path,source_pages)
 values(_station_id,auth.uid(),_request_id,'',_copies,left(coalesce(_title,'Shipping label'),240),v_station.printer_name,_retry_of,'pdf',_pdf_base64,v_hash,v_pages,_source_path,_source_pages) returning * into v_job;
 return jsonb_build_object('id',v_job.id,'status',v_job.status,'station_id',v_station.id,'station_name',v_station.name);
end $$;
revoke all on function public.enqueue_shipping_label_print(uuid,uuid,text,integer,text,integer[],text,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_shipping_label_print(uuid,uuid,text,integer,text,integer[],text,uuid) to authenticated;
create or replace function public.list_print_stations() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'paired',paired_at is not null,
 'computer_name',computer_name,'printer_name',printer_name,'printer_model',printer_model,'printer_connected',printer_connected,
 'last_seen_at',last_seen_at,'online',coalesce(last_seen_at>now()-interval '45 seconds',false),'last_error',last_error,'agent_version',agent_version,'default_roll',default_roll,'left_roll_label',left_roll_label,'right_roll_label',right_roll_label,
 'pdf_print_ready',public._print_helper_supports_pdf(agent_version) and (coalesce(printer_name,'')||' '||coalesce(printer_model,'')) ~* '\m5XL\M','roll_selection_ready',public._print_helper_supports_roll(agent_version)) order by name)
 from public.print_stations where active),'[]'::jsonb);
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
 if v_job.document_type='pdf' and not public._print_helper_supports_pdf(_version) then
  update public.print_stations set last_error='Update to Windows helper 1.2.0 to print shipping PDFs. This request will wait.' where id=_station_id;
  return null;
 end if;
 if v_job.printer_roll<>'default' and not public._print_helper_supports_roll(_version) then
  update public.print_stations set last_error='Update the Windows helper to select Left or Right. Your queued labels will wait.' where id=_station_id;
  return null;
 end if;
 update public.label_print_jobs set status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
 where id=v_job.id returning * into v_job;
 return jsonb_build_object('id',v_job.id,'claim_token',v_job.claim_token,'document_type',v_job.document_type,'pdf_base64',v_job.pdf_base64,'pdf_sha256',v_job.pdf_sha256,'pdf_page_count',v_job.pdf_page_count,'printer_model',(select printer_model from public.print_stations where id=_station_id),'label_xml',v_job.label_xml,'copies',v_job.copies,'printer_name',v_job.printer_name,'title',v_job.title,'printer_roll',v_job.printer_roll);
end $$;
create or replace function public.list_label_print_jobs(_station_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 update public.label_print_jobs set status='uncertain',detail='Computer stopped reporting. Check the printer before requesting another copy.',updated_at=now()
 where status='claimed' and lease_until<now();
 return coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at desc) from (
 select j.id,j.request_id,j.station_id,s.name as station_name,j.title,j.barcode,j.copies,j.submitted_copies,j.status,j.detail,j.created_at,j.printer_name,j.retry_of,j.printer_roll,j.document_type,j.pdf_page_count,j.source_pages
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
 if v_job.document_type='pdf' then
  return public.enqueue_shipping_label_print(v_job.station_id,_request_id,v_job.pdf_base64,v_job.copies,v_job.source_path,v_job.source_pages,v_job.title,v_job.id);
 end if;
 return public.enqueue_label_print(v_job.station_id,_request_id,v_job.label_xml,v_job.copies,v_job.title,v_job.barcode,v_job.id,v_job.printer_roll);
end $$;
notify pgrst, 'reload schema';
commit;
