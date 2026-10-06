begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

-- Read receipts for this show's saved bags, including manual prints and jobs
-- from other staff/computers. Do not rely on the global last-100-jobs window.
create function public.get_ebay_live_bag_print_status(_event_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if _event_id is null or _event_id !~ '^[A-Za-z0-9_-]{6,100}$' then raise exception 'Invalid eBay show' using errcode='22023'; end if;
 return coalesce((select jsonb_agg(to_jsonb(receipt)) from (
  select a.id as attempt_id,j.id as job_id,
   case when j.status='claimed' and j.lease_until<now() then 'uncertain' else j.status end as status,
   s.name as station_name,j.printer_roll,j.copies,j.submitted_copies,j.created_at,j.updated_at,
   case when j.status='claimed' and j.lease_until<now() then 'Computer stopped reporting. Check the printer before requesting another copy.' else j.detail end as detail
  from public.ebay_live_attempts a
  join public.live_sale_lots l on l.id=a.lot_id
  join lateral (
   select p.* from public.label_print_jobs p where p.barcode=l.lot_code
   order by p.created_at desc,p.id desc limit 1
  ) j on true
  join public.print_stations s on s.id=j.station_id
  where a.event_id=_event_id
 ) receipt),'[]'::jsonb);
end $$;
revoke all on function public.get_ebay_live_bag_print_status(text) from public,anon,authenticated;
grant execute on function public.get_ebay_live_bag_print_status(text) to authenticated;
notify pgrst,'reload schema';
commit;
