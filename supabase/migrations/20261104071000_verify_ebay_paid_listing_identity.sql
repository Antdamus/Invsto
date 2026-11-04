begin;
-- A late payment can replace the unpaid listing/transaction ID with an order
-- number. Verify both halves before the existing register merge consumes it.
do $$declare
 src text:=pg_get_functiondef('public.finish_verified_ebay_health_job(uuid,jsonb,integer,text)'::regprocedure);
 guard text:='or exists(select from public.ebay_health_orders o where o.id=r->>''id''';
begin
 if strpos(src,guard)=0 then raise exception 'Unexpected late-payment validation';end if;
 execute replace(src,guard,$g$or exists(
   select from public.ebay_orders final_order
   join public.ebay_order_lines line on line.order_id=final_order.id
   join public.ebay_health_orders prior on prior.id ~ '^[0-9]{11,14}-[0-9]{10,18}$'
     and split_part(prior.id,'-',1)=line.item_number and prior.buyer=lower(final_order.buyer_username)
     and date_trunc('minute',prior.purchased)=date_trunc('minute',(r->>'purchased')::timestamptz)
   where final_order.order_number=r->>'id' and lower(final_order.buyer_username)=lower(r->>'buyer')
    and jsonb_array_length(prior.items)=1 and prior.items->0->>'id'=line.item_number
    and exists(select from jsonb_array_elements(r->'items') it where it->>'id'=line.item_number))
   or exists(select from public.ebay_health_orders o where o.id=r->>'id'$g$);
end$$;
commit;
