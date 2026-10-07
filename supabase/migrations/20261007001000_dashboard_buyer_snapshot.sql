-- The dashboard's old profitability RPC is absent in production. This bounded,
-- read-only replacement returns only the fields used by the dashboard report.
-- Use existing table RLS and require an admin; no order/task state is changed.
create or replace function public.get_dashboard_buyer_snapshot(
  _days_back integer default 90,
  _limit integer default 6
)
returns table (
  buyer_username text,
  order_count bigint,
  gross_sales numeric,
  net_payout numeric,
  payout_missing_count bigint,
  open_return_count bigint
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  return query
  with top_buyers as materialized (
    select
      lower(btrim(o.buyer_username)) as buyer_key,
      max(btrim(o.buyer_username)) as buyer_label,
      count(*) as orders,
      coalesce(sum(o.total_price), 0)::numeric as gross,
      sum(o.net_payout)::numeric as payout,
      count(*) filter (where o.net_payout is null) as missing_payouts
    from public.ebay_orders o
    where nullif(btrim(o.buyer_username), '') is not null
      and o.status not in ('cancelled', 'archived')
      and coalesce(o.sale_date, o.paid_on_date, o.imported_at)
        >= now() - make_interval(days => least(greatest(coalesce(_days_back, 90), 1), 365))
    group by lower(btrim(o.buyer_username))
    order by gross desc, buyer_key
    limit least(greatest(coalesce(_limit, 6), 1), 12)
  ), open_cases as (
    select lower(btrim(c.buyer_username)) as buyer_key, count(*) as cases
    from public.ebay_return_cases c
    where c.status not in ('closed', 'cancelled')
      and lower(btrim(c.buyer_username)) in (select b.buyer_key from top_buyers b)
    group by lower(btrim(c.buyer_username))
  )
  select b.buyer_label, b.orders, b.gross, b.payout, b.missing_payouts, coalesce(c.cases, 0)
  from top_buyers b
  left join open_cases c using (buyer_key)
  order by b.gross desc, b.buyer_key;
end;
$$;

revoke all on function public.get_dashboard_buyer_snapshot(integer, integer) from public;
grant execute on function public.get_dashboard_buyer_snapshot(integer, integer) to authenticated;
comment on function public.get_dashboard_buyer_snapshot(integer, integer)
  is 'Admin dashboard top buyers for a bounded sales window, with all currently open cases and explicit missing payout counts. Invoker RLS applies.';
notify pgrst, 'reload schema';
