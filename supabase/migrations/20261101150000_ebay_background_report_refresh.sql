begin;
set local lock_timeout='8s';
-- This watch outlives both the packing queue and eBay's current held list.
create table public.ebay_report_watch (
 order_number text primary key references public.ebay_orders(order_number) on delete cascade,
 active boolean not null default true, state_at timestamptz, next_finance timestamptz not null default now(),
 next_api timestamptz not null default now(), next_browser timestamptz not null default now(),
 delivery jsonb, api_checked timestamptz, api_note text, browser_checked timestamptz
);
create index ebay_report_finance_due on public.ebay_report_watch(next_finance) where active;
alter table public.ebay_report_watch enable row level security;
revoke all on public.ebay_report_watch from public,anon,authenticated;
grant select,insert,update on public.ebay_report_watch to service_role;
create table public.ebay_report_browser_state (
 singleton boolean primary key default true check(singleton), lease_until timestamptz, ticket uuid,
 attempted timestamptz, completed timestamptz, note text,
 statement_attempt timestamptz, statement_note text, owner_id uuid, reserved text[], claim_month date
);
insert into public.ebay_report_browser_state(singleton) values(true);
alter table public.ebay_report_browser_state enable row level security;
revoke all on public.ebay_report_browser_state from public,anon,authenticated;
create table public.ebay_claim_report_checks(month date primary key,next_at timestamptz not null,last_request timestamptz,note text);
alter table public.ebay_claim_report_checks enable row level security;
revoke all on public.ebay_claim_report_checks from public,anon,authenticated;

create function public.ebay_sale_watch_state(num text,f jsonb) returns boolean
language sql immutable set search_path='' as $$
 select case when bool_or(t->>'transactionStatus' in ('FUNDS_ON_HOLD','FUNDS_PROCESSING')) then true
 when count(*)>0 and bool_and(coalesce(t->>'transactionStatus' in ('FUNDS_AVAILABLE_FOR_PAYOUT','PAYOUT_INITIATED','PAID_OUT','PAYOUT'),false))
 and jsonb_array_length(f->'transactions')<20 then false end
 from jsonb_array_elements(case when jsonb_typeof(f->'transactions')='array' then f->'transactions' else '[]' end) t
 where t->>'transactionType'='SALE' and t->>'bookingEntry'='CREDIT' and
 (t->>'orderNumber'=num or (nullif(t->>'orderNumber','') is null and f->>'orderNumber'=num and f->>'source'='ebay_finances_api'))
$$;
create function public.ebay_observe_report_funds() returns trigger language plpgsql security definer set search_path='' as $$
declare f jsonb:=new.raw_payload->'ebayFinance'; state boolean; at_time timestamptz;
begin
 if tg_op='UPDATE' and f is not distinct from old.raw_payload->'ebayFinance' then return new;end if;
 state:=public.ebay_sale_watch_state(new.order_number,f);
 if state is null then return new;end if;
 at_time:=nullif(f->>'syncedAt','')::timestamptz;
 if at_time is null then return new;end if;
 if state then
 insert into public.ebay_report_watch as w(order_number,state_at,next_finance) values(new.order_number,at_time,at_time+interval '4 hours')
 on conflict(order_number) do update set active=true,state_at=excluded.state_at,next_finance=excluded.next_finance
 where w.state_at is null or w.state_at<=excluded.state_at;
 else
 update public.ebay_report_watch set active=false,state_at=at_time where order_number=new.order_number and (state_at is null or state_at<=at_time);
 end if;
 return new;
end$$;
create trigger ebay_report_funds_watch after insert or update of raw_payload on public.ebay_orders
 for each row execute function public.ebay_observe_report_funds();
insert into public.ebay_report_watch(order_number,state_at)
 select order_number,(raw_payload#>>'{ebayFinance,syncedAt}')::timestamptz from public.ebay_orders
 where public.ebay_sale_watch_state(order_number,raw_payload->'ebayFinance') is true;
-- Seller Hub evidence can start a watch even where per-order Finances has no sale yet.
create function public.ebay_watch_hold_list(rows_in jsonb,at_time timestamptz) returns void
language sql security definer set search_path='' as $$
 insert into public.ebay_report_watch as w(order_number,state_at)
 select distinct e.order_number,at_time from jsonb_array_elements(rows_in) r
 join public.ebay_orders e on e.order_number=r->>'oid' where r->>'kind'='sale' and at_time is not null
 and not (coalesce((e.raw_payload#>>'{ebayFinance,syncedAt}')::timestamptz,'-infinity')>at_time
 and public.ebay_sale_watch_state(e.order_number,e.raw_payload->'ebayFinance') is false)
 on conflict(order_number) do update set active=true,state_at=excluded.state_at,
 next_finance=case when w.active then w.next_finance else now() end where w.state_at is null or w.state_at<excluded.state_at
$$;
select public.ebay_watch_hold_list(entries,verified_at) from public.ebay_account_holds where singleton;
insert into public.ebay_report_watch as w(order_number,state_at)
 select h.order_number,h.checked_at from public.weekly_ebay_payment_observations h join public.ebay_orders e using(order_number)
 where h.funds in ('held','mixed','processing') and not (coalesce((e.raw_payload#>>'{ebayFinance,syncedAt}')::timestamptz,'-infinity')>h.checked_at
 and public.ebay_sale_watch_state(e.order_number,e.raw_payload->'ebayFinance') is false)
 on conflict(order_number) do nothing;
create function public.ebay_watch_hold_list_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.ebay_watch_hold_list(new.entries,new.verified_at);return new;end$$;
create trigger ebay_watch_account_ledger after update of verified_at on public.ebay_account_holds
 for each row when (new.verified_at is distinct from old.verified_at) execute function public.ebay_watch_hold_list_changed();

create function public.maintain_ebay_report_jobs() returns void language plpgsql security definer set search_path='' as $$
declare ids text[];begin
 with due as (select w.order_number from public.ebay_report_watch w where w.active and w.next_finance<=now()
 order by w.next_finance,w.order_number limit 32 for update skip locked),
 deferred as (update public.ebay_report_watch w set next_finance=now()+interval '4 hours' from due
 where w.order_number=due.order_number returning w.order_number)
 select array_agg(order_number) into ids from deferred;
 perform public.enqueue_ebay_finance_jobs(coalesce(ids,'{}'),true);
end$$;
select cron.schedule('invsto-ebay-report-maintenance','*/5 * * * *','select public.maintain_ebay_report_jobs();');
select public.maintain_ebay_report_jobs();

create function public.claim_ebay_delivery_checks() returns text[] language sql security definer set search_path='' as $$
 with due as (select order_number from public.ebay_report_watch where active and delivery is null and next_api<=now()
 order by next_api,order_number limit 12 for update skip locked),
 reserved as (update public.ebay_report_watch w set next_api=now()+interval '6 hours' from due
 where w.order_number=due.order_number returning w.order_number) select coalesce(array_agg(order_number),'{}') from reserved
$$;
create function public.claim_ebay_browser_reports() returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=gen_random_uuid(); ids text[]; ledger boolean; stmt boolean; cm date; may_request boolean;
begin
 if auth.uid() is null or not exists(select from public.employees where user_id=auth.uid() and active and lower(role)='admin') then raise exception 'Active admin access required' using errcode='42501';end if;
 update public.ebay_report_browser_state set ticket=t,owner_id=auth.uid(),lease_until=now()+interval '12 minutes',attempted=now()
 where singleton and coalesce(lease_until,'-infinity')<now() and coalesce(attempted,'-infinity')<now()-interval '12 minutes';
 if not found then return null;end if;
 select verified_at is null or verified_at<now()-interval '6 hours' or (api_at>verified_at and api_cents<>ledger_cents) into ledger from public.ebay_account_holds;
 select coalesce(statement_attempt,'-infinity')<now()-interval '12 hours' into stmt from public.ebay_report_browser_state;
 with due as (select order_number from public.ebay_report_watch where active and delivery is null and next_browser<=now()
 order by next_browser,order_number limit 18 for update skip locked), reserved as
 (update public.ebay_report_watch w set next_browser=now()+interval '12 hours' from due where w.order_number=due.order_number returning w.order_number)
 select coalesce(array_agg(order_number),'{}') into ids from reserved;
 select c.month,coalesce(k.last_request,'-infinity')<now()-interval '2 days' into cm,may_request
 from public.weekly_ebay_account_cash c left join public.ebay_claim_report_checks k using(month)
 left join public.weekly_ebay_claim_exports x using(month)
 where c.month<date_trunc('month',now() at time zone 'America/Los_Angeles')::date
 and coalesce(k.next_at,'-infinity')<=now() and (x.month is null or (c.month>=date_trunc('month',now())::date-interval '2 months' and x.checked_at<now()-interval '4 days'))
 and exists(select from jsonb_array_elements(c.movements) m where lower(m->>'label') in ('claims','gross claims'))
 order by c.month desc limit 1;
 if cm is not null then insert into public.ebay_claim_report_checks(month,next_at) values(cm,now()+interval '2 hours')
 on conflict(month) do update set next_at=excluded.next_at;end if;
 update public.ebay_report_browser_state set reserved=ids,claim_month=cm where singleton;
 return jsonb_build_object('ticket',t,'orders',ids,'ledger',ledger,'statement',stmt,'claim_month',cm,'may_request',may_request);
end$$;
create function public.report_ebay_claim_check(_ticket uuid,_month date,_note text,_requested boolean) returns void
language plpgsql security definer set search_path='' as $$begin
 if not exists(select from public.ebay_report_browser_state where ticket=_ticket and owner_id=auth.uid() and claim_month=_month and lease_until>now()) then raise exception 'Expired claim report check';end if;
 update public.ebay_claim_report_checks set note=left(_note,200),last_request=case when _requested then now() else last_request end where month=_month;
end$$;
revoke all on function public.report_ebay_claim_check(uuid,date,text,boolean) from public,anon;
grant execute on function public.report_ebay_claim_check(uuid,date,text,boolean) to authenticated;
create function public.finish_ebay_browser_reports(_ticket uuid,_observations jsonb,_note text,_statement_note text)
returns void language plpgsql security definer set search_path='' as $$
declare ids text[];begin
 if auth.uid() is null or not exists(select from public.employees where user_id=auth.uid() and active and lower(role)='admin') then raise exception 'Active admin access required' using errcode='42501';end if;
 update public.ebay_report_browser_state set ticket=null,lease_until=null,completed=now(),note=left(_note,240),
 statement_attempt=case when _statement_note is null then statement_attempt else now() end,
 statement_note=coalesce(left(_statement_note,200),statement_note)
 where ticket=_ticket and owner_id=auth.uid() and lease_until>now() returning reserved into ids;
 if not found then raise exception 'Expired report refresh';end if;
 if jsonb_typeof(_observations) is distinct from 'array' or jsonb_array_length(_observations)>18 then raise exception 'Invalid delivery batch';end if;
 update public.ebay_report_watch w set browser_checked=now(),delivery=coalesce(w.delivery,case when r.heading ~ '^Delivered on [A-Z][a-z]{2,8} [0-9]{1,2}(, [0-9]{4})?$'
 then jsonb_build_object('description',r.heading,'checked',now(),'source','Seller Hub order page') end)
 from jsonb_to_recordset(_observations) r(id text,heading text) where w.order_number=r.id and r.id=any(ids);
end$$;
-- Keep the detailed Financial overview when the official statement becomes available:
-- compare its opening, closing and payout controls instead of losing the gross-claim detail.
create table public.ebay_verified_statements (
 month date primary key, checked_at timestamptz not null, opening bigint not null, closing bigint not null, movements jsonb not null);
alter table public.ebay_verified_statements enable row level security;
revoke all on public.ebay_verified_statements from public,anon,authenticated;
create function public.refresh_ebay_verified_statement(_month date,_opening bigint,_closing bigint,_movements jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare saved public.weekly_ebay_account_cash; matched boolean;begin
 if auth.uid() is null or not exists(select from public.employees where user_id=auth.uid() and active and lower(role)='admin') then raise exception 'Active admin access required' using errcode='42501';end if;
 if _month is null or extract(day from _month)<>1 or _month<'2000-01-01' or _month>=date_trunc('month',now() at time zone 'America/Los_Angeles')::date
 or _opening is null or _closing is null or jsonb_typeof(_movements) is distinct from 'array' or jsonb_array_length(_movements) not between 1 and 50 then raise exception 'Invalid eBay statement';end if;
 if not (select count(*)=count(distinct label) and count(*)=count(cents) and sum(cents)+_opening=_closing
 and bool_and(length(trim(label)) between 1 and 100) from jsonb_to_recordset(_movements) m(label text,cents bigint)) then raise exception 'Statement did not reconcile';end if;
 select * into saved from public.weekly_ebay_account_cash where month=_month for update;
 if saved.source is null or saved.source='eBay monthly financial statement' then
 perform public.save_ebay_cash_statement(_month,_opening,_closing,_movements);matched=true;
 else matched:=saved.opening=_opening and saved.closing=_closing and
 (select sum((v->>'cents')::bigint) from jsonb_array_elements(saved.movements) v where lower(v->>'label')='payouts') is not distinct from
 (select sum((v->>'cents')::bigint) from jsonb_array_elements(_movements) v where lower(v->>'label')='payouts');end if;
 insert into public.ebay_verified_statements values(_month,now(),_opening,_closing,_movements) on conflict(month) do update set
 checked_at=excluded.checked_at,opening=excluded.opening,closing=excluded.closing,movements=excluded.movements;
 return case when matched then 'Official statement verified: ' else 'Official statement differs from the saved overview: review ' end||to_char(_month,'Mon YYYY');
end$$;
revoke all on function public.refresh_ebay_verified_statement(date,bigint,bigint,jsonb) from public,anon;
grant execute on function public.refresh_ebay_verified_statement(date,bigint,bigint,jsonb) to authenticated;
revoke all on function public.ebay_sale_watch_state(text,jsonb),public.ebay_observe_report_funds(),public.ebay_watch_hold_list(jsonb,timestamptz),
 public.ebay_watch_hold_list_changed(),public.maintain_ebay_report_jobs(),public.claim_ebay_delivery_checks(),
 public.claim_ebay_browser_reports(),public.finish_ebay_browser_reports(uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.claim_ebay_delivery_checks() to service_role;
grant execute on function public.claim_ebay_browser_reports(),public.finish_ebay_browser_reports(uuid,jsonb,text,text) to authenticated;

create function public.ebay_report_delivery(num text) returns jsonb language sql stable set search_path='' as $$
 select delivery from public.ebay_report_watch where order_number=num
$$;
revoke all on function public.ebay_report_delivery(text) from public,anon,authenticated;
do $$declare f text:=pg_get_functiondef('public.weekly_ebay_item_payments(date,date,timestamp,jsonb)'::regprocedure);
 s text:=pg_get_functiondef('public.weekly_ebay_hold_snapshot()'::regprocedure);
begin
 if strpos(f,'public.weekly_ebay_hold_evidence(o.raw)')=0 or strpos(s,'public.weekly_ebay_hold_evidence(e.raw_payload)')=0 then raise exception 'Unexpected hold reader';end if;
 execute replace(f,'public.weekly_ebay_hold_evidence(o.raw)','(public.weekly_ebay_hold_evidence(o.raw)||jsonb_build_object(''delivery'',public.ebay_report_delivery(o.order_number)))');
 execute replace(s,'public.weekly_ebay_hold_evidence(e.raw_payload)','(public.weekly_ebay_hold_evidence(e.raw_payload)||jsonb_build_object(''delivery'',public.ebay_report_delivery(e.order_number)))');
end$$;
create function public.ebay_report_freshness(m date) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('changes',(select last_success from public.weekly_ebay_change_cursor),'payouts',(select last_success from public.weekly_ebay_payout_scan),
 'finance',(select max(last_checked_at) from public.ebay_finance_jobs where order_id is not null),
 'browser',(select jsonb_build_object('attempt',attempted,'finished',completed,'note',note,'statement_note',statement_note) from public.ebay_report_browser_state),
 'statement',(select checked_at from public.weekly_ebay_account_cash where month=m),'claims',(select checked_at from public.weekly_ebay_claim_exports where month=m),
 'claim_note',(select note from public.ebay_claim_report_checks where month=m),'watching',(select count(*) from public.ebay_report_watch where active),
 'delivered',(select count(*) from public.ebay_report_watch where active and delivery is not null))
$$;
revoke all on function public.ebay_report_freshness(date) from public,anon,authenticated;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure); marker text:='''ebay_account_holds'',';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected weekly report';end if;
 execute replace(f,marker,$s$'ebay_refresh',case when _market in ('all','ebay') then public.ebay_report_freshness(m) end,$s$||marker);
end$$;
notify pgrst,'reload schema';
commit;
