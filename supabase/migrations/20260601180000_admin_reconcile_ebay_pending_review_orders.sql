-- Admin/staff reconciliation helper for pending eBay orders that the eBay API
-- no longer reports as awaiting shipment. Dry-run is the default.

drop function if exists public.admin_reconcile_ebay_pending_review_orders(text[], boolean, text, text);

create or replace function public.admin_reconcile_ebay_pending_review_orders(
  _order_numbers text[] default null,
  _dry_run boolean default true,
  _signed_by_email text default null,
  _note text default null
)
returns table (
  order_id uuid,
  order_number text,
  buyer_username text,
  sale_date timestamptz,
  paid_on_date timestamptz,
  imported_at timestamptz,
  ebay_payment_status text,
  ebay_fulfillment_status text,
  ebay_cancel_status text,
  recommended_action text,
  line_count integer,
  updated_lines integer,
  updated_orders integer,
  applied boolean,
  skipped_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_result record;
  v_action text;
  v_note text;
begin
  if not public.can_manage_inventory() then
    raise exception 'Only active inventory staff can reconcile pending eBay orders' using errcode = '42501';
  end if;

  for v_row in
    select
      o.id as order_id,
      o.order_number,
      o.buyer_username,
      o.sale_date,
      o.paid_on_date,
      o.imported_at,
      o.raw_payload->'pending_order_sync_mismatch' as review,
      o.raw_payload->'pending_order_sync_mismatch'->>'ebayPaymentStatus' as ebay_payment_status,
      o.raw_payload->'pending_order_sync_mismatch'->>'ebayFulfillmentStatus' as ebay_fulfillment_status,
      o.raw_payload->'pending_order_sync_mismatch'->>'ebayCancelStatus' as ebay_cancel_status,
      array_agg(l.id order by l.created_at, l.id) as line_ids,
      count(l.id)::integer as line_count
    from public.ebay_orders o
    join public.ebay_order_lines l on l.order_id = o.id
    where jsonb_typeof(o.raw_payload->'pending_order_sync_mismatch') = 'object'
      and o.status in ('pending', 'partially_fulfilled')
      and l.line_status in ('pending', 'partially_fulfilled')
      and (
        coalesce(array_length(_order_numbers, 1), 0) = 0
        or o.order_number = any(_order_numbers)
      )
    group by o.id, o.order_number, o.buyer_username, o.sale_date, o.paid_on_date, o.imported_at, o.raw_payload
    order by o.order_number
  loop
    v_action := case
      when upper(coalesce(v_row.ebay_payment_status, '')) like '%REFUND%' then 'cancelled'
      when upper(coalesce(v_row.ebay_cancel_status, '')) not in ('', 'NONE_REQUESTED', 'NOT_REQUESTED') then 'cancelled'
      when upper(coalesce(v_row.ebay_fulfillment_status, '')) = 'FULFILLED' then 'fulfilled_no_inventory'
      else null
    end;

    order_id := v_row.order_id;
    order_number := v_row.order_number;
    buyer_username := v_row.buyer_username;
    sale_date := v_row.sale_date;
    paid_on_date := v_row.paid_on_date;
    imported_at := v_row.imported_at;
    ebay_payment_status := v_row.ebay_payment_status;
    ebay_fulfillment_status := v_row.ebay_fulfillment_status;
    ebay_cancel_status := v_row.ebay_cancel_status;
    recommended_action := coalesce(v_action, 'manual_review');
    line_count := v_row.line_count;
    updated_lines := 0;
    updated_orders := 0;
    applied := false;
    skipped_reason := null;

    if v_action is null then
      skipped_reason := 'No automatic rule matched this eBay status combination.';
      return next;
      continue;
    end if;

    if coalesce(_dry_run, true) then
      skipped_reason := 'dry_run';
      return next;
      continue;
    end if;

    v_note := coalesce(
      nullif(btrim(_note), ''),
      case
        when v_action = 'cancelled' then
          format(
            'Closed by eBay reconciliation: eBay reports payment=%s, fulfillment=%s, cancel=%s.',
            coalesce(v_row.ebay_payment_status, 'unknown'),
            coalesce(v_row.ebay_fulfillment_status, 'unknown'),
            coalesce(v_row.ebay_cancel_status, 'unknown')
          )
        else
          format(
            'Closed by eBay reconciliation: eBay reports order fulfilled. payment=%s, fulfillment=%s, cancel=%s.',
            coalesce(v_row.ebay_payment_status, 'unknown'),
            coalesce(v_row.ebay_fulfillment_status, 'unknown'),
            coalesce(v_row.ebay_cancel_status, 'unknown')
          )
      end
    );

    select r.updated_lines, r.updated_orders
      into v_result
    from public.admin_close_ebay_order_lines(
      v_row.line_ids,
      v_action,
      v_note,
      _signed_by_email
    ) as r;

    updated_lines := coalesce(v_result.updated_lines, 0);
    updated_orders := coalesce(v_result.updated_orders, 0);
    applied := true;
    skipped_reason := null;
    return next;
  end loop;
end;
$$;

revoke all on function public.admin_reconcile_ebay_pending_review_orders(text[], boolean, text, text) from public;
grant execute on function public.admin_reconcile_ebay_pending_review_orders(text[], boolean, text, text) to authenticated;
