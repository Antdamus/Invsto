begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

create table public.live_sale_bag_photos (
 id uuid primary key,
 lot_id uuid not null references public.live_sale_lots(id) on delete cascade,
 attempt_id uuid not null references public.ebay_live_attempts(id),
 photo_path text not null unique,
 width integer not null check(width between 160 and 1600),
 height integer not null check(height between 160 and 1600),
 captured_at timestamptz not null,
 created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id)
);
create index live_sale_bag_photos_lot on public.live_sale_bag_photos(lot_id,created_at);
alter table public.live_sale_bag_photos enable row level security;
revoke all on public.live_sale_bag_photos from public,anon,authenticated;
grant select on public.live_sale_bag_photos to authenticated;
create policy live_bag_photos_staff_read on public.live_sale_bag_photos for select to authenticated using(public.can_manage_inventory());

create function public.attach_ebay_live_bag_photo(_attempt_id uuid,_photo_id uuid,_photo_path text,_width integer,_height integer,_captured_at timestamptz)
returns public.live_sale_bag_photos language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; p public.live_sale_bag_photos; added integer;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or nullif(trim(a.buyer),'') is null or a.resolved_at is not null or a.merged_into is not null or public.ebay_live_has_payment_hold(a) then
  raise exception 'Payment is not confirmed for this bag' using errcode='22023';
 end if;
 if a.lot_id is null or not exists(select 1 from public.live_sale_lots where id=a.lot_id and status not in ('cancelled','released')) then raise exception 'This bag is no longer available' using errcode='22023'; end if;
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
revoke all on function public.attach_ebay_live_bag_photo(uuid,uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.attach_ebay_live_bag_photo(uuid,uuid,text,integer,integer,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
