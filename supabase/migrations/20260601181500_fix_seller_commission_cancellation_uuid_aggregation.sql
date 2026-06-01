-- Fix cancellation deductions after eBay line closeout.
-- Postgres cannot aggregate uuid values with max(), so pick the newest
-- non-null related ids deterministically from the source sale ledger rows.

create or replace function public.record_seller_commission_cancellation(
  _order_line_id uuid,
  _reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.ebay_order_lines;
  v_order public.ebay_orders;
  v_row record;
  v_count integer := 0;
begin
  select *
    into v_line
  from public.ebay_order_lines
  where id = _order_line_id;

  if not found then
    return 0;
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = v_line.order_id;

  if v_line.sale_item_id is not null then
    perform public.sync_seller_commission_for_sale_item(v_line.sale_item_id);
  end if;

  for v_row in
    select
      l.seller_employee_id,
      (array_agg(l.shift_id order by l.created_at desc, l.id::text desc) filter (where l.shift_id is not null))[1] as shift_id,
      (array_agg(l.channel order by l.created_at desc, l.id::text desc) filter (where nullif(l.channel, '') is not null))[1] as channel,
      (array_agg(l.sale_id order by l.created_at desc, l.id::text desc) filter (where l.sale_id is not null))[1] as sale_id,
      (array_agg(l.ebay_order_line_id order by l.created_at desc, l.id::text desc) filter (where l.ebay_order_line_id is not null))[1] as ebay_order_line_id,
      sum(l.gross_amount) as gross_amount,
      sum(l.shipping_amount) as shipping_amount,
      sum(l.tax_amount) as tax_amount,
      sum(l.platform_fee_amount) as platform_fee_amount,
      sum(l.net_store_proceeds) as net_store_proceeds,
      string_agg(distinct coalesce(l.source_label, ''), ', ' order by coalesce(l.source_label, '')) as source_label
    from public.seller_commission_ledger l
    where l.source_type = 'sale'
      and l.ebay_order_line_id = v_line.id
      and l.status <> 'void'
    group by l.seller_employee_id
  loop
    insert into public.seller_commission_ledger (
      seller_employee_id,
      shift_id,
      channel,
      sale_id,
      ebay_order_line_id,
      source_type,
      source_id,
      source_label,
      gross_amount,
      shipping_amount,
      tax_amount,
      platform_fee_amount,
      refund_amount,
      net_store_proceeds,
      status,
      notes,
      metadata
    )
    values (
      v_row.seller_employee_id,
      v_row.shift_id,
      coalesce(v_row.channel, 'ebay'),
      v_row.sale_id,
      coalesce(v_row.ebay_order_line_id, v_line.id),
      'cancellation',
      v_line.id::text,
      concat_ws(' - ', 'Cancellation', coalesce(v_order.order_number, v_line.item_title), nullif(v_line.item_title, '')),
      -abs(coalesce(v_row.gross_amount, 0)),
      -abs(coalesce(v_row.shipping_amount, 0)),
      -abs(coalesce(v_row.tax_amount, 0)),
      -abs(coalesce(v_row.platform_fee_amount, 0)),
      abs(coalesce(v_row.net_store_proceeds, 0)),
      -abs(coalesce(v_row.net_store_proceeds, 0)),
      'deducted',
      nullif(btrim(coalesce(_reason, '')), ''),
      jsonb_build_object(
        'source', 'seller_commission_cancellation',
        'order_line_id', v_line.id,
        'order_number', v_order.order_number,
        'item_title', v_line.item_title
      )
    )
    on conflict (seller_employee_id, source_type, source_id) where source_id is not null
    do update
      set shift_id = excluded.shift_id,
          channel = excluded.channel,
          sale_id = excluded.sale_id,
          ebay_order_line_id = excluded.ebay_order_line_id,
          source_label = excluded.source_label,
          gross_amount = excluded.gross_amount,
          shipping_amount = excluded.shipping_amount,
          tax_amount = excluded.tax_amount,
          platform_fee_amount = excluded.platform_fee_amount,
          refund_amount = excluded.refund_amount,
          net_store_proceeds = excluded.net_store_proceeds,
          status = case
            when public.seller_commission_ledger.status = 'paid' then public.seller_commission_ledger.status
            else 'deducted'
          end,
          metadata = coalesce(public.seller_commission_ledger.metadata, '{}'::jsonb) || excluded.metadata,
          updated_at = now()
      where public.seller_commission_ledger.status <> 'paid';

    perform public.create_seller_notification(
      v_row.seller_employee_id,
      'seller',
      'commission_cancellation_deduction',
      'Cancelled sale deducted from commission',
      'A cancelled eBay sale was deducted from your commission ledger: '
        || coalesce(v_order.order_number, v_line.item_title, v_line.id::text)
        || '. Deduction basis: '
        || to_char(abs(coalesce(v_row.net_store_proceeds, 0)), 'FM$999,999,990.00')
        || ' net store proceeds.',
      'normal',
      v_row.shift_id,
      null,
      jsonb_build_object(
        'order_line_id', v_line.id,
        'order_number', v_order.order_number,
        'net_store_proceeds_deducted', abs(coalesce(v_row.net_store_proceeds, 0))
      )
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.record_seller_commission_cancellation(uuid, text) from public;
