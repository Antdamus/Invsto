-- Seller attribution review queue and SMS health.

create or replace function public.get_unassigned_seller_sales(_limit integer default 100)
returns table (
  sale_item_id uuid,
  sale_id uuid,
  order_line_id uuid,
  channel text,
  order_number text,
  buyer_username text,
  item_title text,
  sold_at timestamptz,
  line_status text,
  gross_amount numeric,
  net_store_proceeds numeric,
  inference_source text,
  candidate_count integer,
  candidate_sellers jsonb,
  live_session_id uuid,
  live_session_title text,
  live_session_sellers jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(_limit, 100), 1), 250);
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only management can review unassigned seller sales' using errcode = '42501';
  end if;

  return query
  with base as (
    select distinct on (si.id)
      si.id as sale_item_id,
      si.sale_id,
      coalesce(direct_line.id, live_line.id) as order_line_id,
      lower(coalesce(nullif(btrim(s.platform), ''), 'ebay')) as channel,
      eo.order_number,
      eo.buyer_username,
      coalesce(direct_line.item_title, live_line.item_title, si.title) as item_title,
      coalesce(eo.sale_date, eo.paid_on_date, session_row.started_at, s.created_at, si.created_at) as sold_at,
      coalesce(direct_line.line_status, live_line.line_status) as line_status,
      round(coalesce(si.final_price, 0), 2) as gross_amount,
      round(coalesce(direct_line.net_payout, live_line.net_payout, si.final_price, s.profit_amount, 0), 2) as net_store_proceeds,
      coalesce(loc.store_id, session_row.store_id) as store_id,
      session_row.id as live_session_id,
      session_row.title as live_session_title,
      session_row.primary_seller_employee_id,
      session_row.co_seller_employee_ids,
      session_row.seller_snapshot
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    left join public.ebay_order_lines direct_line on direct_line.sale_item_id = si.id
    left join lateral (
      select
        l.id,
        l.order_id,
        l.item_title,
        l.line_status,
        l.net_payout,
        li.session_id,
        li.packed_at,
        li.scanned_at
      from public.live_sale_lot_items li
      join public.ebay_order_lines l on l.id = li.packed_order_line_id
      where li.packed_sale_item_id = si.id
      order by li.packed_at desc nulls last, li.scanned_at desc nulls last, li.created_at desc
      limit 1
    ) live_line on true
    left join public.ebay_orders eo on eo.id = coalesce(direct_line.order_id, live_line.order_id)
    left join public.live_sale_sessions session_row on session_row.id = live_line.session_id
    left join public.locations loc on loc.id = si.location_id
    where si.seller_employee_id is null
      and lower(coalesce(s.platform, '')) in ('ebay', 'whatnot')
      and coalesce(direct_line.line_status, live_line.line_status, 'fulfilled') not in ('cancelled', 'skipped')
    order by si.id, coalesce(eo.sale_date, eo.paid_on_date, session_row.started_at, s.created_at, si.created_at) desc
  ),
  enriched as (
    select
      b.*,
      coalesce(session_candidates.candidate_count, 0)::integer as session_candidate_count,
      coalesce(session_candidates.candidate_sellers, '[]'::jsonb) as session_candidate_sellers,
      coalesce(shift_candidates.candidate_count, 0)::integer as shift_candidate_count,
      coalesce(shift_candidates.candidate_sellers, '[]'::jsonb) as shift_candidate_sellers
    from base b
    left join lateral (
      with seller_ids as (
        select b.primary_seller_employee_id as employee_id
        where b.primary_seller_employee_id is not null
        union
        select unnest(coalesce(b.co_seller_employee_ids, '{}'::uuid[])) as employee_id
      )
      select
        count(*)::integer as candidate_count,
        coalesce(jsonb_agg(
          jsonb_build_object(
            'seller_employee_id', e.id,
            'seller_name', coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller'),
            'seller_email', e.email,
            'source', 'live_sale_session'
          )
          order by coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller')
        ), '[]'::jsonb) as candidate_sellers
      from seller_ids ids
      join public.employees e on e.id = ids.employee_id
      where e.active is distinct from false
    ) session_candidates on b.live_session_id is not null
    left join lateral (
      select
        count(*)::integer as candidate_count,
        coalesce(jsonb_agg(
          jsonb_build_object(
            'seller_employee_id', e.id,
            'seller_name', coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller'),
            'seller_email', e.email,
            'shift_id', ss.id,
            'shift_start_at', ss.start_at,
            'shift_end_at', ss.end_at,
            'source', 'seller_shift_time'
          )
          order by ss.start_at, coalesce(nullif(btrim(e.display_name), ''), e.email, 'Unnamed seller')
        ), '[]'::jsonb) as candidate_sellers
      from public.seller_sale_shifts ss
      join public.employees e on e.id = ss.seller_employee_id
      where ss.channel = b.channel
        and ss.status = any (public.seller_sale_active_statuses())
        and e.active is distinct from false
        and (b.store_id is null or ss.store_id is null or ss.store_id = b.store_id)
        and b.sold_at >= ss.start_at
        and b.sold_at < ss.end_at
    ) shift_candidates on true
  )
  select
    e.sale_item_id,
    e.sale_id,
    e.order_line_id,
    e.channel,
    e.order_number,
    e.buyer_username,
    e.item_title,
    e.sold_at,
    e.line_status,
    e.gross_amount,
    e.net_store_proceeds,
    case
      when e.session_candidate_count > 1 then 'live_sale_session_ambiguous'
      when e.session_candidate_count = 1 then 'live_sale_session_single'
      when e.shift_candidate_count > 1 then 'seller_shift_time_ambiguous'
      when e.shift_candidate_count = 1 then 'seller_shift_time_single'
      else 'no_matching_seller_shift'
    end as inference_source,
    case
      when e.session_candidate_count > 0 then e.session_candidate_count
      else e.shift_candidate_count
    end as candidate_count,
    case
      when e.session_candidate_count > 0 then e.session_candidate_sellers
      else e.shift_candidate_sellers
    end as candidate_sellers,
    e.live_session_id,
    e.live_session_title,
    case
      when e.live_session_id is null then '[]'::jsonb
      else e.session_candidate_sellers
    end as live_session_sellers
  from enriched e
  order by e.sold_at desc nulls last, e.sale_item_id
  limit v_limit;
end;
$$;

create or replace function public.get_seller_sms_health(_hours_back integer default 24)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hours integer := least(greatest(coalesce(_hours_back, 24), 1), 168);
  v_result jsonb;
begin
  if not public.current_user_can_manage_sellers() then
    raise exception 'Only management can view seller SMS health' using errcode = '42501';
  end if;

  with seller_sms as (
    select *
    from public.sms_outbox so
    where so.created_at >= now() - make_interval(hours => v_hours)
      and (
        so.meta->>'type' = 'seller_notification'
        or so.meta->>'schedule_source' = 'seller_sale'
        or so.meta->>'seller_sale_shift' = 'true'
        or (
          so.meta->>'type' = 'time_exception'
          and (
            so.meta->>'schedule_source' = 'seller_sale'
            or so.meta->>'seller_sale_shift' = 'true'
          )
        )
      )
  ),
  status_counts as (
    select jsonb_object_agg(status, status_count order by status) as counts
    from (
      select status, count(*)::integer as status_count
      from seller_sms
      group by status
    ) grouped
  ),
  latest_rows as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'to_phone', to_phone,
        'status', status,
        'attempts', attempts,
        'last_error', last_error,
        'created_at', created_at,
        'send_after', send_after,
        'notification_type', coalesce(meta->>'notification_type', meta->>'alert_type', meta->>'type')
      )
      order by created_at desc
    ), '[]'::jsonb) as rows
    from (
      select *
      from seller_sms
      order by created_at desc
      limit 10
    ) latest
  )
  select jsonb_build_object(
    'hours_back', v_hours,
    'total', (select count(*)::integer from seller_sms),
    'status_counts', coalesce((select counts from status_counts), '{}'::jsonb),
    'pending_over_10_min', (
      select count(*)::integer
      from seller_sms
      where status in ('pending', 'sending')
        and created_at < now() - interval '10 minutes'
    ),
    'failed', (
      select count(*)::integer
      from seller_sms
      where status = 'failed'
    ),
    'latest_created_at', (
      select max(created_at)
      from seller_sms
    ),
    'latest_error', (
      select last_error
      from seller_sms
      where last_error is not null
      order by created_at desc
      limit 1
    ),
    'latest', (select rows from latest_rows)
  )
    into v_result;

  return coalesce(v_result, jsonb_build_object(
    'hours_back', v_hours,
    'total', 0,
    'status_counts', '{}'::jsonb,
    'pending_over_10_min', 0,
    'failed', 0,
    'latest_created_at', null,
    'latest_error', null,
    'latest', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.get_unassigned_seller_sales(integer) from public;
revoke all on function public.get_seller_sms_health(integer) from public;

grant execute on function public.get_unassigned_seller_sales(integer) to authenticated;
grant execute on function public.get_seller_sms_health(integer) to authenticated;
