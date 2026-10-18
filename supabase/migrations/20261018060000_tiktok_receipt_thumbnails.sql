-- Store browser-generated previews; viewing a receipt never invokes image transforms.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
alter table public.tiktok_order_receipt_photos
 add column thumbnail_path text unique,
 add column image_bytes integer check(image_bytes>0 and image_bytes<=5242880),
 add column thumbnail_bytes integer check(thumbnail_bytes>0 and thumbnail_bytes<=262144),
 add constraint tiktok_receipt_thumbnail_pair check((thumbnail_path is null)=(thumbnail_bytes is null));

alter policy tiktok_receipt_photo_upload on storage.objects
 with check(bucket_id='tiktok-receipt-photos' and public.can_manage_inventory()
  and name ~ ('^'||auth.uid()::text||'/[a-f0-9-]{36}(-thumb)?\.jpg$'));

-- Older captures can be optimized by any inventory staff member, in their own folder.
create function public.finish_tiktok_receipt_thumbnail(_photo_id uuid,_thumbnail_path text,_image_bytes integer,_thumbnail_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare photo public.tiktok_order_receipt_photos;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select * into photo from public.tiktok_order_receipt_photos where id=_photo_id for update;
 if not found then raise exception 'TikTok receipt photo not found';end if;
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
revoke all on function public.finish_tiktok_receipt_thumbnail(uuid,text,integer,integer) from public,anon;
grant execute on function public.finish_tiktok_receipt_thumbnail(uuid,text,integer,integer) to authenticated;

-- Keep the original RPC available to already-open OG tabs. New saves are atomic.
create function public.attach_tiktok_receipt_photo_v2(_order_number text,_sku_id text,_transfer_id uuid,_path text,_video_time numeric,_thumbnail_path text,_image_bytes integer,_thumbnail_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare photo jsonb;
begin
 photo:=public.attach_tiktok_receipt_photo(_order_number,_sku_id,_transfer_id,_path,_video_time);
 return public.finish_tiktok_receipt_thumbnail((photo->>'id')::uuid,_thumbnail_path,_image_bytes,_thumbnail_bytes);
end$$;
revoke all on function public.attach_tiktok_receipt_photo_v2(text,text,uuid,text,numeric,text,integer,integer) from public,anon;
grant execute on function public.attach_tiktok_receipt_photo_v2(text,text,uuid,text,numeric,text,integer,integer) to authenticated;
commit;
