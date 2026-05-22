-- Let inventory staff mark pending eBay order lines as cancelled with a signed
-- audit event. This closes the line from the packing queue without touching
-- inventory stock.

alter table public.ebay_order_admin_events
  add column if not exists checkout_store_id uuid references public.store_locations(id) on delete set null;

drop function if exists public.cancel_ebay_order_lines(uuid[], text, text, uuid);

create or replace function public.cancel_ebay_order_lines(
  _order_line_ids uuid[],
  _notes text,
  _signed_by_email text default null,
  _checkout_store_id uuid default null,
  _evidence_photos jsonb default '[]'::jsonb
)
returns table (
  updated_lines integer,
  updated_orders integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line_id uuid;
  v_line public.ebay_order_lines;
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_now timestamptz := now();
  v_evidence_photos jsonb := case
    when jsonb_typeof(coalesce(_evidence_photos, '[]'::jsonb)) = 'array'
      then coalesce(_evidence_photos, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_order_ids uuid[] := '{}'::uuid[];
  v_updated_line_ids uuid[] := '{}'::uuid[];
  v_snapshots jsonb := '[]'::jsonb;
  v_order_id uuid;
  v_order_status text;
  v_store_name text;
  v_updated_lines integer := 0;
  v_updated_orders integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to cancel eBay order lines' using errcode = '42501';
  end if;

  if coalesce(array_length(_order_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one eBay order line to cancel' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'A note is required to cancel an eBay order' using errcode = '22023';
  end if;

  if _checkout_store_id is not null then
    select name
      into v_store_name
    from public.store_locations
    where id = _checkout_store_id;
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

    if v_line.line_status in ('fulfilled', 'cancelled', 'skipped') then
      continue;
    end if;

    update public.ebay_order_lines
    set line_status = 'cancelled',
        fulfilled_quantity = coalesce(fulfilled_quantity, 0),
        fulfilled_by = auth.uid(),
        fulfilled_by_email = v_signed_email,
        fulfilled_at = v_now,
        notes = v_note,
        updated_at = v_now
    where id = v_line.id;

    v_updated_lines := v_updated_lines + 1;
    v_updated_line_ids := array_append(v_updated_line_ids, v_line.id);
    if not (v_line.order_id = any(v_order_ids)) then
      v_order_ids := array_append(v_order_ids, v_line.order_id);
    end if;

    v_snapshots := v_snapshots || jsonb_build_array(jsonb_build_object(
      'order_id', v_line.order_id,
      'order_line_id', v_line.id,
      'item_title', v_line.item_title,
      'item_number', v_line.item_number,
      'custom_label', v_line.custom_label,
      'quantity', v_line.quantity
    ));
  end loop;

  if v_updated_lines = 0 then
    raise exception 'No open eBay order lines were cancelled' using errcode = '22023';
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
    set status = v_order_status,
        updated_at = v_now
    where id = v_order_id;

    v_updated_orders := v_updated_orders + 1;
  end loop;

  insert into public.ebay_order_admin_events (
    action,
    order_ids,
    order_line_ids,
    notes,
    signed_by,
    signed_by_email,
    checkout_store_id,
    payload
  )
  values (
    'cancelled',
    v_order_ids,
    v_updated_line_ids,
    v_note,
    auth.uid(),
    v_signed_email,
    _checkout_store_id,
    jsonb_build_object(
      'source', 'worker_ebay_order_cancelled',
      'updated_lines', v_updated_lines,
      'updated_orders', v_updated_orders,
      'cancelled_at', v_now,
      'checkout_store_id', _checkout_store_id,
      'checkout_store_name', v_store_name,
      'evidence_bucket', 'order-evidence-photos',
      'evidence_photos', v_evidence_photos,
      'line_snapshots', v_snapshots
    )
  );

  updated_lines := v_updated_lines;
  updated_orders := v_updated_orders;
  return next;
end;
$$;

revoke all on function public.cancel_ebay_order_lines(uuid[], text, text, uuid, jsonb) from public;
grant execute on function public.cancel_ebay_order_lines(uuid[], text, text, uuid, jsonb) to authenticated;
