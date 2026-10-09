-- One authoritative stop for completion, labels and package dispatch.
begin;
set local lock_timeout='3s';
set local statement_timeout='90s';

create or replace function public.ebay_fulfillment_block(_order jsonb,_line jsonb default '{}')
returns text language plpgsql immutable set search_path='' as $$
declare o jsonb:=coalesce(_order->'raw_payload','{}');l jsonb:=coalesce(_line->'raw_payload','{}');p text;c text;
begin
 if lower(coalesce(_order->>'status','')) in ('cancelled','canceled','archived','closed','refunded') then return 'Order is cancelled or closed';end if;
 if lower(coalesce(_line->>'line_status','')) in ('cancelled','canceled','skipped','closed','refunded') then return 'Item is cancelled or closed';end if;
 if upper(coalesce(l->>'orderPaymentStatus','')) in ('REFUNDED','FULLY_REFUNDED','PARTIALLY_REFUNDED','REFUND_PENDING','PENDING_REFUND') then return 'Refund reported for this item';end if;
 p:=upper(coalesce(nullif(o#>>'{pending_order_sync_mismatch,ebayPaymentStatus}',''),nullif(o->>'orderPaymentStatus',''),nullif(o#>>'{order,orderPaymentStatus}',''),nullif(l->>'orderPaymentStatus',''),o#>>'{order,paymentSummary,payments,0,paymentStatus}',''));
 c:=upper(coalesce(nullif(o#>>'{pending_order_sync_mismatch,ebayCancelStatus}',''),nullif(o->>'orderCancelStatus',''),nullif(o#>>'{order,cancelStatus,cancelState}',''),nullif(l->>'orderCancelStatus',''),nullif(o#>>'{api_cancellation_case,cancelStatus}',''),o#>>'{cancellation_page_case,cancelStatus}',''));
 if p in ('REFUNDED','FULLY_REFUNDED','PARTIALLY_REFUNDED','REFUND_PENDING','PENDING_REFUND') then return 'Refund reported by eBay';end if;
 if c not in ('','NONE_REQUESTED','NOT_REQUESTED','NO_CANCEL','NOT_CANCELLED','CANCEL_REJECTED','CANCEL_CLOSED_WITHOUT_REFUND') then return 'Cancellation reported by eBay: '||c;end if;
 if p in ('UNPAID','PENDING','FAILED','PAYMENT_FAILED','PARTIALLY_PAID') then return 'Payment is not confirmed';end if;
 return null;
end $$;

create or replace function public.assert_ebay_fulfillment_allowed(_order_ids uuid[],_line_ids uuid[] default null)
returns void language plpgsql security definer set search_path='' as $$
declare r record;reason text;
begin
 -- Lock the order against a concurrent refund/cancellation update until commit.
 for r in select o.* from public.ebay_orders o where id=any(_order_ids) order by id for update loop
  reason:=public.ebay_fulfillment_block(to_jsonb(r));
  if reason is not null then raise exception 'Do not ship order %: %. Completion and shipping labels are blocked.',r.order_number,reason using errcode='23514';end if;
 end loop;
 for r in select o.order_number,to_jsonb(o) o,to_jsonb(l) l from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
  where l.order_id=any(_order_ids) and (_line_ids is null or l.id=any(_line_ids)) loop
  reason:=public.ebay_fulfillment_block(r.o,r.l);
  if reason is not null then raise exception 'Do not ship order %: %. Completion and shipping labels are blocked.',r.order_number,reason using errcode='23514';end if;
 end loop;
end $$;
revoke all on function public.assert_ebay_fulfillment_allowed(uuid[],uuid[]) from public,anon,authenticated;

create or replace function public.guard_ebay_fulfillment_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Service imports preserve historical facts; a signed-in checkout may never
 -- create a new local fulfillment against a cancellation or refund.
 if auth.uid() is not null and
  ((new.line_status='fulfilled' and old.line_status is distinct from new.line_status) or new.fulfilled_quantity>coalesce(old.fulfilled_quantity,0)) then
  perform public.assert_ebay_fulfillment_allowed(array[new.order_id],array[new.id]);
  if public.ebay_fulfillment_block('{}',to_jsonb(new)) is not null then raise exception 'This item cannot be completed: refund or cancellation reported' using errcode='23514';end if;
 end if;
 return new;
end $$;
create trigger aaa_guard_ebay_fulfillment_payment before update of line_status,fulfilled_quantity on public.ebay_order_lines for each row execute function public.guard_ebay_fulfillment_payment();

create or replace function public.guard_ebay_order_completion_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null and new.status='fulfilled' and old.status is distinct from new.status
 and public.ebay_fulfillment_block(to_jsonb(new)) is not null then
  raise exception 'Order completion blocked: cancelled, refunded or unpaid order' using errcode='23514';
 end if;
 return new;
end $$;
create trigger guard_ebay_order_completion_payment before update of status on public.ebay_orders for each row execute function public.guard_ebay_order_completion_payment();

create or replace function public.guard_ebay_shipping_label_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='ebay_order_label_events' then
  if new.action in ('attached','replaced','extra_label') then perform public.assert_ebay_fulfillment_allowed(new.order_ids);end if;
 else
  if nullif(new.label_file_path,'') is not null and new.label_file_path is distinct from old.label_file_path then
   if public.ebay_fulfillment_block(to_jsonb(new)) is not null then raise exception 'Shipping labels are blocked: order cancelled, refunded or unpaid' using errcode='23514';end if;
   perform public.assert_ebay_fulfillment_allowed(array[new.id]);
  end if;
 end if;
 return new;
end $$;
create trigger guard_ebay_shipping_label_payment before insert on public.ebay_order_label_events for each row execute function public.guard_ebay_shipping_label_payment();
create trigger guard_ebay_order_label_payment before update of label_file_path on public.ebay_orders for each row execute function public.guard_ebay_shipping_label_payment();

create or replace function public.guard_packaging_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status in ('ready','dispatched') and (tg_op='INSERT' or new.status is distinct from old.status) then
  perform public.assert_ebay_fulfillment_allowed(new.order_ids,
   (select array_agg(order_line_id) from public.packaging_items where shipment_id=new.id));
 end if;
 return new;
end $$;
create trigger guard_packaging_payment before insert or update of status on public.packaging_shipments for each row execute function public.guard_packaging_payment();

create or replace function public.check_ebay_fulfillment_allowed(_line_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if coalesce(cardinality(_line_ids),0) not between 1 and 500 then raise exception 'Select between 1 and 500 order items';end if;
 select coalesce(jsonb_agg(jsonb_build_object('line_id',l.id,'order_number',o.order_number,'reason',public.ebay_fulfillment_block(to_jsonb(o),to_jsonb(l)))),'[]') into result
 from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id where l.id=any(_line_ids) and public.ebay_fulfillment_block(to_jsonb(o),to_jsonb(l)) is not null;
 if (select count(*) from public.ebay_order_lines where id=any(_line_ids))<>(select count(distinct x) from unnest(_line_ids) x) then raise exception 'An order item no longer exists. Refresh Pending Orders.';end if;
 return result;
end $$;
revoke all on function public.check_ebay_fulfillment_allowed(uuid[]) from public,anon;
grant execute on function public.check_ebay_fulfillment_allowed(uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
