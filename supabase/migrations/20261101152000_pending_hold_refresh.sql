begin;
-- Read only the financial facts used by the hold filters for the requested open orders.
create function public.pending_ebay_hold_updates(_orders text[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 if cardinality(_orders)>500 then raise exception 'Choose at most 500 orders';end if;
 return (select coalesce(jsonb_object_agg(e.order_number,public.weekly_ebay_hold_evidence(e.raw_payload)||
 jsonb_build_object('delivery',public.ebay_report_delivery(e.order_number))),'{}')
 from public.ebay_orders e where e.order_number=any(_orders) and exists(
 select from public.ebay_order_lines l where l.order_id=e.id and l.line_status in ('pending','partially_fulfilled')));
end$$;
revoke all on function public.pending_ebay_hold_updates(text[]) from public,anon;
grant execute on function public.pending_ebay_hold_updates(text[]) to authenticated;
notify pgrst,'reload schema';
commit;
