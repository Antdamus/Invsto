begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

-- A label can precede packing. It must not claim the scanner, reserve stock,
-- close the bag, or change the seller credited to this auction.
create function public.prepare_ebay_live_bag_label(_attempt_id uuid)
returns public.live_sale_lots language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; l public.live_sale_lots; mail text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null or a.merged_into is not null then
  raise exception 'Payment is not confirmed for this bag' using errcode='22023';
 end if;
 if a.lot_id is not null then
  select * into l from public.live_sale_lots where id=a.lot_id;
  if not found or l.status in ('cancelled','released') then raise exception 'This bag is no longer available for printing' using errcode='22023';end if;
  return l;
 end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not found or c.review_completed_at is not null or a.closed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then
  raise exception 'This show is already closed' using errcode='22023';
 end if;
 select email into mail from auth.users where id=auth.uid();
 l:=public.create_live_sale_lot(c.session_id,'EB-'||coalesce(substring(a.listing_title from '^#([A-Za-z0-9_-]+)'),a.listing_id)||'-'||substr(replace(a.id::text,'-',''),1,8),'eBay '||a.listing_title||' | Winner '||a.buyer,mail,a.seller_id);
 update public.ebay_live_attempts set lot_id=l.id,updated_at=now() where id=a.id;
 insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,'bag_label_prepared',jsonb_build_object('lot_id',l.id,'lot_code',l.lot_code));
 return l;
end $$;
revoke all on function public.prepare_ebay_live_bag_label(uuid) from public,anon,authenticated;
grant execute on function public.prepare_ebay_live_bag_label(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
