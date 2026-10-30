-- Record verified external shipments without closing local orders, consuming
-- inventory, claiming delivery, or creating a fictional shipping-label PDF.
create table if not exists public.ebay_shipping_reconciliation_batches (
  id uuid primary key,
  window_start timestamptz not null,
  window_end timestamptz not null,
  annotation text not null,
  entries jsonb not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid default auth.uid(),
  source text not null default 'ebay_fulfillment_api'
);
alter table public.ebay_shipping_reconciliation_batches enable row level security;
revoke all on public.ebay_shipping_reconciliation_batches from anon, authenticated;

create or replace function public.record_ebay_shipping_reconciliation(
  _batch_id uuid, _window_start timestamptz, _window_end timestamptz,
  _annotation text, _entries jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e jsonb; s jsonb; l public.ebay_order_lines%rowtype; o public.ebay_orders%rowtype;
  evidence jsonb; prior jsonb; tracking jsonb; count_lines integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service-role reconciliation only' using errcode='42501';
  end if;
  if _batch_id is null or _window_start is null or _window_end is null or
     _window_end <= _window_start or _window_end - _window_start > interval '2 days' or
     nullif(btrim(_annotation),'') is null or length(_annotation)>500 or
     jsonb_typeof(_entries) is distinct from 'array' or jsonb_array_length(_entries) not between 1 and 1000 then
    raise exception 'Invalid reconciliation batch';
  end if;
  -- A repeated request returns the original result; changing its contents fails.
  perform pg_advisory_xact_lock(hashtextextended(_batch_id::text,0));
  if exists(select 1 from public.ebay_shipping_reconciliation_batches where id=_batch_id) then
    if not exists(select 1 from public.ebay_shipping_reconciliation_batches where id=_batch_id
      and entries=_entries and window_start=_window_start and window_end=_window_end and annotation=_annotation) then
      raise exception 'Batch ID already used with different evidence';
    end if;
    return jsonb_build_object('batchId',_batch_id,'lines',jsonb_array_length(_entries),'alreadyApplied',true);
  end if;
  if (select count(distinct value->>'lineId') from jsonb_array_elements(_entries)) <> jsonb_array_length(_entries) then
    raise exception 'Duplicate order line';
  end if;
  for e in select value from jsonb_array_elements(_entries) loop
    select * into strict l from public.ebay_order_lines where id=(e->>'lineId')::uuid for update;
    select * into strict o from public.ebay_orders where id=l.order_id for update;
    if o.id is distinct from (e->>'orderId')::uuid or o.order_number is distinct from e->>'orderNumber' or
      l.line_status not in ('pending','partially_fulfilled') or o.status in ('fulfilled','cancelled','archived') then
      raise exception 'Order/line is no longer eligible: %', e->>'orderNumber';
    end if;
    if jsonb_typeof(e->'shipments') is distinct from 'array' or jsonb_array_length(e->'shipments')=0 then
      raise exception 'Missing shipment evidence';
    end if;
    for s in select value from jsonb_array_elements(e->'shipments') loop
      if nullif(s->>'trackingNumber','') is null or nullif(s->>'fulfillmentId','') is null or
        nullif(s->>'shippedAt','') is null or
        (s->>'shippedAt')::timestamptz < _window_start or (s->>'shippedAt')::timestamptz > _window_end or
        not (coalesce(l.transaction_id=s->>'ebayLineItemId',false) or
             coalesce(l.raw_payload #>> '{line,lineItemId}'=s->>'ebayLineItemId',false)) then
        raise exception 'Shipment does not match this line and time window';
      end if;
    end loop;
    evidence := jsonb_build_object('batchId',_batch_id,'note',_annotation,'source','ebay_fulfillment_api',
      'recordedAt',now(),'windowStart',_window_start,'windowEnd',_window_end,'shipments',e->'shipments');
    update public.ebay_order_lines set raw_payload=coalesce(raw_payload,'{}'::jsonb) ||
      jsonb_build_object('shipping_reconciliation',evidence), updated_at=now() where id=l.id;
    prior := coalesce(o.raw_payload->'shipping_reconciliation','{}'::jsonb);
    evidence := evidence || jsonb_build_object('lineIds',
      (select jsonb_agg(distinct v) from jsonb_array_elements(coalesce(prior->'lineIds','[]'::jsonb) || jsonb_build_array(l.id)) v),
      'shipments',(select jsonb_agg(distinct v) from jsonb_array_elements(coalesce(prior->'shipments','[]'::jsonb) || e->'shipments') v));
    select jsonb_agg(distinct v) into tracking from (
      select jsonb_array_elements_text(coalesce(o.label_metadata->'trackingNumbers','[]'::jsonb)) v
      union select nullif(o.label_metadata->>'trackingNumber','')
      union select nullif(o.tracking_number,'')
      union select value->>'trackingNumber' from jsonb_array_elements(e->'shipments')
    ) t where v is not null;
    update public.ebay_orders set
      raw_payload=coalesce(raw_payload,'{}'::jsonb)||jsonb_build_object('shipping_reconciliation',evidence),
      tracking_number=coalesce(nullif(tracking_number,''), e #>> '{shipments,0,trackingNumber}'),
      label_metadata=coalesce(label_metadata,'{}'::jsonb)||jsonb_build_object('trackingNumbers',tracking,
        'trackingNumber',coalesce(nullif(label_metadata->>'trackingNumber',''),e #>> '{shipments,0,trackingNumber}')),
      updated_at=now() where id=o.id;
    count_lines := count_lines+1;
  end loop;
  insert into public.ebay_shipping_reconciliation_batches(id,window_start,window_end,annotation,entries)
    values(_batch_id,_window_start,_window_end,_annotation,_entries);
  return jsonb_build_object('batchId',_batch_id,'lines',count_lines,'alreadyApplied',false);
end;
$$;
revoke all on function public.record_ebay_shipping_reconciliation(uuid,timestamptz,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_ebay_shipping_reconciliation(uuid,timestamptz,timestamptz,text,jsonb) to service_role;

-- Fetch the requested lines once before adding order metadata and issue badges.
-- The previous v2 wrapper re-read both tables after the legacy queue completed.
-- Keep the legacy API unchanged, including staff checks and admin-only fields.
create or replace function public.list_pending_ebay_order_queue_v2(
  _status text default 'pending',
  _include_admin_fields boolean default false,
  _limit integer default 1000,
  _offset integer default 0
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := lower(coalesce(nullif(btrim(_status), ''), 'pending'));
  v_limit integer := least(greatest(coalesce(_limit, 1000), 1), 2000);
  v_offset integer := greatest(coalesce(_offset, 0), 0);
  v_include_admin_fields boolean := public.is_admin() and coalesce(_include_admin_fields, false);
  v_line_statuses text[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  v_line_statuses := case
    when v_status = 'pending' then array['pending', 'partially_fulfilled']::text[]
    when v_status = 'fulfilled' then array['fulfilled']::text[]
    else array['pending', 'partially_fulfilled', 'fulfilled']::text[]
  end;

  return query
  with queue_lines as materialized (
    select l.*
    from public.ebay_order_lines l
    where l.line_status = any(v_line_statuses)
    order by l.created_at desc, l.id desc
    limit v_limit offset v_offset
  )
  select to_jsonb(q)
  from (
  select
    l.id,
    l.order_id,
    l.item_number,
    l.transaction_id,
    l.item_title,
    l.custom_label,
    l.quantity,
    l.sold_for,
    l.shipping_and_handling,
    l.total_price,
    case when v_include_admin_fields then l.net_payout else null::numeric end,
    l.line_status,
    l.created_at,
    l.internal_item_id,
    l.fulfilled_quantity,
    l.fulfilled_at,
    l.assigned_seller_employee_id,
    coalesce(l.assigned_seller_snapshot, '{}'::jsonb),
    l.notes,
    o.id,
    o.order_number,
    o.sales_record_number,
    o.buyer_username,
    o.buyer_name,
    o.sale_date,
    o.paid_on_date,
    o.imported_at,
    o.ship_by_date,
    case when v_include_admin_fields then o.payment_method else null::text end,
    case when v_include_admin_fields then o.shipping_and_handling else null::numeric end,
    case when v_include_admin_fields then o.ebay_collected_tax else null::numeric end,
    o.total_price,
    case when v_include_admin_fields then o.net_payout else null::numeric end,
    o.status,
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'ebayPaymentStatus', ''),
      nullif(o.raw_payload->>'orderPaymentStatus', ''),
      nullif(l.raw_payload->>'orderPaymentStatus', ''),
      nullif(o.raw_payload #>> '{order,orderPaymentStatus}', ''),
      nullif(o.raw_payload #>> '{order,paymentSummary,payments,0,paymentStatus}', '')
    ),
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'ebayFulfillmentStatus', ''),
      nullif(o.raw_payload->>'orderFulfillmentStatus', ''),
      nullif(l.raw_payload->>'orderFulfillmentStatus', ''),
      nullif(o.raw_payload #>> '{order,orderFulfillmentStatus}', ''),
      nullif(o.raw_payload #>> '{order,orderFulfillmentState}', '')
    ),
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'ebayCancelStatus', ''),
      nullif(o.raw_payload->>'orderCancelStatus', ''),
      nullif(l.raw_payload->>'orderCancelStatus', ''),
      nullif(o.raw_payload #>> '{order,cancelStatus,cancelState}', ''),
      nullif(o.raw_payload #>> '{order,cancelStatus,cancelStatus}', '')
    ),
    nullif(o.raw_payload->'pending_order_sync_mismatch'->>'reason', ''),
    nullif(o.raw_payload->'pending_order_sync_mismatch'->>'message', ''),
    nullif(o.raw_payload->'pending_order_sync_mismatch'->>'detectedAt', ''),
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'detectedAt', ''),
      nullif(o.raw_payload->>'last_ebay_order_sync_seen_at', ''),
      nullif(o.raw_payload->>'buyer_history_synced_at', ''),
      nullif(o.raw_payload->>'account_history_synced_at', '')
    ),
    o.label_status,
    o.label_storage_bucket,
    o.label_file_path,
    o.label_uploaded_at,
    0::integer,
    0::integer,
    ''::text,
    coalesce(post_issue.issue_count, 0)::integer,
    post_issue.issue_type,
    post_issue.issue_label,
    post_issue.issue_status,
    post_issue.issue_reason,
    post_issue.issue_latest_at,
    post_issue.issue_scope,
    post_issue.issue_url,
    coalesce(post_issue.issue_payload, '{}'::jsonb),
    coalesce(l.raw_payload, '{}'::jsonb),
    coalesce(o.raw_payload, '{}'::jsonb),
    to_jsonb(s),
    coalesce(o.label_metadata, '{}'::jsonb),
    o.tracking_number
  from queue_lines l
  join public.ebay_orders o on o.id = l.order_id
  left join public.pending_order_item_search s on s.order_line_id = l.id
  left join lateral (
    with active_cases as (
      select c.*
      from public.ebay_return_items ri
      join public.ebay_return_cases c on c.id = ri.return_case_id
      where ri.order_line_id = l.id
        and c.status not in ('closed', 'cancelled')
    ),
    ranked_cases as (
      select
        ac.*,
        lower(concat_ws(
          ' ',
          ac.status,
          ac.return_reason,
          ac.raw_payload->>'returnStatus',
          ac.raw_payload->>'returnState',
          ac.raw_payload->>'returnAction',
          ac.raw_payload->>'returnLifecycleStage',
          ac.raw_payload #>> '{ebaySummary,escalationInfo,caseId}',
          ac.raw_payload #>> '{returnDetails,buyerComment}'
        )) as issue_text
      from active_cases ac
    )
    select
      count(*)::integer as issue_count,
      (array_agg(case when rc.issue_text ~ '(dispute|escalat|case)' then 'dispute' else 'return_request' end order by rc.opened_at desc, rc.id desc))[1] as issue_type,
      (array_agg(case when rc.issue_text ~ '(dispute|escalat|case)' then 'Dispute' else 'Return request' end order by rc.opened_at desc, rc.id desc))[1] as issue_label,
      (array_agg(coalesce(nullif(rc.raw_payload->>'returnStatus', ''), nullif(rc.raw_payload->>'returnState', ''), nullif(rc.raw_payload->>'returnAction', ''), nullif(rc.status, '')) order by rc.opened_at desc, rc.id desc))[1] as issue_status,
      (array_agg(coalesce(nullif(rc.return_reason, ''), nullif(rc.raw_payload->>'returnReason', ''), nullif(rc.raw_payload #>> '{returnDetails,buyerComment}', '')) order by rc.opened_at desc, rc.id desc))[1] as issue_reason,
      max(rc.opened_at) as issue_latest_at,
      'line'::text as issue_scope,
      (array_agg(coalesce(nullif(rc.raw_payload #>> '{returnDetails,detailsUrl}', ''), nullif(rc.raw_payload->>'detailsUrl', '')) order by rc.opened_at desc, rc.id desc))[1] as issue_url,
      (array_agg(jsonb_build_object(
        'caseId', rc.id,
        'ebayReturnId', rc.ebay_return_id,
        'caseType', rc.case_type,
        'status', rc.status,
        'returnStatus', rc.raw_payload->>'returnStatus',
        'returnState', rc.raw_payload->>'returnState',
        'returnAction', rc.raw_payload->>'returnAction',
        'returnLifecycleStage', rc.raw_payload->>'returnLifecycleStage',
        'reason', rc.return_reason,
        'openedAt', rc.opened_at,
        'scope', 'line',
        'detailsUrl', coalesce(nullif(rc.raw_payload #>> '{returnDetails,detailsUrl}', ''), nullif(rc.raw_payload->>'detailsUrl', '')),
        'escalationCaseId', rc.raw_payload #>> '{ebaySummary,escalationInfo,caseId}'
      ) order by rc.opened_at desc, rc.id desc))[1] as issue_payload
    from ranked_cases rc
  ) post_issue on true
  order by l.created_at desc, l.id desc
  ) q (
    id,
    order_id,
    item_number,
    transaction_id,
    item_title,
    custom_label,
    quantity,
    sold_for,
    shipping_and_handling,
    total_price,
    net_payout,
    line_status,
    created_at,
    internal_item_id,
    fulfilled_quantity,
    fulfilled_at,
    assigned_seller_employee_id,
    assigned_seller_snapshot,
    notes,
    order_record_id,
    order_number,
    sales_record_number,
    buyer_username,
    buyer_name,
    sale_date,
    paid_on_date,
    imported_at,
    ship_by_date,
    payment_method,
    order_shipping_and_handling,
    ebay_collected_tax,
    order_total_price,
    order_net_payout,
    order_status,
    ebay_payment_status,
    ebay_fulfillment_status,
    ebay_cancel_status,
    ebay_sync_review_reason,
    ebay_sync_review_message,
    ebay_sync_review_detected_at,
    ebay_status_checked_at,
    label_status,
    label_storage_bucket,
    label_file_path,
    label_uploaded_at,
    video_receipt_photo_count,
    line_note_count,
    latest_line_note,
    post_order_issue_count,
    post_order_issue_type,
    post_order_issue_label,
    post_order_issue_status,
    post_order_issue_reason,
    post_order_issue_latest_at,
    post_order_issue_scope,
    post_order_issue_url,
    post_order_issue_payload,
    line_raw_payload,
    order_raw_payload,
    item_search,
    order_label_metadata,
    order_tracking_number
  );
end;
$$;

comment on function public.list_pending_ebay_order_queue_v2(text, boolean, integer, integer)
  is 'Single-pass paginated pending order queue, preserving status, finance, issue, and item search metadata.';

notify pgrst, 'reload schema';

