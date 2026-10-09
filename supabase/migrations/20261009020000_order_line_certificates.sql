begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Certificates belong to a stable order-line identity, not to its queue/status.
-- Corrections remain in the record; no certificate file is overwritten/deleted.
create table public.ebay_order_line_certificates (
 id uuid primary key,
 order_line_id uuid not null references public.ebay_order_lines(id) on delete restrict,
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
create index order_line_certificates_line_idx on public.ebay_order_line_certificates(order_line_id,created_at desc);
alter table public.ebay_order_line_certificates enable row level security;
create policy order_line_certificates_staff_read on public.ebay_order_line_certificates for select to authenticated
 using(public.can_manage_inventory() or public.can_access_post_order_issues());
revoke all on public.ebay_order_line_certificates from public,anon,authenticated;
grant select on public.ebay_order_line_certificates to authenticated;

create function public.save_order_line_certificate(_id uuid,_line_id uuid,_qr_text text default null,
 _url text default null,_report_number text default null,_watch_serial text default null,_attachments jsonb default '[]')
returns public.ebay_order_line_certificates language plpgsql security definer set search_path='' as $$
declare
 result public.ebay_order_line_certificates;
 file jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory() or public.can_access_post_order_issues(),false) then
  raise exception 'Not allowed to save certificates' using errcode='42501';
 end if;
 if _id is null or not exists(select 1 from public.ebay_order_lines where id=_line_id) then
  raise exception 'Order item not found' using errcode='22023';
 end if;
 -- Retries must return the same saved certificate, never create a second one.
 perform pg_advisory_xact_lock(hashtextextended(_id::text,0));
 select * into result from public.ebay_order_line_certificates where id=_id;
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
  if file->>'bucket' is distinct from 'order-evidence-photos'
   or left(coalesce(file->>'path',''),length('certificates/'||_line_id||'/'||_id||'/')) <> 'certificates/'||_line_id||'/'||_id||'/'
   or coalesce(file->>'mime_type','') not in ('application/pdf','image/jpeg','image/png','image/webp')
   or not exists(select 1 from storage.objects o where o.bucket_id='order-evidence-photos' and o.name=file->>'path'
    and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) then
   raise exception 'Certificate copy must be uploaded to this item by you' using errcode='22023';
  end if;
 end loop;
 insert into public.ebay_order_line_certificates(id,order_line_id,qr_text,certificate_url,report_number,watch_serial,attachments,created_by,created_by_email)
 values(_id,_line_id,nullif(btrim(_qr_text),''),_url,nullif(btrim(_report_number),''),nullif(btrim(_watch_serial),''),_attachments,auth.uid(),
  (select email from auth.users where id=auth.uid())) returning * into result;
 return result;
end;
$$;

create function public.void_order_line_certificate(_id uuid,_reason text)
returns public.ebay_order_line_certificates language plpgsql security definer set search_path='' as $$
declare result public.ebay_order_line_certificates;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory() or public.can_access_post_order_issues(),false) then
  raise exception 'Not allowed to correct certificates' using errcode='42501';
 end if;
 if nullif(btrim(_reason),'') is null or length(_reason)>1000 then raise exception 'Enter a correction reason'; end if;
 select * into result from public.ebay_order_line_certificates where id=_id for update;
 if not found then raise exception 'Certificate not found'; end if;
 if not coalesce(public.is_admin(),false) and result.created_by<>auth.uid() then raise exception 'Only its author or an admin may mark a certificate incorrect' using errcode='42501'; end if;
 if result.voided_at is not null then return result; end if;
 update public.ebay_order_line_certificates set voided_at=now(),voided_by=auth.uid(),void_reason=btrim(_reason) where id=_id returning * into result;
 return result;
end;
$$;
revoke all on function public.save_order_line_certificate(uuid,uuid,text,text,text,text,jsonb) from public,anon;
revoke all on function public.void_order_line_certificate(uuid,text) from public,anon;
grant execute on function public.save_order_line_certificate(uuid,uuid,text,text,text,text,jsonb) to authenticated;
grant execute on function public.void_order_line_certificate(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
