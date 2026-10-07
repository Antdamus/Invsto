begin;
set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- A locator only: scanning never links, packs, closes, or marks an item found.
create or replace function public.find_pending_order_bag(_scan text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  code text := upper(btrim(coalesce(_scan, '')));
  reference text;
  result jsonb;
begin
  if auth.uid() is null or not coalesce(public.can_manage_inventory(), false) then
    raise exception 'Inventory access required' using errcode = '42501';
  end if;
  if code = '' or length(code) > 120 or code !~ '^#?[A-Z0-9][A-Z0-9-]*$' then
    raise exception 'Scan a bag label or enter its bag number' using errcode = '22023';
  end if;
  reference := regexp_replace(regexp_replace(code, '^#', ''), '^0+([0-9])', '\1');
  with bags as materialized (
    select b.id, b.lot_code,
      coalesce(b.matched_order_line_id, k.order_line_id, a.order_line_id) as linked_id,
      a.listing_id, a.buyer, a.listing_title, a.amount
    from public.live_sale_lots b
    left join public.live_bag_order_links k on k.lot_id = b.id
    left join public.ebay_live_attempts a on a.lot_id = b.id
    where b.lot_code = code
      or (code not like 'LIVE-%' and regexp_replace(regexp_replace(upper(btrim(b.auction_number)), '^#', ''), '^0+([0-9])', '\1') = reference)
  ), candidates as (
    select l.id, l.order_id, l.item_number, l.item_title, l.custom_label,
      l.quantity, l.fulfilled_quantity, l.line_status, l.sold_for, l.total_price, l.created_at,
      jsonb_build_object('id', o.id, 'order_number', o.order_number,
        'buyer_username', o.buyer_username, 'buyer_name', o.buyer_name,
        'sale_date', o.sale_date, 'paid_on_date', o.paid_on_date,
        'ship_by_date', o.ship_by_date, 'status', o.status) as ord,
      (select to_jsonb(s) from public.pending_order_item_search s where s.order_line_id = l.id) as item_search,
      exists(select 1 from bags b where b.linked_id = l.id) as linked
    from public.ebay_order_lines l join public.ebay_orders o on o.id = l.order_id
    -- An eBay shipping label/header status is not proof that physical packing is finished.
    where l.line_status in ('pending', 'partially_fulfilled') and l.fulfilled_quantity < l.quantity
      and (
        exists(select 1 from bags b where b.linked_id = l.id or (b.linked_id is null and (
          (nullif(b.listing_id, '') = l.item_number and lower(btrim(b.buyer)) = lower(btrim(o.buyer_username)))
          or (lower(btrim(b.buyer)) = lower(btrim(o.buyer_username))
            and nullif(lower(btrim(b.listing_title)), '') = lower(btrim(l.item_title))
            and abs(b.amount - l.sold_for) < 0.01)
        )))
        or (code like 'LIVE-%' and not exists(select 1 from bags where linked_id is not null)
          and code = any(regexp_split_to_array(upper(concat_ws(' ', l.custom_label, l.item_title)), '[^A-Z0-9-]+')))
        or (code not like 'LIVE-%' and (
          regexp_replace(upper(btrim(l.custom_label)), '^#?0*([0-9])', '\1') = reference
          or exists(select 1 from regexp_matches(concat_ws(' ', l.item_title, l.custom_label),
            '(?:#\s*|\m(?:auction|auc|lot|bag)\s*(?:number|num|no\.?|#)?\s*[:.-]?\s*#?)([[:alnum:]][[:alnum:]-]*)', 'gi') t
            where regexp_replace(upper(t[1]), '^0+([0-9])', '\1') = reference)
        ))
      )
    order by linked desc, o.sale_date desc nulls last, l.id
    limit 41
  )
  select jsonb_build_object(
    'matches', coalesce((select jsonb_agg(jsonb_build_object(
      'line', (to_jsonb(c) - 'ord' - 'linked') || jsonb_build_object('order', c.ord),
      'linked', c.linked, 'reasons', jsonb_build_array(case when c.linked then 'Linked bag' else 'Matching bag / sale' end)
    )) from (select * from candidates limit 40) c), '[]'::jsonb),
    'truncated', (select count(*) > 40 from candidates),
    'bag_found', exists(select 1 from bags),
    'linked_closed', exists(select 1 from bags b join public.ebay_order_lines l on l.id = b.linked_id
      where l.line_status not in ('pending', 'partially_fulfilled') or l.fulfilled_quantity >= l.quantity)
  ) into result;
  return result;
end $$;
revoke all on function public.find_pending_order_bag(text) from public, anon;
grant execute on function public.find_pending_order_bag(text) to authenticated;
commit;
