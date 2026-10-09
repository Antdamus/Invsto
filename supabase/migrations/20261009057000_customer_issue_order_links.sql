begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Case-level links also survive closed tasks and non-physical disputes.
create function public.customer_issue_order_line_ids(_case_id uuid) returns uuid[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(distinct l.id),'{}') from public.ebay_return_cases c
 join public.ebay_order_lines l on l.order_id=c.order_id
 where c.id=_case_id and (
  exists(select 1 from public.ebay_return_items i where i.return_case_id=c.id and i.order_line_id=l.id)
  or exists(select 1 from public.ebay_return_tasks t where t.return_case_id=c.id and l.id=any(t.order_line_ids))
  or coalesce(c.raw_payload->'manualOrderMatch'->'line_ids','[]') @> to_jsonb(array[l.id])
  or (not(c.raw_payload ? 'manualOrderMatch') and coalesce(c.raw_payload->'automaticOrderMatch'->'line_ids','[]') @> to_jsonb(array[l.id]))
 )
$$;
revoke all on function public.customer_issue_order_line_ids(uuid) from public,anon,authenticated;
grant execute on function public.customer_issue_order_line_ids(uuid) to service_role;

create function public.repair_customer_issue_order_links() returns int
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases; chosen record; repaired int:=0; item text; tx text; quantity int;
begin
 for c in select * from public.ebay_return_cases where not(raw_payload ? 'manualOrderMatch')
  and cardinality(public.customer_issue_order_line_ids(id))=0
  and not exists(select 1 from public.ebay_return_items i where i.return_case_id=ebay_return_cases.id)
  and not exists(select 1 from public.ebay_return_tasks t where t.return_case_id=ebay_return_cases.id and cardinality(t.order_line_ids)>0)
  for update loop
  item:=nullif(btrim(c.raw_payload->'apiExtractedDetails'->>'itemNumber'),'');
  tx:=nullif(btrim(c.raw_payload->'apiExtractedDetails'->>'transactionId'),'');
  if item is null and tx is null then continue;end if;
  with candidates as (
   select l.*,o.order_number,o.buyer_username,coalesce(l.transaction_id=tx,false) exact_tx
   from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
   where (c.order_id is null or o.id=c.order_id)
    and (c.order_number is null or o.order_number=c.order_number)
    and (c.order_id is not null or c.order_number is not null or (item is not null and nullif(c.buyer_username,'') is not null))
    and (nullif(c.buyer_username,'') is null or lower(o.buyer_username)=lower(c.buyer_username))
    and (item is null or l.item_number=item)
  ), counted as (select *,count(*) over() total,count(*) filter(where exact_tx) over() exact_total from candidates)
  select * into chosen from counted where (exact_total=1 and exact_tx) or (item is not null and total=1) limit 1;
  if not found then continue;end if;
  update public.ebay_return_cases set order_id=chosen.order_id,order_number=chosen.order_number,case_type='matched_order',
   raw_payload=raw_payload||jsonb_build_object('automaticOrderMatch',jsonb_build_object('order_id',chosen.order_id,'line_ids',jsonb_build_array(chosen.id),
    'source','order_listing_identity','item_number',item,'provider_transaction_id',tx)),updated_at=now() where id=c.id;
  -- Add identity to existing work without reopening it, changing its owner, or
  -- treating evidence association as a returned item or inventory movement.
  update public.ebay_return_tasks set order_id=chosen.order_id,order_line_ids=array[chosen.id],
   question=case when question in (
    'No matching OG order history was found. Review the eBay buyer, item, reason, refund value, and return details before deciding the next step.',
    'No matching OG order history was found. Review the eBay request/dispute details, buyer, item, value, and order number before deciding the next step.')
    then 'Review the original order and its saved item and shipping evidence before deciding the next step.' else question end
  where return_case_id=c.id and coalesce(cardinality(order_line_ids),0)=0;
  quantity:=case when c.raw_payload->'apiExtractedDetails'->>'quantity' ~ '^[0-9]{1,6}$' then (c.raw_payload->'apiExtractedDetails'->>'quantity')::int else 1 end;
  if c.source_lane='return' then
   insert into public.ebay_return_items(return_case_id,order_id,order_line_id,internal_item_id,item_title,item_number,expected_quantity)
   values(c.id,chosen.order_id,chosen.id,chosen.internal_item_id,coalesce(chosen.item_title,c.item_title,'eBay item'),chosen.item_number,greatest(1,least(quantity,chosen.quantity)))
   on conflict(return_case_id,order_line_id) do nothing;
  end if;
  insert into public.ebay_return_events(return_case_id,order_id,order_line_ids,action,notes,payload)
   values(c.id,chosen.order_id,array[chosen.id],'admin_override','Connected original order evidence using a unique eBay order/listing identity. No order, task status, or inventory quantity changed.',
    jsonb_build_object('source','customer_issue_order_link_repair','previous_order_id',c.order_id,'provider_transaction_id',tx,'order_transaction_id',chosen.transaction_id));
  repaired:=repaired+1;
 end loop;
 return repaired;
end $$;
revoke all on function public.repair_customer_issue_order_links() from public,anon,authenticated;
grant execute on function public.repair_customer_issue_order_links() to service_role;
select public.repair_customer_issue_order_links();
commit;
