begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Certificates belong to a stable order-line identity, not to its queue/status.
-- Corrections remain in the record; no certificate file is overwritten/deleted.
create table public.tiktok_order_line_certificates (
 id uuid primary key,
 order_line_id uuid not null references public.tiktok_order_lines(id) on delete restrict,
 provider text not null default 'CGL',
 qr_text text,
 certificate_url text,
 report_number text,
 watch_serial text,
 attachments jsonb not null check(jsonb_typeof(attachments)='array' and jsonb_array_length(attachments) between 1 and 6),
 created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id),
 created_by_email text,
 voided_at timestamptz,
 voided_by uuid references auth.users(id),
 void_reason text
);
create index tiktok_certificates_line_idx on public.tiktok_order_line_certificates(order_line_id,created_at desc);
alter table public.tiktok_order_line_certificates enable row level security;
create policy order_line_certificates_staff_read on public.tiktok_order_line_certificates for select to authenticated
 using(public.can_manage_inventory());
revoke all on public.tiktok_order_line_certificates from public,anon,authenticated;
grant select on public.tiktok_order_line_certificates to authenticated;

create function public.save_tiktok_line_certificate(_id uuid,_line_id uuid,_qr_text text default null,
 _url text default null,_report_number text default null,_watch_serial text default null,_attachments jsonb default '[]')
returns public.tiktok_order_line_certificates language plpgsql security definer set search_path='' as $$
declare
 result public.tiktok_order_line_certificates;
 file jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Not allowed to save certificates' using errcode='42501';
 end if;
 if _id is null or not exists(select 1 from public.tiktok_order_lines where id=_line_id) then
  raise exception 'Order item not found' using errcode='22023';
 end if;
 -- Retries must return the same saved certificate, never create a second one.
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 perform pg_advisory_xact_lock(hashtextextended(_id::text,0));
 select * into result from public.tiktok_order_line_certificates where id=_id;
 if found then
  if result.order_line_id<>_line_id or result.created_by<>auth.uid() then
   raise exception 'Certificate request belongs to another item or user' using errcode='42501';
  end if;
  return result;
 end if;
 if length(coalesce(_qr_text,''))>2048 or coalesce(_qr_text,'') ~ '[[:cntrl:]]'
  or length(coalesce(_url,''))>2048 or (_url is not null and _url !~ '^https://[^[:space:]/@]+[^[:space:]]*$')
  or length(coalesce(_report_number,''))>120 or length(coalesce(_watch_serial,''))>120 then
  raise exception 'Invalid certificate link or identifier' using errcode='22023';
 end if;
 if jsonb_typeof(_attachments) is distinct from 'array' or jsonb_array_length(_attachments) not between 1 and 6 then
  raise exception 'Save at least one PDF or photo copy of the certificate' using errcode='22023';
 end if;
 for file in select value from jsonb_array_elements(_attachments) loop
  if file->>'bucket' is distinct from 'tiktok-order-certificates'
   or left(coalesce(file->>'path',''),length('certificates/'||auth.uid()||'/'||_line_id||'/'||_id||'/')) <> 'certificates/'||auth.uid()||'/'||_line_id||'/'||_id||'/'
   or coalesce(file->>'mime_type','') not in ('application/pdf','image/jpeg','image/png','image/webp')
   or not exists(select 1 from storage.objects o where o.bucket_id='tiktok-order-certificates' and o.name=file->>'path'
    and file->>'path' ~ '/[a-f0-9]{64}\.(pdf|jpg|png|webp)$') then
   raise exception 'Certificate copy must be uploaded to this item by you' using errcode='22023';
  end if;
 end loop;
 insert into public.tiktok_order_line_certificates(id,order_line_id,qr_text,certificate_url,report_number,watch_serial,attachments,created_by,created_by_email)
 values(_id,_line_id,nullif(btrim(_qr_text),''),_url,nullif(btrim(_report_number),''),nullif(btrim(_watch_serial),''),_attachments,auth.uid(),
  auth.email()) returning * into result;
 return result;
end;
$$;

create function public.void_tiktok_line_certificate(_id uuid,_reason text)
returns public.tiktok_order_line_certificates language plpgsql security definer set search_path='' as $$
declare result public.tiktok_order_line_certificates;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Not allowed to correct certificates' using errcode='42501';
 end if;
 if nullif(btrim(_reason),'') is null or length(_reason)>1000 then raise exception 'Enter a correction reason'; end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into result from public.tiktok_order_line_certificates where id=_id for update;
 if not found then raise exception 'Certificate not found'; end if;
 if not coalesce(public.is_admin(),false) and result.created_by<>auth.uid() then raise exception 'Only its author or an admin may mark a certificate incorrect' using errcode='42501'; end if;
 if result.voided_at is not null then return result; end if;
 update public.tiktok_order_line_certificates set voided_at=now(),voided_by=auth.uid(),void_reason=btrim(_reason) where id=_id returning * into result;
 return result;
end;
$$;
revoke all on function public.save_tiktok_line_certificate(uuid,uuid,text,text,text,text,jsonb) from public,anon;
revoke all on function public.void_tiktok_line_certificate(uuid,text) from public,anon;
grant execute on function public.save_tiktok_line_certificate(uuid,uuid,text,text,text,text,jsonb) to authenticated;
grant execute on function public.void_tiktok_line_certificate(uuid,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('tiktok-order-certificates','tiktok-order-certificates',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp']);
create policy tiktok_certificate_read on storage.objects for select to authenticated
 using(bucket_id='tiktok-order-certificates' and public.can_manage_inventory());
create policy tiktok_certificate_upload on storage.objects for insert to authenticated
 with check(bucket_id='tiktok-order-certificates' and public.can_manage_inventory()
  and split_part(name,'/',1)='certificates' and split_part(name,'/',2)=auth.uid()::text
  and name ~ '^certificates/[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9]{64}\.(pdf|jpg|png|webp)$');

create table public.tiktok_line_work (
 line_id uuid primary key references public.tiktok_order_lines(id),
 item_search text check(item_search in('found','not_found')), is_watch boolean not null default false,
 watch_missing boolean not null default false, cgl_required boolean not null default false,
 certificate_id uuid references public.tiktok_order_line_certificates(id),
 revision integer not null default 0, updated_by uuid references auth.users(id), updated_at timestamptz not null default now(),
 check(not watch_missing or is_watch),check(cgl_required or certificate_id is null)
);
create table public.tiktok_order_cancellations (
 order_id uuid primary key references public.tiktok_orders(id), pending boolean not null,
 reason text not null, revision integer not null default 1,
 updated_by uuid not null references auth.users(id),updated_at timestamptz not null default now()
);
do $$declare t text;begin
 foreach t in array array['tiktok_line_work','tiktok_order_cancellations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy staff_read on public.%I for select to authenticated using(public.can_manage_inventory())',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end$$;

create function public.save_tiktok_line_work(_line_id uuid,_revision integer,_action text,_note text default '',_confirmed boolean default false,_certificate_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.tiktok_order_lines;o public.tiktok_orders;w public.tiktok_line_work;previous jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into l from public.tiktok_order_lines where id=_line_id;
 if not found then raise exception 'TikTok order line not found';end if;
 select * into o from public.tiktok_orders where id=l.order_id for update;
 if o.stage in('completed','dispatched') or o.marketplace_status not in('To ship','Shipped','Completed') then raise exception 'This order is closed; item controls are read-only';end if;
 insert into public.tiktok_line_work(line_id) values(l.id) on conflict do nothing;
 select * into w from public.tiktok_line_work where line_id=l.id for update;previous=to_jsonb(w);
 if w.revision is distinct from _revision then raise exception 'Item changed on another screen. Refresh and review it.';end if;
 if length(coalesce(_note,''))>1000 then raise exception 'Use a note of up to 1,000 characters';end if;
 case _action
 when 'found' then w.item_search='found';
 when 'not_found' then w.item_search='not_found';
 when 'watch' then w.is_watch=true;
 when 'unwatch' then
  if w.watch_missing or w.cgl_required then raise exception 'Clear the missing-watch and CGL requirements before removing Watch';end if;w.is_watch=false;
 when 'missing' then
  if not w.is_watch then raise exception 'Mark this item as a watch first';end if;w.watch_missing=true;
 when 'watch_found' then
  if _confirmed is distinct from true then raise exception 'Confirm you physically located and checked this watch';end if;w.watch_missing=false;w.item_search='found';
 when 'require_cgl' then
  if not w.is_watch then raise exception 'Mark this item as a watch first';end if;w.cgl_required=true;
 when 'remove_cgl' then
  if nullif(trim(_note),'') is null then raise exception 'Enter a correction reason to remove the CGL requirement';end if;w.cgl_required=false;w.certificate_id=null;
 when 'confirm_cgl' then
  if not w.cgl_required or _confirmed is distinct from true then raise exception 'Confirm the certificate belongs to this watch';end if;
  if not exists(select 1 from public.tiktok_order_line_certificates where id=_certificate_id and order_line_id=l.id and voided_at is null) then raise exception 'Choose a saved, valid certificate for this exact item';end if;
  w.certificate_id=_certificate_id;
 else raise exception 'Unknown TikTok item action';
 end case;
 update public.tiktok_line_work set item_search=w.item_search,is_watch=w.is_watch,watch_missing=w.watch_missing,cgl_required=w.cgl_required,certificate_id=w.certificate_id,
  revision=revision+1,updated_at=now(),updated_by=auth.uid() where line_id=l.id returning * into w;
 update public.tiktok_orders set revision=revision+1,updated_at=now() where id=o.id;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'item_'||_action,jsonb_build_object('line_id',l.id,'notes',trim(_note),'before',previous,'after',to_jsonb(w)));
 return to_jsonb(w);
end$$;

create function public.set_tiktok_cancellation(_order_id uuid,_revision integer,_pending boolean,_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.tiktok_orders;c public.tiktok_order_cancellations;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into o from public.tiktok_orders where id=_order_id for update;
 if not found or o.stage in('completed','dispatched') or o.marketplace_status<>'To ship' then raise exception 'Only open TikTok orders can change cancellation review';end if;
 if _pending is null or nullif(trim(_reason),'') is null or length(_reason)>1000 then raise exception 'Enter the cancellation or release reason (up to 1,000 characters)';end if;
 select * into c from public.tiktok_order_cancellations where order_id=o.id;
 if c.revision=_revision+1 and c.pending=_pending and c.reason=trim(_reason) then return to_jsonb(c);end if;
 if coalesce(c.revision,0) is distinct from _revision then raise exception 'Cancellation changed on another screen. Refresh and review it.';end if;
 insert into public.tiktok_order_cancellations(order_id,pending,reason,updated_by) values(o.id,_pending,trim(_reason),auth.uid())
 on conflict(order_id) do update set pending=excluded.pending,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now(),revision=tiktok_order_cancellations.revision+1 returning * into c;
 update public.tiktok_orders set revision=revision+1,updated_at=now() where id=o.id;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),case when _pending then 'pending_cancellation' else 'cancellation_released' end,jsonb_build_object('notes',trim(_reason),'marketplace_changed',false));
 return to_jsonb(c);
end$$;

-- Invalidating a confirmed copy reopens only that item's CGL requirement.
create function public.tiktok_certificate_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare oid uuid;
begin
 select order_id into oid from public.tiktok_order_lines where id=new.order_line_id;
 if tg_op='UPDATE' and old.voided_at is null and new.voided_at is not null then
  update public.tiktok_line_work set certificate_id=null,revision=revision+1,updated_at=now(),updated_by=auth.uid() where certificate_id=new.id;
  update public.tiktok_orders set revision=revision+1,updated_at=now() where id=oid;
 end if;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(oid,auth.uid(),case when tg_op='INSERT' then 'certificate_saved' else 'certificate_corrected' end,jsonb_build_object('line_id',new.order_line_id,'certificate_id',new.id,'notes',new.void_reason));return new;
end$$;
create trigger tiktok_certificate_audit after insert or update of voided_at on public.tiktok_order_line_certificates for each row execute function public.tiktok_certificate_audit();

-- Holds cover the current open buyer bundle, without changing any eBay records.
create function public.assert_tiktok_work_ready(_order_ids uuid[]) returns void language plpgsql security definer set search_path='' as $$
declare problem record;
begin
 select o.order_number,case when coalesce(c.pending,false) then 'pending cancellation' when w.watch_missing then 'watch missing' when w.item_search='not_found' then 'item not found' else 'pending CGL' end reason into problem
 from public.tiktok_orders o left join public.tiktok_order_cancellations c on c.order_id=o.id
 left join public.tiktok_order_lines l on l.order_id=o.id left join public.tiktok_line_work w on w.line_id=l.id
 where lower(o.buyer_username) in(select lower(buyer_username) from public.tiktok_orders where id=any(_order_ids))
 and o.stage not in('completed','dispatched') and o.marketplace_status in('To ship','Shipped','Completed')
 and (coalesce(c.pending,false) or w.watch_missing or w.item_search='not_found' or (w.cgl_required and not exists(select 1 from public.tiktok_order_line_certificates cert where cert.id=w.certificate_id and cert.order_line_id=l.id and cert.voided_at is null))) limit 1;
 if found then raise exception 'TikTok order % is waiting: %. Resolve it before completing this buyer.',problem.order_number,problem.reason;end if;
end$$;
alter function public.complete_tiktok_orders(uuid[],jsonb,boolean) rename to complete_tiktok_orders_inventory;
revoke all on function public.complete_tiktok_orders_inventory(uuid[],jsonb,boolean) from public,anon,authenticated;
create function public.complete_tiktok_orders(_order_ids uuid[],_revisions jsonb,_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 perform public.assert_tiktok_work_ready(array(select id from public.tiktok_orders where id=any(_order_ids) and stage<>'completed'));
 return public.complete_tiktok_orders_inventory(_order_ids,_revisions,_confirmed);
end$$;
create function public.guard_tiktok_work_stage() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.stage in('packed','completed','dispatched') and new.stage is distinct from old.stage and old.stage<>'completed' then perform public.assert_tiktok_work_ready(array[new.id]);end if;return new;
end$$;
create trigger tiktok_work_stage before update of stage on public.tiktok_orders for each row execute function public.guard_tiktok_work_stage();
revoke all on function public.save_tiktok_line_work(uuid,integer,text,text,boolean,uuid),public.set_tiktok_cancellation(uuid,integer,boolean,text),public.assert_tiktok_work_ready(uuid[]),public.tiktok_certificate_audit(),public.guard_tiktok_work_stage(),public.complete_tiktok_orders(uuid[],jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_tiktok_line_work(uuid,integer,text,text,boolean,uuid),public.set_tiktok_cancellation(uuid,integer,boolean,text),public.complete_tiktok_orders(uuid[],jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
