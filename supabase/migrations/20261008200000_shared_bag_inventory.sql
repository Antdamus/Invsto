begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- A bag owns its inventory. Pending Orders refers to that same manifest; it
-- never creates a second hold for it. Standalone attachments remain supported.
create table public.shared_inventory_bag_links (
 lot_id uuid primary key references public.live_sale_lots(id),
 order_line_id uuid not null unique references public.ebay_order_lines(id),
 checkout_store_id uuid references public.store_locations(id),
 created_at timestamptz not null default now()
);
create table public.shared_inventory_reviews (
 lot_id uuid primary key references public.live_sale_lots(id),
 order_line_id uuid references public.ebay_order_lines(id),
 reason text not null, snapshot jsonb not null,
 resolved_at timestamptz, created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.shared_inventory_transfers (
 id uuid primary key default gen_random_uuid(),
 order_line_id uuid not null references public.ebay_order_lines(id),lot_id uuid not null references public.live_sale_lots(id),
 item_id uuid not null,stock_row_id uuid not null,quantity integer not null,
 attachment_revision integer not null,created_at timestamptz not null default now(),
 unique(order_line_id,attachment_revision)
);
alter table public.live_sale_lot_items add column shared_transfer_id uuid unique references public.shared_inventory_transfers(id);
alter table public.pending_inventory_attachments add column linked_lot_id uuid references public.live_sale_lots(id);
alter table public.pending_inventory_attachments drop constraint pending_inventory_attachments_status_check;
alter table public.pending_inventory_attachments add check(status in ('reserved','consumed','released','cancelled','linked'));
alter table public.shared_inventory_bag_links enable row level security;
alter table public.shared_inventory_reviews enable row level security;
alter table public.shared_inventory_transfers enable row level security;
revoke all on public.shared_inventory_bag_links,public.shared_inventory_reviews,public.shared_inventory_transfers from public,anon,authenticated;

-- Existing writers predate shared reservations. All relevant mutations use the
-- same transaction lock, including old browser RPCs and direct table writes.
create function public.lock_shared_inventory() returns void language sql security definer set search_path='' as $$
 select pg_advisory_xact_lock(817042,20261008);
$$;
create function public.lock_shared_inventory_statement() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.lock_shared_inventory();return null;end $$;
create trigger shared_inventory_write_lock before insert or update or delete on public.live_sale_lot_items
 for each statement execute function public.lock_shared_inventory_statement();
create trigger shared_inventory_write_lock before insert or update or delete on public.ebay_order_line_reservations
 for each statement execute function public.lock_shared_inventory_statement();
create trigger shared_inventory_write_lock before insert or update or delete on public.pending_inventory_attachments
 for each statement execute function public.lock_shared_inventory_statement();
create trigger shared_inventory_write_lock before update of quantity,fulfilled_quantity,line_status,stock_transaction_id on public.ebay_order_lines
 for each statement execute function public.lock_shared_inventory_statement();
create trigger shared_inventory_write_lock before insert or update or delete on public.live_bag_order_links
 for each statement execute function public.lock_shared_inventory_statement();

create function public.shared_inventory_review(_lot uuid,_line uuid,_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into public.shared_inventory_reviews(lot_id,order_line_id,reason,snapshot)
 values(_lot,_line,_reason,jsonb_build_object(
  'attachment',(select to_jsonb(a) from public.pending_inventory_attachments a where order_line_id=_line),
  'bag_items',(select coalesce(jsonb_agg(to_jsonb(i)),'[]') from public.live_sale_lot_items i where lot_id=_lot and status in ('reserved','packed'))))
 on conflict(lot_id) do update set order_line_id=excluded.order_line_id,reason=excluded.reason,snapshot=excluded.snapshot,resolved_at=null,updated_at=now();
end $$;

create function public.unify_shared_inventory(_lot uuid) returns void
language plpgsql security definer set search_path='' as $$
declare ids uuid[]; lid uuid; prior uuid; other uuid; b public.live_sale_lots;l public.ebay_order_lines;
 a public.pending_inventory_attachments; groups integer; matched integer; transfer uuid;
begin
 perform public.lock_shared_inventory();
 select * into b from public.live_sale_lots where id=_lot;
 if not found then return;end if;
 select array_agg(distinct x) filter(where x is not null) into ids from (
  select order_line_id x from public.live_bag_order_links where lot_id=_lot
  union all select order_line_id from public.ebay_live_attempts where lot_id=_lot
  union all select b.matched_order_line_id
 ) q;
 select order_line_id into prior from public.shared_inventory_bag_links where lot_id=_lot;
 if coalesce(cardinality(ids),0)=0 then
  if prior is not null then perform public.shared_inventory_review(_lot,prior,'The bag/order connection was removed. Review the connection before changing inventory.');end if;
  return;
 end if;
 if cardinality(ids)<>1 then perform public.shared_inventory_review(_lot,prior,'This bag points to different orders. Review its order connection.');return;end if;
 lid:=ids[1];
 if prior is not null and prior<>lid then perform public.shared_inventory_review(_lot,prior,'The order connection changed after inventory was linked. Review the bag.');return;end if;
 select * into l from public.ebay_order_lines where id=lid;
 if l.line_status not in ('pending','partially_fulfilled') then
  if b.status in ('open','reserved','released') then
   perform public.shared_inventory_review(_lot,lid,'This order is already closed. Verify its physical bag and stock transactions before changing inventory.');
  end if;
  return;
 end if;
 if b.status not in ('open','reserved','released') then return;end if;
 select lot_id into other from public.shared_inventory_bag_links where order_line_id=lid and lot_id<>_lot;
 if other is not null then
  perform public.shared_inventory_review(_lot,lid,'More than one bag is linked to this order line. Confirm the correct bag.');
  perform public.shared_inventory_review(other,lid,'More than one bag is linked to this order line. Confirm the correct bag.');return;
 end if;
 insert into public.shared_inventory_bag_links(lot_id,order_line_id,checkout_store_id) values(_lot,lid,(select store_id from public.live_sale_sessions where id=b.session_id)) on conflict(lot_id) do nothing;
 select * into a from public.pending_inventory_attachments where order_line_id=lid and status='reserved' for update;
 if found then
  if a.consumed_quantity<>0 or l.fulfilled_quantity<>0 then
   perform public.shared_inventory_review(_lot,lid,'This attachment was partly completed. Review the remaining bag contents before linking.');return;
  end if;
  if exists(select 1 from public.pending_inventory_attachment_events e where e.order_line_id=lid and e.action='separate_physical_units_confirmed'
   and exists(select 1 from jsonb_array_elements(e.snapshot->'other_bags') x where x->>'lot_id'=_lot::text))
   and not exists(select 1 from public.pending_inventory_attachment_events e where e.order_line_id=lid and e.action='shared_overlap_confirmed'
    and e.snapshot->>'lot_id'=_lot::text and (e.snapshot->>'attachment_revision')::integer=a.revision) then
   perform public.shared_inventory_review(_lot,lid,'These were confirmed as different physical units. Review the bag contents before combining their reservations.');return;
  end if;
  update public.shared_inventory_bag_links set checkout_store_id=coalesce(checkout_store_id,a.checkout_store_id) where lot_id=_lot;
  select count(*)::integer,count(*) filter(where item_id=a.item_id and source_stock_location_row_id=a.stock_location_row_id and qty=a.quantity)::integer
   into groups,matched from (select item_id,source_stock_location_row_id,sum(quantity) qty from public.live_sale_lot_items
    where lot_id=_lot and status='reserved' group by item_id,source_stock_location_row_id) q;
  if groups>0 and (groups<>1 or matched<>1) then
   perform public.shared_inventory_review(_lot,lid,'The pending attachment and bag contents differ. Compare the items, sources and quantities.');return;
  end if;
  update public.pending_inventory_attachments set status='linked',linked_lot_id=_lot,revision=revision+1,updated_at=now() where order_line_id=lid;
  update public.ebay_order_line_reservations set status='released' where order_line_id=lid and status='reserved';
  if groups=0 then
   insert into public.shared_inventory_transfers(order_line_id,lot_id,item_id,stock_row_id,quantity,attachment_revision)
    values(lid,_lot,a.item_id,a.stock_location_row_id,a.quantity,a.revision) returning id into transfer;
   insert into public.live_sale_lot_items(lot_id,session_id,item_id,source_stock_location_row_id,source_location_id,quantity,scanned_by,scanned_by_email,notes,shared_transfer_id)
    select _lot,b.session_id,a.item_id,a.stock_location_row_id,s.location_id,a.quantity,a.attached_by,a.attached_by_email,
     'Existing Pending Orders reservation transferred; no stock removed.',transfer from public.item_stock_locations s where s.id=a.stock_location_row_id;
   update public.live_sale_lots set status='reserved' where id=_lot and status in ('open','released');
  end if;
  insert into public.pending_inventory_attachment_events(order_line_id,action,snapshot,created_by)
   values(lid,'shared_with_bag',to_jsonb(a)||jsonb_build_object('lot_id',_lot,'transferred',groups=0),auth.uid());
 end if;
 -- A linked bag owns reservation allocation even while its manifest is empty.
 update public.ebay_order_line_reservations set status='released' where order_line_id=lid and status='reserved';
 update public.shared_inventory_reviews set resolved_at=now(),updated_at=now() where lot_id=_lot and resolved_at is null;
end $$;

create function public.sync_shared_inventory_link() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if TG_OP<>'DELETE' and new.lot_id is not null then perform public.unify_shared_inventory(new.lot_id);end if;
 if TG_OP<>'INSERT' and old.lot_id is not null and (TG_OP='DELETE' or old.lot_id is distinct from new.lot_id) then perform public.unify_shared_inventory(old.lot_id);end if;
 return null;
end $$;
create trigger shared_inventory_link after insert or update or delete on public.live_bag_order_links for each row execute function public.sync_shared_inventory_link();
create trigger shared_inventory_link after insert or update of lot_id,order_line_id on public.ebay_live_attempts for each row execute function public.sync_shared_inventory_link();

create function public.assert_shared_inventory(_lot uuid) returns void language plpgsql security definer set search_path='' as $$
declare reason text;
begin
 select r.reason into reason from public.shared_inventory_reviews r where r.lot_id=_lot and r.resolved_at is null;
 if found then raise exception 'Inventory review needed: %',reason using errcode='22023';end if;
end $$;

-- Older sync clients cannot recreate an independent order reservation for a bag.
alter function public.reserve_ebay_order_line_stock(uuid) rename to reserve_ebay_order_line_stock_attachment;
create function public.reserve_ebay_order_line_stock(_order_line_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare bag uuid;
begin
 select lot_id into bag from public.shared_inventory_bag_links where order_line_id=_order_line_id;
 if bag is null then return public.reserve_ebay_order_line_stock_attachment(_order_line_id);end if;
 if pg_trigger_depth()=0 and coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
  and not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 update public.ebay_order_line_reservations set status='released' where order_line_id=_order_line_id and status='reserved';
 return jsonb_build_object('ok',true,'status','shared_bag','lot_id',bag);
end $$;
create function public.guard_shared_order_reservation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='reserved' and exists(select 1 from public.shared_inventory_bag_links where order_line_id=new.order_line_id)
  then new.status:='released';end if;
 return new;
end $$;
create trigger shared_inventory_reservation_guard before insert or update on public.ebay_order_line_reservations for each row execute function public.guard_shared_order_reservation();

-- Availability counts *all* order and bag reservations, including old clients.
-- The source row is locked before reading the aggregate and changing the hold.
create function public.guard_shared_bag_item() returns trigger language plpgsql security definer set search_path='' as $$
declare physical integer; held integer; own integer:=0; line_id uuid; restored boolean:=false;
begin
 perform public.lock_shared_inventory();
 if TG_OP='UPDATE' and old.status='packed' and new.status='reserved' and new.item_id=old.item_id and new.quantity=old.quantity and new.source_stock_location_row_id=old.source_stock_location_row_id then
  restored:=exists(select 1 from public.stock_transactions t where t.source_transaction_id=old.packed_stock_transaction_id
   and t.item_id=old.item_id and t.location_id=old.source_location_id and t.quantity=old.quantity and t.action_type='correction'
   and t.user_id=auth.uid() and t.timestamp=transaction_timestamp());
 end if;
 if TG_OP='UPDATE' and old.status='packed' and (new.status<>old.status or new.quantity<>old.quantity or new.item_id<>old.item_id or new.source_stock_location_row_id<>old.source_stock_location_row_id)
  and not restored then raise exception 'Packed inventory needs the return workflow; it cannot be reserved again.' using errcode='22023';end if;
 if new.status<>'reserved' then return new;end if;
 perform public.assert_shared_inventory(new.lot_id);
 select order_line_id into line_id from public.shared_inventory_bag_links where lot_id=new.lot_id;
 if line_id is null and exists(select 1 from public.pending_inventory_attachments a where a.status='reserved'
  and a.item_id=new.item_id and a.stock_location_row_id=new.source_stock_location_row_id) then
  raise exception 'This inventory is already attached to a pending order. Connect the bag to its order first so the existing reservation can be reused.' using errcode='22023';end if;
 if line_id is not null and not restored and not exists(select 1 from public.ebay_order_lines where id=line_id and line_status in ('pending','partially_fulfilled'))
  then raise exception 'This bag belongs to a completed order. No additional reservation was made.' using errcode='22023';end if;
 if exists(select 1 from public.live_sale_lot_items i where i.lot_id=new.lot_id and i.item_id=new.item_id and i.source_stock_location_row_id=new.source_stock_location_row_id and i.status='reserved' and i.id<>new.id)
  then raise exception 'Already reserved in this bag. Change its quantity explicitly instead of scanning it again.' using errcode='22023';end if;
 select s.quantity into physical from public.item_stock_locations s join public.item_types i on i.id=s.item_id
  where s.id=new.source_stock_location_row_id and s.item_id=new.item_id and s.location_id=new.source_location_id
   and s.condition_status='good' and i.deleted_at is null for update of s;
 if not found then raise exception 'Choose available inventory in good condition.' using errcode='22023';end if;
 select coalesce(r.reserved_quantity,0) into held from public.active_stock_reservations r where r.stock_location_row_id=new.source_stock_location_row_id;
 if TG_OP='UPDATE' and old.status='reserved' and old.source_stock_location_row_id=new.source_stock_location_row_id then own:=old.quantity;end if;
 if new.quantity>physical-coalesce(held,0)+own then raise exception 'Not enough unreserved stock. Another order or bag already holds these units.' using errcode='22023';end if;
 if restored then
  update public.shared_inventory_consumptions set reversed_at=now() where lot_id=new.lot_id and reversed_at is null;
  insert into public.live_sale_events(session_id,lot_id,item_id,event_type,payload) values(new.session_id,new.lot_id,new.item_id,'shared_inventory_restored',
   jsonb_build_object('original_stock_transaction',old.packed_stock_transaction_id,'quantity',new.quantity));
 end if;
 return new;
end $$;
create trigger a_shared_bag_inventory_guard before insert or update on public.live_sale_lot_items for each row execute function public.guard_shared_bag_item();

create or replace function public.get_pending_checkout_stock(_item_id uuid,_order_line_id uuid,_checkout_store_id uuid) returns jsonb
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
  left join lateral (select sum(q.quantity) quantity from (
    select x.quantity from public.ebay_order_line_reservations x where x.stock_location_row_id=s.id and x.order_line_id=_order_line_id and x.status='reserved'
    union all select x.quantity from public.live_sale_lot_items x join public.shared_inventory_bag_links k on k.lot_id=x.lot_id
     where k.order_line_id=_order_line_id and x.source_stock_location_row_id=s.id and x.status='reserved'
   ) q) o on true
  where s.item_id=_item_id and s.condition_status='good' and s.quantity>0 and l.active is true
   and (l.parent_location_id is null or p.active is true)
   and (case when coalesce(l.is_tray,false) or l.location_role='tray'
    then coalesce(l.tray_status,'checked_in')<>'checked_out' and coalesce(l.tray_current_store_id,l.store_id)=_checkout_store_id
    else l.location_role in ('storage_location','container') and coalesce(l.store_id,p.store_id)=_checkout_store_id end)
 ) r where r.quantity>0;
 return coalesce(v_rows,'[]'::jsonb);
end $$;


create or replace function public.consume_shared_inventory_bag(
  _order_line_id uuid,
  _lot_id uuid,
  _notes text default null,
  _signed_by_email text default null,
  _checkout_store_id uuid default null
)
returns table (
  order_id uuid,
  order_line_id uuid,
  sale_id uuid,
  packed_items integer,
  removed_units integer, first_item_id uuid, first_stock_row_id uuid, first_location_id uuid, first_sale_item_id uuid, first_tx_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_lot public.live_sale_lots;
  v_sale_id uuid;
  v_sale_item_id uuid;
  v_tx_id uuid;
  v_first_item_id uuid;
  v_first_stock_row_id uuid;
  v_first_location_id uuid;
  v_first_sale_item_id uuid;
  v_first_tx_id uuid;
  v_line_total numeric(12,2);
  v_net_payout numeric(12,2);
  v_fee_amount numeric(12,2);
  v_fee_percent numeric(7,4);
  v_total_units integer;
  v_item_count integer := 0;
  v_removed_units integer := 0;
  v_now timestamptz := now();
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_order_status text;
  v_cart_snapshot jsonb := '[]'::jsonb;
  v_lot_item record;
  v_stock public.item_stock_locations;
  v_item public.item_types;
  v_location public.locations;
  v_remaining integer;
  v_alloc_total numeric(12,2);
  v_alloc_unit numeric(12,2);
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to fulfill eBay orders' using errcode = '42501';
  end if;

  if _order_line_id is null or _lot_id is null then
    raise exception 'Order line and live-sale bag are required' using errcode = '22023';
  end if;

  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id
  for update;

  if not found then
    raise exception 'eBay order line not found' using errcode = 'P0002';
  end if;

  if v_line.line_status in ('fulfilled', 'cancelled', 'skipped') then
    raise exception 'This eBay order line is already closed' using errcode = '23505';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id
  for update;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id
    and status in ('open', 'reserved')
  for update;

  if not found then
    raise exception 'Open live sale bag not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(quantity), 0)::integer,
         count(*)::integer
    into v_total_units, v_item_count
  from public.live_sale_lot_items
  where lot_id = v_lot.id
    and status = 'reserved';

  if coalesce(v_total_units, 0) <= 0 then
    raise exception 'That live sale bag has no reserved items to pack' using errcode = '22023';
  end if;

  v_line_total := coalesce(nullif(v_line.total_price, 0), nullif(v_line.sold_for, 0), 0);
  v_net_payout := coalesce(
    v_line.net_payout,
    case
      when coalesce(v_line.total_price, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then greatest(round(
          v_line.total_price
          - (coalesce(v_order.ebay_collected_tax, 0) * (v_line.total_price / v_order.total_price))
          - (coalesce(v_order.ebay_collected_charges, 0) * (v_line.total_price / v_order.total_price))
          - (coalesce(v_order.seller_collected_tax, 0) * (v_line.total_price / v_order.total_price)),
          2
        ), 0)
      when coalesce(v_line.total_price, 0) > 0 then v_line.total_price
      else null
    end,
    case
      when coalesce(v_order.net_payout, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then round(v_order.net_payout * (coalesce(nullif(v_line.total_price, 0), v_line_total) / v_order.total_price), 2)
      else null
    end,
    v_line_total
  );
  v_fee_amount := greatest(round(v_line_total - v_net_payout, 2), 0);
  v_fee_percent := case when v_line_total > 0 then round((v_fee_amount / v_line_total) * 100, 4) else 0 end;

  select s.id
    into v_sale_id
  from public.sales s
  where s.platform = 'ebay'
    and s.external_sales_id = v_order.order_number
  order by s.created_at desc
  limit 1;

  if v_sale_id is null then
    insert into public.sales (
      external_sales_id,
      user_id,
      email,
      platform,
      subtotal,
      credits_applied,
      total_discount,
      final_amount,
      platform_fee_amount,
      platform_fee_percent,
      profit_amount,
      flagged,
      verified_method,
      verified_at,
      created_at
    )
    values (
      v_order.order_number,
      auth.uid(),
      v_signed_email,
      'ebay',
      coalesce(nullif(v_order.total_price, 0), v_line_total),
      0,
      0,
      coalesce(nullif(v_order.total_price, 0), v_line_total),
      v_fee_amount,
      v_fee_percent,
      v_net_payout,
      false,
      'authenticated_session',
      v_now,
      v_now
    )
    returning id into v_sale_id;
  end if;

  for v_lot_item in
    select *
    from public.live_sale_lot_items
    where lot_id = v_lot.id
      and status = 'reserved'
    order by scanned_at, id
  loop
    select *
      into v_stock
    from public.item_stock_locations
    where id = v_lot_item.source_stock_location_row_id
    for update;

    if not found then
      raise exception 'Source stock row for reserved bag item was not found' using errcode = 'P0002';
    end if;

    if coalesce(v_stock.quantity, 0) < v_lot_item.quantity then
      raise exception 'Only % physical unit(s) remain for a reserved item', coalesce(v_stock.quantity, 0) using errcode = '22023';
    end if;

    select *
      into v_location
    from public.locations
    where id = v_stock.location_id;

    if not exists(select 1 from jsonb_array_elements(public.get_pending_checkout_stock(v_lot_item.item_id,v_line.id,_checkout_store_id)) r
      where (r->>'id')::uuid=v_stock.id and (r->>'quantity')::integer>=v_lot_item.quantity) then
      raise exception 'Bag inventory is unavailable, damaged, reserved elsewhere, or outside the packing store.' using errcode='22023';
    end if;
    select *
      into v_item
    from public.item_types
    where id = v_lot_item.item_id;

    if not found then
      raise exception 'Reserved inventory item was not found' using errcode = 'P0002';
    end if;

    v_alloc_total := case
      when v_line_total > 0 then round(v_line_total * (v_lot_item.quantity::numeric / greatest(v_total_units, 1)), 2)
      else round(coalesce(v_item.sale_price, 0) * v_lot_item.quantity, 2)
    end;
    v_alloc_unit := case
      when v_lot_item.quantity > 0 then round(v_alloc_total / v_lot_item.quantity, 2)
      else 0
    end;

    update public.item_stock_locations
    set quantity = coalesce(quantity, 0) - v_lot_item.quantity,
        last_updated = v_now,
        locked_by = null,
        locked_at = null
    where id = v_stock.id
    returning quantity into v_remaining;

    insert into public.sale_items (
      sale_id,
      item_id,
      title,
      quantity,
      sale_price,
      discount_percent,
      discount_amount,
      final_price,
      remaining_stock_qty,
      location_id,
      photo_path
    )
    values (
      v_sale_id,
      v_item.id,
      v_item.title,
      v_lot_item.quantity,
      v_alloc_unit,
      0,
      0,
      v_alloc_total,
      v_remaining,
      v_stock.location_id,
      coalesce((v_item.photos)[1], '')
    )
    returning id into v_sale_item_id;

    insert into public.sale_item_categories (sale_item_id, category)
    select v_sale_item_id, category
    from unnest(coalesce(v_item.categories, '{}'::text[])) as category;

    insert into public.stock_transactions (
      item_id,
      location_id,
      quantity,
      action_type,
      confirmed_at,
      user_id,
      email,
      notes,
      method,
      timestamp
    )
    values (
      v_item.id,
      v_stock.location_id,
      -v_lot_item.quantity,
      'checkout',
      v_now,
      auth.uid(),
      v_signed_email,
      'Live-sale bag ' || v_lot.lot_code || ' / auction ' || v_lot.auction_number ||
        ' packed for eBay order ' || coalesce(v_order.order_number, v_order.id::text) ||
        coalesce(' - ' || v_notes, ''),
      'shared_bag_checkout',
      v_now
    )
    returning id into v_tx_id;
    update public.stock_transactions set source_stock_location_row_id=v_stock.id,stock_condition='good',
     metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('order_line_id',v_line.id,'bag_lot_id',v_lot.id,'bag_item_id',v_lot_item.id)
     where id=v_tx_id;

    update public.live_sale_lot_items
    set status = 'packed',
        packed_order_line_id = v_line.id,
        packed_sale_item_id = v_sale_item_id,
        packed_stock_transaction_id = v_tx_id,
        packed_at = v_now
    where id = v_lot_item.id;

    if v_first_item_id is null then
      v_first_item_id := v_item.id;
      v_first_stock_row_id := v_stock.id;
      v_first_location_id := v_stock.location_id;
      v_first_sale_item_id := v_sale_item_id;
      v_first_tx_id := v_tx_id;
    end if;

    v_removed_units := v_removed_units + v_lot_item.quantity;
    v_cart_snapshot := v_cart_snapshot || jsonb_build_array(jsonb_build_object(
      'ebay_order_number', v_order.order_number,
      'ebay_item_number', v_line.item_number,
      'ebay_transaction_id', v_line.transaction_id,
      'ebay_buyer_username', v_order.buyer_username,
      'live_sale_session_id', v_lot.session_id,
      'live_sale_lot_id', v_lot.id,
      'auction_number', v_lot.auction_number,
      'lot_code', v_lot.lot_code,
      'lot_item_id', v_lot_item.id,
      'item_id', v_item.id,
      'title', v_item.title,
      'barcode', v_item.barcode,
      'quantity', v_lot_item.quantity,
      'allocated_sale_price', v_alloc_unit,
      'allocated_total', v_alloc_total,
      'source_stock_row_id', v_stock.id,
      'location_id', v_stock.location_id,
      'show_elapsed_seconds', v_lot_item.show_elapsed_seconds
    ));
  end loop;

  insert into public.sales_audit (
    external_sales_id,
    subtotal,
    credits_applied,
    owes_after_credit,
    per_item_discount,
    general_discount,
    effective_discount_pct,
    owes_store,
    platform_fee_amount,
    platform_fee_percent,
    profit_amount,
    platform,
    cart_snapshot,
    flagged,
    notes,
    verified_method,
    verified_at,
    created_at,
    email,
    user_id,
    credits_breakdown
  )
  values (
    v_order.order_number,
    v_line_total,
    0,
    v_line_total,
    0,
    0,
    0,
    v_line_total,
    v_fee_amount,
    v_fee_percent,
    v_net_payout,
    'ebay',
    v_cart_snapshot,
    false,
    coalesce(v_notes, 'Worker fulfilled pending eBay order from live-sale bag'),
    'authenticated_session',
    v_now,
    v_now,
    v_signed_email,
    auth.uid(),
    '[]'::jsonb
  );

  update public.live_sale_lots
  set status = 'packed',
      closed_at = v_now,
      matched_order_id = v_order.id,
      matched_order_line_id = v_line.id
  where id = v_lot.id;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    notes,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_packed_for_order',
    v_signed_email,
    v_notes,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'order_line_id', v_line.id,
      'packed_items', v_item_count,
      'removed_units', v_removed_units
    )
  );

  order_id := v_order.id;
  order_line_id := v_line.id;
  sale_id := v_sale_id;
  packed_items := v_item_count;
  removed_units := v_removed_units;
  first_item_id:=v_first_item_id;first_stock_row_id:=v_first_stock_row_id;first_location_id:=v_first_location_id;first_sale_item_id:=v_first_sale_item_id;first_tx_id:=v_first_tx_id;
  return next;
end;
$$;


create or replace function public.guard_ebay_live_reservation() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; increasing boolean;
begin
 if TG_OP='INSERT' then increasing:=NEW.status='reserved';
 else increasing:=NEW.status='reserved' and (OLD.status<>'reserved' or NEW.quantity>OLD.quantity or NEW.lot_id<>OLD.lot_id or NEW.session_id<>OLD.session_id or to_jsonb(NEW)->>'source_stock_location_row_id' is distinct from to_jsonb(OLD)->>'source_stock_location_row_id' or to_jsonb(NEW)->>'item_id' is distinct from to_jsonb(OLD)->>'item_id');end if;
 if TG_TABLE_NAME='live_sale_manual_lot_items' and TG_OP='UPDATE' and NEW.status='reserved' then increasing:=increasing or (to_jsonb(NEW)-array['quantity','edit_revision','notes']) is distinct from (to_jsonb(OLD)-array['quantity','edit_revision','notes']);end if;
 select ec.* into c from public.ebay_live_connections ec join public.live_sale_lots l on l.session_id=ec.session_id where l.id=NEW.lot_id;
 if not found then return NEW;end if;
 if NEW.session_id<>c.session_id then raise exception 'Bag and show do not match' using errcode='22023';end if;
 select * into a from public.ebay_live_attempts where lot_id=NEW.lot_id for update;
 if TG_OP='UPDATE' and NEW.status='packed' and OLD.status<>'packed' and (a.id is null or a.payment_state<>'paid' or a.resolved_at is not null) then raise exception 'Payment needs review before packing this bag' using errcode='22023';end if;
 if TG_TABLE_NAME='live_sale_lot_items' then
  if TG_OP='UPDATE' and NEW.item_id=OLD.item_id then NEW.live_unit_cost:=OLD.live_unit_cost;NEW.live_unit_minimum:=OLD.live_unit_minimum;end if;
 end if;
 if not increasing then return NEW;end if;
 if TG_TABLE_NAME='live_sale_lot_items' then
 if TG_OP='UPDATE' and OLD.status='packed' and NEW.status='reserved' and NEW.item_id=OLD.item_id
  and NEW.quantity=OLD.quantity and NEW.source_stock_location_row_id=OLD.source_stock_location_row_id and exists(
   select 1 from public.stock_transactions t where t.source_transaction_id=OLD.packed_stock_transaction_id and t.item_id=OLD.item_id
    and t.location_id=OLD.source_location_id and t.quantity=OLD.quantity and t.action_type='correction' and t.user_id=auth.uid() and t.timestamp=transaction_timestamp()) then return NEW;end if;
 -- Moving an existing hold into its exact bag does not allocate new stock.
 if TG_TABLE_NAME='live_sale_lot_items' and TG_OP='INSERT' and to_jsonb(NEW)->>'shared_transfer_id' is not null and exists(
  select 1 from public.shared_inventory_transfers t join public.pending_inventory_attachments p on p.order_line_id=t.order_line_id
  join public.shared_inventory_bag_links k on k.lot_id=t.lot_id and k.order_line_id=t.order_line_id
  where t.id=(to_jsonb(NEW)->>'shared_transfer_id')::uuid and t.lot_id=NEW.lot_id and t.item_id=NEW.item_id
   and t.stock_row_id=NEW.source_stock_location_row_id and t.quantity=NEW.quantity and p.status='linked' and p.linked_lot_id=NEW.lot_id
 ) then
  select cost,minimum_sale_price into NEW.live_unit_cost,NEW.live_unit_minimum from public.item_types where id=NEW.item_id;
  return NEW;
 end if;
 -- A paid bag already connected to Pending Orders can be corrected by packing
 -- staff after the show. Payment holds still prevent new stock allocation.
 if TG_TABLE_NAME='live_sale_lot_items' and a.payment_state='paid' and a.resolved_at is null
  and public.can_manage_inventory() and exists(select 1 from public.shared_inventory_bag_links k join public.ebay_order_lines l on l.id=k.order_line_id
    where k.lot_id=NEW.lot_id and l.line_status in ('pending','partially_fulfilled')) then
  if TG_OP='INSERT' or NEW.item_id<>OLD.item_id then
   select cost,minimum_sale_price into NEW.live_unit_cost,NEW.live_unit_minimum from public.item_types where id=NEW.item_id;
  end if;
 return NEW;
 end if;
 end if;

 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null or a.closed_at is not null then raise exception 'Select a paid, open eBay auction before scanning' using errcode='22023';end if;
 if a.claimed_by is distinct from auth.uid() then raise exception 'This bag is assigned to another scanner' using errcode='42501';end if;
 if not(public.ebay_live_scan_evidence_ok(c,a)) then raise exception 'Capture is disconnected. Recheck payment on eBay before scanning' using errcode='22023';end if;
 if TG_TABLE_NAME='live_sale_lot_items' then
  if TG_OP='INSERT' or NEW.item_id<>OLD.item_id then
   select case when cost>=0 and cost<>'NaN'::numeric then cost end,minimum_sale_price into NEW.live_unit_cost,NEW.live_unit_minimum from public.item_types where id=NEW.item_id;
  else NEW.live_unit_cost:=OLD.live_unit_cost;NEW.live_unit_minimum:=OLD.live_unit_minimum;end if;
 end if;
 return NEW;
end $$;

create table public.shared_inventory_consumptions (
 lot_id uuid primary key references public.live_sale_lots(id),order_line_id uuid not null references public.ebay_order_lines(id),
 result jsonb not null,created_at timestamptz not null default now(),reversed_at timestamptz
);
alter table public.shared_inventory_consumptions enable row level security;
revoke all on public.shared_inventory_consumptions from public,anon,authenticated;

create function public.shared_inventory_snapshot(_lot uuid) returns text language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_object('bag',(select jsonb_build_array(status,matched_order_line_id) from public.live_sale_lots where id=_lot),
  'link',(select order_line_id from public.shared_inventory_bag_links where lot_id=_lot),
  'review',(select jsonb_build_array(reason,resolved_at) from public.shared_inventory_reviews where lot_id=_lot),
  'items',(select coalesce(jsonb_agg(jsonb_build_array(id,item_id,source_stock_location_row_id,quantity,status) order by id),'[]')
   from public.live_sale_lot_items where lot_id=_lot and status in ('reserved','packed')))::text);
$$;

create function public.get_shared_bag_inventory(_lot_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 select jsonb_build_object('kind','bag','lot_id',b.id,'lot_code',b.lot_code,'bag_number',coalesce(substring(e.listing_title from '#\s*([[:alnum:]][[:alnum:]-]*)'),b.auction_number),
  'order_line_id',k.order_line_id,'revision',public.shared_inventory_snapshot(b.id),'status',case when b.status='packed' then 'consumed' else 'reserved' end,
  'remaining_quantity',coalesce((select sum(quantity) from public.live_sale_lot_items where lot_id=b.id and status='reserved'),0),
  'checkout_store_id',coalesce(k.checkout_store_id,s.store_id),'conflict',(select reason from public.shared_inventory_reviews where lot_id=b.id and resolved_at is null),
  'pending_attachment',(select to_jsonb(p)||jsonb_build_object('item',to_jsonb(i),'location',to_jsonb(l)) from public.pending_inventory_attachments p
   join public.item_types i on i.id=p.item_id join public.item_stock_locations st on st.id=p.stock_location_row_id join public.locations l on l.id=st.location_id
   where p.order_line_id=k.order_line_id and p.status='reserved'),
  'items',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('id',x.id,'item_id',x.item_id,'stock_location_row_id',x.source_stock_location_row_id,
    'quantity',x.quantity,'status',x.status,'item',jsonb_build_object('id',i.id,'title',i.title,'barcode',i.barcode,'photo_url',i.photo_url,'photos',i.photos,'weight',i.weight,'sale_price',i.sale_price),
    'source_location',to_jsonb(l),
    'location',jsonb_build_object('id',l.id,'location_name',l.location_name,'location_code',l.location_code)) order by x.scanned_at,x.id)
   from public.live_sale_lot_items x join public.item_types i on i.id=x.item_id join public.locations l on l.id=x.source_location_id
   where x.lot_id=b.id and x.status in ('reserved','packed')),'[]')) into result
 from public.live_sale_lots b join public.live_sale_sessions s on s.id=b.session_id
 left join public.shared_inventory_bag_links k on k.lot_id=b.id left join public.ebay_live_attempts e on e.lot_id=b.id where b.id=_lot_id;
 if result is null then raise exception 'Bag not found' using errcode='22023';end if;
 return result;
end $$;

create function public.get_shared_pending_inventory(_order_line_ids uuid[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 if cardinality(_order_line_ids)>2000 then raise exception 'Load at most 2000 item lines at once' using errcode='22023';end if;
 select coalesce(jsonb_agg(r),'[]') into rows from (
  select public.get_shared_bag_inventory(k.lot_id) r from public.shared_inventory_bag_links k where k.order_line_id=any(_order_line_ids)
  union all select a||jsonb_build_object('kind','attachment') from jsonb_array_elements(public.get_pending_inventory_attachments(_order_line_ids)) a
   where not exists(select 1 from public.shared_inventory_bag_links k where k.order_line_id=(a->>'order_line_id')::uuid)
 ) q;
 return rows;
end $$;

-- An old Attach Inventory dialog cannot add another reservation to a linked bag.
alter function public.save_pending_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer) rename to save_pending_inventory_attachment_standalone;
create function public.save_pending_inventory_attachment(_order_line_id uuid,_item_id uuid,_stock_location_row_id uuid,_checkout_store_id uuid,_quantity integer,_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.lock_shared_inventory();
 if exists(select 1 from public.shared_inventory_bag_links where order_line_id=_order_line_id) then
  raise exception 'This order uses its bag inventory. Refresh and open Manage bag inventory; no second reservation was made.' using errcode='22023';
 end if;
 if _quantity>0 and exists(select 1 from public.live_sale_lot_items x where x.item_id=_item_id and x.source_stock_location_row_id=_stock_location_row_id and x.status='reserved'
  and not exists(select 1 from public.shared_inventory_bag_links k where k.lot_id=x.lot_id)) then
  raise exception 'This inventory is already in an unlinked bag. Connect that bag or confirm a different physical unit before attaching.' using errcode='22023';end if;
 return public.save_pending_inventory_attachment_standalone(_order_line_id,_item_id,_stock_location_row_id,_checkout_store_id,_quantity,_expected_revision);
end $$;

-- Both pages explicitly SET a quantity, with a manifest revision. Repeated
-- scans never mean +1. Changing another device's manifest requires reloading.
create function public.save_shared_bag_inventory(_lot_id uuid,_item_id uuid,_stock_location_row_id uuid,_checkout_store_id uuid,
 _quantity integer,_expected_revision text) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.live_sale_lots; lid uuid; oldqty integer; available integer; src public.item_stock_locations; mail text;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();
 perform public.assert_shared_inventory(_lot_id);
 if _expected_revision is distinct from public.shared_inventory_snapshot(_lot_id) then raise exception 'The bag contents changed. Reopen them before saving.' using errcode='40001';end if;
 select * into b from public.live_sale_lots where id=_lot_id for update;
 if b.id is null or b.status not in ('open','reserved','released') then raise exception 'This bag is already completed or cancelled.' using errcode='22023';end if;
 select order_line_id into lid from public.shared_inventory_bag_links where lot_id=b.id;
 if lid is null then raise exception 'Connect this bag to its pending order before editing here.' using errcode='22023';end if;
 perform 1 from public.ebay_order_lines where id=lid and line_status in ('pending','partially_fulfilled') for update;
 if not found then raise exception 'This order is no longer pending.' using errcode='22023';end if;
 if _quantity is null or _quantity<0 or _quantity>100000 then raise exception 'Choose a valid whole quantity.' using errcode='22023';end if;
 select coalesce(sum(quantity),0) into oldqty from public.live_sale_lot_items where lot_id=b.id and item_id=_item_id and source_stock_location_row_id=_stock_location_row_id and status='reserved';
 if oldqty=_quantity then return public.get_shared_bag_inventory(b.id);end if;
 select email into mail from auth.users where id=auth.uid();
 select * into src from public.item_stock_locations where id=_stock_location_row_id and item_id=_item_id for update;
 if _quantity>0 then
  if exists(select 1 from public.shared_inventory_bag_links k where k.lot_id=b.id and k.checkout_store_id is not null and k.checkout_store_id<>_checkout_store_id)
   and exists(select 1 from public.live_sale_lot_items where lot_id=b.id and status='reserved') then
   raise exception 'Keep this bag inventory in its packing store. Move the physical stock before changing stores.' using errcode='22023';end if;
  select (r->>'quantity')::integer into available from jsonb_array_elements(public.get_pending_checkout_stock(_item_id,lid,_checkout_store_id)) r where (r->>'id')::uuid=src.id;
  if available is null or _quantity>available then raise exception 'That quantity is unavailable at the chosen store.' using errcode='22023';end if;
 end if;
 update public.live_sale_lot_items set status='released',notes=concat_ws(' | ',notes,'Shared inventory quantity changed')
  where lot_id=b.id and item_id=_item_id and source_stock_location_row_id=_stock_location_row_id and status='reserved';
 if _quantity>0 then
  insert into public.live_sale_lot_items(lot_id,session_id,item_id,source_stock_location_row_id,source_location_id,quantity,scanned_by,scanned_by_email,notes)
   values(b.id,b.session_id,_item_id,src.id,src.location_id,_quantity,auth.uid(),mail,'Quantity confirmed in shared bag inventory');
 end if;
 update public.live_sale_lots set status=case when exists(select 1 from public.live_sale_lot_items where lot_id=b.id and status='reserved') then 'reserved' else 'open' end where id=b.id;
 if _quantity>0 then update public.shared_inventory_bag_links set checkout_store_id=_checkout_store_id where lot_id=b.id;end if;
 insert into public.live_sale_events(session_id,lot_id,item_id,event_type,actor_email,payload)
  values(b.session_id,b.id,_item_id,'shared_inventory_quantity_changed',mail,jsonb_build_object('order_line_id',lid,'source',src.id,'previous_quantity',oldqty,'quantity',_quantity));
 update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array[_item_id::text],updated_at=now() where id='inventory';
 return public.get_shared_bag_inventory(b.id);
end $$;

alter function public.reserve_live_sale_item(uuid,text,uuid,integer,text,text) rename to reserve_live_sale_item_original;
create function public.reserve_live_sale_item(_lot_id uuid,_item_barcode text,_stock_location_row_id uuid default null,_quantity integer default 1,_signed_by_email text default null,_notes text default null)
returns table(lot_item_id uuid,lot_id uuid,item_id uuid,title text,barcode text,source_stock_location_row_id uuid,source_location_id uuid,source_location_name text,source_location_code text,quantity integer,remaining_available integer,show_elapsed_seconds integer)
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();perform public.unify_shared_inventory(_lot_id);perform public.assert_shared_inventory(_lot_id);
 if exists(select 1 from public.live_sale_lot_items x join public.item_types i on i.id=x.item_id where x.lot_id=_lot_id and x.status='reserved'
   and regexp_replace(lower(i.barcode),'[\s-]+','','g')=regexp_replace(lower(btrim(_item_barcode)),'[\s-]+','','g')) then
  return query select x.id,x.lot_id,i.id,i.title,i.barcode,x.source_stock_location_row_id,x.source_location_id,l.location_name,l.location_code,x.quantity,
   public.get_available_stock_after_reservations(x.source_stock_location_row_id),x.show_elapsed_seconds
   from public.live_sale_lot_items x join public.item_types i on i.id=x.item_id join public.locations l on l.id=x.source_location_id
   where x.lot_id=_lot_id and x.status='reserved' and regexp_replace(lower(i.barcode),'[\s-]+','','g')=regexp_replace(lower(btrim(_item_barcode)),'[\s-]+','','g');
  return;
 end if;
 return query select * from public.reserve_live_sale_item_original(_lot_id,_item_barcode,_stock_location_row_id,_quantity,_signed_by_email,_notes);
end $$;

create function public.complete_shared_bag_inventory() returns trigger language plpgsql security definer set search_path='' as $$
declare bag uuid; r record; delta integer; groups integer; unitcount integer; x public.live_sale_lot_items; result jsonb; store uuid;
begin
 if new.fulfilled_quantity=old.fulfilled_quantity and new.line_status=old.line_status then return new;end if;
 select lot_id into bag from public.shared_inventory_bag_links where order_line_id=old.id;
 if bag is null then return new;end if;
 if new.line_status in ('cancelled','skipped') then
  if exists(select 1 from public.live_sale_lot_items where lot_id=bag and status='reserved') then
   perform public.shared_inventory_review(bag,old.id,'This order was cancelled while its bag still holds inventory. Verify the physical contents before releasing them.');
  end if;
  return new;
 end if;
 delta:=new.fulfilled_quantity-old.fulfilled_quantity;
 if delta<=0 then return new;end if;
 perform public.assert_shared_inventory(bag);
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) or new.fulfilled_by is distinct from auth.uid() then
  raise exception 'A signed-in packing employee must complete this bag.' using errcode='42501';end if;
 select email into new.fulfilled_by_email from auth.users where id=auth.uid();
 select count(*),coalesce(sum(quantity),0) into groups,unitcount from public.live_sale_lot_items where lot_id=bag and status='reserved';
 if groups=0 then return new;end if;
 if new.fulfilled_quantity<>new.quantity or old.fulfilled_quantity<>0 then raise exception 'Complete the entire linked bag together; partial bag checkout needs inventory review.' using errcode='22023';end if;
 if exists(select 1 from public.shared_inventory_consumptions where lot_id=bag and reversed_at is null) then raise exception 'This bag inventory was already deducted. Refresh the order.' using errcode='23505';end if;
 select coalesce(k.checkout_store_id,s.store_id) into store from public.live_sale_lots b join public.live_sale_sessions s on s.id=b.session_id
  join public.shared_inventory_bag_links k on k.lot_id=b.id where b.id=bag;
 if store is null then raise exception 'Set the bag store before completing its inventory.' using errcode='22023';end if;
 if new.stock_transaction_id is not null and new.stock_transaction_id is distinct from old.stock_transaction_id then
  select * into x from public.live_sale_lot_items where lot_id=bag and status='reserved' limit 1;
  if groups<>1 or new.internal_item_id is distinct from x.item_id or new.stock_location_row_id is distinct from x.source_stock_location_row_id
   or not exists(select 1 from public.stock_transactions t where t.id=new.stock_transaction_id and t.item_id=x.item_id and t.location_id=x.source_location_id
    and t.quantity=-x.quantity and t.action_type='checkout' and t.user_id=auth.uid() and t.timestamp=transaction_timestamp()) then
   raise exception 'This order uses its full bag inventory. Refresh and complete the bag together.' using errcode='22023';end if;
  update public.live_sale_lot_items set status='packed',packed_order_line_id=old.id,packed_sale_item_id=new.sale_item_id,packed_stock_transaction_id=new.stock_transaction_id,packed_at=now() where id=x.id;
  update public.live_sale_lots set status='packed',matched_order_id=old.order_id,matched_order_line_id=old.id,closed_at=now() where id=bag;
  result:=jsonb_build_object('order_id',old.order_id,'order_line_id',old.id,'sale_id',new.sale_id,'packed_items',1,'removed_units',x.quantity);
 else
  select * into r from public.consume_shared_inventory_bag(old.id,bag,new.notes,new.fulfilled_by_email,store);
  new.internal_item_id:=r.first_item_id;new.stock_location_row_id:=r.first_stock_row_id;new.location_id:=r.first_location_id;
  new.sale_id:=r.sale_id;new.sale_item_id:=r.first_sale_item_id;new.stock_transaction_id:=r.first_tx_id;
  result:=to_jsonb(r);
 end if;
 if new.notes='Completed without inventory removal: physical item present, not entered in inventory yet.' then new.notes:=null;end if;
 new.notes:=concat_ws(E'\n',nullif(new.notes,''),'Linked bag inventory deducted once at packing handoff.');
 insert into public.shared_inventory_consumptions(lot_id,order_line_id,result) values(bag,old.id,result)
  on conflict(lot_id) do update set result=excluded.result,created_at=now(),reversed_at=null;
 update public.pending_inventory_attachments set status='consumed',consumed_quantity=quantity,revision=revision+1,updated_at=now() where order_line_id=old.id and status='linked';
 update public.metadata set inventory_version=gen_random_uuid()::text,
  changed_item_ids=array(select distinct item_id::text from public.live_sale_lot_items where lot_id=bag),updated_at=now() where id='inventory';
 return new;
end $$;
create trigger a_shared_inventory_completion before update of line_status,fulfilled_quantity on public.ebay_order_lines for each row execute function public.complete_shared_bag_inventory();

-- The original public bag checkout now enters the same completion trigger as
-- Complete Order. A retry returns its recorded result without touching stock.
create or replace function public.fulfill_ebay_order_line_with_live_lot(_order_line_id uuid,_lot_id uuid,_notes text default null,_signed_by_email text default null,_checkout_store_id uuid default null)
returns table(order_id uuid,order_line_id uuid,sale_id uuid,packed_items integer,removed_units integer)
language plpgsql security definer set search_path='' as $$
declare prior jsonb; linked uuid; email text; l public.ebay_order_lines;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();
 select result into prior from public.shared_inventory_consumptions where lot_id=_lot_id and shared_inventory_consumptions.order_line_id=_order_line_id and reversed_at is null;
 if prior is null then
  select k.order_line_id into linked from public.shared_inventory_bag_links k where k.lot_id=_lot_id;
  if linked is null then
   perform public.set_live_bag_order_link(_lot_id,_order_line_id,(select k.order_line_id from public.live_bag_order_links k where k.lot_id=_lot_id));
   perform public.unify_shared_inventory(_lot_id);
  elsif linked<>_order_line_id then raise exception 'This bag is linked to another order.' using errcode='22023';end if;
  perform public.assert_shared_inventory(_lot_id);
  if not exists(select 1 from public.live_sale_lot_items where lot_id=_lot_id and status='reserved') then raise exception 'This bag has no inventory to complete.' using errcode='22023';end if;
  select * into l from public.ebay_order_lines where id=_order_line_id for update;
  if l.line_status not in ('pending','partially_fulfilled') then raise exception 'This order line is already completed.' using errcode='23505';end if;
  select u.email into email from auth.users u where u.id=auth.uid();
  update public.ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled',fulfilled_by=auth.uid(),fulfilled_by_email=email,fulfilled_at=now(),notes=_notes where id=_order_line_id;
  update public.ebay_orders o set status=case when not exists(select 1 from public.ebay_order_lines x where x.order_id=o.id and x.line_status not in ('fulfilled','cancelled','skipped'))
   then 'fulfilled' else 'partially_fulfilled' end where o.id=l.order_id;
  select result into prior from public.shared_inventory_consumptions c where c.lot_id=_lot_id;
 end if;
 return query select (prior->>'order_id')::uuid,(prior->>'order_line_id')::uuid,(prior->>'sale_id')::uuid,(prior->>'packed_items')::integer,(prior->>'removed_units')::integer;
end $$;

-- Refuse changing a proven connection while its contents are reserved/packed.
create function public.guard_shared_bag_link_change() returns trigger language plpgsql security definer set search_path='' as $$
declare bag uuid; line_id uuid;
begin
 if TG_OP<>'DELETE' and exists(select 1 from public.shared_inventory_bag_links k where k.order_line_id=new.order_line_id and k.lot_id<>new.lot_id) then
  raise exception 'This order line already has a linked bag. Verify its connection before assigning a different bag.' using errcode='22023';end if;
 if TG_OP='INSERT' then return new;end if;
 bag:=old.lot_id;
 select order_line_id into line_id from public.shared_inventory_bag_links where lot_id=bag;
 if line_id is not null and (TG_OP='DELETE' or new.order_line_id is distinct from line_id)
  and exists(select 1 from public.live_sale_lot_items where lot_id=bag and status in ('reserved','packed')) then
  raise exception 'This bag already shares inventory with its order. Review or release its contents before changing the link.' using errcode='22023';end if;
 return case when TG_OP='DELETE' then old else new end;
end $$;
create trigger shared_inventory_link_change before insert or update or delete on public.live_bag_order_links for each row execute function public.guard_shared_bag_link_change();

create function public.get_inventory_bag_candidates(_item_id uuid,_stock_location_row_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('lot_id',b.id,'lot_code',b.lot_code,'bag_number',coalesce(substring(e.listing_title from '#\s*([[:alnum:]][[:alnum:]-]*)'),b.auction_number),
  'buyer',to_jsonb(e)->>'buyer','title',e.listing_title,'show_date',s.started_at,'quantity',x.quantity,'revision',public.shared_inventory_snapshot(b.id))),'[]') into result
 from public.live_sale_lot_items x join public.live_sale_lots b on b.id=x.lot_id join public.live_sale_sessions s on s.id=b.session_id
 left join public.ebay_live_attempts e on e.lot_id=b.id
 where x.status='reserved' and x.item_id=_item_id and (_stock_location_row_id is null or x.source_stock_location_row_id=_stock_location_row_id)
  and not exists(select 1 from public.shared_inventory_bag_links k where k.lot_id=x.lot_id);
 return result;
end $$;

create function public.save_pending_inventory_attachment_checked(_order_line_id uuid,_item_id uuid,_stock_location_row_id uuid,_checkout_store_id uuid,
 _quantity integer,_expected_revision integer,_separate_units boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.lock_shared_inventory();
 if not coalesce(_separate_units,false) then return public.save_pending_inventory_attachment(_order_line_id,_item_id,_stock_location_row_id,_checkout_store_id,_quantity,_expected_revision);end if;
 if exists(select 1 from public.shared_inventory_bag_links where order_line_id=_order_line_id) then raise exception 'This order already uses its bag inventory.' using errcode='22023';end if;
 result:=public.save_pending_inventory_attachment_standalone(_order_line_id,_item_id,_stock_location_row_id,_checkout_store_id,_quantity,_expected_revision);
 insert into public.pending_inventory_attachment_events(order_line_id,action,snapshot,created_by)
  values(_order_line_id,'separate_physical_units_confirmed',jsonb_build_object('item_id',_item_id,'source',_stock_location_row_id,'quantity',_quantity,
   'other_bags',public.get_inventory_bag_candidates(_item_id,_stock_location_row_id)),auth.uid());
 return result;
end $$;

create function public.connect_existing_inventory_bag(_lot_id uuid,_order_line_id uuid,_expected_revision text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();
 if _expected_revision is distinct from public.shared_inventory_snapshot(_lot_id) then raise exception 'The bag changed. Reopen it before connecting.' using errcode='40001';end if;
 perform public.set_live_bag_order_link(_lot_id,_order_line_id,(select order_line_id from public.live_bag_order_links where lot_id=_lot_id));
 perform public.unify_shared_inventory(_lot_id);perform public.assert_shared_inventory(_lot_id);
 return public.get_shared_bag_inventory(_lot_id);
end $$;

create function public.resolve_shared_inventory_overlap(_lot_id uuid,_choice text,_note text,_expected_revision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lid uuid; a public.pending_inventory_attachments; before_state jsonb; b public.live_sale_lots;ids uuid[];
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 if _choice not in ('bag','attachment') or length(btrim(coalesce(_note,''))) not between 3 and 2000 then raise exception 'Select the verified contents and explain the correction.' using errcode='22023';end if;
 perform public.lock_shared_inventory();
 if _expected_revision is distinct from public.shared_inventory_snapshot(_lot_id) then raise exception 'The bag contents changed. Reopen them before saving.' using errcode='40001';end if;
 select order_line_id into lid from public.shared_inventory_bag_links where lot_id=_lot_id;
 select * into b from public.live_sale_lots where id=_lot_id for update;
 select * into a from public.pending_inventory_attachments where order_line_id=lid and status='reserved' for update;
 if not found or a.consumed_quantity<>0 or not exists(select 1 from public.ebay_order_lines where id=lid and line_status='pending' and fulfilled_quantity=0) then
  raise exception 'This review needs an untouched pending attachment and order.' using errcode='22023';end if;
 select array_agg(distinct x) filter(where x is not null) into ids from (
  select order_line_id x from public.live_bag_order_links where lot_id=_lot_id union all select order_line_id from public.ebay_live_attempts where lot_id=_lot_id union all select b.matched_order_line_id) q;
 if cardinality(ids)<>1 or ids[1]<>lid then raise exception 'Correct the conflicting order connections first.' using errcode='22023';end if;
 before_state:=public.get_shared_bag_inventory(_lot_id);
 if _choice='bag' then
  if not exists(select 1 from public.live_sale_lot_items where lot_id=_lot_id and status='reserved') then raise exception 'The bag has no inventory to keep.' using errcode='22023';end if;
  update public.pending_inventory_attachments set status='linked',linked_lot_id=_lot_id,revision=revision+1,updated_at=now() where order_line_id=lid;
  update public.ebay_order_line_reservations set status='released' where order_line_id=lid and status='reserved';
 else
  update public.live_sale_lot_items set status='released',notes=concat_ws(' | ',notes,'Physical contents reviewed: '||_note) where lot_id=_lot_id and status='reserved';
 end if;
 update public.shared_inventory_reviews set resolved_at=now(),updated_at=now() where lot_id=_lot_id;
 insert into public.pending_inventory_attachment_events(order_line_id,action,snapshot,created_by)
  values(lid,'shared_overlap_confirmed',jsonb_build_object('lot_id',_lot_id,'attachment_revision',a.revision,'choice',_choice,'note',_note),auth.uid());
 perform public.unify_shared_inventory(_lot_id);perform public.assert_shared_inventory(_lot_id);
 insert into public.live_sale_events(session_id,lot_id,event_type,actor_email,notes,payload)
  values(b.session_id,b.id,'shared_inventory_overlap_resolved',(select email from auth.users where id=auth.uid()),_note,
   jsonb_build_object('choice',_choice,'before',before_state,'after',public.get_shared_bag_inventory(b.id)));
 return public.get_shared_bag_inventory(b.id);
end $$;

-- Acquire the shared lock before legacy functions acquire row/table locks.
-- Their signatures, permissions, evidence and accounting remain unchanged.
do $$ declare f record;definition text;patched text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language lang on lang.oid=p.prolang where n.nspname='public' and lang.lanname='plpgsql'
  and p.proname=any(array['set_live_sale_lot_group_quantity','correct_live_sale_lot_item_group','cancel_live_sale_lot','release_live_sale_lot_item',
   'cancel_live_sale_session','set_live_bag_order_link','fulfill_ebay_order_line','fulfill_pending_checkout_bundle',
   'complete_ebay_order_lines_without_inventory_evidence','complete_ebay_order_lines_without_inventory','complete_ebay_order_line_without_inventory','complete_ebay_orders_without_inventory','admin_revert_ebay_order_lines']) loop
  definition:=pg_get_functiondef(f.oid);
  patched:=regexp_replace(definition,E'(\n[ \\t]*)begin([ \\r]*\n)',E'\\1begin\\2  perform public.lock_shared_inventory();\n','i');
  if patched=definition then raise exception 'Shared lock could not be installed in %',f.oid::regprocedure;end if;
  execute patched;
 end loop;
end $$;

-- Legacy single-item bundle checkout can reuse a matching one-item bag. A
-- multi-item bag must be reviewed as a whole; no partial/different scan wins.
alter function public.fulfill_pending_checkout_bundle(uuid,uuid,jsonb,text,uuid) rename to fulfill_pending_checkout_bundle_original;
create function public.fulfill_pending_checkout_bundle(_request_id uuid,_checkout_store_id uuid,_lines jsonb,_notes text default null,_seller_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare entry jsonb;entries jsonb:='[]';bag uuid;group_count integer;matches integer;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.lock_shared_inventory();
 if jsonb_typeof(_lines)<>'array' then raise exception 'Stage at least one order line' using errcode='22023';end if;
 for entry in select * from jsonb_array_elements(_lines) loop
  select lot_id into bag from public.shared_inventory_bag_links where order_line_id=(entry->>'order_line_id')::uuid;
  if bag is not null and coalesce(entry->>'mode','inventory')='inventory' then
   perform public.assert_shared_inventory(bag);
   select count(*),count(*) filter(where item_id=(entry->>'item_id')::uuid and source_stock_location_row_id=(entry->>'stock_location_row_id')::uuid and quantity=(entry->>'quantity')::integer)
    into group_count,matches from public.live_sale_lot_items where lot_id=bag and status in ('reserved','packed');
   if group_count<>1 or matches<>1 then raise exception 'Review and complete this order using its full bag inventory.' using errcode='22023';end if;
   entry:=entry||jsonb_build_object('mode','without_inventory');
  end if;
  entries:=entries||jsonb_build_array(entry);
 end loop;
 return public.fulfill_pending_checkout_bundle_original(_request_id,_checkout_store_id,entries,_notes,_seller_employee_id);
end $$;
revoke all on function public.fulfill_pending_checkout_bundle_original(uuid,uuid,jsonb,text,uuid),public.fulfill_pending_checkout_bundle(uuid,uuid,jsonb,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fulfill_pending_checkout_bundle(uuid,uuid,jsonb,text,uuid) to authenticated;

create function public.audit_shared_inventory_closeout() returns trigger language plpgsql security definer set search_path='' as $$
declare removals jsonb;
begin
 select jsonb_agg(jsonb_build_object('lot_id',lot_id,'order_line_id',order_line_id,'result',result)) into removals
 from public.shared_inventory_consumptions where order_line_id=any(new.order_line_ids) and created_at=transaction_timestamp() and reversed_at is null;
 if removals is not null then new.payload:=coalesce(new.payload,'{}')||jsonb_build_object('shared_bag_inventory_removals',removals);
  if new.notes='Completed without inventory removal: physical item present, not entered in inventory yet.' then new.notes:='Completed pending items; shared bag inventory deducted once.';end if;
 end if;
 return new;
end $$;
create trigger shared_inventory_closeout_audit before insert on public.ebay_order_admin_events for each row execute function public.audit_shared_inventory_closeout();
revoke all on function public.audit_shared_inventory_closeout() from public,anon,authenticated,service_role;

-- The fast bag locator remains read-only. Its existing Item Found confirmation
-- can connect the exact scanned bag after the worker checks the order/content.
create function public.get_pending_scanned_inventory(_scan text,_order_line_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare code text:=upper(btrim(_scan));ref text;ids uuid[];lookup jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 lookup:=public.find_pending_order_bag(code);
 if not exists(select 1 from jsonb_array_elements(lookup->'matches') x where x#>>'{line,id}'=_order_line_id::text) then raise exception 'Scan no longer matches that pending order.' using errcode='22023';end if;
 ref:=regexp_replace(regexp_replace(code,'^#',''),'^0+([0-9])','\1');
 select array_agg(b.id) into ids from public.live_sale_lots b
 left join public.shared_inventory_bag_links k on k.lot_id=b.id left join public.ebay_live_attempts a on a.lot_id=b.id
 where b.status in ('open','reserved') and exists(select 1 from public.live_sale_lot_items i where i.lot_id=b.id and i.status='reserved')
  and (coalesce(k.order_line_id,a.order_line_id) is null or coalesce(k.order_line_id,a.order_line_id)=_order_line_id)
  and (b.lot_code=code or (code not like 'LIVE-%' and (
   regexp_replace(regexp_replace(upper(btrim(b.auction_number)),'^#',''),'^0+([0-9])','\1')=ref
   or regexp_replace(upper(substring(a.listing_title from '#\s*([[:alnum:]][[:alnum:]-]*)')),'^0+([0-9])','\1')=ref)));
 if cardinality(ids)=1 then return jsonb_build_object('bag',public.get_shared_bag_inventory(ids[1]),'ambiguous',false);end if;
 return jsonb_build_object('bag',null,'ambiguous',coalesce(cardinality(ids),0)>1);
end $$;
revoke all on function public.get_pending_scanned_inventory(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_pending_scanned_inventory(text,uuid) to authenticated;

-- Audit and normalize only verified identities. No stock is restored, sold, or
-- removed by this migration; mismatches remain held and are flagged for review.
do $$ declare bag record;begin
 for bag in select distinct lot_id from public.ebay_live_attempts where lot_id is not null and order_line_id is not null
  union select lot_id from public.live_bag_order_links loop perform public.unify_shared_inventory(bag.lot_id);end loop;
end $$;

revoke all on function public.lock_shared_inventory(),public.lock_shared_inventory_statement(),public.shared_inventory_review(uuid,uuid,text),
 public.unify_shared_inventory(uuid),public.sync_shared_inventory_link(),public.assert_shared_inventory(uuid),public.shared_inventory_snapshot(uuid),
 public.reserve_ebay_order_line_stock_attachment(uuid),public.save_pending_inventory_attachment_standalone(uuid,uuid,uuid,uuid,integer,integer),
 public.reserve_live_sale_item_original(uuid,text,uuid,integer,text,text),public.consume_shared_inventory_bag(uuid,uuid,text,text,uuid),
 public.guard_shared_order_reservation(),public.guard_shared_bag_item(),public.complete_shared_bag_inventory(),public.guard_shared_bag_link_change(),
 public.get_shared_bag_inventory(uuid),public.get_shared_pending_inventory(uuid[]),public.save_shared_bag_inventory(uuid,uuid,uuid,uuid,integer,text),
 public.reserve_live_sale_item(uuid,text,uuid,integer,text,text),public.save_pending_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer)
 from public,anon,authenticated,service_role;
grant execute on function public.get_shared_bag_inventory(uuid),public.get_shared_pending_inventory(uuid[]),public.save_shared_bag_inventory(uuid,uuid,uuid,uuid,integer,text),
 public.reserve_live_sale_item(uuid,text,uuid,integer,text,text),public.save_pending_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer) to authenticated;
grant execute on function public.reserve_ebay_order_line_stock(uuid) to authenticated,service_role;
revoke all on function public.get_inventory_bag_candidates(uuid,uuid),public.save_pending_inventory_attachment_checked(uuid,uuid,uuid,uuid,integer,integer,boolean),
 public.connect_existing_inventory_bag(uuid,uuid,text),public.resolve_shared_inventory_overlap(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_inventory_bag_candidates(uuid,uuid),public.save_pending_inventory_attachment_checked(uuid,uuid,uuid,uuid,integer,integer,boolean),
 public.connect_existing_inventory_bag(uuid,uuid,text),public.resolve_shared_inventory_overlap(uuid,text,text,text) to authenticated;
revoke all on function public.reserve_ebay_order_line_stock(uuid) from public,anon;
notify pgrst,'reload schema';
commit;

