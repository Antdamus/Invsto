-- Receipt stills belong to a stable TikTok order line. eBay is unchanged.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
create table public.tiktok_order_receipt_photos (
 id uuid primary key default gen_random_uuid(),
 line_id uuid not null references public.tiktok_order_lines(id),
 transfer_id uuid not null unique,
 path text not null unique,
 video_time numeric not null check(video_time>=0 and video_time<=604800),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
create index tiktok_receipt_photos_line on public.tiktok_order_receipt_photos(line_id,created_at desc);
alter table public.tiktok_order_receipt_photos enable row level security;
create policy staff_read on public.tiktok_order_receipt_photos for select to authenticated using(public.can_manage_inventory());
revoke all on public.tiktok_order_receipt_photos from anon,authenticated;
grant select on public.tiktok_order_receipt_photos to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('tiktok-receipt-photos','tiktok-receipt-photos',false,5242880,array['image/jpeg']);
create policy tiktok_receipt_photo_read on storage.objects for select to authenticated
 using(bucket_id='tiktok-receipt-photos' and public.can_manage_inventory());
create policy tiktok_receipt_photo_upload on storage.objects for insert to authenticated
 with check(bucket_id='tiktok-receipt-photos' and public.can_manage_inventory()
  and name ~ ('^'||auth.uid()::text||'/[a-f0-9-]{36}\.jpg$'));

create function public.attach_tiktok_receipt_photo(_order_number text,_sku_id text,_transfer_id uuid,_path text,_video_time numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.tiktok_order_lines; photo public.tiktok_order_receipt_photos;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _transfer_id is null or _path is distinct from auth.uid()::text||'/'||_transfer_id::text||'.jpg'
  or _video_time is null or _video_time<0 or _video_time>604800 or _video_time='NaN'::numeric
 then raise exception 'Invalid TikTok receipt capture';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select l.* into item from public.tiktok_order_lines l join public.tiktok_orders o on o.id=l.order_id
  where o.order_number=_order_number and l.sku_id=_sku_id;
 if not found then raise exception 'Matching TikTok order and SKU not found. Import the order before saving its capture.';end if;
 select * into photo from public.tiktok_order_receipt_photos where transfer_id=_transfer_id;
 if found then
  if photo.line_id<>item.id or photo.path<>_path then raise exception 'This capture is already attached to another item';end if;
  return to_jsonb(photo);
 end if;
 if not exists(select 1 from storage.objects where bucket_id='tiktok-receipt-photos' and name=_path) then raise exception 'Upload the receipt photo first';end if;
 insert into public.tiktok_order_receipt_photos(line_id,transfer_id,path,video_time,created_by)
  values(item.id,_transfer_id,_path,_video_time,auth.uid()) returning * into photo;
 insert into public.tiktok_order_events(order_id,actor,action,details)
  values(item.order_id,auth.uid(),'receipt_photo_saved',jsonb_build_object('line_id',item.id,'sku_id',item.sku_id,'photo_id',photo.id,'video_time',_video_time));
 return to_jsonb(photo);
end$$;
revoke all on function public.attach_tiktok_receipt_photo(text,text,uuid,text,numeric) from public,anon;
grant execute on function public.attach_tiktok_receipt_photo(text,text,uuid,text,numeric) to authenticated;
commit;
