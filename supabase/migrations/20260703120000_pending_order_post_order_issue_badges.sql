-- Surface synced eBay Post-Order requests in the fast pending-order queue.
-- Return cases are joined to the exact order line when possible, with an
-- order-level fallback only for cases that have no linked return item rows.

drop function if exists public.list_pending_ebay_order_queue(text, boolean, integer, integer);

create or replace function public.list_pending_ebay_order_queue(
  _status text default 'pending',
  _include_admin_fields boolean default false,
  _limit integer default 1000,
  _offset integer default 0
)
returns table (
  id uuid,
  order_id uuid,
  item_number text,
  transaction_id text,
  item_title text,
  custom_label text,
  quantity integer,
  sold_for numeric,
  shipping_and_handling numeric,
  total_price numeric,
  net_payout numeric,
  line_status text,
  created_at timestamptz,
  internal_item_id uuid,
  fulfilled_quantity integer,
  fulfilled_at timestamptz,
  assigned_seller_employee_id uuid,
  assigned_seller_snapshot jsonb,
  notes text,
  order_record_id uuid,
  order_number text,
  sales_record_number text,
  buyer_username text,
  buyer_name text,
  sale_date timestamptz,
  paid_on_date timestamptz,
  imported_at timestamptz,
  ship_by_date timestamptz,
  payment_method text,
  order_shipping_and_handling numeric,
  ebay_collected_tax numeric,
  order_total_price numeric,
  order_net_payout numeric,
  order_status text,
  ebay_payment_status text,
  ebay_fulfillment_status text,
  ebay_cancel_status text,
  ebay_sync_review_reason text,
  ebay_sync_review_message text,
  ebay_sync_review_detected_at text,
  ebay_status_checked_at text,
  label_status text,
  label_storage_bucket text,
  label_file_path text,
  label_uploaded_at timestamptz,
  video_receipt_photo_count integer,
  line_note_count integer,
  latest_line_note text,
  post_order_issue_count integer,
  post_order_issue_type text,
  post_order_issue_label text,
  post_order_issue_status text,
  post_order_issue_reason text,
  post_order_issue_latest_at timestamptz,
  post_order_issue_scope text,
  post_order_issue_url text,
  post_order_issue_payload jsonb
)
language plpgsql
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
    case when v_include_admin_fields then l.net_payout else null::numeric end as net_payout,
    l.line_status,
    l.created_at,
    l.internal_item_id,
    l.fulfilled_quantity,
    l.fulfilled_at,
    l.assigned_seller_employee_id,
    coalesce(l.assigned_seller_snapshot, '{}'::jsonb) as assigned_seller_snapshot,
    l.notes,
    o.id as order_record_id,
    o.order_number,
    o.sales_record_number,
    o.buyer_username,
    o.buyer_name,
    o.sale_date,
    o.paid_on_date,
    o.imported_at,
    o.ship_by_date,
    case when v_include_admin_fields then o.payment_method else null::text end as payment_method,
    case when v_include_admin_fields then o.shipping_and_handling else null::numeric end as order_shipping_and_handling,
    case when v_include_admin_fields then o.ebay_collected_tax else null::numeric end as ebay_collected_tax,
    o.total_price as order_total_price,
    case when v_include_admin_fields then o.net_payout else null::numeric end as order_net_payout,
    o.status as order_status,
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'ebayPaymentStatus', ''),
      nullif(o.raw_payload->>'orderPaymentStatus', ''),
      nullif(l.raw_payload->>'orderPaymentStatus', ''),
      nullif(o.raw_payload #>> '{order,orderPaymentStatus}', ''),
      nullif(o.raw_payload #>> '{order,paymentSummary,payments,0,paymentStatus}', '')
    ) as ebay_payment_status,
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'ebayFulfillmentStatus', ''),
      nullif(o.raw_payload->>'orderFulfillmentStatus', ''),
      nullif(l.raw_payload->>'orderFulfillmentStatus', ''),
      nullif(o.raw_payload #>> '{order,orderFulfillmentStatus}', ''),
      nullif(o.raw_payload #>> '{order,orderFulfillmentState}', '')
    ) as ebay_fulfillment_status,
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'ebayCancelStatus', ''),
      nullif(o.raw_payload->>'orderCancelStatus', ''),
      nullif(l.raw_payload->>'orderCancelStatus', ''),
      nullif(o.raw_payload #>> '{order,cancelStatus,cancelState}', ''),
      nullif(o.raw_payload #>> '{order,cancelStatus,cancelStatus}', '')
    ) as ebay_cancel_status,
    nullif(o.raw_payload->'pending_order_sync_mismatch'->>'reason', '') as ebay_sync_review_reason,
    nullif(o.raw_payload->'pending_order_sync_mismatch'->>'message', '') as ebay_sync_review_message,
    nullif(o.raw_payload->'pending_order_sync_mismatch'->>'detectedAt', '') as ebay_sync_review_detected_at,
    coalesce(
      nullif(o.raw_payload->'pending_order_sync_mismatch'->>'detectedAt', ''),
      nullif(o.raw_payload->>'last_ebay_order_sync_seen_at', ''),
      nullif(o.raw_payload->>'buyer_history_synced_at', ''),
      nullif(o.raw_payload->>'account_history_synced_at', '')
    ) as ebay_status_checked_at,
    o.label_status,
    o.label_storage_bucket,
    o.label_file_path,
    o.label_uploaded_at,
    0::integer as video_receipt_photo_count,
    0::integer as line_note_count,
    ''::text as latest_line_note,
    coalesce(post_issue.issue_count, 0)::integer as post_order_issue_count,
    post_issue.issue_type as post_order_issue_type,
    post_issue.issue_label as post_order_issue_label,
    post_issue.issue_status as post_order_issue_status,
    post_issue.issue_reason as post_order_issue_reason,
    post_issue.issue_latest_at as post_order_issue_latest_at,
    post_issue.issue_scope as post_order_issue_scope,
    post_issue.issue_url as post_order_issue_url,
    coalesce(post_issue.issue_payload, '{}'::jsonb) as post_order_issue_payload
  from public.ebay_order_lines l
  join public.ebay_orders o on o.id = l.order_id
  left join lateral (
    with active_cases as (
      select
        c.*,
        true as line_match
      from public.ebay_return_items ri
      join public.ebay_return_cases c on c.id = ri.return_case_id
      where ri.order_line_id = l.id
        and c.status not in ('closed', 'cancelled')

      union all

      select
        c.*,
        false as line_match
      from public.ebay_return_cases c
      where c.order_id = l.order_id
        and c.status not in ('closed', 'cancelled')
        and not exists (
          select 1
          from public.ebay_return_items ri
          where ri.return_case_id = c.id
        )
    ),
    ranked_cases as (
      select
        active_cases.*,
        lower(concat_ws(
          ' ',
          active_cases.status,
          active_cases.return_reason,
          active_cases.raw_payload->>'returnStatus',
          active_cases.raw_payload->>'returnState',
          active_cases.raw_payload->>'returnAction',
          active_cases.raw_payload->>'returnLifecycleStage',
          active_cases.raw_payload #>> '{ebaySummary,escalationInfo,caseId}',
          active_cases.raw_payload #>> '{returnDetails,buyerComment}'
        )) as issue_text
      from active_cases
    )
    select
      count(*)::integer as issue_count,
      (
        array_agg(
          case
            when issue_text ~ '(dispute|escalat|case)' then 'dispute'
            else 'return_request'
          end
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_type,
      (
        array_agg(
          case
            when issue_text ~ '(dispute|escalat|case)' then 'Dispute'
            else 'Return request'
          end
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_label,
      (
        array_agg(
          coalesce(
            nullif(raw_payload->>'returnStatus', ''),
            nullif(raw_payload->>'returnState', ''),
            nullif(raw_payload->>'returnAction', ''),
            nullif(status, '')
          )
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_status,
      (
        array_agg(
          coalesce(
            nullif(return_reason, ''),
            nullif(raw_payload->>'returnReason', ''),
            nullif(raw_payload #>> '{returnDetails,buyerComment}', '')
          )
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_reason,
      max(opened_at) as issue_latest_at,
      (
        array_agg(
          case when line_match then 'line' else 'order' end
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_scope,
      (
        array_agg(
          coalesce(
            nullif(raw_payload #>> '{returnDetails,detailsUrl}', ''),
            nullif(raw_payload->>'detailsUrl', '')
          )
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_url,
      (
        array_agg(
          jsonb_build_object(
            'caseId', id,
            'ebayReturnId', ebay_return_id,
            'caseType', case_type,
            'status', status,
            'returnStatus', raw_payload->>'returnStatus',
            'returnState', raw_payload->>'returnState',
            'returnAction', raw_payload->>'returnAction',
            'returnLifecycleStage', raw_payload->>'returnLifecycleStage',
            'reason', return_reason,
            'openedAt', opened_at,
            'scope', case when line_match then 'line' else 'order' end,
            'detailsUrl', coalesce(
              nullif(raw_payload #>> '{returnDetails,detailsUrl}', ''),
              nullif(raw_payload->>'detailsUrl', '')
            ),
            'escalationCaseId', raw_payload #>> '{ebaySummary,escalationInfo,caseId}'
          )
          order by line_match desc, opened_at desc, id desc
        )
      )[1] as issue_payload
    from ranked_cases
  ) post_issue on true
  where l.line_status = any(v_line_statuses)
  order by l.created_at desc, l.id desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.list_pending_ebay_order_queue(text, boolean, integer, integer) from public;
grant execute on function public.list_pending_ebay_order_queue(text, boolean, integer, integer) to authenticated;

comment on function public.list_pending_ebay_order_queue(text, boolean, integer, integer)
  is 'Fast pending eBay order queue read path with compact eBay API status fields and active Post-Order request/dispute badges.';

notify pgrst, 'reload schema';
