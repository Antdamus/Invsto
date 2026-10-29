begin;
set local lock_timeout='2s';
set local statement_timeout='20s';

-- A photo and an identification label are evidence/organization actions.
-- Payment state, holds, inventory claims and shipping clearance remain unchanged.
-- Existing canceled/released bags can retain evidence and be reprinted without
-- reopening them. Missing buyers and superseded auction identities still fail.
create or replace function public.prepare_ebay_live_bag_label(_attempt_id uuid)
returns public.live_sale_lots language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; l public.live_sale_lots; mail text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or nullif(trim(a.buyer),'') is null or a.merged_into is not null then
  raise exception 'Select the current auction record with its buyer' using errcode='22023';
 end if;
 if a.lot_id is not null then
  select * into l from public.live_sale_lots where id=a.lot_id;
  if not found then raise exception 'This bag is no longer available for printing' using errcode='22023';end if;
  return l;
 end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not found or c.review_completed_at is not null or a.closed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then
  raise exception 'This show is already closed' using errcode='22023';
 end if;
 select email into mail from auth.users where id=auth.uid();
 l:=public.create_live_sale_lot(c.session_id,'EB-'||coalesce(substring(a.listing_title from '^#([A-Za-z0-9_-]+)'),a.listing_id)||'-'||substr(replace(a.id::text,'-',''),1,8),'eBay '||a.listing_title||' | Winner '||a.buyer,mail,a.seller_id);
 update public.ebay_live_attempts set lot_id=l.id,updated_at=now() where id=a.id;
 insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,'bag_label_prepared',jsonb_build_object('lot_id',l.id,'lot_code',l.lot_code));
 return l;
end $$;

create or replace function public.enqueue_ebay_live_auto_label(_attempt_id uuid,_station_id uuid,_label_xml text,_printer_roll text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; l public.live_sale_lots; j public.label_print_jobs; result jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or nullif(trim(a.buyer),'') is null or a.merged_into is not null then
  raise exception 'Select the current auction record with its buyer' using errcode='22023';
 end if;
 select * into l from public.live_sale_lots where id=a.lot_id;
 if not found then raise exception 'Prepare this bag before printing' using errcode='22023'; end if;
 if position(l.lot_code in coalesce(_label_xml,''))=0 then raise exception 'The label does not identify this bag' using errcode='22023'; end if;
 select * into j from public.label_print_jobs where request_id=a.id or barcode=l.lot_code order by created_at limit 1;
 if not found then
  result:=public.enqueue_label_print(_station_id,a.id,_label_xml,1,a.listing_title,l.lot_code,null,_printer_roll);
  select * into j from public.label_print_jobs where id=(result->>'id')::uuid;
 end if;
 return jsonb_build_object('id',j.id,'status',j.status,'station_id',j.station_id,'station_name',(select name from public.print_stations where id=j.station_id));
end $$;

create or replace function public.attach_ebay_live_bag_photo(_attempt_id uuid,_photo_id uuid,_photo_path text,_width integer,_height integer,_captured_at timestamptz)
returns public.live_sale_bag_photos language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; p public.live_sale_bag_photos; added integer;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or nullif(trim(a.buyer),'') is null or a.merged_into is not null then
  raise exception 'Select the current auction record with its buyer' using errcode='22023';
 end if;
 if a.lot_id is null or not exists(select 1 from public.live_sale_lots where id=a.lot_id) then raise exception 'This bag is no longer available' using errcode='22023'; end if;
 if _photo_id is null or _photo_path is distinct from ('live-bags/'||a.lot_id::text||'/'||auth.uid()::text||'/'||_photo_id::text||'.jpg') then raise exception 'The photo does not belong to this bag' using errcode='22023'; end if;
 if _width is null or _height is null or _width not between 160 and 1600 or _height not between 160 and 1600 or _captured_at is null then raise exception 'Invalid photo dimensions or capture time' using errcode='22023'; end if;
 if not exists(select 1 from storage.objects where bucket_id='photos' and name=_photo_path and metadata->>'mimetype'='image/jpeg' and (metadata->>'size')::bigint between 1 and 3000000) then
  raise exception 'The photo upload is not complete. Retry this photo.' using errcode='22023';
 end if;
 insert into public.live_sale_bag_photos(id,lot_id,attempt_id,photo_path,width,height,captured_at,created_by)
 values(_photo_id,a.lot_id,a.id,_photo_path,_width,_height,_captured_at,auth.uid()) on conflict(id) do nothing;
 get diagnostics added=row_count;
 select * into p from public.live_sale_bag_photos where id=_photo_id;
 if p.lot_id<>a.lot_id or p.attempt_id<>a.id or p.created_by<>auth.uid() or p.photo_path<>_photo_path or p.width<>_width or p.height<>_height or p.captured_at<>_captured_at then raise exception 'This photo request belongs to a different capture' using errcode='22023'; end if;
 if added=1 then insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,'bag_photo_added',jsonb_build_object('photo_id',p.id,'lot_id',p.lot_id)); end if;
 return p;
end $$;

notify pgrst,'reload schema';
commit;
