begin;
set local lock_timeout='8s';

create table public.ebay_health_orders (
  id text primary key, purchased timestamptz not null, buyer text not null, paid boolean not null,
  original_cents bigint not null check(original_cents>=0), status text not null,
  items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items)>0)
);
create index ebay_health_order_dates on public.ebay_health_orders(purchased);
create table public.ebay_health_cases (
  id text primary key, requested date not null, buyer text not null, reason text not null,
  items text[] not null, gross bigint not null check(gross>=0), linked_order text, purchase_day date
);
create table public.ebay_health_refunds (
  order_id text not null, reference text not null, day date not null, gross bigint not null check(gross>=0),
  net bigint not null check(net>=0), title text, primary key(order_id,reference,day,gross,net)
);
create table public.ebay_health_jobs (
  kind text not null check(kind in ('orders','cases','payments','case_detail')), id text not null,
  due timestamptz not null default now(), verified timestamptz, attempted timestamptz, note text,
  ticket uuid, owner_id uuid, lease_until timestamptz, primary key(kind,id)
);
create index ebay_health_due on public.ebay_health_jobs(kind,due);
create unique index ebay_health_ticket on public.ebay_health_jobs(ticket) where ticket is not null;
create table public.ebay_health_config (
  singleton boolean primary key default true check(singleton), coverage_start date,
  cancellation numeric check(cancellation between 0 and 100),
  buyer numeric check(buyer between 0 and 100), refund numeric check(refund between 0 and 100)
);
insert into public.ebay_health_config(singleton) values(true);
do $$declare tbl text;begin
 foreach tbl in array array['ebay_health_orders','ebay_health_cases','ebay_health_refunds','ebay_health_jobs','ebay_health_config'] loop
  execute format('alter table public.%I enable row level security',tbl);
  execute format('revoke all on public.%I from public,anon,authenticated',tbl);
 end loop;
end$$;
create function public.require_ebay_health_admin() returns void language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select from public.employees where user_id=auth.uid() and active and lower(role)='admin')
 then raise exception 'Active admin access required' using errcode='42501';end if;
end$$;
revoke all on function public.require_ebay_health_admin() from public,anon,authenticated;
create function public.enqueue_ebay_health_payment() returns trigger language plpgsql set search_path='' as $$
begin
 if new.id~'^[0-9]{2}-[0-9]{5}-[0-9]{5}$' and new.status in ('Canceled','Refunded','Partially refunded','Returned by authenticator')
 and (tg_op='INSERT' or old.status is distinct from new.status) then
  insert into public.ebay_health_jobs(kind,id) values('payments',new.id)
  on conflict(kind,id) do update set due=least(ebay_health_jobs.due,now());
 end if;return null;
end$$;
create trigger ebay_health_order_payment after insert or update on public.ebay_health_orders
 for each row execute function public.enqueue_ebay_health_payment();

-- Data and watermarks are updated in the same transaction. A failed or partial read preserves the last complete result.
create function public.store_ebay_health_rows(k text,rows_in jsonb) returns void language plpgsql set search_path='' as $$
begin
 if k='orders' then
  if exists(select from jsonb_array_elements(rows_in) r where (r->>'id')!~'^[0-9-]{8,45}$'
   or length(r->>'buyer') not between 1 and 160 or jsonb_array_length(r->'items') not between 1 and 1000)
  then raise exception 'Invalid order identity or line count';end if;
  insert into public.ebay_health_orders as o(id,purchased,buyer,paid,original_cents,status,items)
   select id,purchased,lower(buyer),paid,original_cents,status,items from jsonb_to_recordset(rows_in)
    r(id text,purchased timestamptz,buyer text,paid boolean,original_cents bigint,status text,items jsonb)
   on conflict(id) do update set purchased=excluded.purchased,buyer=excluded.buyer,paid=excluded.paid,
    original_cents=excluded.original_cents,status=excluded.status,items=excluded.items;
  -- An unpaid sale may later acquire an order number. Join using its unique item, buyer and sale minute.
  delete from public.ebay_health_orders old using jsonb_to_recordset(rows_in)
   n(id text,buyer text,purchased timestamptz,items jsonb)
   where old.id~'^[0-9]{11,14}-[0-9]{10,18}$' and n.id~'^[0-9]{2}-[0-9]{5}-[0-9]{5}$'
    and old.buyer=lower(n.buyer) and abs(extract(epoch from old.purchased-n.purchased))<60
    and jsonb_array_length(old.items)=1 and exists(select from jsonb_array_elements(n.items) i where i->>'id'=split_part(old.id,'-',1));
 elsif k='cases' then
  insert into public.ebay_health_cases as c(id,requested,buyer,reason,items,gross,linked_order,purchase_day)
   select id,requested,lower(buyer),reason,items,gross,linked_order,purchase_day from jsonb_to_recordset(rows_in)
   r(id text,requested date,buyer text,reason text,items text[],gross bigint,linked_order text,purchase_day date)
   on conflict(id) do update set requested=excluded.requested,buyer=excluded.buyer,reason=excluded.reason,items=excluded.items,
    gross=excluded.gross,linked_order=coalesce(excluded.linked_order,c.linked_order),purchase_day=coalesce(excluded.purchase_day,c.purchase_day);
 elsif k='payments' then
  insert into public.ebay_health_refunds as p(order_id,reference,day,gross,net,title)
   select order_id,reference,day,gross,net,nullif(title,'') from jsonb_to_recordset(rows_in)
    r(order_id text,reference text,day date,gross bigint,net bigint,title text)
   on conflict(order_id,reference,day,gross,net) do update set title=coalesce(excluded.title,p.title);
 else raise exception 'Unknown source';end if;
end$$;
revoke all on function public.store_ebay_health_rows(text,jsonb) from public,anon,authenticated;

create function public.claim_ebay_health_jobs() returns jsonb language plpgsql security definer set search_path='' as $$
declare today date:=(now() at time zone 'America/Los_Angeles')::date; oldest date; result jsonb;
begin
 perform public.require_ebay_health_admin();
 oldest:=(today-interval '4 months')::date-1;
 insert into public.ebay_health_jobs(kind,id) select 'orders',d::date::text
  from generate_series(date_trunc('week',oldest::timestamp),today::timestamp,interval '7 days') d on conflict do nothing;
 insert into public.ebay_health_jobs(kind,id) values('cases','register') on conflict do nothing;
 insert into public.ebay_health_jobs(kind,id)
  select 'payments',o.id from public.ebay_health_orders o where o.purchased >= oldest::timestamp at time zone 'America/New_York'
   and o.id~'^[0-9]{2}-[0-9]{5}-[0-9]{5}$' and
   (o.status in ('Canceled','Refunded','Partially refunded','Returned by authenticator')
    or exists(select from public.ebay_orders saved where saved.order_number=o.id and
     jsonb_path_exists(saved.raw_payload,'$.ebayFinance.transactions[*] ? (@.transactionType == "REFUND")')))
  on conflict do nothing;
 insert into public.ebay_health_jobs(kind,id)
  select 'case_detail',c.id from public.ebay_health_cases c where c.requested>=oldest and c.purchase_day is null
  and not exists(select from public.ebay_health_orders o where o.buyer=c.buyer and exists
    (select from jsonb_array_elements(o.items) i where i->>'id'=any(c.items)))
  on conflict do nothing;
 with candidates as (
  select kind,id,row_number() over(partition by kind order by
   case when kind='orders' and id>=date_trunc('week',today::timestamp)::date::text then 0 else 1 end,due,id) as n
  from public.ebay_health_jobs where due<=now() and coalesce(lease_until,'-infinity')<now() and
   (kind<>'orders' or id>=date_trunc('week',oldest::timestamp)::date::text)
 ), claimed as (
  update public.ebay_health_jobs j set ticket=gen_random_uuid(),owner_id=auth.uid(),lease_until=now()+interval '10 minutes',attempted=now()
   from candidates c where (j.kind,j.id)=(c.kind,c.id) and c.n<=case j.kind when 'payments' then 8 when 'case_detail' then 3 else 1 end
   and coalesce(j.lease_until,'-infinity')<now() returning j.kind,j.id,j.ticket)
 select coalesce(jsonb_agg(to_jsonb(claimed) order by case kind when 'cases' then 1 when 'orders' then 2 else 3 end),'[]')
 into result from claimed;return result;
end$$;
create function public.finish_ebay_health_job(_ticket uuid,_rows jsonb,_count integer,_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare job public.ebay_health_jobs; today date:=(now() at time zone 'America/Los_Angeles')::date; cadence interval;
begin
 perform public.require_ebay_health_admin();
 select * into job from public.ebay_health_jobs where ticket=_ticket and owner_id=auth.uid() and lease_until>now() for update;
 if not found then raise exception 'Expired performance check';end if;
 if _error is not null then
  update public.ebay_health_jobs set ticket=null,owner_id=null,lease_until=null,note=left(_error,220),due=now()+interval '2 hours'
  where ticket=_ticket;return;
 end if;
 if _count is null or _count not between 0 and 25000 or jsonb_typeof(_rows) is distinct from 'array' or jsonb_array_length(_rows)<>_count
 then raise exception 'Incomplete Seller Hub page set';end if;
 if job.kind='case_detail' then
  if _count<>1 or _rows#>>'{0,id}' is distinct from job.id or _rows#>>'{0,purchase_day}' is null then raise exception 'Case identity not verified';end if;
  update public.ebay_health_cases set purchase_day=(_rows#>>'{0,purchase_day}')::date,linked_order=_rows#>>'{0,linked_order}' where id=job.id;
  -- An archived order can disappear from All orders but still have a verified case and saved item lines.
  insert into public.ebay_health_orders(id,purchased,buyer,paid,original_cents,status,items)
   select o.order_number,o.sale_date,lower(o.buyer_username),o.paid_on_date is not null,
    round(sum(coalesce(public.weekly_sales_money(l.raw_payload#>>'{line,lineItemCost,value}'),l.sold_for*l.quantity))*100)::bigint,
    'Canceled',jsonb_agg(jsonb_build_object('id',l.item_number,'title',l.item_title) order by l.id)
   from public.ebay_orders o join public.ebay_order_lines l on l.order_id=o.id
   join public.ebay_health_cases c on c.id=job.id and c.linked_order=o.order_number and lower(o.buyer_username)=c.buyer
   where o.sale_date is not null and (o.sale_date at time zone 'America/Los_Angeles')::date=c.purchase_day
   group by o.order_number,o.sale_date,o.buyer_username,o.paid_on_date
   having bool_and(l.item_number=any((select items from public.ebay_health_cases where id=job.id)::text[]))
    and bool_and(coalesce(public.weekly_sales_money(l.raw_payload#>>'{line,lineItemCost,value}'),l.sold_for*l.quantity) is not null)
   on conflict(id) do nothing;
 elsif job.kind='payments' then
  if exists(select from jsonb_array_elements(_rows) r where r->>'order_id' is distinct from job.id)
  then raise exception 'Transaction belongs to another order';end if;
  perform public.store_ebay_health_rows(job.kind,_rows);
 else
  if job.kind='orders' and exists(select from jsonb_array_elements(_rows) r
   where ((r->>'purchased')::timestamptz at time zone 'America/Los_Angeles')::date not between job.id::date and job.id::date+6)
  then raise exception 'Order outside the requested sale dates';end if;
  perform public.store_ebay_health_rows(job.kind,_rows);
 end if;
 cadence:=case when job.kind='case_detail' then interval '1 year' when job.kind='cases' then interval '4 hours'
  when job.kind='orders' and job.id >=date_trunc('week',today::timestamp)::date::text then interval '2 hours'
  when job.kind='orders' then interval '24 hours' else interval '7 days' end;
 update public.ebay_health_jobs set ticket=null,owner_id=null,lease_until=null,verified=now(),note=null,due=now()+cadence where ticket=_ticket;
end$$;

create function public.ebay_health_freshness() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('version',(select max(verified) from public.ebay_health_jobs),
  'sources',(select jsonb_object_agg(kind,info) from (
    select kind,jsonb_build_object('last',max(verified),'oldest',min(verified),'waiting',count(*) filter(where verified is null),
     'errors',count(*) filter(where note is not null),'note',(array_agg(note order by attempted desc) filter(where note is not null))[1]) info
    from public.ebay_health_jobs where kind<>'orders' or id>=date_trunc('week',(now() at time zone 'America/Los_Angeles')-interval '4 months 1 day')::date::text group by kind) s));
$$;
revoke all on function public.ebay_health_freshness() from public,anon,authenticated;
create function public.ebay_health_badge() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform public.require_ebay_health_admin();return public.ebay_health_freshness();end$$;
create function public.ebay_health_report() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare first_day date:=((now() at time zone 'America/New_York')::date-interval '8 months 1 day')::date;
begin perform public.require_ebay_health_admin();
 return jsonb_build_object('as_of',now(),'sources',public.ebay_health_freshness(),'config',(select to_jsonb(c)-'singleton' from public.ebay_health_config c),
  'orders',(select coalesce(jsonb_agg(to_jsonb(o)),'[]') from public.ebay_health_orders o where purchased>=first_day::timestamp at time zone 'America/New_York'),
  'cases',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.ebay_health_cases c where requested>=first_day),
  'payments',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.ebay_health_refunds p join public.ebay_health_orders o on o.id=p.order_id where o.purchased>=first_day::timestamp at time zone 'America/New_York'));
end$$;
create function public.set_ebay_health_targets(_cancel numeric,_buyer numeric,_refund numeric) returns void language plpgsql security definer set search_path='' as $$
begin perform public.require_ebay_health_admin();update public.ebay_health_config set cancellation=_cancel,buyer=_buyer,refund=_refund where singleton;end$$;
create function public.ebay_health_release_evidence() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare packet jsonb;
begin perform public.require_ebay_health_admin();
 select public.weekly_ebay_hold_snapshot() into packet;
 return jsonb_build_object('verified_at',packet->'verified_at','entries',(select coalesce(jsonb_agg(jsonb_build_object(
  'id',x->>'oid','cents',x->'cents','evidence',x->'hold_detail','lines',
  (select jsonb_agg(jsonb_build_object('status',l.line_status,'closed',l.fulfilled_at,'signed',(l.fulfilled_by is not null or nullif(trim(l.fulfilled_by_email),'') is not null),'full',l.fulfilled_quantity>=l.quantity))
   from public.ebay_orders o join public.ebay_order_lines l on l.order_id=o.id where o.order_number=x->>'oid'))),'[]')
  from jsonb_array_elements(packet->'entries') x where x->>'kind'='sale'));
end$$;
revoke all on function public.claim_ebay_health_jobs(),public.finish_ebay_health_job(uuid,jsonb,integer,text),public.ebay_health_badge(),public.ebay_health_report(),public.set_ebay_health_targets(numeric,numeric,numeric),public.ebay_health_release_evidence() from public,anon,authenticated;
grant execute on function public.claim_ebay_health_jobs(),public.finish_ebay_health_job(uuid,jsonb,integer,text),public.ebay_health_badge(),public.ebay_health_report(),public.set_ebay_health_targets(numeric,numeric,numeric),public.ebay_health_release_evidence() to authenticated;
alter function public.ebay_report_manual_actions(date) rename to ebay_report_manual_actions_before_performance;
revoke all on function public.ebay_report_manual_actions_before_performance(date) from public,anon,authenticated;
create function public.ebay_report_manual_actions(_month date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actions jsonb;
begin
 actions:=public.ebay_report_manual_actions_before_performance(_month);
 if exists(select from public.ebay_health_config where coverage_start is not null) and
   (not exists(select from public.ebay_health_jobs where kind='cases' and verified>now()-interval '12 hours')
    or not exists(select from public.ebay_health_jobs where kind='orders' and verified>now()-interval '12 hours')) then
  actions:=actions||jsonb_build_object('kind','performance');
 end if;return actions;
end$$;
revoke all on function public.ebay_report_manual_actions(date) from public,anon,authenticated;
grant execute on function public.ebay_report_manual_actions(date) to authenticated;
commit;
notify pgrst,'reload schema';
