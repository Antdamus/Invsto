create table if not exists public.ebay_order_cancellation_cases (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  ebay_cancel_id text,
  order_number text not null,
  item_number text,
  transaction_id text,
  item_title text,
  buyer_username text,
  cancel_status text,
  cancel_reason text,
  requested_at timestamptz,
  details_url text,
  page_url text,
  source text not null default 'ebay-cancellations-page',
  raw_payload jsonb not null default '{}'::jsonb,
  imported_by uuid references auth.users(id) on delete set null,
  imported_by_email text,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ebay_order_cancellation_cases_order_number_idx
  on public.ebay_order_cancellation_cases(order_number);

create index if not exists ebay_order_cancellation_cases_item_txn_idx
  on public.ebay_order_cancellation_cases(order_number, item_number, transaction_id);

alter table public.ebay_order_cancellation_cases enable row level security;

drop policy if exists "Inventory managers can read ebay cancellation cases" on public.ebay_order_cancellation_cases;
create policy "Inventory managers can read ebay cancellation cases"
  on public.ebay_order_cancellation_cases
  for select
  to authenticated
  using (public.can_manage_inventory());

drop policy if exists "Inventory managers can write ebay cancellation cases" on public.ebay_order_cancellation_cases;
create policy "Inventory managers can write ebay cancellation cases"
  on public.ebay_order_cancellation_cases
  for all
  to authenticated
  using (public.can_manage_inventory())
  with check (public.can_manage_inventory());

grant select, insert, update on public.ebay_order_cancellation_cases to authenticated;

create or replace function public.import_ebay_order_cancellation_page(
  _cancellations jsonb,
  _metadata jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  imported_count integer,
  matched_pending_lines integer,
  unmatched_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry jsonb;
  v_now timestamptz := now();
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_cancel_id text;
  v_order_number text;
  v_item_number text;
  v_transaction_id text;
  v_item_title text;
  v_buyer_username text;
  v_cancel_status text;
  v_cancel_reason text;
  v_requested_at timestamptz;
  v_details_url text;
  v_page_url text;
  v_source text;
  v_identity_key text;
  v_case_payload jsonb;
  v_line_matches integer;
  v_imported integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to import eBay cancellation cases' using errcode = '42501';
  end if;

  if coalesce(jsonb_typeof(_cancellations), '') <> 'array' then
    raise exception 'Expected cancellations to be a JSON array' using errcode = '22023';
  end if;

  for v_entry in select value from jsonb_array_elements(_cancellations)
  loop
    if jsonb_typeof(v_entry) <> 'object' then
      continue;
    end if;

    v_order_number := nullif(btrim(coalesce(
      v_entry->>'orderNumber',
      v_entry->>'orderId',
      v_entry->>'omsOrderId',
      v_entry #>> '{order,orderNumber}',
      v_entry #>> '{order,orderId}'
    )), '');
    if v_order_number is null then
      continue;
    end if;

    v_cancel_id := nullif(btrim(coalesce(
      v_entry->>'cancellationId',
      v_entry->>'cancelId',
      v_entry->>'requestId',
      v_entry->>'caseId'
    )), '');
    v_item_number := nullif(btrim(coalesce(v_entry->>'itemNumber', v_entry->>'itemId', v_entry #>> '{item,itemNumber}')), '');
    v_transaction_id := nullif(btrim(coalesce(v_entry->>'transactionId', v_entry->>'txnId')), '');
    v_item_title := nullif(btrim(coalesce(v_entry->>'itemTitle', v_entry->>'title', v_entry #>> '{item,title}')), '');
    v_buyer_username := nullif(btrim(coalesce(v_entry->>'buyerUsername', v_entry->>'buyerUserName', v_entry->>'buyer', v_entry #>> '{buyer,username}')), '');
    v_cancel_status := nullif(btrim(coalesce(
      v_entry->>'cancelStatus',
      v_entry->>'cancellationStatus',
      v_entry->>'status',
      v_entry->>'state'
    )), '');
    v_cancel_reason := nullif(btrim(coalesce(
      v_entry->>'cancelReason',
      v_entry->>'cancellationReason',
      v_entry->>'reason'
    )), '');
    v_details_url := nullif(btrim(coalesce(v_entry->>'detailsUrl', v_entry->>'detailUrl', v_entry->>'actionUrl')), '');
    v_page_url := nullif(btrim(coalesce(v_entry->>'pageUrl', _metadata->>'pageUrl')), '');
    v_source := coalesce(nullif(btrim(v_entry->>'source'), ''), 'ebay-cancellations-page');
    v_requested_at := null;
    begin
      v_requested_at := nullif(btrim(coalesce(v_entry->>'requestedAt', v_entry->>'createdAt', v_entry->>'openedAt')), '')::timestamptz;
    exception when others then
      v_requested_at := null;
    end;

    v_identity_key := md5(lower(concat_ws(
      '|',
      coalesce(v_cancel_id, ''),
      v_order_number,
      coalesce(v_item_number, ''),
      coalesce(v_transaction_id, '')
    )));

    v_case_payload := jsonb_strip_nulls(jsonb_build_object(
      'source', v_source,
      'cancellationId', v_cancel_id,
      'cancelId', v_cancel_id,
      'orderNumber', v_order_number,
      'itemNumber', v_item_number,
      'transactionId', v_transaction_id,
      'itemTitle', v_item_title,
      'buyerUsername', v_buyer_username,
      'cancelStatus', v_cancel_status,
      'cancellationStatus', v_cancel_status,
      'cancelReason', v_cancel_reason,
      'cancellationReason', v_cancel_reason,
      'requestedAt', v_requested_at,
      'detailsUrl', v_details_url,
      'pageUrl', v_page_url,
      'capturedAt', coalesce(v_entry->>'capturedAt', _metadata->>'capturedAt'),
      'importedAt', v_now,
      'importedByEmail', coalesce(v_signed_email, ''),
      'visibleSummaryText', v_entry->>'visibleSummaryText'
    ));

    insert into public.ebay_order_cancellation_cases (
      identity_key,
      ebay_cancel_id,
      order_number,
      item_number,
      transaction_id,
      item_title,
      buyer_username,
      cancel_status,
      cancel_reason,
      requested_at,
      details_url,
      page_url,
      source,
      raw_payload,
      imported_by,
      imported_by_email,
      imported_at,
      updated_at
    )
    values (
      v_identity_key,
      v_cancel_id,
      v_order_number,
      v_item_number,
      v_transaction_id,
      v_item_title,
      v_buyer_username,
      v_cancel_status,
      v_cancel_reason,
      v_requested_at,
      v_details_url,
      v_page_url,
      v_source,
      coalesce(v_entry, '{}'::jsonb) || jsonb_build_object('metadata', coalesce(_metadata, '{}'::jsonb), 'normalized', v_case_payload),
      auth.uid(),
      v_signed_email,
      v_now,
      v_now
    )
    on conflict (identity_key) do update
      set ebay_cancel_id = excluded.ebay_cancel_id,
          order_number = excluded.order_number,
          item_number = excluded.item_number,
          transaction_id = excluded.transaction_id,
          item_title = excluded.item_title,
          buyer_username = excluded.buyer_username,
          cancel_status = excluded.cancel_status,
          cancel_reason = excluded.cancel_reason,
          requested_at = excluded.requested_at,
          details_url = excluded.details_url,
          page_url = excluded.page_url,
          source = excluded.source,
          raw_payload = excluded.raw_payload,
          imported_by = excluded.imported_by,
          imported_by_email = excluded.imported_by_email,
          updated_at = excluded.updated_at;

    v_imported := v_imported + 1;

    select count(*)::integer
      into v_line_matches
    from public.ebay_order_lines l
    join public.ebay_orders o on o.id = l.order_id
    where o.order_number = v_order_number
      and l.line_status in ('pending', 'partially_fulfilled')
      and (
        v_item_number is null
        or l.item_number = v_item_number
      )
      and (
        v_transaction_id is null
        or l.transaction_id = v_transaction_id
      );

    if coalesce(v_line_matches, 0) > 0 then
      v_matched := v_matched + v_line_matches;
      update public.ebay_order_lines l
        set raw_payload = coalesce(l.raw_payload, '{}'::jsonb) || jsonb_build_object(
              'cancellation_page_case',
              v_case_payload,
              'last_ebay_cancellation_page_imported_at',
              v_now
            ),
            updated_at = v_now
      from public.ebay_orders o
      where o.id = l.order_id
        and o.order_number = v_order_number
        and l.line_status in ('pending', 'partially_fulfilled')
        and (
          v_item_number is null
          or l.item_number = v_item_number
        )
        and (
          v_transaction_id is null
          or l.transaction_id = v_transaction_id
        );

      update public.ebay_orders
        set raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object(
              'cancellation_page_case',
              v_case_payload,
              'last_ebay_cancellation_page_imported_at',
              v_now
            ),
            updated_at = v_now
      where order_number = v_order_number;
    else
      v_unmatched := v_unmatched + 1;
    end if;
  end loop;

  return query select v_imported, v_matched, v_unmatched;
end;
$$;

revoke all on function public.import_ebay_order_cancellation_page(jsonb, jsonb, text) from public;
grant execute on function public.import_ebay_order_cancellation_page(jsonb, jsonb, text) to authenticated;

comment on function public.import_ebay_order_cancellation_page(jsonb, jsonb, text)
  is 'Imports visible rows from the eBay cancellations page and stamps matching pending orders with a cancellation-page review signal.';
