begin;
set local lock_timeout='3s';
set local statement_timeout='90s';

-- One explicitly selected inventory source per eBay item line. Historical
-- changes and removals are retained separately; browser staging is not a hold.
create table public.pending_inventory_attachments (
 order_line_id uuid primary key references public.ebay_order_lines(id),
 item_id uuid not null references public.item_types(id),
 stock_location_row_id uuid not null references public.item_stock_locations(id),
 checkout_store_id uuid not null references public.store_locations(id),
 quantity integer not null check(quantity>0),
 consumed_quantity integer not null default 0 check(consumed_quantity>=0 and consumed_quantity<=quantity),
 status text not null default 'reserved' check(status in ('reserved','consumed','released','cancelled')),
 revision integer not null default 1, attached_by uuid not null, attached_by_email text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pending_inventory_attachment_events (
 id uuid primary key default gen_random_uuid(), order_line_id uuid not null references public.ebay_order_lines(id),
 action text not null, snapshot jsonb not null, stock_transaction_id uuid,
 created_by uuid, created_at timestamptz not null default now()
);
create index pending_inventory_attachment_events_line_idx on public.pending_inventory_attachment_events(order_line_id,created_at);
alter table public.pending_inventory_attachments enable row level security;
alter table public.pending_inventory_attachment_events enable row level security;
revoke all on public.pending_inventory_attachments,public.pending_inventory_attachment_events from public,anon,authenticated;

create function public.get_pending_inventory_attachments(_order_line_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 if cardinality(_order_line_ids)>2000 then raise exception 'Load at most 2000 item lines at once' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object(
  'item',jsonb_build_object('id',i.id,'title',i.title,'barcode',i.barcode,'photo_url',i.photo_url,'photos',i.photos),
  'location',jsonb_build_object('id',l.id,'location_name',l.location_name,'location_code',l.location_code),
  'store_name',s.name,'remaining_quantity',a.quantity-a.consumed_quantity)),'[]') into result
 from public.pending_inventory_attachments a join public.item_types i on i.id=a.item_id
 join public.item_stock_locations r on r.id=a.stock_location_row_id
 join public.locations l on l.id=r.location_id join public.store_locations s on s.id=a.checkout_store_id
 where a.order_line_id=any(_order_line_ids);
 return result;
end $$;

-- Retain the automatic SKU allocator for lines that have never been manually
-- attached. Re-syncing must not replace a worker's item, source or quantity.
alter function public.reserve_ebay_order_line_stock(uuid) rename to reserve_ebay_order_line_stock_automatic;
revoke all on function public.reserve_ebay_order_line_stock_automatic(uuid) from public,anon,authenticated,service_role;
create function public.reserve_ebay_order_line_stock(_order_line_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.pending_inventory_attachments; l public.ebay_order_lines; n integer;
begin
 if pg_trigger_depth()=0 and coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
  and not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into l from public.ebay_order_lines where id=_order_line_id for update;
 select * into a from public.pending_inventory_attachments where order_line_id=_order_line_id;
 if not found then return public.reserve_ebay_order_line_stock_automatic(_order_line_id);end if;
 n:=a.quantity-a.consumed_quantity;
 if a.status='reserved' and n>0 and l.line_status in ('pending','partially_fulfilled') then
  if n>l.quantity-l.fulfilled_quantity then raise exception 'Attached inventory exceeds the remaining order quantity. Review the attachment first.' using errcode='22023';end if;
  insert into public.ebay_order_line_reservations(order_id,order_line_id,item_id,stock_location_row_id,location_id,quantity,status,source,raw_payload)
  select l.order_id,l.id,a.item_id,a.stock_location_row_id,s.location_id,n,'reserved','pending_attachment',jsonb_build_object('attachment_revision',a.revision)
  from public.item_stock_locations s where s.id=a.stock_location_row_id
  on conflict(order_line_id) do update set item_id=excluded.item_id,stock_location_row_id=excluded.stock_location_row_id,
   location_id=excluded.location_id,quantity=excluded.quantity,status='reserved',source='pending_attachment',raw_payload=excluded.raw_payload;
 else
  update public.ebay_order_line_reservations set status=case when a.status='cancelled' then 'cancelled' when a.status='consumed' then 'fulfilled' else 'released' end
   where order_line_id=_order_line_id and status='reserved';
 end if;
 return jsonb_build_object('ok',true,'status',a.status,'quantity',n,'itemId',a.item_id);
end $$;

create function public.save_pending_inventory_attachment(
 _order_line_id uuid,_item_id uuid,_stock_location_row_id uuid,_checkout_store_id uuid,_quantity integer,_expected_revision integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.ebay_order_lines; a public.pending_inventory_attachments; available integer; email text; current_revision integer;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 -- Match the existing checkout lock order and serialize legacy reservation writers.
 lock table public.ebay_order_line_reservations,public.live_sale_lot_items in share row exclusive mode;
 select * into l from public.ebay_order_lines where id=_order_line_id for update;
 if not found or l.line_status not in ('pending','partially_fulfilled') or l.quantity<=l.fulfilled_quantity
  then raise exception 'This item line is no longer pending. Refresh the order.' using errcode='22023';end if;
 perform 1 from public.ebay_orders where id=l.order_id and status not in ('cancelled','archived') for update;
 if not found then raise exception 'This order is no longer available for packing.' using errcode='22023';end if;
 select * into a from public.pending_inventory_attachments where order_line_id=l.id for update;
 current_revision:=coalesce(a.revision,0);
 if _expected_revision is distinct from current_revision then raise exception 'The inventory attachment changed on another screen. Reopen it before saving.' using errcode='40001';end if;
 select u.email into email from auth.users u where id=auth.uid();
 if _quantity=0 then
  if a.order_line_id is null or a.status<>'reserved' then raise exception 'There is no inventory attachment to remove.' using errcode='22023';end if;
  update public.pending_inventory_attachments set status='released',revision=revision+1,updated_at=now() where order_line_id=l.id;
  update public.ebay_order_line_reservations set status='released' where order_line_id=l.id and status='reserved';
  if l.fulfilled_quantity=0 then update public.ebay_order_lines set internal_item_id=null,stock_location_row_id=null,location_id=null where id=l.id;end if;
 else
  if _quantity is null or _quantity<1 or _quantity>l.quantity-l.fulfilled_quantity then raise exception 'Choose a positive quantity within the remaining order quantity.' using errcode='22023';end if;
  perform 1 from public.store_locations where id=_checkout_store_id and active is true for share;
  if not found then raise exception 'Choose an active packing store.' using errcode='22023';end if;
  perform 1 from public.item_stock_locations where id=_stock_location_row_id for update;
  perform 1 from public.locations where id in(select location_id from public.item_stock_locations where id=_stock_location_row_id) for share;
  perform 1 from public.locations where id in(select p.parent_location_id from public.locations p join public.item_stock_locations s on s.location_id=p.id where s.id=_stock_location_row_id) for share;
  perform 1 from public.item_types where id=_item_id for share;
  select (r->>'quantity')::integer into available from jsonb_array_elements(public.get_pending_checkout_stock(_item_id,l.id,_checkout_store_id)) r
   where (r->>'id')::uuid=_stock_location_row_id;
  if available is null or _quantity>available then raise exception 'That quantity is unavailable, reserved elsewhere, or outside the selected store. Scan again.' using errcode='22023';end if;
  insert into public.pending_inventory_attachments(order_line_id,item_id,stock_location_row_id,checkout_store_id,quantity,attached_by,attached_by_email)
   values(l.id,_item_id,_stock_location_row_id,_checkout_store_id,_quantity,auth.uid(),email)
  on conflict(order_line_id) do update set item_id=excluded.item_id,stock_location_row_id=excluded.stock_location_row_id,
   checkout_store_id=excluded.checkout_store_id,quantity=excluded.quantity,consumed_quantity=0,status='reserved',
   revision=public.pending_inventory_attachments.revision+1,attached_by=excluded.attached_by,attached_by_email=excluded.attached_by_email,updated_at=now();
  perform public.reserve_ebay_order_line_stock(l.id);
  if l.fulfilled_quantity=0 then
   update public.ebay_order_lines set internal_item_id=_item_id,stock_location_row_id=_stock_location_row_id,
    location_id=(select location_id from public.item_stock_locations where id=_stock_location_row_id) where id=l.id;
  end if;
 end if;
 insert into public.pending_inventory_attachment_events(order_line_id,action,snapshot,created_by)
  select l.id,case when _quantity=0 then 'removed' else 'attached' end,to_jsonb(p)||jsonb_build_object('previous',to_jsonb(a)),auth.uid()
  from public.pending_inventory_attachments p where order_line_id=l.id;
 update public.metadata set inventory_version=gen_random_uuid()::text,
  changed_item_ids=array(select distinct x::text from unnest(array[_item_id,a.item_id]) x where x is not null),updated_at=now() where id='inventory';
 return public.get_pending_inventory_attachments(array[l.id]);
end $$;

-- Same stock, sale-item and audit accounting as fulfill_ebay_order_line; the
-- caller owns the line transition, so this helper must not update that row.
create function public.remove_pending_attachment_inventory(
  _order_line_id uuid,
  _item_id uuid,
  _stock_location_row_id uuid,
  _quantity integer,
  _sold_price numeric default null,
  _net_payout numeric default null,
  _notes text default null,
  _signed_by_email text default null
)
returns table (
  order_id uuid,
  order_line_id uuid,
  sale_id uuid,
  sale_item_id uuid,
  stock_transaction_id uuid,
  item_id uuid,
  remaining_stock integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_stock public.item_stock_locations;
  v_item public.item_types;
  v_sale_id uuid;
  v_sale_item_id uuid;
  v_tx_id uuid;
  v_qty integer := coalesce(_quantity, 0);
  v_unit_price numeric(12,2);
  v_line_total numeric(12,2);
  v_net_payout numeric(12,2);
  v_fee_amount numeric(12,2);
  v_fee_percent numeric(7,4);
  v_remaining integer;
  v_now timestamptz := now();
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_order_status text;
  v_snapshot jsonb;
  v_new_fulfilled_quantity integer;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to fulfill eBay orders' using errcode = '42501';
  end if;

  if _order_line_id is null or _item_id is null or _stock_location_row_id is null then
    raise exception 'Order line, item, and source location are required' using errcode = '22023';
  end if;

  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
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
    into v_item
  from public.item_types
  where id = _item_id;

  if not found then
    raise exception 'Inventory item not found' using errcode = 'P0002';
  end if;

  select *
    into v_stock
  from public.item_stock_locations
  where id = _stock_location_row_id
  for update;

  if not found then
    raise exception 'Source stock row not found' using errcode = 'P0002';
  end if;

  if v_stock.item_id is distinct from _item_id then
    raise exception 'The selected source location does not contain that item' using errcode = '22023';
  end if;

  if (coalesce(v_line.fulfilled_quantity, 0) + v_qty) > v_line.quantity then
    raise exception 'This would fulfill more units than the eBay line requires' using errcode = '22023';
  end if;

  if coalesce(v_stock.quantity, 0) < v_qty then
    raise exception 'Only % units are available at the selected source', coalesce(v_stock.quantity, 0) using errcode = '22023';
  end if;

  v_unit_price := coalesce(_sold_price, v_line.sold_for, v_item.sale_price, 0);
  v_line_total := round(v_unit_price * v_qty, 2);
  v_net_payout := coalesce(
    _net_payout,
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
      when coalesce(v_line.total_price, 0) > 0
        then v_line.total_price
      else null
    end,
    case
      when coalesce(v_order.net_payout, 0) > 0 and coalesce(v_order.total_price, 0) > 0
        then round(v_order.net_payout * (v_line_total / v_order.total_price), 2)
      else null
    end,
    v_line_total
  );
  -- Line-level payout totals cover every ordered unit; account only for the
  -- attached units when the remainder was never entered into inventory.
  if _net_payout is null and v_line.quantity>0
   and (v_line.net_payout is not null or coalesce(v_line.total_price,0)>0) then
    v_net_payout:=round(v_net_payout*v_qty/v_line.quantity,2);
  end if;
  v_fee_amount := greatest(round(v_line_total - v_net_payout, 2), 0);
  v_fee_percent := case when v_line_total > 0 then round((v_fee_amount / v_line_total) * 100, 4) else 0 end;
  v_remaining := coalesce(v_stock.quantity, 0) - v_qty;

  update public.item_stock_locations
  set quantity = v_remaining,
      locked_by = null,
      locked_at = null
  where id = v_stock.id;

  v_snapshot := jsonb_build_array(jsonb_build_object(
    'ebay_order_number', v_order.order_number,
    'ebay_item_number', v_line.item_number,
    'ebay_transaction_id', v_line.transaction_id,
    'ebay_buyer_username', v_order.buyer_username,
    'item_id', v_item.id,
    'title', v_item.title,
    'barcode', v_item.barcode,
    'quantity', v_qty,
    'sale_price', v_unit_price,
    'line_total', v_line_total,
    'net_payout', v_net_payout,
    'source_stock_row_id', v_stock.id,
    'location_id', v_stock.location_id
  ));

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
      nullif(_signed_by_email, ''),
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
    v_qty,
    v_unit_price,
    0,
    0,
    v_line_total,
    v_remaining,
    v_stock.location_id,
    coalesce((v_item.photos)[1], '')
  )
  returning id into v_sale_item_id;

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
    -v_qty,
    'checkout',
    v_now,
    auth.uid(),
    nullif(_signed_by_email, ''),
    'eBay pending order ' || v_order.order_number || coalesce(' - ' || v_notes, ''),
    'ebay_pending_order',
    v_now
  )
  returning id into v_tx_id;

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
    v_snapshot,
    false,
    coalesce(v_notes, 'Worker fulfilled pending eBay order'),
    'authenticated_session',
    v_now,
    v_now,
    nullif(_signed_by_email, ''),
    auth.uid(),
    '[]'::jsonb
  );

  insert into public.sale_item_categories (sale_item_id, category)
  select v_sale_item_id, category
  from unnest(coalesce(v_item.categories, '{}'::text[])) as category;

  order_id := v_order.id;
  order_line_id := v_line.id;
  sale_id := v_sale_id;
  sale_item_id := v_sale_item_id;
  stock_transaction_id := v_tx_id;
  item_id := v_item.id;
  remaining_stock := v_remaining;
  return next;
end;
$$;


revoke all on function public.remove_pending_attachment_inventory(uuid,uuid,uuid,integer,numeric,numeric,text,text) from public,anon,authenticated,service_role;

create function public.consume_pending_inventory_attachment() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.pending_inventory_attachments; n integer; delta integer; result record; tx uuid; available integer;
begin
 if new.fulfilled_quantity=old.fulfilled_quantity and new.line_status=old.line_status and new.quantity=old.quantity then return new;end if;
 select * into a from public.pending_inventory_attachments where order_line_id=old.id and status='reserved' for update;
 if not found then return new;end if;
 if new.line_status in ('cancelled','skipped') then
  update public.pending_inventory_attachments set status='cancelled',revision=revision+1,updated_at=now() where order_line_id=old.id;
  update public.ebay_order_line_reservations set status='cancelled' where order_line_id=old.id and status='reserved';
  insert into public.pending_inventory_attachment_events(order_line_id,action,snapshot,created_by) values(old.id,'cancelled',to_jsonb(a),auth.uid());
  return new;
 end if;
 delta:=new.fulfilled_quantity-old.fulfilled_quantity;
 if delta<=0 then
  if new.line_status='fulfilled' or a.quantity-a.consumed_quantity>new.quantity-new.fulfilled_quantity then
   raise exception 'Review the attached inventory before changing this order quantity or closing it.' using errcode='22023';end if;
  return new;
 end if;
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) or new.fulfilled_by is distinct from auth.uid() then
  raise exception 'Attached inventory must be completed by a signed-in packing employee.' using errcode='42501';end if;
 if new.fulfilled_quantity>new.quantity then raise exception 'Completion exceeds the order quantity.' using errcode='22023';end if;
 select email into new.fulfilled_by_email from auth.users where id=auth.uid();
 n:=least(delta,a.quantity-a.consumed_quantity);
 if new.stock_transaction_id is not null and new.stock_transaction_id is distinct from old.stock_transaction_id then
  -- The normal inventory checkout already removed these units. Accept only its
  -- exact item/source transaction; a different scan must not discard the hold.
  if new.internal_item_id is distinct from a.item_id or new.stock_location_row_id is distinct from a.stock_location_row_id
   or not exists(select 1 from public.stock_transactions t where t.id=new.stock_transaction_id and t.item_id=a.item_id
    and t.location_id=(select location_id from public.item_stock_locations where id=a.stock_location_row_id)
    and t.quantity=-delta and t.action_type='checkout') then
   raise exception 'The scanned item differs from the saved inventory attachment. Update or remove the attachment first.' using errcode='22023';end if;
  tx:=new.stock_transaction_id;
 else
  lock table public.ebay_order_line_reservations,public.live_sale_lot_items in share row exclusive mode;
  perform 1 from public.item_stock_locations where id=a.stock_location_row_id for update;
  perform 1 from public.store_locations where id=a.checkout_store_id and active is true for share;
  perform 1 from public.locations where id in(select location_id from public.item_stock_locations where id=a.stock_location_row_id) for share;
  perform 1 from public.locations where id in(select p.parent_location_id from public.locations p join public.item_stock_locations s on s.location_id=p.id where s.id=a.stock_location_row_id) for share;
  perform 1 from public.item_types where id=a.item_id for share;
  select (r->>'quantity')::integer into available from jsonb_array_elements(public.get_pending_checkout_stock(a.item_id,old.id,a.checkout_store_id)) r
   where (r->>'id')::uuid=a.stock_location_row_id;
  if available is null or n>available then raise exception 'Attached stock is no longer available at its saved source. Review the attachment before completing.' using errcode='22023';end if;
  if new.notes='Completed without inventory removal: physical item present, not entered in inventory yet.' then
   new.notes:='Completed pending item; saved inventory attachment removed from stock.';
  end if;
  select * into result from public.remove_pending_attachment_inventory(old.id,a.item_id,a.stock_location_row_id,n,
   null,null,concat_ws(E'\n',nullif(new.notes,''),'Saved inventory attachment'),new.fulfilled_by_email);
  tx:=result.stock_transaction_id;
  new.internal_item_id:=a.item_id;new.stock_location_row_id:=a.stock_location_row_id;
  new.location_id:=(select location_id from public.item_stock_locations where id=a.stock_location_row_id);
  new.sale_id:=result.sale_id;new.sale_item_id:=result.sale_item_id;new.stock_transaction_id:=tx;
  update public.stock_transactions set source_stock_location_row_id=a.stock_location_row_id,stock_condition='good',
   metadata=coalesce(metadata,'{}')||jsonb_build_object('order_line_id',old.id,'inventory_attachment_revision',a.revision,'checkout_store_id',a.checkout_store_id)
   where id=tx;
 end if;
 update public.pending_inventory_attachments set consumed_quantity=consumed_quantity+n,
  status=case when consumed_quantity+n=quantity then 'consumed' else 'reserved' end,revision=revision+1,updated_at=now() where order_line_id=old.id;
 insert into public.pending_inventory_attachment_events(order_line_id,action,snapshot,stock_transaction_id,created_by)
  values(old.id,'consumed',to_jsonb(a)||jsonb_build_object('consumed_now',n),tx,auth.uid());
 -- Keep imported eBay payloads unchanged: inventory accounting is recorded in
 -- attachment events and stock transactions, not in payment-sync evidence.
 update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array[a.item_id::text],updated_at=now() where id='inventory';
 return new;
end $$;
create trigger pending_inventory_attachment_completion before update of line_status,fulfilled_quantity,quantity on public.ebay_order_lines
for each row execute function public.consume_pending_inventory_attachment();

-- Keep legacy evidence/closeout audit records accurate when the completion also
-- consumed an attachment. Existing photos, GPS and line snapshots are retained.
create function public.audit_pending_attachment_closeout() returns trigger
language plpgsql security definer set search_path='' as $$
declare removals jsonb;
begin
 select jsonb_agg(jsonb_build_object('order_line_id',e.order_line_id,'stock_transaction_id',e.stock_transaction_id,
  'item_id',e.snapshot->'item_id','quantity',e.snapshot->'consumed_now')) into removals
 from public.pending_inventory_attachment_events e where e.order_line_id=any(new.order_line_ids)
  and e.action='consumed' and e.created_at=transaction_timestamp();
 if removals is not null then
  new.payload:=coalesce(new.payload,'{}')||jsonb_build_object('inventory_attachment_removals',removals);
  if new.notes='Completed without inventory removal: physical item present, not entered in inventory yet.' then
   new.notes:='Completed pending items; saved inventory attachments removed from stock.';
  end if;
 end if;
 return new;
end $$;
create trigger pending_attachment_closeout_audit before insert on public.ebay_order_admin_events
for each row execute function public.audit_pending_attachment_closeout();
revoke all on function public.audit_pending_attachment_closeout() from public,anon,authenticated;

revoke all on function public.consume_pending_inventory_attachment(),public.reserve_ebay_order_line_stock(uuid),
 public.get_pending_inventory_attachments(uuid[]),public.save_pending_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.reserve_ebay_order_line_stock(uuid) to authenticated,service_role;
grant execute on function public.get_pending_inventory_attachments(uuid[]),public.save_pending_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
