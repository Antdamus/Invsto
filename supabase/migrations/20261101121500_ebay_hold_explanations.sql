begin;
set local lock_timeout='8s';
-- Only the evidence needed to explain a hold; never buyer identity or account credentials.
create function public.weekly_ebay_hold_evidence(_raw jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('finance',jsonb_build_object(
 'source',_raw#>>'{ebayFinance,source}','orderNumber',_raw#>>'{ebayFinance,orderNumber}',
 'syncedAt',_raw#>>'{ebayFinance,syncedAt}',
 'transactions',coalesce((select jsonb_agg(jsonb_build_object('orderNumber',t->>'orderNumber','transactionType',t->>'transactionType',
 'bookingEntry',t->>'bookingEntry','transactionStatus',t->>'transactionStatus','memo',t->>'memo'))
 from jsonb_array_elements(case when jsonb_typeof(_raw#>'{ebayFinance,transactions}')='array' then _raw#>'{ebayFinance,transactions}' else '[]' end) t
 where t->>'transactionType'='SALE' and t->>'bookingEntry'='CREDIT'),'[]')),
 'payments',coalesce((select jsonb_agg(jsonb_build_object('paymentHolds',p->'paymentHolds'))
 from jsonb_array_elements(case when jsonb_typeof(_raw#>'{order,paymentSummary,payments}')='array' then _raw#>'{order,paymentSummary,payments}' else '[]' end) p where jsonb_typeof(p->'paymentHolds')='array'),'[]'),
 'modified',_raw#>>'{order,lastModifiedDate}')
$$;
revoke all on function public.weekly_ebay_hold_evidence(jsonb) from public,anon,authenticated;

do $$declare f text:=pg_get_functiondef('public.weekly_ebay_item_payments(date,date,timestamp,jsonb)'::regprocedure);
 marker text:='''held'',o.held,';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected item payments report';end if;
 execute replace(f,marker,marker||'''hold_detail'',case when o.fund in (''held'',''mixed'') then public.weekly_ebay_hold_evidence(o.raw) end,');
end$$;

-- Enrich the saved all-month Seller Hub list on read. Keep its verified amounts
-- and snapshot time intact, even if a newer payment record has changed since then.
create function public.weekly_ebay_hold_snapshot() returns jsonb
language sql stable set search_path='' as $$
 select (to_jsonb(h)-'singleton'-'next_api_at')||jsonb_build_object('entries',
 case when h.entries is null then null else coalesce((select jsonb_agg(r||case when r->>'kind'='sale' then
 jsonb_build_object('hold_detail',public.weekly_ebay_hold_evidence(e.raw_payload)) else '{}' end order by n)
 from jsonb_array_elements(h.entries) with ordinality x(r,n)
 left join public.ebay_orders e on e.order_number=r->>'oid'),'[]') end)
 from public.ebay_account_holds h where h.singleton
$$;
revoke all on function public.weekly_ebay_hold_snapshot() from public,anon,authenticated;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='(select to_jsonb(h)-''singleton''-''next_api_at'' from public.ebay_account_holds h where singleton)';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected account hold report';end if;
 execute replace(f,marker,'public.weekly_ebay_hold_snapshot()');
end$$;
notify pgrst,'reload schema';
commit;
