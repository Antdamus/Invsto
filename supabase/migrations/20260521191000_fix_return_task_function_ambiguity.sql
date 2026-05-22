create or replace function public.open_ebay_return_case(
  _order_id uuid,
  _order_line_ids uuid[],
  _order_number text default null,
  _ebay_return_id text default null,
  _buyer_username text default null,
  _return_reason text default null,
  _notes text default null,
  _raw_payload jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  return_case_id uuid,
  task_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.ebay_orders;
  v_case public.ebay_return_cases;
  v_task public.ebay_return_tasks;
  v_line_ids uuid[] := coalesce(_order_line_ids, '{}'::uuid[]);
  v_ebay_return_id text := nullif(btrim(coalesce(_ebay_return_id, '')), '');
  v_reason text := nullif(btrim(coalesce(_return_reason, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_payload jsonb := case
    when jsonb_typeof(coalesce(_raw_payload, '{}'::jsonb)) = 'object'
      then coalesce(_raw_payload, '{}'::jsonb)
    else jsonb_build_object('payload', _raw_payload)
  end;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to open eBay return cases' using errcode = '42501';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select *
    into v_case
  from public.ebay_return_cases
  where order_id = v_order.id
    and (
      (v_ebay_return_id is not null and ebay_return_id = v_ebay_return_id)
      or (
        v_ebay_return_id is null
        and status not in ('closed', 'cancelled')
        and ebay_return_id is null
      )
    )
  order by opened_at desc
  limit 1;

  if not found then
    insert into public.ebay_return_cases (
      order_id,
      order_number,
      ebay_return_id,
      buyer_username,
      return_reason,
      status,
      opened_at,
      created_by,
      created_by_email,
      notes,
      raw_payload
    )
    values (
      v_order.id,
      coalesce(nullif(btrim(_order_number), ''), v_order.order_number),
      v_ebay_return_id,
      coalesce(nullif(btrim(_buyer_username), ''), v_order.buyer_username),
      v_reason,
      'open',
      now(),
      auth.uid(),
      v_signed_email,
      v_notes,
      v_payload || jsonb_build_object('source', 'ebay_return_extension')
    )
    returning * into v_case;

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
      'return_created',
      v_order.id,
      v_line_ids,
      v_notes,
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'source', 'ebay_return_extension',
        'order_number', v_order.order_number,
        'buyer_username', v_case.buyer_username,
        'return_reason', v_reason,
        'ebay_return_id', v_ebay_return_id
      ) || v_payload
    );
  else
    update public.ebay_return_cases
    set ebay_return_id = coalesce(v_ebay_return_id, ebay_return_id),
        return_reason = coalesce(v_reason, return_reason),
        buyer_username = coalesce(nullif(btrim(_buyer_username), ''), buyer_username),
        notes = coalesce(v_notes, notes),
        raw_payload = coalesce(raw_payload, '{}'::jsonb) || v_payload || jsonb_build_object('source', 'ebay_return_extension')
    where id = v_case.id
    returning * into v_case;
  end if;

  select *
    into v_task
  from public.ebay_return_tasks t
  where t.return_case_id = v_case.id
    and t.task_type = 'return_intake'
  order by
    case when t.status in ('open', 'assigned', 'in_progress', 'blocked') then 0 else 1 end,
    t.created_at desc
  limit 1;

  if not found and v_case.status not in ('closed', 'cancelled') then
    insert into public.ebay_return_tasks (
      return_case_id,
      order_id,
      order_line_ids,
      task_type,
      title,
      question,
      status,
      priority,
      created_by,
      created_by_email,
      metadata
    )
    values (
      v_case.id,
      v_order.id,
      v_line_ids,
      'return_intake',
      'Complete eBay return intake',
      'Inspect the returned item, attach evidence photos, choose the disposition, and save the return.',
      'open',
      case when v_reason ilike '%description%' or v_reason ilike '%authentic%' then 'high' else 'normal' end,
      auth.uid(),
      v_signed_email,
      v_payload || jsonb_build_object(
        'source', 'ebay_return_extension',
        'order_number', v_order.order_number,
        'buyer_username', v_case.buyer_username,
        'ebay_return_id', v_ebay_return_id,
        'return_reason', v_reason
      )
    )
    returning * into v_task;

    insert into public.ebay_return_task_events (
      task_id,
      return_case_id,
      action,
      new_status,
      notes,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_task.id,
      v_case.id,
      'created',
      v_task.status,
      'Return intake task opened from eBay returns page.',
      auth.uid(),
      v_signed_email,
      v_task.metadata
    );
  elsif v_task.id is not null and v_task.status not in ('resolved', 'cancelled') then
    update public.ebay_return_tasks
    set order_line_ids = case when cardinality(v_line_ids) > 0 then v_line_ids else order_line_ids end,
        metadata = coalesce(metadata, '{}'::jsonb) || v_payload
    where id = v_task.id
    returning * into v_task;
  elsif v_task.id is not null then
    update public.ebay_return_tasks
    set metadata = coalesce(metadata, '{}'::jsonb) || v_payload || jsonb_build_object('duplicateExportIgnoredAt', now())
    where id = v_task.id
    returning * into v_task;

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
    values (
      v_task.id,
      v_case.id,
      'commented',
      v_task.status,
      v_task.status,
      'Duplicate eBay return export ignored because this return task is already resolved or cancelled.',
      auth.uid(),
      v_signed_email,
      v_payload || jsonb_build_object('duplicate_export_ignored', true)
    );
  end if;

  return_case_id := v_case.id;
  task_id := v_task.id;
  return next;
end;
$$;

create or replace function public.open_unmatched_ebay_return_case(
  _ebay_return_id text default null,
  _buyer_username text default null,
  _item_number text default null,
  _item_title text default null,
  _transaction_id text default null,
  _return_reason text default null,
  _return_status text default null,
  _return_action text default null,
  _return_initiated text default null,
  _refund_text text default null,
  _details_url text default null,
  _page_url text default null,
  _notes text default null,
  _raw_payload jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  return_case_id uuid,
  task_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.ebay_return_cases;
  v_task public.ebay_return_tasks;
  v_ebay_return_id text := nullif(btrim(coalesce(_ebay_return_id, '')), '');
  v_buyer_username text := nullif(btrim(coalesce(_buyer_username, '')), '');
  v_item_number text := nullif(btrim(coalesce(_item_number, '')), '');
  v_item_title text := nullif(btrim(coalesce(_item_title, '')), '');
  v_transaction_id text := nullif(btrim(coalesce(_transaction_id, '')), '');
  v_reason text := nullif(btrim(coalesce(_return_reason, '')), '');
  v_return_status text := nullif(btrim(coalesce(_return_status, '')), '');
  v_return_action text := nullif(btrim(coalesce(_return_action, '')), '');
  v_return_initiated text := nullif(btrim(coalesce(_return_initiated, '')), '');
  v_refund_text text := nullif(btrim(coalesce(_refund_text, '')), '');
  v_details_url text := nullif(btrim(coalesce(_details_url, '')), '');
  v_page_url text := nullif(btrim(coalesce(_page_url, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_payload jsonb := case
    when jsonb_typeof(coalesce(_raw_payload, '{}'::jsonb)) = 'object'
      then coalesce(_raw_payload, '{}'::jsonb)
    else jsonb_build_object('payload', _raw_payload)
  end;
  v_case_payload jsonb;
  v_audit_note text;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to open eBay return cases' using errcode = '42501';
  end if;

  v_audit_note := concat_ws(E'\n',
    'No matching OG fulfilled order history was found for this eBay return/refund.',
    v_notes
  );

  v_case_payload := v_payload || jsonb_build_object(
    'source', 'ebay_return_extension',
    'caseType', 'unmatched_legacy',
    'unmatchedReason', 'No matching fulfilled OG order line was found.',
    'ebayReturnId', v_ebay_return_id,
    'buyerUsername', v_buyer_username,
    'itemNumber', v_item_number,
    'itemTitle', v_item_title,
    'transactionId', v_transaction_id,
    'returnReason', v_reason,
    'returnStatus', v_return_status,
    'returnAction', v_return_action,
    'returnInitiated', v_return_initiated,
    'refundText', v_refund_text,
    'detailsUrl', v_details_url,
    'pageUrl', v_page_url
  );

  select *
    into v_case
  from public.ebay_return_cases
  where order_id is null
    and case_type in ('unmatched_legacy', 'refund_only')
    and (
      (v_ebay_return_id is not null and ebay_return_id = v_ebay_return_id)
      or (
        v_ebay_return_id is null
        and status not in ('closed', 'cancelled')
        and v_item_number is not null
        and v_buyer_username is not null
        and raw_payload->>'itemNumber' = v_item_number
        and raw_payload->>'buyerUsername' = v_buyer_username
      )
    )
  order by opened_at desc
  limit 1;

  if not found then
    insert into public.ebay_return_cases (
      order_id,
      order_number,
      case_type,
      ebay_return_id,
      buyer_username,
      return_reason,
      status,
      opened_at,
      created_by,
      created_by_email,
      notes,
      raw_payload
    )
    values (
      null,
      null,
      'unmatched_legacy',
      v_ebay_return_id,
      v_buyer_username,
      v_reason,
      'needs_review',
      now(),
      auth.uid(),
      v_signed_email,
      v_audit_note,
      v_case_payload
    )
    returning * into v_case;

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
      'return_created',
      null,
      '{}'::uuid[],
      v_audit_note,
      auth.uid(),
      v_signed_email,
      v_case_payload
    );
  else
    update public.ebay_return_cases
    set ebay_return_id = coalesce(v_ebay_return_id, ebay_return_id),
        buyer_username = coalesce(v_buyer_username, buyer_username),
        return_reason = coalesce(v_reason, return_reason),
        notes = concat_ws(E'\n\n', nullif(notes, ''), v_notes),
        raw_payload = coalesce(raw_payload, '{}'::jsonb) || v_case_payload,
        status = case when status = 'closed' then status else 'needs_review' end
    where id = v_case.id
    returning * into v_case;

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
      'return_created',
      null,
      '{}'::uuid[],
      'Unmatched eBay return details refreshed from the eBay returns page.',
      auth.uid(),
      v_signed_email,
      v_case_payload
    );
  end if;

  select *
    into v_task
  from public.ebay_return_tasks t
  where t.return_case_id = v_case.id
    and t.task_type = 'return_review'
  order by
    case when t.status in ('open', 'assigned', 'in_progress', 'blocked') then 0 else 1 end,
    t.created_at desc
  limit 1;

  if not found and v_case.status not in ('closed', 'cancelled') then
    insert into public.ebay_return_tasks (
      return_case_id,
      order_id,
      order_line_ids,
      task_type,
      title,
      question,
      status,
      priority,
      created_by,
      created_by_email,
      metadata
    )
    values (
      v_case.id,
      null,
      '{}'::uuid[],
      'return_review',
      'Review unmatched eBay return/refund',
      'No matching OG order history was found. Review the eBay buyer, item, reason, and refund details before deciding the next step.',
      'open',
      'high',
      auth.uid(),
      v_signed_email,
      v_case_payload
    )
    returning * into v_task;

    insert into public.ebay_return_task_events (
      task_id,
      return_case_id,
      action,
      new_status,
      notes,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_task.id,
      v_case.id,
      'created',
      v_task.status,
      'Legacy/unmatched eBay return review task opened from the eBay returns page.',
      auth.uid(),
      v_signed_email,
      v_task.metadata
    );
  elsif v_task.id is not null and v_task.status not in ('resolved', 'cancelled') then
    update public.ebay_return_tasks
    set metadata = coalesce(metadata, '{}'::jsonb) || v_case_payload,
        priority = case when priority in ('urgent', 'high') then priority else 'high' end
    where id = v_task.id
    returning * into v_task;
  elsif v_task.id is not null then
    update public.ebay_return_tasks
    set metadata = coalesce(metadata, '{}'::jsonb) || v_case_payload || jsonb_build_object('duplicateExportIgnoredAt', now())
    where id = v_task.id
    returning * into v_task;

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
    values (
      v_task.id,
      v_case.id,
      'commented',
      v_task.status,
      v_task.status,
      'Duplicate eBay return export ignored because this return task is already resolved or cancelled.',
      auth.uid(),
      v_signed_email,
      v_case_payload || jsonb_build_object('duplicate_export_ignored', true)
    );
  end if;

  return_case_id := v_case.id;
  task_id := v_task.id;
  return next;
end;
$$;

revoke all on function public.open_ebay_return_case(uuid, uuid[], text, text, text, text, text, jsonb, text) from public;
revoke all on function public.open_unmatched_ebay_return_case(text, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, text) from public;
grant execute on function public.open_ebay_return_case(uuid, uuid[], text, text, text, text, text, jsonb, text) to authenticated;
grant execute on function public.open_unmatched_ebay_return_case(text, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, text) to authenticated;
