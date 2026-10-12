-- CSV provenance survives fulfillment. It must not block an explicit admin
-- reversal, while stale CSV uploads must still fail closed.
begin;

-- Keep the existing audited implementation and shared-inventory lock intact.
-- The private implementation is only reachable through the admin wrapper.
do $$ begin
  if to_regprocedure('public.admin_revert_ebay_order_lines_audited(uuid[],text,text)') is null then
    alter function public.admin_revert_ebay_order_lines(uuid[], text, text)
      rename to admin_revert_ebay_order_lines_audited;
  end if;
end $$;

create or replace function public.admin_revert_ebay_order_lines(
  _order_line_ids uuid[], _notes text, _signed_by_email text default null
) returns table (reverted_lines integer, restored_units integer, updated_orders integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_previous_context text := current_setting('app.ebay_admin_reversal', true);
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only admins can revert eBay order fulfillment' using errcode = '42501';
  end if;
  perform set_config('app.ebay_admin_reversal', 'on', true);
  return query select * from public.admin_revert_ebay_order_lines_audited(_order_line_ids, _notes, _signed_by_email);
  -- Never leave the exception enabled for another write in this transaction.
  perform set_config('app.ebay_admin_reversal', coalesce(v_previous_context, ''), true);
exception when others then
  perform set_config('app.ebay_admin_reversal', coalesce(v_previous_context, ''), true);
  raise;
end $$;

revoke all on function public.admin_revert_ebay_order_lines_audited(uuid[], text, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_revert_ebay_order_lines(uuid[], text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_revert_ebay_order_lines(uuid[], text, text) to authenticated;

create or replace function public.guard_pending_csv_order_import()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_url text := coalesce(new.raw_payload #>> '{import_metadata,sourcePageUrl}','');
  v_source text := coalesce(new.raw_payload #>> '{import_metadata,source}','');
begin
  -- Only the signed admin RPC may reopen CSV-origin records. The wrapper restores the
  -- setting before returning; the owner check rejects client-set flags.
  if tg_op = 'UPDATE'
    and current_setting('app.ebay_admin_reversal', true) = 'on'
    and auth.uid() is not null and coalesce(public.is_admin(), false)
    and current_user = pg_catalog.pg_get_userbyid((
      select proowner from pg_catalog.pg_proc
      where oid = 'public.admin_revert_ebay_order_lines(uuid[],text,text)'::regprocedure
    )) then
    return new;
  end if;
  if new.status not in ('pending','partially_fulfilled') or
    coalesce(new.raw_payload->>'source','') <> 'ebay_orders_report_csv' then return new; end if;
  if tg_op='UPDATE' then
    if old.status in ('fulfilled','cancelled','archived') then
      raise exception 'CSV imports cannot reopen completed orders' using errcode='23514';
    end if;
    return new;
  end if;
  if (v_url<>'' or v_source='ebay-awaiting-shipment-report')
    and not public.is_awaiting_shipment_report_url(v_url) then
    raise exception 'Report not imported. Select Awaiting shipment in eBay Orders and send a new report; All orders reports are blocked.' using errcode='23514';
  end if;
  if new.shipped_on_date is not null or public.pending_csv_row_has_closed_evidence(new.raw_payload->'first_row') then
    raise exception 'Report not imported. Already-shipped, refunded, canceled or unpaid records cannot enter Pending Orders from CSV.' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function public.guard_pending_csv_line_import()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_order public.ebay_orders%rowtype;
begin
  -- Only the signed admin RPC may reopen CSV-origin records. The wrapper restores the
  -- setting before returning; the owner check rejects client-set flags.
  if tg_op = 'UPDATE'
    and current_setting('app.ebay_admin_reversal', true) = 'on'
    and auth.uid() is not null and coalesce(public.is_admin(), false)
    and current_user = pg_catalog.pg_get_userbyid((
      select proowner from pg_catalog.pg_proc
      where oid = 'public.admin_revert_ebay_order_lines(uuid[],text,text)'::regprocedure
    )) then
    return new;
  end if;
  if new.line_status not in ('pending','partially_fulfilled') or not exists (
    select 1 from jsonb_object_keys(coalesce(new.raw_payload,'{}'::jsonb)) k
    where regexp_replace(lower(k),'[^a-z0-9]','','g')='ordernumber'
  ) then return new; end if;
  if tg_op='UPDATE' then
    if old.line_status in ('fulfilled','cancelled','skipped') then
      raise exception 'CSV imports cannot reopen completed order lines' using errcode='23514';
    end if;
    return new;
  end if;
  -- Lock against a simultaneous closeout before admitting a missing CSV line.
  select * into v_order from public.ebay_orders where id=new.order_id for update;
  if v_order.status in ('fulfilled','cancelled','archived') or v_order.shipped_on_date is not null
    or public.pending_csv_row_has_closed_evidence(new.raw_payload) then
    raise exception 'CSV import cannot add a pending line to an already-shipped or completed order' using errcode='23514';
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
commit;
