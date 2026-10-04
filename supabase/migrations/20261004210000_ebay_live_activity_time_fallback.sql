begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- A later-read auction win supersedes an order-import fallback outside that
-- minute. Keep matching second-precision order times and other time sources.
create or replace function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;c public.ebay_live_connections;
 ids uuid[];v_state text;started timestamptz;later_payment boolean;payment_date timestamptz;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 select s.started_at into started from public.live_sale_sessions s where s.id=c.session_id;
 -- Repair previously unread date-prefixed clocks using saved original metadata.
 update public.ebay_live_observations set occurred_at=public.ebay_live_activity_time(c.stream_start_at,c.stream_metadata->>'activity_timezone',time_label)
  where event_id=_event_id and source='activity' and occurred_at is null;
 update public.ebay_live_attempts target set sold_at=e.occurred_at,sale_time_source='ebay_activity',sale_time_precision='minute'
  from public.ebay_live_observations e where target.event_id=_event_id and target.merged_into is null
   and e.event_id=target.event_id and e.source_key=target.win_key and e.kind='won' and e.source='activity' and e.occurred_at is not null
   and (target.sold_at is null or (target.sale_time_source='ebay_order'
    and (target.sold_at<e.occurred_at or target.sold_at>=e.occurred_at+interval '1 minute')));
 for a in select * from public.ebay_live_attempts where event_id=_event_id and resolved_at is null and merged_into is null for update loop
  if a.order_line_id is null then
   select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=a.listing_id and lower(eo.buyer_username)=lower(a.buyer) and el.quantity=1
    and public.ebay_live_order_item_amount(el)=a.amount
    and eo.sale_date>=coalesce(a.sold_at,started)-interval '1 day' and eo.sale_date<=coalesce(a.sold_at,started)+interval '2 days'
    and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
    and not exists(select 1 from public.ebay_live_attempts used where used.order_line_id=el.id);
   if cardinality(ids)<>1 or ids is null then continue;end if;
   update public.ebay_live_attempts set order_line_id=ids[1] where id=a.id;
   a.order_line_id:=ids[1];
  end if;
  select * into l from public.ebay_order_lines where id=a.order_line_id;
  select * into o from public.ebay_orders where id=l.order_id;
  if a.sold_at is null and o.sale_date is not null then
   update public.ebay_live_attempts set sold_at=o.sale_date,sale_time_source='ebay_order',sale_time_precision='second' where id=a.id;
  end if;
  payment_date:=null;
  begin
   payment_date:=(o.raw_payload#>>'{order,paymentSummary,payments,0,paymentDate}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then payment_date:=null;
  end;
  -- A current exact order can resolve an earlier failed retry after the show.
  -- A Paid tile alone cannot. Keep cancellations, manual reviews, unknown
  -- failure times, ambiguous reruns and failures in/after the payment minute held.
  later_payment:=c.broadcast_ended_at is not null and a.payment_state='failed' and payment_date is not null
   and l.item_number=a.listing_id and lower(o.buyer_username)=lower(a.buyer) and public.ebay_live_order_item_amount(l)=a.amount
   and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
   and exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and e.attempt_id=a.id and e.kind='failed')
   and not exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and (e.attempt_id=a.id or e.listing_id=a.listing_id)
    and (e.kind in ('cancelled','unknown') or (e.kind='failed' and (e.occurred_at is null or e.occurred_at+interval '1 minute'>payment_date))));
  v_state:=null;
  if o.status='cancelled' or l.line_status='cancelled' or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS') then v_state:='cancelled';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}','')) in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') then v_state:='review';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',''))='PAID' then
   v_state:=case when a.payment_state in ('failed','cancelled','review') and not later_payment then 'review' else 'paid' end;
  end if;
  if v_state is not null and v_state<>a.payment_state then
   update public.ebay_live_attempts set payment_state=v_state,payment_source='order_import',
    paid_at=case when v_state='paid' then coalesce(payment_date,paid_at,now()) else paid_at end,
    review_note=case when later_payment and v_state='paid' then 'Exact eBay order paid after the historical payment failures' when v_state<>'paid' then 'Order import requires payment/bag review' else review_note end,updated_at=now() where id=a.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'order_reconciled',jsonb_build_object('order_line_id',l.id,'state',v_state,'historical_failure_resolved',later_payment and v_state='paid','payment_date',payment_date));
  end if;
 end loop;
end $$;

commit;
