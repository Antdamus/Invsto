-- Native eBay return intake workflow.
-- A return is not an order reversal: the sale remains closed, and the return
-- gets its own case, item disposition, inventory movement, evidence, and audit.

insert into storage.buckets (id, name, public)
values ('ebay-return-evidence', 'ebay-return-evidence', false)
on conflict (id) do nothing;

drop policy if exists "Inventory staff upload eBay return evidence" on storage.objects;
create policy "Inventory staff upload eBay return evidence"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'ebay-return-evidence' and public.can_manage_inventory());

drop policy if exists "Inventory staff read eBay return evidence" on storage.objects;
create policy "Inventory staff read eBay return evidence"
on storage.objects
for select
to authenticated
using (bucket_id = 'ebay-return-evidence' and public.can_manage_inventory());

drop policy if exists "Admins delete eBay return evidence" on storage.objects;
create policy "Admins delete eBay return evidence"
on storage.objects
for delete
to authenticated
using (bucket_id = 'ebay-return-evidence' and public.is_admin());

create table if not exists public.ebay_return_cases (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.ebay_orders(id) on delete cascade,
  order_number text not null,
  ebay_return_id text,
  buyer_username text,
  return_reason text,
  return_tracking_number text,
  status text not null default 'received'
    check (status in ('open', 'received', 'partially_received', 'needs_review', 'closed', 'cancelled')),
  opened_at timestamptz not null default now(),
  received_at timestamptz,
  closed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.ebay_return_items (
  id uuid primary key default gen_random_uuid(),
  return_case_id uuid not null references public.ebay_return_cases(id) on delete cascade,
  order_id uuid not null references public.ebay_orders(id) on delete cascade,
  order_line_id uuid not null references public.ebay_order_lines(id) on delete cascade,
  internal_item_id uuid references public.item_types(id) on delete set null,
  original_stock_location_row_id uuid references public.item_stock_locations(id) on delete set null,
  original_location_id uuid references public.locations(id) on delete set null,
  item_title text not null,
  item_number text,
  expected_quantity integer not null default 1 check (expected_quantity >= 0),
  received_quantity integer not null default 0 check (received_quantity >= 0),
  condition_received text not null default 'unknown'
    check (condition_received in ('new', 'used_good', 'damaged', 'missing_parts', 'wrong_item', 'unknown')),
  disposition text not null default 'admin_review'
    check (disposition in ('restock', 'quarantine', 'damaged', 'wrong_item', 'refund_only', 'missing', 'admin_review')),
  destination_location_id uuid references public.locations(id) on delete set null,
  stock_transaction_id uuid references public.stock_transactions(id) on delete set null,
  processed_by uuid references auth.users(id) on delete set null,
  processed_by_email text,
  processed_at timestamptz not null default now(),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  unique (return_case_id, order_line_id)
);

create table if not exists public.ebay_return_events (
  id uuid primary key default gen_random_uuid(),
  return_case_id uuid references public.ebay_return_cases(id) on delete cascade,
  action text not null
    check (action in ('return_created', 'return_received', 'item_inspected', 'restocked', 'closed', 'cancelled', 'admin_override')),
  order_id uuid references public.ebay_orders(id) on delete cascade,
  order_line_ids uuid[] not null default '{}'::uuid[],
  return_item_ids uuid[] not null default '{}'::uuid[],
  notes text,
  evidence_photos jsonb not null default '[]'::jsonb,
  signed_by uuid references auth.users(id) on delete set null,
  signed_by_email text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

alter table public.ebay_return_cases enable row level security;
alter table public.ebay_return_items enable row level security;
alter table public.ebay_return_events enable row level security;

drop policy if exists "ebay_return_cases_inventory_staff_select" on public.ebay_return_cases;
create policy "ebay_return_cases_inventory_staff_select"
on public.ebay_return_cases
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_return_items_inventory_staff_select" on public.ebay_return_items;
create policy "ebay_return_items_inventory_staff_select"
on public.ebay_return_items
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_return_events_inventory_staff_select" on public.ebay_return_events;
create policy "ebay_return_events_inventory_staff_select"
on public.ebay_return_events
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_return_cases_inventory_staff_insert" on public.ebay_return_cases;
create policy "ebay_return_cases_inventory_staff_insert"
on public.ebay_return_cases
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "ebay_return_items_inventory_staff_insert" on public.ebay_return_items;
create policy "ebay_return_items_inventory_staff_insert"
on public.ebay_return_items
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "ebay_return_events_inventory_staff_insert" on public.ebay_return_events;
create policy "ebay_return_events_inventory_staff_insert"
on public.ebay_return_events
for insert
to authenticated
with check (public.can_manage_inventory());

grant select, insert on table public.ebay_return_cases to authenticated;
grant select, insert on table public.ebay_return_items to authenticated;
grant select, insert on table public.ebay_return_events to authenticated;

create index if not exists ebay_return_cases_order_idx
  on public.ebay_return_cases(order_id, opened_at desc);

create index if not exists ebay_return_cases_status_idx
  on public.ebay_return_cases(status, opened_at desc);

create index if not exists ebay_return_items_line_idx
  on public.ebay_return_items(order_line_id, processed_at desc);

create index if not exists ebay_return_events_case_idx
  on public.ebay_return_events(return_case_id, created_at desc);

create or replace function public.touch_ebay_return_case_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_return_cases_updated_at on public.ebay_return_cases;
create trigger trg_ebay_return_cases_updated_at
before update on public.ebay_return_cases
for each row execute function public.touch_ebay_return_case_updated_at();

create or replace function public.receive_ebay_return(
  _return_items jsonb,
  _return_reason text default null,
  _return_tracking_number text default null,
  _ebay_return_id text default null,
  _notes text default null,
  _evidence_photos jsonb default '[]'::jsonb,
  _signed_by_email text default null
)
returns table (
  return_case_ids uuid[],
  return_item_ids uuid[],
  restocked_units integer,
  recorded_items integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_case public.ebay_return_cases;
  v_location public.locations;
  v_stock public.item_stock_locations;
  v_return_item_id uuid;
  v_stock_tx_id uuid;
  v_case_id uuid;
  v_case_ids uuid[] := '{}'::uuid[];
  v_return_item_ids uuid[] := '{}'::uuid[];
  v_changed_item_ids text[] := '{}'::text[];
  v_evidence_photos jsonb := case
    when jsonb_typeof(coalesce(_evidence_photos, '[]'::jsonb)) = 'array'
      then coalesce(_evidence_photos, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_reason text := nullif(btrim(coalesce(_return_reason, '')), '');
  v_tracking text := nullif(btrim(coalesce(_return_tracking_number, '')), '');
  v_ebay_return_id text := nullif(btrim(coalesce(_ebay_return_id, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_now timestamptz := now();
  v_line_id uuid;
  v_destination_location_id uuid;
  v_expected_qty integer;
  v_received_qty integer;
  v_condition text;
  v_disposition text;
  v_item_notes text;
  v_recorded integer := 0;
  v_restocked integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to process eBay returns' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(_return_items, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(_return_items, '[]'::jsonb)) = 0 then
    raise exception 'At least one returned item is required' using errcode = '22023';
  end if;

  if jsonb_array_length(v_evidence_photos) = 0 then
    raise exception 'At least one return evidence photo is required' using errcode = '22023';
  end if;

  for v_item in
    select value from jsonb_array_elements(_return_items)
  loop
    v_line_id := nullif(v_item->>'order_line_id', '')::uuid;
    v_received_qty := greatest(coalesce(nullif(v_item->>'received_quantity', '')::integer, 0), 0);
    v_condition := coalesce(nullif(btrim(v_item->>'condition_received'), ''), 'unknown');
    v_disposition := coalesce(nullif(btrim(v_item->>'disposition'), ''), 'admin_review');
    v_item_notes := nullif(btrim(coalesce(v_item->>'notes', '')), '');
    v_destination_location_id := nullif(v_item->>'destination_location_id', '')::uuid;

    if v_condition not in ('new', 'used_good', 'damaged', 'missing_parts', 'wrong_item', 'unknown') then
      raise exception 'Invalid return condition: %', v_condition using errcode = '22023';
    end if;

    if v_disposition not in ('restock', 'quarantine', 'damaged', 'wrong_item', 'refund_only', 'missing', 'admin_review') then
      raise exception 'Invalid return disposition: %', v_disposition using errcode = '22023';
    end if;

    select *
      into v_line
    from public.ebay_order_lines
    where id = v_line_id
    for update;

    if not found then
      raise exception 'eBay order line not found' using errcode = 'P0002';
    end if;

    if v_line.line_status <> 'fulfilled' then
      raise exception 'Only fulfilled eBay lines can be returned: %', coalesce(v_line.item_title, v_line.id::text)
      using errcode = '22023';
    end if;

    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id
    for update;

    if not found then
      raise exception 'eBay order not found' using errcode = 'P0002';
    end if;

    v_expected_qty := greatest(coalesce(v_line.fulfilled_quantity, 0), coalesce(v_line.quantity, 0), 0);
    if v_received_qty > v_expected_qty then
      raise exception 'Received quantity cannot exceed fulfilled quantity for %', coalesce(v_line.item_title, v_line.id::text)
      using errcode = '22023';
    end if;

    if v_disposition <> 'missing' and v_received_qty <= 0 then
      raise exception 'Received quantity is required unless the item is marked missing' using errcode = '22023';
    end if;

    select *
      into v_case
    from public.ebay_return_cases
    where order_id = v_order.id
      and status not in ('closed', 'cancelled')
      and (
        v_ebay_return_id is null
        or ebay_return_id is null
        or ebay_return_id = v_ebay_return_id
      )
    order by opened_at desc
    limit 1
    for update;

    if not found then
      insert into public.ebay_return_cases (
        order_id,
        order_number,
        ebay_return_id,
        buyer_username,
        return_reason,
        return_tracking_number,
        status,
        opened_at,
        received_at,
        created_by,
        created_by_email,
        notes,
        raw_payload
      )
      values (
        v_order.id,
        v_order.order_number,
        v_ebay_return_id,
        v_order.buyer_username,
        v_reason,
        v_tracking,
        'received',
        v_now,
        v_now,
        auth.uid(),
        v_signed_email,
        v_notes,
        jsonb_build_object('source', 'og_return_intake')
      )
      returning * into v_case;

      insert into public.ebay_return_events (
        return_case_id,
        action,
        order_id,
        notes,
        evidence_photos,
        signed_by,
        signed_by_email,
        payload
      )
      values (
        v_case.id,
        'return_created',
        v_order.id,
        v_notes,
        v_evidence_photos,
        auth.uid(),
        v_signed_email,
        jsonb_build_object(
          'order_number', v_order.order_number,
          'buyer_username', v_order.buyer_username,
          'return_reason', v_reason,
          'return_tracking_number', v_tracking,
          'ebay_return_id', v_ebay_return_id
        )
      );
    else
      update public.ebay_return_cases
      set return_reason = coalesce(v_reason, return_reason),
          return_tracking_number = coalesce(v_tracking, return_tracking_number),
          ebay_return_id = coalesce(v_ebay_return_id, ebay_return_id),
          received_at = coalesce(received_at, v_now),
          notes = coalesce(v_notes, notes)
      where id = v_case.id
      returning * into v_case;
    end if;

    v_case_id := v_case.id;
    if not (v_case_id = any(v_case_ids)) then
      v_case_ids := array_append(v_case_ids, v_case_id);
    end if;

    if v_disposition = 'restock' then
      if v_line.internal_item_id is null then
        raise exception 'This returned line is not linked to an inventory item and cannot be restocked automatically'
        using errcode = '22023';
      end if;

      if v_destination_location_id is null then
        raise exception 'A restock destination location is required' using errcode = '22023';
      end if;

      select *
        into v_location
      from public.locations
      where id = v_destination_location_id
        and coalesce(active, true) is true;

      if not found then
        raise exception 'Return destination location was not found or is inactive' using errcode = 'P0002';
      end if;

      select *
        into v_stock
      from public.item_stock_locations
      where item_id = v_line.internal_item_id
        and location_id = v_destination_location_id
      order by last_updated desc nulls last, confirmed_at desc nulls last
      limit 1
      for update;

      if found then
        update public.item_stock_locations
        set quantity = coalesce(quantity, 0) + v_received_qty,
            last_updated = v_now,
            locked_by = null,
            locked_at = null
        where id = v_stock.id;
      else
        insert into public.item_stock_locations (
          item_id,
          location_id,
          quantity,
          added_by,
          confirmation_email,
          confirmation_method,
          confirmed_at,
          last_updated
        )
        values (
          v_line.internal_item_id,
          v_destination_location_id,
          v_received_qty,
          auth.uid(),
          v_signed_email,
          'ebay_return_restock',
          v_now,
          v_now
        );
      end if;

      insert into public.stock_transactions (
        item_id,
        location_id,
        quantity,
        action_type,
        confirmed_at,
        user_id,
        email,
        notes,
        source_transaction_id,
        method,
        timestamp
      )
      values (
        v_line.internal_item_id,
        v_destination_location_id,
        v_received_qty,
        'correction',
        v_now,
        auth.uid(),
        v_signed_email,
        'eBay return restock for order ' || coalesce(v_order.order_number, v_order.id::text) || coalesce(' - ' || v_notes, ''),
        v_line.stock_transaction_id,
        'ebay_return_restock',
        v_now
      )
      returning id into v_stock_tx_id;

      v_restocked := v_restocked + v_received_qty;
      if not (v_line.internal_item_id::text = any(v_changed_item_ids)) then
        v_changed_item_ids := array_append(v_changed_item_ids, v_line.internal_item_id::text);
      end if;
    else
      v_stock_tx_id := null;
    end if;

    insert into public.ebay_return_items (
      return_case_id,
      order_id,
      order_line_id,
      internal_item_id,
      original_stock_location_row_id,
      original_location_id,
      item_title,
      item_number,
      expected_quantity,
      received_quantity,
      condition_received,
      disposition,
      destination_location_id,
      stock_transaction_id,
      processed_by,
      processed_by_email,
      processed_at,
      notes,
      metadata
    )
    values (
      v_case_id,
      v_order.id,
      v_line.id,
      v_line.internal_item_id,
      v_line.stock_location_row_id,
      v_line.location_id,
      v_line.item_title,
      v_line.item_number,
      v_expected_qty,
      v_received_qty,
      v_condition,
      v_disposition,
      case when v_disposition = 'restock' then v_destination_location_id else null end,
      v_stock_tx_id,
      auth.uid(),
      v_signed_email,
      v_now,
      v_item_notes,
      jsonb_build_object(
        'source', 'og_return_intake',
        'order_number', v_order.order_number,
        'return_tracking_number', v_tracking,
        'return_reason', v_reason
      )
    )
    returning id into v_return_item_id;

    v_return_item_ids := array_append(v_return_item_ids, v_return_item_id);
    v_recorded := v_recorded + 1;

    insert into public.ebay_return_events (
      return_case_id,
      action,
      order_id,
      order_line_ids,
      return_item_ids,
      notes,
      evidence_photos,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_case_id,
      case when v_disposition = 'restock' then 'restocked' else 'item_inspected' end,
      v_order.id,
      array[v_line.id],
      array[v_return_item_id],
      coalesce(v_item_notes, v_notes),
      v_evidence_photos,
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'order_number', v_order.order_number,
        'item_title', v_line.item_title,
        'item_number', v_line.item_number,
        'expected_quantity', v_expected_qty,
        'received_quantity', v_received_qty,
        'condition_received', v_condition,
        'disposition', v_disposition,
        'destination_location_id', v_destination_location_id,
        'stock_transaction_id', v_stock_tx_id
      )
    );
  end loop;

  foreach v_case_id in array v_case_ids loop
    update public.ebay_return_cases
    set status = case
          when exists (
            select 1
            from public.ebay_return_items ri
            where ri.return_case_id = v_case_id
              and ri.disposition in ('admin_review', 'wrong_item')
          ) then 'needs_review'
          when exists (
            select 1
            from public.ebay_return_items ri
            where ri.return_case_id = v_case_id
              and ri.received_quantity < ri.expected_quantity
              and ri.disposition <> 'missing'
          ) then 'partially_received'
          else 'closed'
        end,
        closed_at = case
          when not exists (
            select 1
            from public.ebay_return_items ri
            where ri.return_case_id = v_case_id
              and ri.disposition in ('admin_review', 'wrong_item')
          )
          and not exists (
            select 1
            from public.ebay_return_items ri
            where ri.return_case_id = v_case_id
              and ri.received_quantity < ri.expected_quantity
              and ri.disposition <> 'missing'
          ) then v_now
          else closed_at
        end
    where id = v_case_id;

    insert into public.ebay_return_events (
      return_case_id,
      action,
      order_id,
      order_line_ids,
      return_item_ids,
      notes,
      evidence_photos,
      signed_by,
      signed_by_email,
      payload
    )
    select
      v_case_id,
      case when c.status = 'closed' then 'closed' else 'return_received' end,
      c.order_id,
      coalesce(array_agg(distinct ri.order_line_id) filter (where ri.order_line_id is not null), '{}'::uuid[]),
      coalesce(array_agg(distinct ri.id) filter (where ri.id is not null), '{}'::uuid[]),
      v_notes,
      v_evidence_photos,
      auth.uid(),
      v_signed_email,
      jsonb_build_object('status', c.status, 'closed_at', v_now)
    from public.ebay_return_cases c
    left join public.ebay_return_items ri on ri.return_case_id = c.id
    where c.id = v_case_id
    group by c.id;
  end loop;

  if v_restocked > 0 then
    update public.metadata
    set inventory_version = gen_random_uuid()::text,
        changed_item_ids = v_changed_item_ids,
        updated_at = v_now
    where id = 'inventory';
  end if;

  return_case_ids := v_case_ids;
  return_item_ids := v_return_item_ids;
  restocked_units := v_restocked;
  recorded_items := v_recorded;
  return next;
end;
$$;

revoke all on function public.receive_ebay_return(
  jsonb, text, text, text, text, jsonb, text
) from public;

grant execute on function public.receive_ebay_return(
  jsonb, text, text, text, text, jsonb, text
) to authenticated;
