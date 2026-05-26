create or replace function public.close_ebay_return_case_from_page(
  _payload jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  return_case_id uuid,
  closed_task_count integer,
  case_status text,
  closed_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb := case
    when jsonb_typeof(coalesce(_payload, '{}'::jsonb)) = 'object'
      then coalesce(_payload, '{}'::jsonb)
    else jsonb_build_object('payload', _payload)
  end;
  v_return jsonb := case
    when jsonb_typeof(coalesce(v_payload->'return', '{}'::jsonb)) = 'object'
      then coalesce(v_payload->'return', '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_metadata jsonb := case
    when jsonb_typeof(coalesce(v_payload->'metadata', '{}'::jsonb)) = 'object'
      then coalesce(v_payload->'metadata', '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_detail jsonb := case
    when jsonb_typeof(coalesce(v_return->'returnDetails', '{}'::jsonb)) = 'object'
      then coalesce(v_return->'returnDetails', '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_case public.ebay_return_cases;
  v_return_id text := nullif(btrim(coalesce(
    v_return->>'returnId',
    v_return->>'ebayReturnId',
    v_metadata->>'returnId',
    v_metadata->>'ebayReturnId',
    v_payload->>'returnId',
    v_payload->>'ebayReturnId',
    ''
  )), '');
  v_order_number text := nullif(btrim(coalesce(
    v_return->>'orderNumber',
    v_metadata->>'orderNumber',
    v_payload->>'orderNumber',
    ''
  )), '');
  v_buyer_username text := nullif(btrim(coalesce(
    v_return->>'buyerUsername',
    v_metadata->>'buyerUsername',
    v_payload->>'buyerUsername',
    ''
  )), '');
  v_closed_text text := lower(concat_ws(' ',
    v_return->>'returnClosed',
    v_return->>'returnStatus',
    v_return->>'returnState',
    v_return->>'returnAction',
    v_return->>'primaryText',
    v_return->>'closedText',
    v_detail->>'returnClosed',
    v_detail->>'returnStatus',
    v_detail->>'returnState',
    v_detail->>'returnAction',
    v_detail->>'primaryText',
    v_detail->>'closedText',
    v_metadata->>'returnClosed',
    v_metadata->>'returnStatus',
    v_metadata->>'returnState',
    v_metadata->>'returnAction',
    v_metadata->>'closedText'
  ));
  v_closed_at timestamptz := coalesce(
    nullif(v_return->>'closedAt', '')::timestamptz,
    nullif(v_detail->>'closedAt', '')::timestamptz,
    nullif(v_metadata->>'closedAt', '')::timestamptz,
    now()
  );
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_closure jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to close eBay return cases' using errcode = '42501';
  end if;

  if v_closed_text not like '%closed%' then
    raise exception 'The eBay return page payload does not show this return is closed' using errcode = '22023';
  end if;

  select *
    into v_case
  from public.ebay_return_cases
  where (v_return_id is not null and ebay_return_id = v_return_id)
     or (v_order_number is not null and order_number = v_order_number and (v_buyer_username is null or buyer_username = v_buyer_username))
  order by updated_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No OG eBay return case matched return %, order %', coalesce(v_return_id, '<none>'), coalesce(v_order_number, '<none>')
      using errcode = 'P0002';
  end if;

  v_closure := jsonb_build_object(
    'source', 'ebay_return_detail_page',
    'detectedAt', now(),
    'closedAt', v_closed_at,
    'returnId', coalesce(v_return_id, v_case.ebay_return_id),
    'orderNumber', coalesce(v_order_number, v_case.order_number),
    'buyerUsername', coalesce(v_buyer_username, v_case.buyer_username),
    'status', 'CLOSED',
    'state', 'CLOSED',
    'actionDue', 'CLOSED_ON_EBAY_PAGE',
    'pagePrimaryText', coalesce(v_return->>'primaryText', v_detail->>'primaryText', ''),
    'pageClosedText', coalesce(v_return->>'closedText', v_detail->>'closedText', ''),
    'detailsUrl', coalesce(v_return->>'detailsUrl', v_detail->>'detailsUrl', v_metadata->>'detailsUrl', ''),
    'pagePayload', v_payload
  );

  update public.ebay_return_cases
  set status = 'closed',
      closed_at = coalesce(closed_at, v_closed_at),
      raw_payload = coalesce(raw_payload, '{}'::jsonb)
        || v_payload
        || jsonb_build_object(
          'returnStatus', 'CLOSED',
          'returnState', 'CLOSED',
          'returnAction', 'CLOSED_ON_EBAY_PAGE',
          'ebayClosedOnEbay', true,
          'ebayClosure', v_closure
        ),
      updated_at = now()
  where id = v_case.id
  returning * into v_case;

  with resolved as (
    update public.ebay_return_tasks
    set status = 'resolved',
        resolved_at = now(),
        resolved_by = auth.uid(),
        resolved_by_email = v_signed_email,
        resolution_notes = 'Resolved from eBay return detail page showing this return is closed.',
        metadata = coalesce(metadata, '{}'::jsonb)
          || v_payload
          || jsonb_build_object(
            'returnStatus', 'CLOSED',
            'returnState', 'CLOSED',
            'returnAction', 'CLOSED_ON_EBAY_PAGE',
            'ebayClosedOnEbay', true,
            'ebayClosure', v_closure
          ),
        updated_at = now()
    where return_case_id = v_case.id
      and task_type in ('return_review', 'return_intake')
      and status not in ('resolved', 'cancelled')
    returning *
  ),
  task_events as (
    insert into public.ebay_return_task_events (
      task_id,
      return_case_id,
      action,
      old_status,
      new_status,
      notes,
      signed_by,
      signed_by_email,
      payload
    )
    select
      id,
      return_case_id,
      'resolved',
      null,
      'resolved',
      'Resolved from eBay return detail page showing this return is closed.',
      auth.uid(),
      v_signed_email,
      v_closure
    from resolved
  )
  select count(*)::integer into closed_task_count from resolved;

  insert into public.ebay_return_events (
    return_case_id,
    action,
    order_id,
    order_line_ids,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_case.id,
    'closed',
    v_case.order_id,
    '{}'::uuid[],
    'Closed from eBay return detail page.',
    auth.uid(),
    v_signed_email,
    v_closure
  );

  return_case_id := v_case.id;
  case_status := v_case.status;
  closed_at := v_case.closed_at;
  return next;
end;
$$;

revoke all on function public.close_ebay_return_case_from_page(jsonb, text) from public;
grant execute on function public.close_ebay_return_case_from_page(jsonb, text) to authenticated;
