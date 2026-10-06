-- Fail closed for historical CSVs, including requests from stale browsers.
-- Fulfillment API imports and normal fulfillment updates retain their behavior.
begin;

create or replace function public.is_awaiting_shipment_report_url(_url text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  with u as (
    select replace(replace(coalesce(_url,''),'%3A',':'),'%3a',':') as value
  ), f as (
    select value, replace(replace(substring(value from '[?&]filter=([^&#]*)'),'%2C',','),'%2c',',') as filter,
      (select count(*) from regexp_matches(value,'[?&]filter=','g')) as n from u
  )
  select coalesce(value ~ '^https://www[.]ebay[.]com/sh/ord/?[?]' and n=1
    and filter ~ '(^|,)status:AWAITING_SHIPMENT(,|$)'
    and (select count(*) from regexp_matches(filter,'(^|,)status:','g'))=1,false) from f;
$$;

create or replace function public.pending_csv_row_has_closed_evidence(_row jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select exists (
    select 1 from jsonb_each_text(coalesce(_row,'{}'::jsonb)) e
    where (regexp_replace(lower(e.key),'[^a-z0-9]','','g')='shippedondate'
      and lower(btrim(coalesce(e.value,''))) not in ('','-','--','---','n/a','none','null'))
    or (regexp_replace(lower(e.key),'[^a-z0-9]','','g') in ('orderstatus','paymentstatus','fulfillmentstatus')
      and lower(btrim(e.value)) in ('shipped','delivered','fulfilled','completed','cancelled','canceled',
        'refunded','fully refunded','fully_refunded','unpaid','awaiting payment'))
  );
$$;

create or replace function public.guard_pending_csv_order_import()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_url text := coalesce(new.raw_payload #>> '{import_metadata,sourcePageUrl}','');
  v_source text := coalesce(new.raw_payload #>> '{import_metadata,source}','');
begin
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

drop trigger if exists guard_pending_csv_order_import on public.ebay_orders;
create trigger guard_pending_csv_order_import before insert or update of status on public.ebay_orders
for each row execute function public.guard_pending_csv_order_import();
drop trigger if exists guard_pending_csv_line_import on public.ebay_order_lines;
create trigger guard_pending_csv_line_import before insert or update of line_status on public.ebay_order_lines
for each row execute function public.guard_pending_csv_line_import();
notify pgrst, 'reload schema';
commit;
