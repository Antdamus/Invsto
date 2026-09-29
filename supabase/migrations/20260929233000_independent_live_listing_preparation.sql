begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

-- Listing preparation is independent of sales capture and post-show review.
-- Keep the destination event ID, without creating or reopening a sales session.
alter table public.ebay_live_listing_requests
 drop constraint ebay_live_listing_requests_event_id_fkey;
alter table public.ebay_live_listing_requests
 add constraint ebay_live_listing_requests_event_id_check
 check(event_id ~ '^[A-Za-z0-9_-]{6,100}$');

create or replace function public.queue_live_listing(_id uuid,_event_id text,_barcode text,_starting_bid numeric,_duration integer,_existing_listing_checked boolean default false)
returns public.ebay_live_listing_requests language plpgsql security definer set search_path='' as $$
declare item jsonb; saved public.ebay_live_listing_requests; photo_count integer;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _id is null or _starting_bid is null or _starting_bid<=0 or _starting_bid>=1000000 or round(_starting_bid,2)<>_starting_bid or _duration is null or _duration not in (15,30,45,60,90,120) then raise exception 'Enter a starting bid and auction duration';end if;
 if _event_id is null or _event_id !~ '^[A-Za-z0-9_-]{6,100}$' then raise exception 'Enter a valid eBay Stream Manager event URL' using errcode='22023';end if;
 -- Serialize queue/claim operations by destination event, even without a sales session.
 perform pg_advisory_xact_lock(hashtextextended('live_listing:'||_event_id,0));
 item:=public.lookup_live_listing_item(_barcode);
 select * into saved from public.ebay_live_listing_requests where event_id=_event_id and item_id=(item->>'id')::uuid;
 if found then return saved;end if;
 if (item->>'available')::bigint<1 then raise exception 'This item has no available good stock';end if;
 if nullif(btrim(item->>'title'),'') is null or nullif(btrim(item->>'description'),'') is null then raise exception 'Add the item title and description on Stock first';end if;
 select count(distinct p) into photo_count from (select jsonb_array_elements_text(case when jsonb_typeof(item->'photos')='array' then item->'photos' else '[]'::jsonb end) p union select item->>'photo_url') x where nullif(btrim(p),'') is not null;
 if photo_count not between 1 and 25 then raise exception 'This item needs 1–25 stock photos';end if;
 if coalesce(item->>'existing_listing_id','')<>'' and not coalesce(_existing_listing_checked,false) then raise exception 'Check the existing eBay listing quantity before preparing another auction';end if;
 insert into public.ebay_live_listing_requests(id,event_id,item_id,snapshot,starting_bid,duration_seconds)
 values(_id,_event_id,(item->>'id')::uuid,item,_starting_bid,_duration) returning * into saved;
 return saved;
end $$;

create or replace function public.claim_live_listing(_event_id text,_worker_token uuid) returns public.ebay_live_listing_requests
language plpgsql security definer set search_path='' as $$
declare saved public.ebay_live_listing_requests;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _worker_token is null then raise exception 'Missing computer identity';end if;
 if _event_id is null or _event_id !~ '^[A-Za-z0-9_-]{6,100}$' then raise exception 'Enter a valid eBay Stream Manager event URL' using errcode='22023';end if;
 -- Serialize queue/claim operations by destination event, even without a sales session.
 perform pg_advisory_xact_lock(hashtextextended('live_listing:'||_event_id,0));
 select * into saved from public.ebay_live_listing_requests where event_id=_event_id and status in ('preparing','ready') order by created_at limit 1;
 if found then
  if saved.worker_id=auth.uid() and saved.worker_token=_worker_token then return saved;end if;
  raise exception 'An item is already being prepared on another receiver. Finish it there first.';
 end if;
 select * into saved from public.ebay_live_listing_requests where event_id=_event_id and status='queued' order by created_at limit 1 for update;
 if not found then return null;end if;
 if not exists(select 1 from public.item_stock_locations where item_id=saved.item_id and condition_status='good' and public.get_available_stock_after_reservations(id)>0) or not exists(select 1 from public.item_types where id=saved.item_id and deleted_at is null) then
  update public.ebay_live_listing_requests set status='failed',note='No available good stock remains',updated_at=now() where id=saved.id;return null;
 end if;
 update public.ebay_live_listing_requests set status='preparing',worker_id=auth.uid(),worker_token=_worker_token,note='Preparing on the show computer',updated_at=now() where id=saved.id returning * into saved;
 return saved;
end $$;

notify pgrst,'reload schema';
commit;
