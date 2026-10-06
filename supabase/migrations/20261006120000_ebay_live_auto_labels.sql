begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

-- Automatic sends share the existing queue. The auction row lock and request ID
-- make one automatic job per attempt across receivers, users and computers.
create index if not exists label_print_jobs_request_lookup on public.label_print_jobs(request_id);
create index if not exists label_print_jobs_barcode_lookup on public.label_print_jobs(barcode);
create function public.enqueue_ebay_live_auto_label(_attempt_id uuid,_station_id uuid,_label_xml text,_printer_roll text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; l public.live_sale_lots; j public.label_print_jobs; result jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or nullif(trim(a.buyer),'') is null or a.resolved_at is not null or a.merged_into is not null or public.ebay_live_has_payment_hold(a) then
  raise exception 'Payment is not confirmed for this bag' using errcode='22023';
 end if;
 select * into l from public.live_sale_lots where id=a.lot_id;
 if not found or l.status in ('cancelled','released') then raise exception 'Prepare this bag before printing' using errcode='22023'; end if;
 if position(l.lot_code in coalesce(_label_xml,''))=0 then raise exception 'The label does not identify this bag' using errcode='22023'; end if;
 select * into j from public.label_print_jobs where request_id=a.id or barcode=l.lot_code order by created_at limit 1;
 if not found then
  result:=public.enqueue_label_print(_station_id,a.id,_label_xml,1,a.listing_title,l.lot_code,null,_printer_roll);
  select * into j from public.label_print_jobs where id=(result->>'id')::uuid;
 end if;
 return jsonb_build_object('id',j.id,'status',j.status,'station_id',j.station_id,'station_name',(select name from public.print_stations where id=j.station_id));
end $$;
revoke all on function public.enqueue_ebay_live_auto_label(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_ebay_live_auto_label(uuid,uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
