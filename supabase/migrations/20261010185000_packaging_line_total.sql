begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Count distinct order lines across the entire filtered queue, before paging.
-- Keep the existing buyer grouping, readiness rules, and history labels intact.
do $migration$
declare definition text; old_fragment text := '''rows'',coalesce((select jsonb_agg(to_jsonb(p)-''tracking_numbers'') from page p),''[]''))';
begin
 definition := pg_get_functiondef('public.packaging_queue(text,text,integer)'::regprocedure);
 if position(old_fragment in definition)=0 then raise exception 'Packaging queue shape changed; review migration'; end if;
 execute replace(definition, old_fragment, $replacement$
 'line_total', (select count(distinct l.id)
  from filtered r join public.ebay_order_lines l on l.order_id=any(r.order_ids)
  where r.view=_view and case when r.view in ('to_package','in_progress','on_hold') then
   l.line_status='fulfilled' and l.fulfilled_quantity > coalesce((
    select sum(i.quantity) from public.packaging_items i
    join public.packaging_shipments s on s.id=i.shipment_id
    where i.order_line_id=l.id and s.status<>'cancelled'
     and s.id is distinct from r.shipment_id
   ),0)
  else exists(select 1 from public.packaging_items i where i.shipment_id=r.shipment_id and i.order_line_id=l.id)
  end),
 'rows',coalesce((select jsonb_agg(to_jsonb(p)-'tracking_numbers') from page p),'[]'))
 $replacement$);
end $migration$;
commit;
