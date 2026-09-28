begin;
-- The tile ordinal is its list position, not the auction reference in its title.
create or replace function public.claim_ebay_live_bag(_attempt_id uuid) returns public.live_sale_lots language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; l public.live_sale_lots; mail text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null or a.closed_at is not null then raise exception 'Only a paid, open auction can be scanned' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not(coalesce(c.capture_ready and c.source_seen_at>now()-interval '30 seconds',false) or coalesce(a.verified_at>now()-interval '2 minutes',false)) then raise exception 'Capture is disconnected. Verify payment on eBay first' using errcode='22023';end if;
 if a.claimed_by is not null and a.claimed_by<>auth.uid() then raise exception 'Another scanner already has this bag. Ask an admin to release the claim' using errcode='42501';end if;
 select email into mail from auth.users where id=auth.uid();
 if a.lot_id is null then
  l:=public.create_live_sale_lot(c.session_id,'EB-'||coalesce(substring(a.listing_title from '^#([A-Za-z0-9_-]+)'),a.listing_id)||'-'||substr(replace(a.id::text,'-',''),1,8),'eBay '||a.listing_title||' | Winner '||a.buyer,mail,a.seller_id);
 else select * into l from public.live_sale_lots where id=a.lot_id;end if;
 if l.status not in ('open','reserved') then raise exception 'This bag is no longer available for scanning' using errcode='22023';end if;
 update public.ebay_live_attempts set claimed_by=auth.uid(),claimed_at=coalesce(claimed_at,now()),lot_id=l.id,updated_at=now() where id=a.id;
 insert into public.ebay_live_audit(event_id,attempt_id,action) values(a.event_id,a.id,'bag_claimed');
 return l;
end $$;

notify pgrst,'reload schema';
commit;
