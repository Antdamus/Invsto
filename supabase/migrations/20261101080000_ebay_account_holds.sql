begin;
-- One whole Seller Hub ledger, independent of the account total checked by the API.
create table public.ebay_account_holds (
 singleton boolean primary key default true check(singleton),
 verified_at timestamptz, ledger_cents bigint check(ledger_cents>=0), entries jsonb,
 api_at timestamptz, api_cents bigint check(api_cents>=0), api_error text,
 next_api_at timestamptz not null default now()
);
insert into public.ebay_account_holds(singleton) values(true);
alter table public.ebay_account_holds enable row level security;
revoke all on public.ebay_account_holds from public,anon,authenticated;
grant select,update on public.ebay_account_holds to service_role;

create function public.store_ebay_hold_ledger(_at timestamptz,_total bigint,_count integer,_rows jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; n integer; unique_n integer; summed bigint;
begin
 if _at is null or _at>now()+interval '2 minutes' or _total is null or _total<0
 or _count is null or _count not between 0 and 20000 or jsonb_typeof(_rows) is distinct from 'array'
 or jsonb_array_length(_rows)<>_count then raise exception 'Incomplete Seller Hub ledger'; end if;
 if exists(select 1 from jsonb_to_recordset(_rows) r(kind text,ref text,oid text,cents bigint,placed date)
   where kind is null or kind not in ('sale','return','dispute','retro','other') or
   ref is null or ref!~'^[a-zA-Z0-9_-]{1,110}$' or oid is not null and oid!~'^\d{2}-\d{5}-\d{5}$'
   or (kind='sale' and (oid is null or oid<>ref)) or cents is null or cents<0 or placed is null)
 then raise exception 'Invalid Seller Hub hold row'; end if;
 with raw as (select * from jsonb_to_recordset(_rows) r(kind text,ref text,oid text,cents bigint,placed date)),
 resolved as (select r.*,coalesce(r.oid,c.order_number) ord from raw r
   left join lateral (select min(order_number) order_number from public.ebay_return_cases
     where r.kind in ('return','dispute') and ebay_return_id=r.ref and order_number is not null
     having count(distinct order_number)=1) c on true)
 select count(*),count(distinct (case when kind='sale' then 'sale' else 'reserve' end,ref)),coalesce(sum(cents),0),
   coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind',kind,'ref',ref,'oid',ord,'cents',cents,'placed',placed,
     'date',p.purchased)) order by cents desc,r.ref),'[]') into n,unique_n,summed,result
 from resolved r left join lateral (select min((sale_date at time zone 'America/New_York')::date) purchased
   from public.ebay_orders where order_number=r.ord having count(distinct (sale_date at time zone 'America/New_York')::date)=1) p on true;
 if n<>_count or n<>unique_n or summed<>_total then raise exception 'Seller Hub count or balance did not reconcile';end if;
 update public.ebay_account_holds set verified_at=_at,ledger_cents=_total,entries=result where singleton and (verified_at is null or verified_at<=_at);
end$$;
revoke all on function public.store_ebay_hold_ledger(timestamptz,bigint,integer,jsonb) from public,anon,authenticated;
grant execute on function public.store_ebay_hold_ledger(timestamptz,bigint,integer,jsonb) to service_role;

create function public.refresh_ebay_hold_ledger(_at timestamptz,_total bigint,_count integer,_rows jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not exists(select from public.employees where user_id=auth.uid() and active and lower(role)='admin')
 then raise exception 'Active admin access required' using errcode='42501';end if;
 if _at<now()-interval '30 minutes' then raise exception 'Refresh Seller Hub before saving';end if;
 perform public.store_ebay_hold_ledger(_at,_total,_count,_rows);
end$$;
revoke all on function public.refresh_ebay_hold_ledger(timestamptz,bigint,integer,jsonb) from public,anon;
grant execute on function public.refresh_ebay_hold_ledger(timestamptz,bigint,integer,jsonb) to authenticated;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='''ebay_account_payouts'',';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected weekly report';end if;
 execute replace(f,marker,$x$'ebay_account_holds',case when _market in ('ebay','all') then
 (select to_jsonb(h)-'singleton'-'next_api_at' from public.ebay_account_holds h where singleton) end,'ebay_account_payouts',$x$);
end$$;
notify pgrst,'reload schema';
commit;
