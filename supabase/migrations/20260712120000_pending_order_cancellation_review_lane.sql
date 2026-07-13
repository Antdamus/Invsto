-- Persist the "keep pending" decision for eBay cancellation states shown in
-- the Pending Orders cancellation review lane.

create or replace function public.mark_pending_order_cancellation_review(
  _order_line_id uuid,
  _decision text default 'keep_pending',
  _note text default null,
  _signed_by_email text default null
)
returns table (
  order_id uuid,
  updated_lines integer,
  decision text,
  reviewed_at timestamptz,
  review_payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_decision text := coalesce(lower(nullif(btrim(coalesce(_decision, 'keep_pending')), '')), 'keep_pending');
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_now timestamptz := now();
  v_review_payload jsonb;
  v_updated_lines integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to review pending-order cancellation states' using errcode = '42501';
  end if;

  if v_decision not in ('keep_pending', 'clear') then
    raise exception 'Invalid cancellation review decision' using errcode = '22023';
  end if;

  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id
  for update;

  if not found then
    raise exception 'eBay order line not found' using errcode = 'P0002';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id
  for update;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select count(*)::integer
    into v_updated_lines
  from public.ebay_order_lines
  where order_id = v_order.id
    and line_status in ('pending', 'partially_fulfilled');

  if v_decision = 'clear' then
    update public.ebay_orders
    set raw_payload = coalesce(raw_payload, '{}'::jsonb) - 'cancellation_review',
        updated_at = v_now
    where id = v_order.id;

    v_review_payload := '{}'::jsonb;
  else
    v_review_payload := jsonb_build_object(
      'decision', 'keep_pending',
      'note', coalesce(v_note, ''),
      'reviewedAt', v_now,
      'reviewedBy', auth.uid(),
      'reviewedByEmail', coalesce(v_signed_email, ''),
      'orderLineId', v_line.id,
      'orderId', v_order.id,
      'orderNumber', v_order.order_number,
      'buyerUsername', v_order.buyer_username,
      'itemNumber', v_line.item_number,
      'itemTitle', v_line.item_title,
      'ebayCancelStatus', coalesce(
        nullif(v_order.raw_payload->'pending_order_sync_mismatch'->>'ebayCancelStatus', ''),
        nullif(v_order.raw_payload->>'orderCancelStatus', ''),
        nullif(v_line.raw_payload->>'orderCancelStatus', ''),
        nullif(v_order.raw_payload #>> '{order,cancelStatus,cancelState}', ''),
        nullif(v_order.raw_payload #>> '{order,cancelStatus,cancelStatus}', '')
      )
    );

    update public.ebay_orders
    set raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object('cancellation_review', v_review_payload),
        updated_at = v_now
    where id = v_order.id;
  end if;

  return query
  select
    v_order.id,
    v_updated_lines,
    v_decision,
    v_now,
    v_review_payload;
end;
$$;

revoke all on function public.mark_pending_order_cancellation_review(uuid, text, text, text) from public;
grant execute on function public.mark_pending_order_cancellation_review(uuid, text, text, text) to authenticated;

comment on function public.mark_pending_order_cancellation_review(uuid, text, text, text)
  is 'Marks an eBay cancellation status reviewed so it stays in Pending Orders but leaves the active cancellation review lane.';
