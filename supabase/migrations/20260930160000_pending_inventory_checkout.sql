-- Barcode-led pending-order packing, with atomic inventory removal and retry receipts.
begin;

-- PostgreSQL has no min(uuid); this existing sale-item trigger blocked checkout.
create or replace function public.infer_seller_shift_for_sale_time(
  _channel text,
  _sold_at timestamptz,
  _store_id uuid default null,
  _session_id uuid default null
)
returns table (
  seller_employee_id uuid,
  shift_id uuid,
  candidate_count integer,
  source text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel text := lower(nullif(btrim(coalesce(_channel, '')), ''));
  v_sold_at timestamptz := coalesce(_sold_at, now());
  v_count integer := 0;
begin
  seller_employee_id := null;
  shift_id := null;
  candidate_count := 0;
  source := 'none';

  if v_channel not in ('ebay', 'whatnot') then
    return next;
    return;
  end if;

  if _session_id is not null then
    with session_sellers as (
      select s.primary_seller_employee_id as employee_id
      from public.live_sale_sessions s
      where s.id = _session_id
        and s.primary_seller_employee_id is not null
      union
      select unnest(coalesce(s.co_seller_employee_ids, '{}'::uuid[])) as employee_id
      from public.live_sale_sessions s
      where s.id = _session_id
    ),
    active_session_sellers as (
      select distinct e.id as employee_id
      from session_sellers ss
      join public.employees e on e.id = ss.employee_id
      where e.active is distinct from false
    )
    select count(*), min(employee_id::text)::uuid
      into v_count, seller_employee_id
    from active_session_sellers;

    if v_count = 1 then
      shift_id := public.find_seller_sale_shift_for_commission(seller_employee_id, v_channel, v_sold_at, _store_id);
      candidate_count := 1;
      source := 'live_sale_session';
      return next;
      return;
    elsif v_count > 1 then
      seller_employee_id := null;
      shift_id := null;
      candidate_count := v_count;
      source := 'live_sale_session_ambiguous';
      return next;
      return;
    end if;
  end if;

  with candidates as (
    select
      s.seller_employee_id,
      s.id as shift_id
    from public.seller_sale_shifts s
    join public.employees e on e.id = s.seller_employee_id
    where s.channel = v_channel
      and s.status = any (public.seller_sale_active_statuses())
      and e.active is distinct from false
      and (_store_id is null or s.store_id is null or s.store_id = _store_id)
      and v_sold_at >= s.start_at
      and v_sold_at < s.end_at
  )
  select count(*), min(c.seller_employee_id::text)::uuid, min(c.shift_id::text)::uuid
    into v_count, seller_employee_id, shift_id
  from candidates c;

  candidate_count := coalesce(v_count, 0);
  if candidate_count = 1 then
    source := 'seller_shift_time';
  elsif candidate_count > 1 then
    seller_employee_id := null;
    shift_id := null;
    source := 'seller_shift_time_ambiguous';
  else
    source := 'none';
  end if;

  return next;
end;
$$;


create function public.lookup_pending_checkout_items(_term text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_term text:=lower(btrim(coalesce(_term,''))); v_items jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if length(v_term) not between 1 and 200 then raise exception 'Enter a barcode or item name' using errcode='22023'; end if;
 -- Search exact identities before descriptions; never silently choose a duplicate barcode.
 select jsonb_agg(to_jsonb(m)) into v_items from (
  select i.id,i.title,i.description,i.barcode,i.sale_price,i.photo_url,i.photos,i.categories,i.weight,
   case when lower(btrim(i.barcode))=v_term or i.id::text=v_term then null
    else (select jsonb_agg(b.id) from public.bulk_batches b where b.item_type_id=i.id and lower(btrim(b.bag_barcode))=v_term) end as checkout_batch_ids
  from public.item_types i where i.deleted_at is null and i.deletion_status='active'
   and (lower(btrim(i.barcode))=v_term or i.id::text=v_term or exists(
    select 1 from public.bulk_batches b where b.item_type_id=i.id and lower(btrim(b.bag_barcode))=v_term))
  order by i.title,i.id limit 25
 ) m;
 if v_items is not null then return jsonb_build_object('exact',true,'items',v_items); end if;
 select jsonb_agg(to_jsonb(m)) into v_items from (
  select i.id,i.title,i.description,i.barcode,i.sale_price,i.photo_url,i.photos,i.categories,i.weight
  from public.item_types i where i.deleted_at is null and i.deletion_status='active'
   and (strpos(lower(coalesce(i.title,'')),v_term)>0 or strpos(lower(coalesce(i.description,'')),v_term)>0
    or strpos(lower(coalesce(i.barcode,'')),v_term)>0)
  order by i.title,i.id limit 25
 ) m;
 return jsonb_build_object('exact',false,'items',coalesce(v_items,'[]'::jsonb));
end $$;

create function public.get_pending_checkout_stock(_item_id uuid,_order_line_id uuid,_checkout_store_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_rows jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _checkout_store_id is null or not exists(select 1 from public.store_locations where id=_checkout_store_id and active is true)
  then raise exception 'Choose an active checkout store' using errcode='22023'; end if;
 if not exists(select 1 from public.ebay_order_lines where id=_order_line_id and line_status in ('pending','partially_fulfilled'))
  then raise exception 'Select a pending order line' using errcode='22023'; end if;
 select jsonb_agg(to_jsonb(r) order by r.own_reserved_quantity desc,r.id) into v_rows from (
  select s.id,s.item_id,s.location_id,s.batch_id,b.bag_barcode,to_jsonb(l) as location,
   s.quantity as physical_quantity,coalesce(a.reserved_quantity,0) as reserved_quantity,
   coalesce(o.quantity,0) as own_reserved_quantity,
   greatest(s.quantity-coalesce(a.reserved_quantity,0)+coalesce(o.quantity,0),0) as quantity
  from public.item_stock_locations s join public.locations l on l.id=s.location_id
  join public.item_types i on i.id=s.item_id and i.deleted_at is null and i.deletion_status='active'
  left join public.locations p on p.id=l.parent_location_id
  left join public.bulk_batches b on b.id=s.batch_id
  left join public.active_stock_reservations a on a.stock_location_row_id=s.id
  left join public.ebay_order_line_reservations o on o.stock_location_row_id=s.id and o.order_line_id=_order_line_id and o.status='reserved'
  where s.item_id=_item_id and s.condition_status='good' and s.quantity>0 and l.active is true
   and (l.parent_location_id is null or p.active is true)
   and (case when coalesce(l.is_tray,false) or l.location_role='tray'
    then coalesce(l.tray_status,'checked_in')<>'checked_out' and coalesce(l.tray_current_store_id,l.store_id)=_checkout_store_id
    else l.location_role in ('storage_location','container') and coalesce(l.store_id,p.store_id)=_checkout_store_id end)
 ) r where r.quantity>0;
 return coalesce(v_rows,'[]'::jsonb);
end $$;

create table public.pending_checkout_receipts (
 user_id uuid not null references auth.users(id),request_id uuid not null,
 payload jsonb not null,result jsonb not null,created_at timestamptz not null default now(),primary key(user_id,request_id)
);
alter table public.pending_checkout_receipts enable row level security;
revoke all on public.pending_checkout_receipts from public,anon,authenticated;

create function public.get_pending_checkout_receipt(_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pending-checkout:'||auth.uid()::text||_request_id::text,0));
 select result into v_result from public.pending_checkout_receipts where user_id=auth.uid() and request_id=_request_id;
 return v_result;
end $$;

create function public.fulfill_pending_checkout_bundle(
 _request_id uuid,_checkout_store_id uuid,_lines jsonb,_notes text default null,_seller_employee_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_payload jsonb;v_prior public.pending_checkout_receipts;v_entry record;v_line public.ebay_order_lines;
 v_stock public.item_stock_locations;v_available bigint;v_email text;v_result jsonb;v_results jsonb:='[]';v_fulfilled record;
 v_no_inventory jsonb:='[]';v_no_inventory_orders uuid[]:='{}';
 v_notes text:=nullif(btrim(coalesce(_notes,'')),'');
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _request_id is null or _checkout_store_id is null then raise exception 'Checkout store and request id required' using errcode='22023'; end if;
 if jsonb_typeof(_lines) is distinct from 'array' then raise exception 'Stage at least one order line' using errcode='22023'; end if;
 if jsonb_array_length(_lines) not between 1 and 100 or length(coalesce(v_notes,''))>2000 then raise exception 'Use 1-100 lines and notes under 2001 characters' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(_lines) e where jsonb_typeof(e) is distinct from 'object'
  or coalesce(e->>'quantity','') !~ '^[1-9][0-9]{0,5}$'
  or coalesce(e->>'expected_fulfilled_quantity','') !~ '^[0-9]{1,6}$'
  or coalesce(e->>'order_line_id','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(e->>'mode','inventory') not in ('inventory','without_inventory')
  or (coalesce(e->>'mode','inventory')='inventory' and (coalesce(e->>'item_id','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(e->>'stock_location_row_id','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')))
  then raise exception 'Each line needs valid identities and a positive whole quantity' using errcode='22023'; end if;
 if (select count(distinct (e->>'order_line_id')::uuid) from jsonb_array_elements(_lines) e)<>jsonb_array_length(_lines)
  then raise exception 'Each order line can appear only once in a checkout' using errcode='22023'; end if;
 select jsonb_agg(e order by e->>'order_line_id') into _lines from jsonb_array_elements(_lines) e;
 v_payload:=jsonb_build_object('store_id',_checkout_store_id,'lines',_lines,'notes',v_notes,'seller_id',_seller_employee_id);
 perform pg_advisory_xact_lock(hashtextextended('pending-checkout:'||auth.uid()::text||_request_id::text,0));
 select * into v_prior from public.pending_checkout_receipts where user_id=auth.uid() and request_id=_request_id;
 if found then
  if v_prior.payload<>v_payload then raise exception 'This checkout request already saved different items' using errcode='22023'; end if;
  return v_prior.result;
 end if;
 -- Reservations can be created by legacy RPCs which do not lock their stock row.
 -- Serialize their writes for this short transaction so none can appear between
 -- the availability check and removal. Stock and location locks also guard moves.
 lock table public.ebay_order_line_reservations,public.live_sale_lot_items in share row exclusive mode;
 perform 1 from public.store_locations where id=_checkout_store_id and active is true for share;
 if not found then raise exception 'Choose an active checkout store' using errcode='22023'; end if;
 perform 1 from public.ebay_order_lines where id in(select (e->>'order_line_id')::uuid from jsonb_array_elements(_lines) e) order by id for update;
 perform 1 from public.ebay_orders where id in(select l.order_id from public.ebay_order_lines l
  where l.id in(select (e->>'order_line_id')::uuid from jsonb_array_elements(_lines) e)) order by id for update;
 perform 1 from public.item_stock_locations where id in(select (e->>'stock_location_row_id')::uuid from jsonb_array_elements(_lines) e) order by id for update;
 perform 1 from public.locations where id in(select s.location_id from public.item_stock_locations s
  where s.id in(select (e->>'stock_location_row_id')::uuid from jsonb_array_elements(_lines) e)) order by id for share;
 perform 1 from public.locations where id in(select l.parent_location_id from public.locations l join public.item_stock_locations s on s.location_id=l.id
  where s.id in(select (e->>'stock_location_row_id')::uuid from jsonb_array_elements(_lines) e)) order by id for share;
 perform 1 from public.item_types where id in(select (e->>'item_id')::uuid from jsonb_array_elements(_lines) e) order by id for share;
 for v_entry in select * from jsonb_to_recordset(_lines) as e(order_line_id uuid,item_id uuid,stock_location_row_id uuid,quantity integer,expected_fulfilled_quantity integer,sold_price numeric,net_payout numeric,mode text) loop
  select * into v_line from public.ebay_order_lines where id=v_entry.order_line_id;
  if not found or v_line.line_status not in ('pending','partially_fulfilled')
   or exists(select 1 from public.ebay_orders where id=v_line.order_id and status in ('cancelled','archived','fulfilled'))
   then raise exception 'An order is no longer pending. Refresh before checkout' using errcode='22023'; end if;
  if v_line.fulfilled_quantity<>v_entry.expected_fulfilled_quantity then raise exception 'An order quantity changed. Refresh before checkout' using errcode='22023'; end if;
  if v_entry.quantity>v_line.quantity-v_line.fulfilled_quantity then raise exception 'Quantity exceeds the remaining order quantity' using errcode='22023'; end if;
  if v_entry.sold_price<0 then raise exception 'Sale price cannot be negative' using errcode='22023'; end if;
  if coalesce(v_entry.mode,'inventory')='inventory' and not exists(select 1 from jsonb_array_elements(public.get_pending_checkout_stock(v_entry.item_id,v_line.id,_checkout_store_id)) r
    where (r->>'id')::uuid=v_entry.stock_location_row_id)
   then raise exception 'Source is unavailable, reserved, or outside the checkout store. Scan again' using errcode='22023'; end if;
 end loop;
 -- Protect reservations belonging to other orders/bags and sum repeated sources.
 for v_entry in select stock_location_row_id,sum(quantity) as quantity from jsonb_to_recordset(_lines)
  as e(stock_location_row_id uuid,quantity integer,mode text) where coalesce(mode,'inventory')='inventory' group by stock_location_row_id loop
  select * into v_stock from public.item_stock_locations where id=v_entry.stock_location_row_id;
  select v_stock.quantity-coalesce((select reserved_quantity from public.active_stock_reservations where stock_location_row_id=v_stock.id),0)
   +coalesce((select sum(r.quantity) from public.ebay_order_line_reservations r where r.stock_location_row_id=v_stock.id and r.status='reserved'
    and r.order_line_id in(select (e->>'order_line_id')::uuid from jsonb_array_elements(_lines) e)),0) into v_available;
  if v_entry.quantity>v_available then raise exception 'Not enough unreserved stock for this bundle. Scan again' using errcode='22023'; end if;
 end loop;
 select email into v_email from auth.users where id=auth.uid();
 update public.ebay_order_line_reservations set status='released',raw_payload=raw_payload||jsonb_build_object('checkout_request_id',_request_id)
  where status='reserved' and order_line_id in(select (e->>'order_line_id')::uuid from jsonb_array_elements(_lines) e);
 for v_entry in select * from jsonb_to_recordset(_lines) as e(order_line_id uuid,item_id uuid,stock_location_row_id uuid,quantity integer,sold_price numeric,net_payout numeric,mode text) loop
  if _seller_employee_id is not null then
   perform public.assign_seller_to_ebay_order_line(v_entry.order_line_id,_seller_employee_id,null,null);
  end if;
  if v_entry.mode='without_inventory' then
   select * into v_line from public.ebay_order_lines where id=v_entry.order_line_id;
   update public.ebay_order_lines set fulfilled_quantity=fulfilled_quantity+v_entry.quantity,
    line_status=case when fulfilled_quantity+v_entry.quantity>=quantity then 'fulfilled' else 'partially_fulfilled' end,
    internal_item_id=case when v_line.fulfilled_quantity=0 then null else internal_item_id end,
    stock_location_row_id=case when v_line.fulfilled_quantity=0 then null else stock_location_row_id end,
    location_id=case when v_line.fulfilled_quantity=0 then null else location_id end,
    fulfilled_by=auth.uid(),fulfilled_by_email=v_email,fulfilled_at=now(),updated_at=now(),
    notes=concat_ws(E'\n',nullif(notes,''),coalesce(v_notes,'Physical item present; completed without inventory removal.'))
    where id=v_line.id;
   v_no_inventory_orders:=array_append(v_no_inventory_orders,v_line.order_id);
   v_no_inventory:=v_no_inventory||jsonb_build_array(jsonb_build_object('order_line_id',v_line.id,'order_id',v_line.order_id,
    'item_title',v_line.item_title,'quantity',v_entry.quantity,'previous_fulfilled_quantity',v_line.fulfilled_quantity));
   v_results:=v_results||jsonb_build_array(jsonb_build_object('order_id',v_line.order_id,'order_line_id',v_line.id,
    'mode','without_inventory','quantity',v_entry.quantity));
  else
  select * into v_fulfilled from public.fulfill_ebay_order_line(v_entry.order_line_id,v_entry.item_id,v_entry.stock_location_row_id,
   v_entry.quantity,v_entry.sold_price,v_entry.net_payout,v_notes,v_email);
  update public.stock_transactions set source_stock_location_row_id=v_entry.stock_location_row_id,stock_condition='good',
   metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('pending_checkout_request_id',_request_id,'order_line_id',v_entry.order_line_id,
    'checkout_store_id',_checkout_store_id,'batch_id',(select batch_id from public.item_stock_locations where id=v_entry.stock_location_row_id))
   where id=v_fulfilled.stock_transaction_id;
   v_results:=v_results||jsonb_build_array(to_jsonb(v_fulfilled)||jsonb_build_object('mode','inventory','quantity',v_entry.quantity));
  end if;
  -- The existing order trigger may reserve a partial remainder. Reallocate only
  -- after every staged line has been removed, so it cannot reserve this bundle.
  update public.ebay_order_line_reservations set status='released' where order_line_id=v_entry.order_line_id and status='reserved';
 end loop;
 for v_entry in select (e->>'order_line_id')::uuid as id from jsonb_array_elements(_lines) e loop
  perform public.reserve_ebay_order_line_stock(v_entry.id);
  update public.ebay_order_line_reservations set status='fulfilled' where order_line_id=v_entry.id and status='released'
   and exists(select 1 from public.ebay_order_lines l where l.id=v_entry.id and l.line_status='fulfilled');
 end loop;
 if jsonb_array_length(v_no_inventory)>0 then
  update public.ebay_orders o set status=case when not exists(select 1 from public.ebay_order_lines l where l.order_id=o.id
   and l.line_status not in ('fulfilled','cancelled','skipped')) then 'fulfilled' else 'partially_fulfilled' end,updated_at=now()
   where o.id=any(v_no_inventory_orders);
  insert into public.ebay_order_admin_events(action,order_ids,order_line_ids,notes,signed_by,signed_by_email,checkout_store_id,gps_status,payload)
   values('fulfilled_no_inventory',array(select distinct id from unnest(v_no_inventory_orders) id),
    array(select (e->>'order_line_id')::uuid from jsonb_array_elements(v_no_inventory) e),
    coalesce(v_notes,'Physical items present; completed without inventory removal.'),auth.uid(),v_email,_checkout_store_id,'not_requested',
    jsonb_build_object('source','mixed_pending_checkout','checkout_request_id',_request_id,'line_snapshots',v_no_inventory));
 end if;
 update public.metadata set inventory_version=gen_random_uuid()::text,
  changed_item_ids=array(select distinct e->>'item_id' from jsonb_array_elements(_lines) e where e->>'item_id' is not null),updated_at=now() where id='inventory';
 v_result:=jsonb_build_object('request_id',_request_id,'lines',v_results,'saved_at',now());
 insert into public.pending_checkout_receipts(user_id,request_id,payload,result) values(auth.uid(),_request_id,v_payload,v_result);
 return v_result;
end $$;

-- Old pages retain the same signature and receive the same reservation/store guards.
create or replace function public.fulfill_ebay_order_line_for_store(
 _order_line_id uuid,_item_id uuid,_stock_location_row_id uuid,_quantity integer,_sold_price numeric default null,
 _net_payout numeric default null,_notes text default null,_signed_by_email text default null,_checkout_store_id uuid default null
) returns table(order_id uuid,order_line_id uuid,sale_id uuid,sale_item_id uuid,stock_transaction_id uuid,item_id uuid,remaining_stock integer)
language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 v_result:=public.fulfill_pending_checkout_bundle(gen_random_uuid(),_checkout_store_id,jsonb_build_array(jsonb_build_object(
  'order_line_id',_order_line_id,'item_id',_item_id,'stock_location_row_id',_stock_location_row_id,'quantity',_quantity,'sold_price',_sold_price,'net_payout',_net_payout,
  'expected_fulfilled_quantity',(select fulfilled_quantity from public.ebay_order_lines where id=_order_line_id))),_notes,null);
 return query select * from jsonb_to_recordset(v_result->'lines') as r(order_id uuid,order_line_id uuid,sale_id uuid,sale_item_id uuid,stock_transaction_id uuid,item_id uuid,remaining_stock integer);
end $$;
revoke all on function public.fulfill_ebay_order_line(uuid,uuid,uuid,integer,numeric,numeric,text,text) from public,anon,authenticated;
revoke all on function public.lookup_pending_checkout_items(text),public.get_pending_checkout_stock(uuid,uuid,uuid),
 public.get_pending_checkout_receipt(uuid),public.fulfill_pending_checkout_bundle(uuid,uuid,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.lookup_pending_checkout_items(text),public.get_pending_checkout_stock(uuid,uuid,uuid),
 public.get_pending_checkout_receipt(uuid),public.fulfill_pending_checkout_bundle(uuid,uuid,jsonb,text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
