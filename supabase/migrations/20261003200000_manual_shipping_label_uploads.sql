-- Attach PDFs from any provider while keeping every label on mixed shipments.
create index if not exists ebay_label_manual_request_idx on public.ebay_order_label_events
  ((label_metadata->>'manualUploadRequestId')) where source = 'manual-label-upload';

create or replace function public.attach_manual_shipping_labels(_request_id uuid, _labels jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_label jsonb; v_order public.ebay_orders; v_all_ids uuid[]; v_ids uuid[]; v_lines uuid[];
  v_path text; v_metadata jsonb; v_event_id uuid; v_result jsonb := '[]'::jsonb;
  v_existing public.ebay_order_label_events; v_fingerprint text := md5(_labels::text);
begin
  if auth.uid() is null or not public.can_manage_inventory() then
    raise exception 'Only inventory staff can attach shipping labels' using errcode = '42501';
  end if;
  if _request_id is null or jsonb_typeof(_labels) is distinct from 'array'
     or jsonb_array_length(_labels) not between 1 and 20 then
    raise exception 'Choose between 1 and 20 shipping-label PDFs' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('manual-label-upload:' || _request_id::text, 0));
  select * into v_existing from public.ebay_order_label_events
    where source='manual-label-upload' and label_metadata->>'manualUploadRequestId'=_request_id::text limit 1;
  if found then
    if v_existing.signed_by is distinct from auth.uid()
       or v_existing.label_metadata->>'manualUploadFingerprint' is distinct from v_fingerprint then
      raise exception 'This upload request has already been used' using errcode = '22023';
    end if;
    return jsonb_build_object('saved',true,'already_saved',true);
  end if;
  select array_agg(distinct id::uuid order by id::uuid) into v_all_ids
  from jsonb_array_elements(_labels) label cross join lateral jsonb_array_elements_text(label->'order_ids') ids(id);
  if coalesce(cardinality(v_all_ids),0)=0 or cardinality(v_all_ids)>100
     or (select count(*) from public.ebay_orders where id=any(v_all_ids)) <> cardinality(v_all_ids) then
    raise exception 'Select valid orders for every label' using errcode = '22023';
  end if;
  perform id from public.ebay_orders where id=any(v_all_ids) order by id for update;
  for v_label in select value from jsonb_array_elements(_labels)
  loop
    select array_agg(distinct id::uuid) into v_ids from jsonb_array_elements_text(v_label->'order_ids') ids(id);
    v_path := v_label->>'path';
    v_metadata := v_label->'metadata';
    if coalesce(cardinality(v_ids),0)=0 or coalesce(v_path,'') not like 'manual-labels/%.pdf'
       or jsonb_typeof(v_metadata) is distinct from 'object'
       or jsonb_typeof(v_metadata->'trackingNumbers') is distinct from 'array'
       or jsonb_array_length(v_metadata->'trackingNumbers') not between 1 and 100
       or not exists (select 1 from storage.objects where bucket_id='ebay-labels' and name=v_path) then
      raise exception 'Each label needs an uploaded PDF, selected orders and tracking/barcode numbers' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_metadata->'trackingNumbers') code
               where jsonb_typeof(code) is distinct from 'string' or (code #>> '{}') !~ '^[A-Za-z0-9]{6,80}$') then
      raise exception 'Tracking/barcode numbers must contain 6–80 letters or digits' using errcode = '22023';
    end if;
    v_metadata := v_metadata || jsonb_build_object('manualUploadRequestId',_request_id,
      'manualUploadFingerprint',v_fingerprint,'source','manual-label-upload','capturedAt',now());
    for v_order in select * from public.ebay_orders where id=any(v_ids) order by id
    loop
      select coalesce(array_agg(id),'{}'::uuid[]) into v_lines from public.ebay_order_lines where order_id=v_order.id;
      insert into public.ebay_order_label_events(action,order_ids,order_line_ids,order_numbers,
        label_storage_bucket,label_file_path,label_metadata,signed_by,signed_by_email,source)
      values(case when nullif(v_order.label_file_path,'') is null then 'attached' else 'extra_label' end,
        array[v_order.id],v_lines,array[v_order.order_number],'ebay-labels',v_path,
        v_metadata || jsonb_build_object('orderNumbers',jsonb_build_array(v_order.order_number)),
        auth.uid(),auth.email(),'manual-label-upload') returning id into v_event_id;
      if nullif(v_order.label_file_path,'') is null then
        update public.ebay_orders set label_storage_bucket='ebay-labels',label_file_path=v_path,
          label_metadata=v_metadata || jsonb_build_object('orderNumbers',jsonb_build_array(v_order.order_number)),
          label_status=case when label_status='completed' then label_status else 'label_uploaded' end,
          label_uploaded_at=now(),label_uploaded_by=auth.uid(),updated_at=now() where id=v_order.id;
      end if;
      v_result := v_result || jsonb_build_array(v_event_id);
    end loop;
  end loop;
  return jsonb_build_object('saved',true,'event_ids',v_result);
end;
$$;
revoke all on function public.attach_manual_shipping_labels(uuid,jsonb) from public,anon;
grant execute on function public.attach_manual_shipping_labels(uuid,jsonb) to authenticated;
