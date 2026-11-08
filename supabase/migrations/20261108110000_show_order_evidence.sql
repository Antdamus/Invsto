begin;
set local lock_timeout='5s';
create table public.ebay_show_order_evidence (
 order_number text primary key, captured_at timestamptz not null default now(),
 source_payload jsonb not null, previous_sale_date timestamptz, previous_date_precision text
);
alter table public.ebay_show_order_evidence enable row level security;
revoke all on public.ebay_show_order_evidence from public,anon,authenticated;
grant select on public.ebay_show_order_evidence to service_role;

-- Internal, bounded reconciliation. Existing operational states, assignments,
-- tracking, notes, reservations and completion evidence are never replaced.
create function public.reconcile_ebay_show_orders(_orders jsonb,_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o jsonb; l jsonb; old public.ebay_orders; line_old public.ebay_order_lines;
 number text; item text; txn text; ids uuid[]; matched uuid[]; order_id uuid;
 purchased timestamptz; paid timestamptz; stamp timestamptz:=statement_timestamp();
 pay text; fulfil text; cancel text; state text; line_state text; raw jsonb; qty integer; cost numeric;
 changed_dates int:=0; new_orders int:=0; new_lines int:=0; updated_orders int:=0; updated_lines int:=0; skipped int:=0;
begin
 if jsonb_typeof(_orders) is distinct from 'array' or jsonb_array_length(_orders)>100 then raise exception 'Choose at most 100 eBay orders';end if;
 if (select count(distinct x->>'orderId') from jsonb_array_elements(_orders) x)<>jsonb_array_length(_orders) then raise exception 'Missing or duplicate order IDs';end if;
 for o in select value from jsonb_array_elements(_orders) order by value->>'orderId' loop
  number:=o->>'orderId';
  if number !~ '^[0-9]{2}-[0-9]{5}-[0-9]{5}$' or coalesce(o->>'creationDate','')!~ 'T[0-9]{2}:[0-9]{2}' then raise exception 'Invalid order identity or purchase timestamp';end if;
  purchased:=(o->>'creationDate')::timestamptz;
  pay:=upper(coalesce(o->>'orderPaymentStatus',''));fulfil:=upper(coalesce(o->>'orderFulfillmentStatus',''));cancel:=upper(coalesce(o#>>'{cancelStatus,cancelState}',''));
  paid:=case when o#>>'{paymentSummary,payments,0,paymentDate}' ~ 'T[0-9]{2}:[0-9]{2}' then (o#>>'{paymentSummary,payments,0,paymentDate}')::timestamptz end;
  perform pg_advisory_xact_lock(hashtextextended('ebay-order-evidence:'||number,0));
  select * into old from public.ebay_orders where order_number=number for update;
  if old.id is null and pay not in ('PAID','PARTIALLY_REFUNDED','FULLY_REFUNDED','REFUNDED') and fulfil not in ('FULFILLED','IN_PROGRESS') and cancel not in ('CANCELLED','CANCELED','CANCEL_CLOSED_WITH_REFUND') then skipped:=skipped+1;continue;end if;
  if jsonb_typeof(o->'lineItems') is distinct from 'array' or jsonb_array_length(o->'lineItems')=0 then raise exception 'Missing order lines for %',number;end if;
  if old.id is not null and (old.sale_date is distinct from purchased or coalesce(old.raw_payload#>>'{date_precision,sale_date}','')<>'timestamp') then changed_dates:=changed_dates+1;end if;
  state:=case when cancel in ('CANCELLED','CANCELED','CANCEL_CLOSED_WITH_REFUND') then 'cancelled' when fulfil='FULFILLED' then 'fulfilled' when fulfil='IN_PROGRESS' then 'partially_fulfilled' else 'pending' end;
  raw:=coalesce(old.raw_payload,'{}')||jsonb_build_object('order',o,'orderPaymentStatus',pay,'orderFulfillmentStatus',fulfil,'orderCancelStatus',cancel,
   'ebay_order_evidence',jsonb_build_object('source','ebay_fulfillment_api','checked_at',stamp,'order_number',number),
   'date_precision',coalesce(old.raw_payload->'date_precision','{}')||jsonb_build_object('sale_date','timestamp')||case when paid is not null then '{"paid_on_date":"timestamp"}'::jsonb else '{}' end);
  if old.id is null then raw:=raw||'{"source":"ebay_fulfillment_api"}'::jsonb;new_orders:=new_orders+1;else updated_orders:=updated_orders+1;end if;
  order_id:=old.id;
  if not _dry_run then
   insert into public.ebay_show_order_evidence(order_number,source_payload,previous_sale_date,previous_date_precision)
   values(number,o,old.sale_date,old.raw_payload#>>'{date_precision,sale_date}')
   on conflict(order_number) do update set source_payload=excluded.source_payload,captured_at=stamp;
   if old.id is null then
    insert into public.ebay_orders(order_number,buyer_username,buyer_name,sale_date,paid_on_date,total_price,status,raw_payload)
    values(number,o#>>'{buyer,username}',coalesce(o#>>'{fulfillmentStartInstructions,0,shippingStep,shipTo,fullName}',o#>>'{buyer,buyerRegistrationAddress,fullName}'),purchased,paid,public.weekly_sales_money(o#>>'{pricingSummary,total,value}'),state,raw)
    returning id into order_id;
   else
    update public.ebay_orders set sale_date=purchased,paid_on_date=coalesce(paid,paid_on_date),raw_payload=raw where id=old.id;
   end if;
  end if;
  matched:='{}';
  for l in select value from jsonb_array_elements(o->'lineItems') loop
   txn:=nullif(l->>'lineItemId','');item:=nullif(l->>'legacyItemId','');qty:=(l->>'quantity')::integer;
   if txn is null or item is null or qty is null or qty<=0 then raise exception 'Invalid line identity or quantity for %',number;end if;
   select array_agg(id) into ids from public.ebay_order_lines where ebay_order_lines.order_id=old.id and (transaction_id=txn or raw_payload#>>'{line,lineItemId}'=txn);
   if coalesce(cardinality(ids),0)=0 then
    select array_agg(id) into ids from public.ebay_order_lines where ebay_order_lines.order_id=old.id and item_number=item;
    -- A legacy CSV line can be upgraded only when its item mapping is unique.
    if cardinality(ids)=1 and (select count(*) from jsonb_array_elements(o->'lineItems') x where x->>'legacyItemId'=item)>1 then raise exception 'Ambiguous legacy item in %',number;end if;
   end if;
   if cardinality(ids)>1 then raise exception 'Ambiguous stored order line for %',number;end if;
   if cardinality(ids)=1 and ids[1]=any(matched) then raise exception 'Duplicate line mapping for %',number;end if;
   select * into line_old from public.ebay_order_lines where id=ids[1] for update;
   if line_old.id is null then new_lines:=new_lines+1;else updated_lines:=updated_lines+1;matched:=array_append(matched,line_old.id);end if;
   cost:=coalesce(public.weekly_sales_money(l#>>'{discountedLineItemCost,value}'),public.weekly_sales_money(l#>>'{lineItemCost,value}'));
   raw:=coalesce(line_old.raw_payload,'{}')||jsonb_build_object('line',l,'orderPaymentStatus',pay,'orderFulfillmentStatus',fulfil,'orderCancelStatus',cancel,'history_evidence_checked_at',stamp);
   if line_old.id is null then raw:=raw||'{"source":"ebay_fulfillment_api"}'::jsonb;end if;
   if not _dry_run then
    if line_old.id is null then
     line_state:=state;
     insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,quantity,sold_for,total_price,line_status,fulfilled_quantity,raw_payload)
     values(order_id,item,txn,coalesce(nullif(l->>'title',''),'eBay item'),qty,cost/qty,cost,line_state,case when line_state in ('fulfilled','cancelled') then qty else 0 end,raw);
    else
     update public.ebay_order_lines set raw_payload=raw where id=line_old.id;
    end if;
   end if;
  end loop;
 end loop;
 return jsonb_build_object('dryRun',_dry_run,'ordersUpdated',updated_orders,'datesCorrected',changed_dates,'ordersInserted',new_orders,'linesUpdated',updated_lines,'linesInserted',new_lines,'unpaidOrdersSkipped',skipped);
end$$;
revoke all on function public.reconcile_ebay_show_orders(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_ebay_show_orders(jsonb,boolean) to service_role;
notify pgrst,'reload schema';
commit;
