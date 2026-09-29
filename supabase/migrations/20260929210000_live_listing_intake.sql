begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

create table public.ebay_live_listing_requests (
 id uuid primary key, event_id text not null references public.ebay_live_connections(event_id),
 item_id uuid not null references public.item_types(id), snapshot jsonb not null,
 starting_bid numeric(12,2) not null check(starting_bid>0 and starting_bid<1000000),
 duration_seconds integer not null check(duration_seconds in (15,30,45,60,90,120)),
 status text not null default 'queued' check(status in ('queued','preparing','ready','created','failed','cancelled')),
 created_by uuid not null default auth.uid(), worker_id uuid, worker_token uuid,
 listing_id text, note text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(event_id,item_id), unique(event_id,listing_id)
);
alter table public.ebay_live_listing_requests enable row level security;
revoke all on public.ebay_live_listing_requests from anon,authenticated;

create function public.lookup_live_listing_item(_barcode text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ids uuid[]; i public.item_types; qty bigint; linked_listing text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if length(btrim(coalesce(_barcode,''))) not between 1 and 200 then raise exception 'Scan an inventory item barcode';end if;
 select array_agg(id) into ids from public.item_types where deleted_at is null and (lower(btrim(barcode))=lower(btrim(_barcode)) or id::text=btrim(_barcode));
 if cardinality(ids) is distinct from 1 then raise exception 'No unique stock item matches this code. Check its barcode on Stock.';end if;
 select * into i from public.item_types where id=ids[1];
 select coalesce(sum(public.get_available_stock_after_reservations(id)),0) into qty from public.item_stock_locations where item_id=i.id and condition_status='good';
 select listing_id into linked_listing from public.ebay_inventory_links where item_type_id=i.id;
 return jsonb_build_object('id',i.id,'barcode',i.barcode,'title',i.title,'description',i.description,
  'photos',to_jsonb(i)->'photos','photo_url',i.photo_url,'available',qty,'retail_price',i.sale_price,
  'existing_listing_id',linked_listing,'watch_details',to_jsonb(i)->'watch_details','coin_details',to_jsonb(i)->'coin_details',
  'ebay_category_id',to_jsonb(i)->'ebay_category_id','ebay_aspects',to_jsonb(i)->'ebay_aspects','ebay_condition',to_jsonb(i)->'ebay_condition');
end $$;

create function public.queue_live_listing(_id uuid,_event_id text,_barcode text,_starting_bid numeric,_duration integer,_existing_listing_checked boolean default false)
returns public.ebay_live_listing_requests language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; item jsonb; saved public.ebay_live_listing_requests; photo_count integer;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _id is null or _starting_bid is null or _starting_bid<=0 or _starting_bid>=1000000 or round(_starting_bid,2)<>_starting_bid or _duration is null or _duration not in (15,30,45,60,90,120) then raise exception 'Enter a starting bid and auction duration';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found or c.broadcast_ended_at is not null or c.review_completed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'Choose a linked show that is still live';end if;
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

create function public.get_live_listing_requests(_event_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from (select id,event_id,item_id,snapshot->>'title' title,snapshot->>'barcode' barcode,starting_bid,duration_seconds,status,listing_id,note,created_at,updated_at from public.ebay_live_listing_requests where event_id=_event_id order by created_at desc limit 50) r),'[]');
end $$;

create function public.claim_live_listing(_event_id text,_worker_token uuid) returns public.ebay_live_listing_requests
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; saved public.ebay_live_listing_requests;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _worker_token is null then raise exception 'Missing computer identity';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found or c.broadcast_ended_at is not null or c.review_completed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show is no longer live';end if;
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

create function public.report_live_listing(_id uuid,_worker_token uuid,_status text,_note text default null,_listing_id text default null) returns void
language plpgsql security definer set search_path='' as $$
declare job public.ebay_live_listing_requests;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into job from public.ebay_live_listing_requests where id=_id for update;
 if not found or job.worker_id is distinct from auth.uid() or job.worker_token is distinct from _worker_token then raise exception 'This preparation belongs to another computer' using errcode='42501';end if;
 if job.status='created' and _status='created' and job.listing_id=_listing_id then return;end if;
 if _status is null or not ((job.status='preparing' and _status in ('ready','failed')) or (job.status='ready' and _status in ('created','failed'))) then raise exception 'This preparation has already changed. Refresh its status.';end if;
 if _status='created' and coalesce(_listing_id,'')!~'^[0-9]{9,20}$' then raise exception 'A verified eBay listing ID is required';end if;
 update public.ebay_live_listing_requests set status=_status,note=left(_note,500),listing_id=case when _status='created' then _listing_id else listing_id end,updated_at=now() where id=_id;
end $$;

create function public.retry_live_listing(_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 update public.ebay_live_listing_requests set status='queued',snapshot=public.lookup_live_listing_item(item_id::text),note=null,worker_id=null,worker_token=null,updated_at=now() where id=_id and status='failed';
 if not found then raise exception 'Only failed preparations can be retried';end if;
end $$;
revoke all on function public.lookup_live_listing_item(text),public.queue_live_listing(uuid,text,text,numeric,integer,boolean),public.get_live_listing_requests(text),public.claim_live_listing(text,uuid),public.report_live_listing(uuid,uuid,text,text,text),public.retry_live_listing(uuid) from public,anon,authenticated;
grant execute on function public.lookup_live_listing_item(text),public.queue_live_listing(uuid,text,text,numeric,integer,boolean),public.get_live_listing_requests(text),public.claim_live_listing(text,uuid),public.report_live_listing(uuid,uuid,text,text,text),public.retry_live_listing(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
