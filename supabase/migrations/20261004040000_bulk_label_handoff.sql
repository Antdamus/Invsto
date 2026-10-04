-- Target the requested orders before loading their lines. The nested REST filter
-- checked unrelated pending rows and repeated staff RLS checks during handoff.
create or replace function public.list_pending_ebay_order_matches(
  _order_numbers text[] default '{}', _buyer_usernames text[] default '{}',
  _item_number text default null, _transaction_id text default null,
  _include_admin_fields boolean default false, _limit integer default 1000, _offset integer default 0
) returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  v_order_ids uuid[];
  v_admin boolean := public.is_admin() and coalesce(_include_admin_fields,false);
  v_item text := nullif(btrim(_item_number),'');
  v_txn text := nullif(btrim(_transaction_id),'');
begin
  if auth.uid() is null or not public.can_manage_inventory() then
    raise exception 'Staff access required' using errcode='42501';
  end if;
  if coalesce(cardinality(_order_numbers),0)>0 then
    select coalesce(array_agg(id),'{}'::uuid[]) into v_order_ids
      from public.ebay_orders where order_number=any(_order_numbers);
  elsif coalesce(cardinality(_buyer_usernames),0)>0 then
    select coalesce(array_agg(id),'{}'::uuid[]) into v_order_ids
      from public.ebay_orders where buyer_username=any(_buyer_usernames);
  elsif v_item is null and v_txn is null then
    raise exception 'An order, buyer, item or transaction is required' using errcode='22023';
  end if;
  return query
  select jsonb_build_object(
    'id',l.id,'order_id',l.order_id,'item_number',l.item_number,'transaction_id',l.transaction_id,
    'item_title',l.item_title,'custom_label',l.custom_label,'quantity',l.quantity,
    'sold_for',l.sold_for,'shipping_and_handling',l.shipping_and_handling,'total_price',l.total_price,
    'net_payout',case when v_admin then l.net_payout end,'line_status',l.line_status,'created_at',l.created_at,
    'raw_payload',l.raw_payload,'internal_item_id',l.internal_item_id,'fulfilled_quantity',l.fulfilled_quantity,
    'fulfilled_at',l.fulfilled_at,'assigned_seller_employee_id',l.assigned_seller_employee_id,
    'assigned_seller_snapshot',l.assigned_seller_snapshot,'notes',l.notes,'item_search',to_jsonb(s),
    'ebay_orders',jsonb_build_object(
      'id',o.id,'order_number',o.order_number,'sales_record_number',o.sales_record_number,
      'buyer_username',o.buyer_username,'buyer_name',o.buyer_name,'sale_date',o.sale_date,
      'paid_on_date',o.paid_on_date,'imported_at',o.imported_at,'ship_by_date',o.ship_by_date,
      'payment_method',case when v_admin then o.payment_method end,
      'shipping_and_handling',case when v_admin then o.shipping_and_handling end,
      'ebay_collected_tax',case when v_admin then o.ebay_collected_tax end,
      'total_price',o.total_price,'net_payout',case when v_admin then o.net_payout end,
      'status',o.status,'raw_payload',o.raw_payload,'label_status',o.label_status,
      'label_storage_bucket',o.label_storage_bucket,'label_file_path',o.label_file_path,
      'label_uploaded_at',o.label_uploaded_at))
  from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
  left join public.pending_order_item_search s on s.order_line_id=l.id
  where l.line_status in ('pending','partially_fulfilled')
    and (v_order_ids is null or l.order_id=any(v_order_ids))
    and (v_item is null or l.item_number=v_item)
    and (v_txn is null or l.transaction_id=v_txn)
  order by l.created_at desc,l.id desc
  limit least(greatest(coalesce(_limit,1000),1),2000) offset greatest(coalesce(_offset,0),0);
end $$;
revoke all on function public.list_pending_ebay_order_matches(text[],text[],text,text,boolean,integer,integer) from public,anon;
grant execute on function public.list_pending_ebay_order_matches(text[],text[],text,text,boolean,integer,integer) to authenticated;

-- Save a combined PDF as one atomic batch instead of repeating reads and writes
-- for each order. Locks retain the original retry/concurrent-append semantics.
create or replace function public.append_ebay_shipping_label(
  _order_ids uuid[], _label_file_path text, _label_metadata jsonb default '{}'::jsonb, _shipment_id text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_ids uuid[]; v_orders jsonb; v_events jsonb;
  v_path text:=nullif(btrim(_label_file_path),'');
  v_actor uuid:=auth.uid(); v_email text:=auth.email();
begin
  if v_actor is null or not public.can_manage_inventory() then
    raise exception 'Only inventory staff can attach shipping labels' using errcode='42501';
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(_order_ids) ids(id) where id is not null;
  if coalesce(cardinality(v_ids),0) not between 1 and 100
    or (select count(*) from public.ebay_orders where id=any(v_ids))<>cardinality(v_ids) then
    raise exception 'Select valid orders for this label' using errcode='22023';
  end if;
  if v_path is null or jsonb_typeof(_label_metadata) is distinct from 'object'
    or not exists(select 1 from storage.objects where bucket_id='ebay-labels' and name=v_path) then
    raise exception 'An uploaded shipping-label PDF and label metadata are required' using errcode='22023';
  end if;
  perform id from public.ebay_orders where id=any(v_ids) order by id for update;
  insert into public.ebay_order_label_events(action,order_ids,order_line_ids,order_numbers,shipment_id,
    label_storage_bucket,label_file_path,label_metadata,signed_by,signed_by_email,source)
  select case when nullif(btrim(o.label_file_path),'') is null then 'attached' else 'extra_label' end,
    array[o.id],coalesce(lines.ids,'{}'::uuid[]),array[o.order_number],nullif(btrim(_shipment_id),''),
    'ebay-labels',v_path,_label_metadata||jsonb_build_object('source','extension-append','orderNumbers',jsonb_build_array(o.order_number)),
    v_actor,v_email,'extension-append'
  from public.ebay_orders o
  left join (select order_id,array_agg(id order by id) ids from public.ebay_order_lines
    where order_id=any(v_ids) group by order_id) lines on lines.order_id=o.id
  where o.id=any(v_ids) and not exists(
    select 1 from public.ebay_order_label_events e where o.id=any(e.order_ids)
      and e.label_storage_bucket='ebay-labels' and e.label_file_path=v_path
      and e.action in ('attached','replaced','extra_label'));
  update public.ebay_orders o set ebay_shipment_id=nullif(btrim(_shipment_id),''),
    label_storage_bucket='ebay-labels',label_file_path=v_path,
    label_metadata=_label_metadata||jsonb_build_object('source','extension-append','orderNumbers',jsonb_build_array(o.order_number)),
    label_status=case when o.label_status='completed' then o.label_status else 'label_uploaded' end,
    label_uploaded_at=now(),label_uploaded_by=v_actor,updated_at=now()
  where o.id=any(v_ids) and nullif(btrim(o.label_file_path),'') is null;
  select jsonb_agg(e.id order by ids.id) into v_events from unnest(v_ids) ids(id)
  cross join lateral (select id from public.ebay_order_label_events where ids.id=any(order_ids)
    and label_storage_bucket='ebay-labels' and label_file_path=v_path
    and action in ('attached','replaced','extra_label') order by created_at,id limit 1) e;
  select jsonb_agg(jsonb_build_object('id',id,'ebay_shipment_id',ebay_shipment_id,
    'label_status',label_status,'label_storage_bucket',label_storage_bucket,'label_file_path',label_file_path,
    'label_uploaded_at',label_uploaded_at,'label_metadata',label_metadata) order by id) into v_orders
  from public.ebay_orders where id=any(v_ids);
  return jsonb_build_object('saved',true,'event_ids',v_events,'order_labels',v_orders);
end $$;
revoke all on function public.append_ebay_shipping_label(uuid[],text,jsonb,text) from public,anon;
grant execute on function public.append_ebay_shipping_label(uuid[],text,jsonb,text) to authenticated;
notify pgrst,'reload schema';
