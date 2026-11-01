begin;
create table public.weekly_ebay_earnings_auth (
 state uuid primary key default gen_random_uuid(),actor uuid not null,expires_at timestamptz not null default now()+interval '15 minutes'
);
create table public.weekly_ebay_earnings_sync (
 singleton boolean primary key default true check(singleton), credential text, actor uuid, connected_at timestamptz,
 next_at timestamptz not null default now(), lease uuid,lease_until timestamptz,claimed boolean not null default false,
 stop_at timestamptz, window_end timestamptz, page_offset integer not null default 0,
 last_success timestamptz,last_error text
);
insert into public.weekly_ebay_earnings_sync(singleton) values(true);
create table public.weekly_ebay_order_earnings (
 order_number text primary key, purchased_at timestamptz not null, earnings numeric(14,2) not null,
 gross numeric(14,2), expenses numeric(14,2), refunds numeric(14,2), labels numeric(14,2), checked_at timestamptz not null
);
alter table public.weekly_ebay_earnings_auth enable row level security;
alter table public.weekly_ebay_earnings_sync enable row level security;
alter table public.weekly_ebay_order_earnings enable row level security;
revoke all on public.weekly_ebay_earnings_auth,public.weekly_ebay_earnings_sync,public.weekly_ebay_order_earnings from public,anon,authenticated;
grant select,insert,update,delete on public.weekly_ebay_earnings_auth,public.weekly_ebay_earnings_sync,public.weekly_ebay_order_earnings to service_role;
create function public.dispatch_weekly_ebay_earnings() returns void language plpgsql security definer set search_path='' as $$
declare ticket uuid:=gen_random_uuid();begin
 update public.weekly_ebay_earnings_sync set lease=ticket,lease_until=now()+interval '2 minutes',claimed=false
 where singleton and credential is not null and next_at<=now() and (lease_until is null or lease_until<=now());
 if not found then return;end if;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-weekly-earnings',headers:='{"Content-Type":"application/json"}'::jsonb,body:=jsonb_build_object('ticket',ticket),timeout_milliseconds:=65000);
end$$;
revoke all on function public.dispatch_weekly_ebay_earnings() from public,anon,authenticated;
grant execute on function public.dispatch_weekly_ebay_earnings() to service_role;
-- An official order-earnings total includes marketplace fees, refunds and eBay postage.
-- Use it once per order in preference to the independently summed transactions.
do $$declare f text:=pg_get_functiondef('public.weekly_sales_proceeds(date,date)'::regprocedure);
 old text:='case when e.complete then e.balance else least(coalesce(e.balance,0),0) end,e.complete from evidence e';begin
 if strpos(f,old)=0 then raise exception 'Unexpected transaction reconciliation';end if;
 execute replace(f,old,'case when official.order_number is not null then official.earnings when e.complete then e.balance else least(coalesce(e.balance,0),0) end,e.complete or official.order_number is not null from evidence e
 left join public.weekly_ebay_order_earnings official on official.order_number=e.order_number and official.checked_at>=statement_timestamp()-interval ''7 days''');
end$$;
-- A newly reported refund may precede the order or returns feed. Hold any
-- balance whose merchandise portion cannot yet be separated from shipping or tax.
do $$declare f text:=pg_get_functiondef('public.weekly_sales_order_rows(date,date)'::regprocedure);begin
 if strpos(f,'c.item_amount,c.checkout_amount,c.unknown,pr.buyer_refund')=0 then raise exception 'Unexpected refund calculation';end if;
 f:=replace(f,'c.item_amount,c.checkout_amount,c.unknown,pr.buyer_refund','abs(earn.refunds) as earnings_refund,c.item_amount,c.checkout_amount,c.unknown,pr.buyer_refund');
 f:=replace(f,'left join case_totals c using(id)','left join case_totals c using(id) left join public.weekly_ebay_order_earnings earn on earn.order_number=o.order_number and earn.checked_at>=statement_timestamp()-interval ''7 days''');
 f:=replace(f,'greatest(buyer_refund,checkout_amount)>=checkout','greatest(buyer_refund,checkout_amount,earnings_refund)>=checkout');
 f:=replace(f,'when buyer_refund is not null and checkout=gross and cn=0 then least(gross,buyer_refund)','when greatest(buyer_refund,earnings_refund) is not null and checkout=gross and cn=0 then least(gross,greatest(buyer_refund,earnings_refund))');
 f:=replace(f,'e.missing or (e.gross>e.cn+e.refund_amount','e.missing or coalesce(e.gross>e.cn+e.refund_amount and e.earnings_refund>greatest(e.refund_amount,e.checkout_amount,e.buyer_refund),false) or (e.gross>e.cn+e.refund_amount');
 execute f;
end$$;
notify pgrst,'reload schema';
commit;
