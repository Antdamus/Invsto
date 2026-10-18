-- Removal keeps a small tombstone so a delayed capture delivery cannot restore the photo.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
alter table public.tiktok_order_receipt_photos
 add column removed_at timestamptz,
 add column removed_by uuid references auth.users(id),
 add column files_deleted_at timestamptz,
 add constraint tiktok_receipt_removal_pair check((removed_at is null)=(removed_by is null)),
 add constraint tiktok_receipt_deleted_after_removal check(files_deleted_at is null or removed_at is not null);

create function public.remove_tiktok_receipt_photo(_photo_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare photo public.tiktok_order_receipt_photos; item public.tiktok_order_lines;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select * into photo from public.tiktok_order_receipt_photos where id=_photo_id for update;
 if not found then raise exception 'TikTok receipt photo not found';end if;
 if photo.removed_at is not null then return to_jsonb(photo);end if;
 update public.tiktok_order_receipt_photos set removed_at=now(),removed_by=auth.uid() where id=photo.id returning * into photo;
 select * into item from public.tiktok_order_lines where id=photo.line_id;
 insert into public.tiktok_order_events(order_id,actor,action,details)
  values(item.order_id,auth.uid(),'receipt_photo_removed',jsonb_build_object('line_id',item.id,'sku_id',item.sku_id,'photo_id',photo.id,'video_time',photo.video_time));
 return to_jsonb(photo);
end$$;
revoke all on function public.remove_tiktok_receipt_photo(uuid) from public,anon;
grant execute on function public.remove_tiktok_receipt_photo(uuid) to authenticated;

-- Delete actual objects through Storage's API, never by deleting storage metadata in SQL.
create policy tiktok_receipt_photo_delete on storage.objects for delete to authenticated
 using(bucket_id='tiktok-receipt-photos' and public.can_manage_inventory() and exists(
  select 1 from public.tiktok_order_receipt_photos p where p.removed_at is not null and (p.path=name or p.thumbnail_path=name)));
alter policy tiktok_receipt_photo_upload on storage.objects
 with check(bucket_id='tiktok-receipt-photos' and public.can_manage_inventory()
  and name ~ ('^'||auth.uid()::text||'/[a-f0-9-]{36}(-thumb)?\.jpg$')
  and not exists(select 1 from public.tiktok_order_receipt_photos p where p.removed_at is not null
   and (p.path=name or p.thumbnail_path=name or split_part(name,'/',2)=p.transfer_id::text||'-thumb.jpg')));

create function public.finish_tiktok_receipt_photo_removal(_photo_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare photo public.tiktok_order_receipt_photos;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select * into photo from public.tiktok_order_receipt_photos where id=_photo_id for update;
 if not found or photo.removed_at is null then raise exception 'Remove the TikTok receipt photo first';end if;
 if exists(select 1 from storage.objects where bucket_id='tiktok-receipt-photos' and name in(photo.path,photo.thumbnail_path))
 then raise exception 'Receipt image files still need deletion';end if;
 if photo.files_deleted_at is null then
  update public.tiktok_order_receipt_photos set files_deleted_at=now() where id=photo.id returning * into photo;
 end if;
 return to_jsonb(photo);
end$$;
revoke all on function public.finish_tiktok_receipt_photo_removal(uuid) from public,anon;
grant execute on function public.finish_tiktok_receipt_photo_removal(uuid) to authenticated;

create or replace function public.attach_tiktok_receipt_photo(_order_number text,_sku_id text,_transfer_id uuid,_path text,_video_time numeric)
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
  if photo.removed_at is not null then raise exception 'This capture was removed. Take a new capture in TikTok.';end if;
  return to_jsonb(photo);
 end if;
 if not exists(select 1 from storage.objects where bucket_id='tiktok-receipt-photos' and name=_path) then raise exception 'Upload the receipt photo first';end if;
 insert into public.tiktok_order_receipt_photos(line_id,transfer_id,path,video_time,created_by)
  values(item.id,_transfer_id,_path,_video_time,auth.uid()) returning * into photo;
 insert into public.tiktok_order_events(order_id,actor,action,details)
  values(item.order_id,auth.uid(),'receipt_photo_saved',jsonb_build_object('line_id',item.id,'sku_id',item.sku_id,'photo_id',photo.id,'video_time',_video_time));
 return to_jsonb(photo);
end$$;

create or replace function public.finish_tiktok_receipt_thumbnail(_photo_id uuid,_thumbnail_path text,_image_bytes integer,_thumbnail_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare photo public.tiktok_order_receipt_photos;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select * into photo from public.tiktok_order_receipt_photos where id=_photo_id for update;
 if not found then raise exception 'TikTok receipt photo not found';end if;
 if photo.removed_at is not null then raise exception 'This capture was removed. Take a new capture in TikTok.';end if;
 if _thumbnail_path is distinct from auth.uid()::text||'/'||photo.transfer_id::text||'-thumb.jpg'
  or _image_bytes is null or _image_bytes<1 or _image_bytes>5242880
  or _thumbnail_bytes is null or _thumbnail_bytes<1 or _thumbnail_bytes>262144
 then raise exception 'Invalid TikTok receipt thumbnail';end if;
 if photo.thumbnail_path is not null then return to_jsonb(photo);end if;
 if not exists(select 1 from storage.objects where bucket_id='tiktok-receipt-photos' and name=_thumbnail_path)
 then raise exception 'Upload the receipt thumbnail first';end if;
 update public.tiktok_order_receipt_photos set thumbnail_path=_thumbnail_path,image_bytes=_image_bytes,thumbnail_bytes=_thumbnail_bytes
  where id=photo.id returning * into photo;
 return to_jsonb(photo);
end$$;
commit;
