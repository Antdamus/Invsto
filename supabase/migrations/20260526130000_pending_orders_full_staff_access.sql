-- Temporarily give active inventory staff the same Pending Orders closeout
-- permissions that admins use. This is intentionally scoped to pending-order
-- admin events/RPCs instead of changing public.is_admin() globally.

drop policy if exists "ebay_order_admin_events_admin_select" on public.ebay_order_admin_events;
create policy "ebay_order_admin_events_staff_select"
on public.ebay_order_admin_events
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_order_admin_events_admin_insert" on public.ebay_order_admin_events;
create policy "ebay_order_admin_events_staff_insert"
on public.ebay_order_admin_events
for insert
to authenticated
with check (public.can_manage_inventory());

create or replace function public.admin_close_ebay_order_lines(
  _order_line_ids uuid[],
  _action text,
  _notes text,
  _signed_by_email text default null
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
  v_action text := nullif(btrim(coalesce(_action, '')), '');
  v_note text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_now timestamptz := now();
  v_order_ids uuid[] := '{}'::uuid[];
  v_order_id uuid;
  v_order_status text;
  v_updated_lines integer := 0;
  v_updated_orders integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Only active inventory staff can close pending eBay orders without inventory removal' using errcode = '42501';
  end if;

  if coalesce(array_length(_order_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one eBay order line' using errcode = '22023';
  end if;

  if v_action not in ('fulfilled_no_inventory', 'cancelled') then
    raise exception 'Invalid pending-order closeout action' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'A note is required for pending-order closeout' using errcode = '22023';
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
    set line_status = case
          when v_action = 'fulfilled_no_inventory' then 'fulfilled'
          else 'cancelled'
        end,
        fulfilled_quantity = case
          when v_action = 'fulfilled_no_inventory' then quantity
          else coalesce(fulfilled_quantity, 0)
        end,
        fulfilled_by = auth.uid(),
        fulfilled_by_email = v_signed_email,
        fulfilled_at = v_now,
        notes = v_note
    where id = v_line.id;

    v_updated_lines := v_updated_lines + 1;
    if not (v_line.order_id = any(v_order_ids)) then
      v_order_ids := array_append(v_order_ids, v_line.order_id);
    end if;
  end loop;

  if v_updated_lines = 0 then
    raise exception 'No open eBay order lines were updated' using errcode = '22023';
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

  insert into public.ebay_order_admin_events (
    action,
    order_ids,
    order_line_ids,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_action,
    v_order_ids,
    _order_line_ids,
    v_note,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'updated_lines', v_updated_lines,
      'updated_orders', v_updated_orders,
      'closed_at', v_now
    )
  );

  updated_lines := v_updated_lines;
  updated_orders := v_updated_orders;
  return next;
end;
$$;

revoke all on function public.admin_close_ebay_order_lines(uuid[], text, text, text) from public;
grant execute on function public.admin_close_ebay_order_lines(uuid[], text, text, text) to authenticated;
