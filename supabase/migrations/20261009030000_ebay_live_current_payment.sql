begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Current listing payment is separate from the immutable Activity history.
-- Repeated failures/wins must not become extra sales or override a later Paid card.
create table public.ebay_live_listing_payments (
 event_id text not null references public.ebay_live_connections(event_id),
 listing_id text not null, buyer text, amount numeric(12,2),
 kind text not null check(kind in ('paid','failed','cancelled','unknown')),
 observed_at timestamptz not null, source_key text not null, evidence text,
 primary key(event_id,listing_id)
);
alter table public.ebay_live_listing_payments enable row level security;
revoke all on public.ebay_live_listing_payments from public,anon,authenticated;

insert into public.ebay_live_listing_payments
 select distinct on (o.event_id,o.listing_id) o.event_id,o.listing_id,o.buyer,o.amount,o.kind,o.observed_at,o.source_key,o.evidence
 from public.ebay_live_observations o join public.ebay_live_connections c using(event_id)
 where o.source='listing' and o.listing_id is not null and o.kind in ('paid','failed','cancelled')
 and c.review_completed_at is null
 order by o.event_id,o.listing_id,o.observed_at desc,(o.kind<>'paid') desc,o.source_key;

create function public.apply_ebay_live_listing_payments_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; p public.ebay_live_listing_payments;
 a public.ebay_live_attempts; other public.ebay_live_attempts; ids uuid[]; candidates integer; worked integer;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found or c.review_completed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then return;end if;
 for p in select * from public.ebay_live_listing_payments where event_id=_event_id loop
  if p.kind<>'paid' then
   update public.ebay_live_attempts set payment_state=case p.kind when 'unknown' then 'waiting' else p.kind end,
    payment_source='listing_current',updated_at=now()
   where event_id=_event_id and listing_id=p.listing_id and merged_into is null and resolved_at is null
    and nullif(btrim(p.buyer),'') is not null and lower(btrim(buyer))=lower(btrim(p.buyer))
    and (p.amount is null or amount=p.amount)
    and payment_state is distinct from case p.kind when 'unknown' then 'waiting' else p.kind end;
   continue;
  end if;
  if nullif(btrim(p.buyer),'') is null or p.amount is null then continue;end if;
  select array_agg(id),count(*),count(*) filter(where lot_id is not null or order_line_id is not null or claimed_at is not null or closed_at is not null)
   into ids,candidates,worked from public.ebay_live_attempts
   where event_id=_event_id and listing_id=p.listing_id and lower(btrim(buyer))=lower(btrim(p.buyer)) and amount=p.amount
   and merged_into is null and resolved_at is null and event_exclusion is null;
  if candidates=0 then continue;end if;
  -- Never combine two physical bags or two distinct auction wins.
  if worked>1 or (select count(*) from public.ebay_live_attempts where id=any(ids) and win_key is not null)>1 then continue;end if;
  select * into a from public.ebay_live_attempts where id=any(ids)
   order by (lot_id is not null or order_line_id is not null or claimed_at is not null or closed_at is not null) desc,
    (win_key is not null) desc,created_at,id limit 1;
  -- Preserve a deliberate operator resolution; this routine only fixes capture evidence.
  if exists(select 1 from public.ebay_live_audit where attempt_id=any(ids) and action in ('cancel_release','notification_reviewed')) then continue;end if;
  -- A newer official cancellation/refund must not be resurrected by an older card.
  if exists(select 1 from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
   where l.id=a.order_line_id and o.raw_payload#>>'{ebay_order_evidence,source}'='ebay_fulfillment_api'
    and nullif(o.raw_payload#>>'{ebay_order_evidence,checked_at}','')::timestamptz>p.observed_at
    and (o.status='cancelled' or l.line_status='cancelled'
     or upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',l.raw_payload->>'orderPaymentStatus','')) in ('FULLY_REFUNDED','PARTIALLY_REFUNDED')
     or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}',l.raw_payload->>'orderCancelStatus','')) not in ('','NONE_REQUESTED'))) then continue;end if;
  for other in select * from public.ebay_live_attempts where id=any(ids) and id<>a.id loop
   if a.win_key is null and other.win_key is not null then
    update public.ebay_live_attempts set win_key=null where id=other.id;
    update public.ebay_live_attempts set win_key=other.win_key,win_time_label=other.win_time_label,
     sold_at=coalesce(sold_at,other.sold_at),sale_time_source=coalesce(sale_time_source,other.sale_time_source),
     sale_time_precision=coalesce(sale_time_precision,other.sale_time_precision) where id=a.id;
    a.win_key:=other.win_key;
   end if;
   update public.ebay_live_observations set attempt_id=a.id where attempt_id=other.id;
   update public.ebay_live_attempts set merged_into=a.id,resolved_at=now(),updated_at=now(),
    review_note='Duplicate capture combined with the current eBay Paid listing' where id=other.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'current_paid_duplicate_combined',jsonb_build_object('duplicate_id',other.id,'paid_key',p.source_key));
  end loop;
  -- Do not alter another buyer's successful purchase if a listing was sold again.
  update public.ebay_live_observations set attempt_id=a.id,disposition='matched'
   where event_id=_event_id and listing_id=p.listing_id and lower(btrim(buyer))=lower(btrim(p.buyer)) and amount=p.amount
   and observed_at<=p.observed_at and disposition<>'reviewed';
  if a.payment_state<>'paid' or a.payment_source is distinct from 'listing_current' then
   update public.ebay_live_attempts set payment_state='paid',payment_source='listing_current',paid_at=coalesce(paid_at,p.observed_at),
    review_note=null,updated_at=now() where id=a.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'current_listing_payment',
    jsonb_build_object('state','paid','previous_state',a.payment_state,'source_key',p.source_key,'observed_at',p.observed_at));
  end if;
 end loop;
end $$;
revoke all on function public.apply_ebay_live_listing_payments_internal(text) from public,anon,authenticated;

-- Keep order identity/time reconciliation, then restore the latest listing payment.
alter function public.reconcile_ebay_live_orders_internal(text) rename to reconcile_ebay_live_orders_before_current_payment;
create function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.reconcile_ebay_live_orders_before_current_payment(_event_id);
 perform public.apply_ebay_live_listing_payments_internal(_event_id);
end $$;
revoke all on function public.reconcile_ebay_live_orders_internal(text) from public,anon,authenticated;

alter function public.ingest_ebay_live_events(text,jsonb,jsonb) rename to ingest_ebay_live_events_before_current_payment;
revoke all on function public.ingest_ebay_live_events_before_current_payment(text,jsonb,jsonb) from public,anon,authenticated;
create function public.ingest_ebay_live_events(_event_id text,_events jsonb,_health jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; e jsonb; seen timestamptz;
begin
 -- The original ingress validates permissions, event ownership, and payload bounds.
 result:=public.ingest_ebay_live_events_before_current_payment(_event_id,_events,_health);
 for e in select value from jsonb_array_elements(_events) loop
  if e->>'source'<>'listing' or coalesce(e->>'listing_id','')!~'^[0-9]{8,20}$'
   or (e->>'kind' not in ('paid','failed','cancelled') and not (e->>'kind'='unknown' and e->>'payment_snapshot'='true')) then continue;end if;
  if e->>'kind'='paid' and coalesce(e->>'currency','')<>'USD' then continue;end if;
  seen:=nullif(e->>'observed_at','')::timestamptz;
  if seen is null or seen>now()+interval '30 seconds' then continue;end if;
  insert into public.ebay_live_listing_payments(event_id,listing_id,buyer,amount,kind,observed_at,source_key,evidence)
   values(_event_id,e->>'listing_id',left(e->>'buyer',100),case when coalesce(e->>'amount','')~'^[0-9]{1,9}([.][0-9]{1,2})?$' then (e->>'amount')::numeric end,e->>'kind',seen,e->>'key',left(e->>'evidence',1000))
   on conflict(event_id,listing_id) do update set buyer=excluded.buyer,amount=excluded.amount,kind=excluded.kind,
    observed_at=excluded.observed_at,source_key=excluded.source_key,evidence=excluded.evidence
   where excluded.observed_at>ebay_live_listing_payments.observed_at;
  if e->>'kind'='unknown' and e->>'payment_snapshot'='true' then
   update public.ebay_live_observations set disposition='matched'
    where event_id=_event_id and source_key=e->>'key' and source='listing' and kind='unknown' and disposition<>'reviewed';
  end if;
 end loop;
 if jsonb_array_length(_events)>0 then perform public.apply_ebay_live_listing_payments_internal(_event_id);end if;
 return result;
end $$;
revoke all on function public.ingest_ebay_live_events(text,jsonb,jsonb) from public,anon;
grant execute on function public.ingest_ebay_live_events(text,jsonb,jsonb) to authenticated;

-- A sales total is paid money, never failed bids or the count of closed bags.
alter function public.ebay_live_recovery_status(text) rename to ebay_live_recovery_before_paid_total;
create function public.ebay_live_recovery_status(_event_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; paid_total numeric; paid_count integer; historical_total numeric;
begin
 result:=public.ebay_live_recovery_before_paid_total(_event_id);if result is null then return null;end if;
 select coalesce(sum(amount),0),count(*) into paid_total,paid_count from public.ebay_live_attempts
  where event_id=_event_id and payment_state='paid' and merged_into is null and resolved_at is null;
 historical_total:=(result->>'captured_total')::numeric;
 -- eBay's headline is a separate metric, not proof that each buyer paid.
 if result->>'phase'='needs_review' and result->>'reason'='live_sales'
  and (result->>'listing_passes')::int>=2 and (result->>'activity_passes')::int>=2
  and (result->>'sold_seen')::int=(result->>'sold_expected')::int
  and (result->>'saved_listings')::int>=(result->>'sold_expected')::int then
  result:=result||jsonb_build_object('phase','read','reason',null,'requires_manual_note',false);
 end if;
 return result||jsonb_build_object('captured_total',paid_total,'paid_total',paid_total,'paid_auctions',paid_count,'historical_attempt_total',historical_total);
end $$;
revoke all on function public.ebay_live_recovery_status(text) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
