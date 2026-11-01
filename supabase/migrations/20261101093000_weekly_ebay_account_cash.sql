begin;
set local lock_timeout='8s';
create table public.weekly_ebay_account_cash (
 month date primary key check (extract(day from month)=1),
 opening bigint not null, closing bigint not null, movements jsonb not null check(jsonb_typeof(movements)='array'),
 source text not null, checked_at timestamptz not null default now(), bank_fee bigint check(bank_fee>=0),
 observed_held bigint, observed_available bigint, observed_at timestamptz
);
alter table public.weekly_ebay_account_cash enable row level security;
revoke all on public.weekly_ebay_account_cash from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_account_cash to service_role;

create function public.save_ebay_cash_statement(_month date,_opening bigint,_closing bigint,_movements jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare n integer;distinct_keys integer;delta numeric;begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin')
 then raise exception 'Active admin access required' using errcode='42501';end if;
 if _month is null or extract(day from _month)<>1 or _month<'2000-01-01' or _month>=date_trunc('month',now() at time zone 'America/Los_Angeles')::date
 or _opening is null or _closing is null or jsonb_typeof(_movements) is distinct from 'array'
 or jsonb_array_length(_movements) not between 1 and 50 then raise exception 'Expected a completed statement month';end if;
 select count(*),count(distinct label),sum(cents) into n,distinct_keys,delta from jsonb_to_recordset(_movements) as m(label text,cents bigint)
 where length(trim(label)) between 1 and 100 and cents is not null;
 if n<>jsonb_array_length(_movements) or n<>distinct_keys or delta+_opening is distinct from _closing
 then raise exception 'Statement entries do not reconcile';end if;
 insert into public.weekly_ebay_account_cash as c(month,opening,closing,movements,source)
 values(_month,_opening,_closing,_movements,'eBay monthly financial statement')
 on conflict(month) do update set opening=excluded.opening,closing=excluded.closing,movements=excluded.movements,
 source=excluded.source,checked_at=now(),bank_fee=case when
 (select m->>'cents' from jsonb_array_elements(c.movements) m where m->>'label'='Payouts')=
 (select m->>'cents' from jsonb_array_elements(excluded.movements) m where m->>'label'='Payouts') then c.bank_fee end;
end$$;
revoke all on function public.save_ebay_cash_statement(date,bigint,bigint,jsonb) from public,anon;
grant execute on function public.save_ebay_cash_statement(date,bigint,bigint,jsonb) to authenticated;

-- Carry the report's own verified order net into the item list, including partially refunded multi-line orders.
do $$declare f text:=pg_get_functiondef('public.weekly_ebay_item_payments(date,date,timestamp,jsonb)'::regprocedure);
 r text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 cols text:='needs_review boolean,proceeds numeric'; sel text:='s.refunded,s.needs_review'; out_key text:='''booked'',o.booked';
 net_key text:='''refunded'',refunded,''needs_review'',needs_review,''proceeds'',proceeds';
 report_key text:='''ebay_account_holds'',';
begin
 if strpos(f,cols)=0 or strpos(f,sel)=0 or strpos(f,out_key)=0 or strpos(r,net_key)=0 or strpos(r,report_key)=0
 then raise exception 'Unexpected purchase-week report definition';end if;
 execute replace(replace(replace(f,cols,'net numeric,'||cols),sel,'s.net,'||sel),out_key,'''net_item'',o.net,'||out_key);
 execute replace(replace(r,net_key,'''net'',net,'||net_key),report_key,$key$'ebay_cash_statement',case when _market in ('ebay','all') then
  (select to_jsonb(c) from public.weekly_ebay_account_cash c where c.month=m) end,$key$||report_key);
end$$;
notify pgrst,'reload schema';
commit;
