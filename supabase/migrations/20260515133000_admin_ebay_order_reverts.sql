-- Admin order history reversals for eBay pending-order fulfillment.
-- Reverting keeps an audit trail, restores stock when stock was removed, and
-- puts the selected order lines back into the packing queue.

create table if not exists public.ebay_order_revert_events (
  id uuid primary key default gen_random_uuid(),
  order_ids uuid[] not null default '{}'::uuid[],
  order_line_ids uuid[] not null default '{}'::uuid[],
  notes text not null,
  signed_by uuid references auth.users(id) on delete set null,
  signed_by_email text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
alter table public.ebay_order_revert_events enable row level security;
drop policy if exists "ebay_order_revert_events_admin_select" on public.ebay_order_revert_events;
create policy "ebay_order_revert_events_admin_select"
on public.ebay_order_revert_events
for select
to authenticated
using (public.is_admin());
drop policy if exists "ebay_order_revert_events_admin_insert" on public.ebay_order_revert_events;
create policy "ebay_order_revert_events_admin_insert"
on public.ebay_order_revert_events
for insert
to authenticated
with check (public.is_admin());
grant select, insert on table public.ebay_order_revert_events to authenticated;
create or replace function public.admin_revert_ebay_order_lines(
  _order_line_ids uuid[],
  _notes text,
  _signed_by_email text default null
)
returns table (
  reverted_lines integer,
  restored_units integer,
  updated_orders integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line_id uuid;
  v_line public.ebay_order_lines;
  v_stock public.item_stock_locations;
  v_order public.ebay_orders;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_now timestamptz := now();
  v_qty integer;
  v_order_ids uuid[] := '{}'::uuid[];
  v_reverted_line_ids uuid[] := '{}'::uuid[];
  v_order_id uuid;
  v_order_status text;
  v_reverted_lines integer := 0;
  v_restored_units integer := 0;
  v_updated_orders integer := 0;
  v_snapshots jsonb := '[]'::jsonb;
  v_found_stock boolean;
begin
  if not public.is_admin() then
    raise exception 'Only admins can revert eBay order fulfillment' using errcode = '42501';
  end if;

  if coalesce(array_length(_order_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one eBay order line to revert' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'A note is required to revert an eBay order' using errcode = '22023';
  end if;

  foreach v_line_id in array _order_line_ids loop
    select *
      into v_line
    from public.ebay_order_lines
    where id = v_line_id
    for update;

    if not found then
      continue;
    end if;

    if v_line.line_status not in ('fulfilled', 'partially_fulfilled', 'cancelled', 'skipped') then
      continue;
    end if;

    select *
      into v_order
    from public.ebay_orders
    where id = v_line.order_id
    for update;

    v_qty := greatest(coalesce(v_line.fulfilled_quantity, 0), 0);

    v_snapshots := v_snapshots || jsonb_build_array(jsonb_build_object(
      'order_id', v_line.order_id,
      'order_number', v_order.order_number,
      'order_line_id', v_line.id,
      'item_title', v_line.item_title,
      'item_number', v_line.item_number,
      'previous_status', v_line.line_status,
      'fulfilled_quantity', v_line.fulfilled_quantity,
      'fulfilled_by_email', v_line.fulfilled_by_email,
      'fulfilled_at', v_line.fulfilled_at,
      'internal_item_id', v_line.internal_item_id,
      'stock_location_row_id', v_line.stock_location_row_id,
      'location_id', v_line.location_id,
      'sale_id', v_line.sale_id,
      'sale_item_id', v_line.sale_item_id,
      'stock_transaction_id', v_line.stock_transaction_id,
      'notes', v_line.notes
    ));

    if v_qty > 0 and v_line.internal_item_id is not null and v_line.location_id is not null then
      v_found_stock := false;
      if v_line.stock_location_row_id is not null then
        select *
          into v_stock
        from public.item_stock_locations
        where id = v_line.stock_location_row_id
        for update;
        v_found_stock := found;
      end if;

      if v_found_stock then
        update public.item_stock_locations
        set quantity = coalesce(quantity, 0) + v_qty,
            last_updated = v_now,
            locked_by = null,
            locked_at = null
        where id = v_stock.id;
      else
        insert into public.item_stock_locations (
          id,
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
          coalesce(v_line.stock_location_row_id, gen_random_uuid()),
          v_line.internal_item_id,
          v_line.location_id,
          v_qty,
          auth.uid(),
          v_signed_email,
          'admin_ebay_order_revert',
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
        v_line.location_id,
        v_qty,
        'correction',
        v_now,
        auth.uid(),
        v_signed_email,
        'Admin reverted eBay order ' || coalesce(v_order.order_number, v_line.order_id::text) || ' - ' || v_note,
        v_line.stock_transaction_id,
        'admin_ebay_order_revert',
        v_now
      );

      v_restored_units := v_restored_units + v_qty;
    end if;

    update public.ebay_order_lines
    set line_status = 'pending',
        fulfilled_quantity = 0,
        fulfilled_by = null,
        fulfilled_by_email = null,
        fulfilled_at = null,
        internal_item_id = null,
        stock_location_row_id = null,
        location_id = null,
        sale_id = null,
        sale_item_id = null,
        stock_transaction_id = null,
        notes = 'Admin reverted: ' || v_note
    where id = v_line.id;

    v_reverted_lines := v_reverted_lines + 1;
    v_reverted_line_ids := array_append(v_reverted_line_ids, v_line.id);
    if not (v_line.order_id = any(v_order_ids)) then
      v_order_ids := array_append(v_order_ids, v_line.order_id);
    end if;
  end loop;

  if v_reverted_lines = 0 then
    raise exception 'No closed eBay order lines were reverted' using errcode = '22023';
  end if;

  foreach v_order_id in array v_order_ids loop
    select case
      when not exists (
        select 1
        from public.ebay_order_lines l
        where l.order_id = v_order_id
          and l.line_status not in ('fulfilled', 'cancelled', 'skipped')
      ) then
        case
          when exists (
            select 1
            from public.ebay_order_lines l
            where l.order_id = v_order_id
              and l.line_status = 'fulfilled'
          ) then 'fulfilled'
          else 'cancelled'
        end
      when exists (
        select 1
        from public.ebay_order_lines l
        where l.order_id = v_order_id
          and l.line_status in ('fulfilled', 'partially_fulfilled')
      ) then 'partially_fulfilled'
      else 'pending'
    end
    into v_order_status;

    update public.ebay_orders
    set status = v_order_status
    where id = v_order_id;

    v_updated_orders := v_updated_orders + 1;
  end loop;

  insert into public.ebay_order_revert_events (
    order_ids,
    order_line_ids,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_order_ids,
    v_reverted_line_ids,
    v_note,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'reverted_lines', v_reverted_lines,
      'restored_units', v_restored_units,
      'updated_orders', v_updated_orders,
      'reverted_at', v_now,
      'line_snapshots', v_snapshots
    )
  );

  reverted_lines := v_reverted_lines;
  restored_units := v_restored_units;
  updated_orders := v_updated_orders;
  return next;
end;
$$;
revoke all on function public.admin_revert_ebay_order_lines(uuid[], text, text) from public;
grant execute on function public.admin_revert_ebay_order_lines(uuid[], text, text) to authenticated;
