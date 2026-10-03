-- Pending-order extension imports add labels without changing an existing primary label.
-- Keep the explicit replacement RPC used by Order History separate.
create index if not exists ebay_label_events_file_idx
  on public.ebay_order_label_events(label_storage_bucket,label_file_path);

create or replace function public.append_ebay_shipping_label(
  _order_ids uuid[],
  _label_file_path text,
  _label_metadata jsonb default '{}'::jsonb,
  _shipment_id text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ids uuid[]; v_order public.ebay_orders; v_lines uuid[]; v_orders jsonb;
  v_path text := nullif(btrim(_label_file_path),''); v_event_id uuid;
  v_events jsonb := '[]'::jsonb; v_metadata jsonb;
begin
  if auth.uid() is null or not public.can_manage_inventory() then
    raise exception 'Only inventory staff can attach shipping labels' using errcode = '42501';
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(_order_ids) ids(id) where id is not null;
  if coalesce(cardinality(v_ids),0) not between 1 and 100
     or (select count(*) from public.ebay_orders where id=any(v_ids)) <> cardinality(v_ids) then
    raise exception 'Select valid orders for this label' using errcode = '22023';
  end if;
  if v_path is null or jsonb_typeof(_label_metadata) is distinct from 'object'
     or not exists (select 1 from storage.objects where bucket_id='ebay-labels' and name=v_path) then
    raise exception 'An uploaded shipping-label PDF and label metadata are required' using errcode = '22023';
  end if;
  -- Serialize competing labels on the same orders; a repeated PDF is idempotent per order.
  perform id from public.ebay_orders where id=any(v_ids) order by id for update;
  for v_order in select * from public.ebay_orders where id=any(v_ids) order by id
  loop
    select coalesce(array_agg(id),'{}'::uuid[]) into v_lines from public.ebay_order_lines where order_id=v_order.id;
    v_metadata := _label_metadata || jsonb_build_object('source','extension-append',
      'orderNumbers',jsonb_build_array(v_order.order_number));
    select e.id into v_event_id from public.ebay_order_label_events e
      where v_order.id=any(e.order_ids) and e.label_storage_bucket='ebay-labels'
        and e.label_file_path=v_path and e.action in ('attached','replaced','extra_label')
      order by e.created_at limit 1;
    if not found then
      insert into public.ebay_order_label_events(action,order_ids,order_line_ids,order_numbers,
        shipment_id,label_storage_bucket,label_file_path,label_metadata,signed_by,signed_by_email,source)
      values(case when nullif(btrim(v_order.label_file_path),'') is null then 'attached' else 'extra_label' end,
        array[v_order.id],v_lines,array[v_order.order_number],nullif(btrim(_shipment_id),''),
        'ebay-labels',v_path,v_metadata,auth.uid(),auth.email(),'extension-append') returning id into v_event_id;
    end if;
    if nullif(btrim(v_order.label_file_path),'') is null then
      update public.ebay_orders set ebay_shipment_id=nullif(btrim(_shipment_id),''),
        label_storage_bucket='ebay-labels',label_file_path=v_path,label_metadata=v_metadata,
        label_status=case when label_status='completed' then label_status else 'label_uploaded' end,
        label_uploaded_at=now(),label_uploaded_by=auth.uid(),updated_at=now() where id=v_order.id;
    end if;
    v_events := v_events || jsonb_build_array(v_event_id);
  end loop;
  select jsonb_agg(jsonb_build_object('id',id,'ebay_shipment_id',ebay_shipment_id,
    'label_status',label_status,'label_storage_bucket',label_storage_bucket,'label_file_path',label_file_path,
    'label_uploaded_at',label_uploaded_at,'label_metadata',label_metadata)) into v_orders
    from public.ebay_orders where id=any(v_ids);
  return jsonb_build_object('saved',true,'event_ids',v_events,'order_labels',v_orders);
end;
$$;
revoke all on function public.append_ebay_shipping_label(uuid[],text,jsonb,text) from public,anon;
grant execute on function public.append_ebay_shipping_label(uuid[],text,jsonb,text) to authenticated;
