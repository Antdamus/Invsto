begin;
set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- A lookup link is independent of packing, payment reconciliation and bag closure.
create table public.live_bag_order_links (
  lot_id uuid primary key references public.live_sale_lots(id) on delete cascade,
  order_line_id uuid not null references public.ebay_order_lines(id) on delete cascade,
  linked_by uuid not null references auth.users(id),
  linked_at timestamptz not null default now()
);
create index live_bag_order_links_line_idx on public.live_bag_order_links(order_line_id);
alter table public.live_bag_order_links enable row level security;
revoke all on public.live_bag_order_links from public, anon, authenticated;
grant select on public.live_bag_order_links to authenticated;
create policy staff_read on public.live_bag_order_links for select to authenticated
  using (public.can_manage_inventory());

create function public.set_live_bag_order_link(
  _lot_id uuid, _order_line_id uuid, _expected_order_line_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare
  bag public.live_sale_lots; line public.ebay_order_lines; ord public.ebay_orders;
  previous_id uuid; reconciled_id uuid;
begin
  if auth.uid() is null or not public.can_manage_inventory() then
    raise exception 'Inventory access required' using errcode = '42501';
  end if;
  -- Match the fulfillment lock order: line, order, then bag.
  if _order_line_id is not null then
    select * into line from public.ebay_order_lines where id = _order_line_id for update;
    if not found then raise exception 'Order line not found' using errcode = '22023'; end if;
    select * into ord from public.ebay_orders where id = line.order_id for update;
    if line.line_status not in ('pending', 'partially_fulfilled')
      or line.fulfilled_quantity >= line.quantity
      or ord.status not in ('pending', 'partially_fulfilled') then
      raise exception 'Choose an open pending order line' using errcode = '22023';
    end if;
  end if;
  select * into bag from public.live_sale_lots where id = _lot_id for update;
  if not found then raise exception 'Bag not found' using errcode = '22023'; end if;
  if bag.status not in ('open', 'reserved') or bag.matched_order_line_id is not null then
    raise exception 'Only open or reserved bags can change their order link' using errcode = '22023';
  end if;
  select order_line_id into previous_id from public.live_bag_order_links where lot_id = bag.id;
  if previous_id is distinct from _expected_order_line_id then
    raise exception 'The bag link changed. Refresh before trying again' using errcode = '40001';
  end if;
  select order_line_id into reconciled_id from public.ebay_live_attempts where lot_id = bag.id;
  if _order_line_id is not null and reconciled_id is not null and reconciled_id <> _order_line_id then
    raise exception 'eBay already identifies a different order for this bag. Review the live sale first' using errcode = '22023';
  end if;
  if previous_id is not distinct from _order_line_id then return; end if;
  if _order_line_id is null then
    delete from public.live_bag_order_links where lot_id = bag.id;
  else
    insert into public.live_bag_order_links(lot_id, order_line_id, linked_by)
      values (bag.id, _order_line_id, auth.uid())
    on conflict (lot_id) do update set order_line_id = excluded.order_line_id,
      linked_by = excluded.linked_by, linked_at = now();
  end if;
  insert into public.live_sale_events(session_id, lot_id, event_type, actor, actor_email, payload)
  values (bag.session_id, bag.id, case when _order_line_id is null then 'order_unlinked' else 'order_linked' end,
    auth.uid(), auth.jwt()->>'email', jsonb_build_object('previous_order_line_id', previous_id, 'order_line_id', _order_line_id));
end $$;

create function public.get_live_bag_order_matches(_lot_id uuid, _search text default '')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  bag public.live_sale_lots; sale public.ebay_live_attempts;
  saved_id uuid; linked_id uuid; matches jsonb;
  show_started timestamptz; window_start timestamptz; window_end timestamptz;
  auction text; title text; term text := lower(btrim(coalesce(_search, '')));
begin
  if auth.uid() is null or not public.can_manage_inventory() then
    raise exception 'Inventory access required' using errcode = '42501';
  end if;
  if length(term) > 120 then raise exception 'Search must be 120 characters or fewer' using errcode = '22023'; end if;
  select * into bag from public.live_sale_lots where id = _lot_id;
  if not found then raise exception 'Bag not found' using errcode = '22023'; end if;
  select * into sale from public.ebay_live_attempts where lot_id = bag.id;
  select order_line_id into saved_id from public.live_bag_order_links where lot_id = bag.id;
  linked_id := coalesce(bag.matched_order_line_id, saved_id, sale.order_line_id);
  select started_at into show_started from public.live_sale_sessions where id = bag.session_id;
  -- Bags may be prepared before a show, and orders may arrive well after it.
  -- Dates rank suggestions over a range; saved/exact identities and manual search
  -- remain available outside it. PostgreSQL least/greatest ignore null inputs.
  window_start := least(bag.created_at, sale.created_at, show_started) - interval '7 days';
  window_end := greatest(bag.created_at, bag.closed_at, sale.created_at, sale.closed_at, show_started) + interval '30 days';
  title := lower(btrim(coalesce(sale.listing_title, '')));
  -- New eBay bags use an internal EB-* auction_number; the printed reference lives in the title.
  auction := lower(coalesce(substring(sale.listing_title from '#\s*([[:alnum:]][[:alnum:]-]*)'),
    nullif(regexp_replace(bag.auction_number, '^#+', ''), '')));

  with candidates as (
    select l.*, o.order_number, o.buyer_username, o.buyer_name, o.sale_date, o.paid_on_date,
      o.ship_by_date, o.status as order_status,
      l.id = linked_id as linked,
      nullif(lower(btrim(sale.buyer)), '') = lower(btrim(o.buyer_username)) as buyer_match,
      nullif(sale.listing_id, '') = l.item_number as listing_match,
      sale.amount is not null and l.sold_for is not null and abs(sale.amount - l.sold_for) < 0.01 as amount_match,
      title <> '' and title = lower(btrim(l.item_title)) as title_match,
      exists (select 1 from regexp_matches(concat_ws(' ', l.item_title, l.custom_label),
        '(?:#\s*|\m(?:auction|auc|lot|bag)\s*(?:number|num|no\.?|#)?\s*[:.-]?\s*#?)([[:alnum:]][[:alnum:]-]*)', 'gi') t
        where lower(t[1]) = auction) or lower(btrim(l.custom_label)) = auction as auction_match,
      coalesce(o.sale_date, o.paid_on_date, o.imported_at, l.created_at)
        between window_start and window_end as date_match,
      position(lower(bag.lot_code) in lower(concat_ws(' ', l.custom_label, l.item_title))) > 0 as bag_match
    from public.ebay_order_lines l join public.ebay_orders o on o.id = l.order_id
    where l.id = linked_id or (
      l.line_status in ('pending', 'partially_fulfilled') and l.fulfilled_quantity < l.quantity
      and o.status in ('pending', 'partially_fulfilled')
      and (term = '' or position(term in lower(concat_ws(' ', o.order_number, o.buyer_username, o.buyer_name,
        l.item_title, l.custom_label, l.item_number, l.sold_for::text))) > 0)
    )
  ), scored as (
    select c.*,
      (case when linked then 1000 else 0 end + case when bag_match then 200 else 0 end
      + case when buyer_match then 80 else 0 end + case when listing_match then 70 else 0 end
      + case when title_match then 45 else 0 end + case when auction_match then 35 else 0 end
      + case when amount_match then 20 else 0 end + case when date_match then 15 else 0 end) as score,
      array_remove(array[
        case when linked then 'Linked order' end, case when bag_match then 'Bag ID' end,
        case when buyer_match then 'Buyer username' end, case when listing_match then 'eBay listing' end,
        case when title_match then 'Listing title' end, case when auction_match then 'Auction number' end,
        case when amount_match then 'Sale amount' end, case when date_match then 'Within date range'
          else 'Outside suggested date range — review' end,
        case when nullif(btrim(sale.buyer), '') is not null and not coalesce(buyer_match, false) then 'Different buyer — review' end
      ], null) as reasons
    from candidates c
    where linked or term <> '' or bag_match or buyer_match or (listing_match and amount_match)
      or (date_match and (listing_match or title_match or auction_match))
  )
  select coalesce(jsonb_agg(jsonb_build_object('score', score, 'reasons', reasons, 'linked', coalesce(linked, false),
    'line', jsonb_build_object('id', id, 'order_id', order_id, 'item_number', item_number,
      'item_title', item_title, 'custom_label', custom_label, 'quantity', quantity,
      'fulfilled_quantity', fulfilled_quantity, 'line_status', line_status, 'sold_for', sold_for,
      'total_price', total_price, 'created_at', created_at,
      'order', jsonb_build_object('id', order_id, 'order_number', order_number, 'buyer_username', buyer_username,
        'buyer_name', buyer_name, 'sale_date', sale_date, 'paid_on_date', paid_on_date, 'ship_by_date', ship_by_date, 'status', order_status))
    ) order by score desc, sale_date desc nulls last, id), '[]'::jsonb) into matches
  from (select * from scored order by score desc, sale_date desc nulls last, id limit 30) limited;
  return jsonb_build_object('saved_line_id', saved_id, 'linked_line_id', linked_id,
    'link_source', case when bag.matched_order_line_id is not null then 'Packed order' when saved_id is not null then 'Saved link'
      when sale.order_line_id is not null then 'Identified by eBay' else null end,
    'editable', bag.status in ('open', 'reserved') and bag.matched_order_line_id is null,
    'buyer', sale.buyer, 'amount', sale.amount, 'title', sale.listing_title,
    'date_window_start', window_start, 'date_window_end', window_end, 'matches', matches);
end $$;

-- Even older packing clients cannot fulfill a bag against a different saved order.
create function public.guard_live_bag_order_link() returns trigger
language plpgsql security definer set search_path = '' as $$
declare linked_id uuid;
begin
  if new.matched_order_line_id is not null then
    select order_line_id into linked_id from public.live_bag_order_links where lot_id = new.id;
    if linked_id is not null and linked_id <> new.matched_order_line_id then
      raise exception 'This bag is linked to a different order. Correct the bag link before packing' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger live_bag_order_link_packing_guard before update of matched_order_line_id
  on public.live_sale_lots for each row execute function public.guard_live_bag_order_link();

revoke all on function public.guard_live_bag_order_link() from public, anon, authenticated;
revoke all on function public.set_live_bag_order_link(uuid, uuid, uuid) from public, anon;
revoke all on function public.get_live_bag_order_matches(uuid, text) from public, anon;
grant execute on function public.set_live_bag_order_link(uuid, uuid, uuid) to authenticated;
grant execute on function public.get_live_bag_order_matches(uuid, text) to authenticated;
commit;
