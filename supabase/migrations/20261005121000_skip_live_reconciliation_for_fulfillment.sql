-- Packing changes fulfillment, not the eBay payment evidence. A large buyer's
-- closeout used to reconcile (and lock) the entire Live event for every line
-- and again for every order. Keep payment/refund/cancellation reconciliation,
-- but return before that work for fulfillment-only updates.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.ebay_live_order_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_order uuid; v_event text;
begin
  if TG_TABLE_NAME = 'ebay_orders' then
    if TG_OP = 'UPDATE' then
      if NEW.raw_payload is not distinct from OLD.raw_payload
        and (NEW.status = 'cancelled') is not distinct from (OLD.status = 'cancelled') then
        return NEW;
      end if;
    end if;
    v_order := NEW.id;
  else
    if TG_OP = 'UPDATE' then
      if NEW.raw_payload is not distinct from OLD.raw_payload
        and NEW.sold_for is not distinct from OLD.sold_for
        and (NEW.line_status = 'cancelled') is not distinct from (OLD.line_status = 'cancelled') then
        return NEW;
      end if;
    end if;
    v_order := NEW.order_id;
  end if;

  for v_event in
    select distinct a.event_id
    from public.ebay_live_attempts a
    join public.ebay_order_lines l on l.item_number = a.listing_id
    join public.ebay_orders o on o.id = l.order_id
    where o.id = v_order and lower(o.buyer_username) = lower(a.buyer)
  loop
    perform public.reconcile_ebay_live_orders_internal(v_event);
  end loop;
  return NEW;
end $$;

revoke all on function public.ebay_live_order_changed() from public, anon, authenticated;
commit;
