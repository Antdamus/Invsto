begin;
create table public.weekly_ebay_payout_batches(
 id text primary key,status text not null,amount numeric not null check(amount>=0),currency text not null,
 reported_day date not null,source text not null,checked_at timestamptz not null,
 next_detail timestamptz not null default now(),detail_checked timestamptz, detail_error text
);
create table public.weekly_ebay_payout_entries(
 payout_id text references public.weekly_ebay_payout_batches(id),txn text,kind text,
 order_number text not null,signed_amount numeric not null, currency text not null,
 primary key(payout_id,txn,kind)
);
create index weekly_ebay_payout_order_idx on public.weekly_ebay_payout_entries(order_number);
create table public.weekly_ebay_payout_scan(singleton boolean primary key default true check(singleton),next_at timestamptz not null default now(),last_success timestamptz,last_error text);
insert into public.weekly_ebay_payout_scan(singleton) values(true);
alter table public.weekly_ebay_payout_batches enable row level security;
alter table public.weekly_ebay_payout_entries enable row level security;
alter table public.weekly_ebay_payout_scan enable row level security;
revoke all on public.weekly_ebay_payout_batches,public.weekly_ebay_payout_entries,public.weekly_ebay_payout_scan from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_payout_batches,public.weekly_ebay_payout_entries,public.weekly_ebay_payout_scan to service_role;

-- Replace a batch only after every page was read. Unrelated balance transfers never become order earnings.
create function public.save_weekly_ebay_payout_entries(_id text,_entries jsonb)
returns void language plpgsql security definer set search_path='' as $$begin
 if jsonb_typeof(_entries) is distinct from 'array' then raise exception 'Incomplete payout entries';end if;
 perform 1 from public.weekly_ebay_payout_batches where id=_id for update;
 if not found then raise exception 'Unknown payout';end if;
 delete from public.weekly_ebay_payout_entries where payout_id=_id;
 insert into public.weekly_ebay_payout_entries(payout_id,txn,kind,order_number,signed_amount,currency)
 select _id,x.txn,x.kind,x.order_number,x.signed_amount,x.currency from jsonb_to_recordset(_entries)
 as x(txn text,kind text,order_number text,signed_amount numeric,currency text)
 where x.order_number ~ '^[0-9]{2}-[0-9]{5}-[0-9]{5}$' and x.kind not in ('PAYOUT','WITHDRAWAL','TRANSFER');
 update public.weekly_ebay_payout_batches set detail_checked=now(),detail_error=null,next_detail=now()+case when status='SUCCEEDED' then interval '30 days' else interval '4 hours' end where id=_id;
end$$;
revoke all on function public.save_weekly_ebay_payout_entries(text,jsonb) from public,anon,authenticated;
grant execute on function public.save_weekly_ebay_payout_entries(text,jsonb) to service_role;

-- Use the literal order and transaction references. An express withdrawal drawn
-- from the account balance has no attributable order without such a reference.
create function public.weekly_ebay_order_payout(_number text,_raw jsonb) returns jsonb language sql stable set search_path='' as $$
with rows as (
 select e.payout_id,e.txn,e.kind,e.signed_amount,e.currency from public.weekly_ebay_payout_entries e where e.order_number=_number
 union all
 select t->>'payoutId',t->>'transactionId',t->>'transactionType',
  case t->>'bookingEntry' when 'CREDIT' then 1 when 'DEBIT' then -1 end*public.weekly_sales_money(trim(leading '-' from t->>'amount')),t->>'currency'
 from jsonb_array_elements(coalesce(_raw#>'{ebayFinance,transactions}','[]')) t
 where t->>'orderNumber'=_number and nullif(t->>'payoutId','') is not null and nullif(t->>'transactionId','') is not null
 and t->>'transactionStatus'<>'FAILED' and t->>'transactionType' not in('PAYOUT','TRANSFER','WITHDRAWAL')
 and not exists(select 1 from public.weekly_ebay_payout_entries e where e.payout_id=t->>'payoutId' and e.txn=t->>'transactionId' and e.kind=t->>'transactionType')
), entries as (select payout_id,txn,kind,
 case when count(signed_amount)=count(*) and min(signed_amount)=max(signed_amount) then min(signed_amount) end signed_amount,
 case when count(currency)=count(*) and min(currency)=max(currency) then min(currency) end currency
 from rows group by payout_id,txn,kind), receipts as (
 select e.payout_id,b.status,b.reported_day,
 case when bool_and((e.currency='USD' and e.signed_amount is not null) is true) then sum(e.signed_amount) end as net,
 case when bool_and((e.currency='USD' and e.signed_amount is not null) is true) then coalesce(sum(e.signed_amount) filter(where e.kind='SALE' and e.signed_amount>0),0) end as sale
 from entries e left join public.weekly_ebay_payout_batches b on b.id=e.payout_id group by e.payout_id,b.status,b.reported_day
)
select case when count(*)>0 then jsonb_agg(jsonb_build_object('id',payout_id,'status',status,'date',reported_day,'net',net,'sale',sale) order by reported_day,payout_id) else '[]'::jsonb end from receipts
$$;
revoke all on function public.weekly_ebay_order_payout(text,jsonb) from public,anon,authenticated;
do $$declare f text:=pg_get_functiondef('public.weekly_ebay_item_payments(date,date,timestamp,jsonb)'::regprocedure);
 marker text:='''user'',o.buyer_username,';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected item report';end if;
 execute replace(f,marker,'''payouts'',public.weekly_ebay_order_payout(o.order_number,o.raw),'||marker);
end$$;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='''ebay_item_orders'',';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected report shape';end if;
 execute replace(f,marker,$x$'ebay_account_payouts',case when _market in ('ebay','all') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'day',reported_day,'amount',amount) order by reported_day desc,id)
 from public.weekly_ebay_payout_batches where reported_day>=m and reported_day<end_date and status='SUCCEEDED' and currency='USD'),'[]') end,'ebay_item_orders',$x$);
end$$;
notify pgrst,'reload schema';
commit;
