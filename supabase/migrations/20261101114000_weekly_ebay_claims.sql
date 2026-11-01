begin;
set local lock_timeout='8s';
-- One replaceable Seller Hub snapshot per posting month. Only claim rows are retained.
create table public.weekly_ebay_claim_exports (
 month date primary key check(extract(day from month)=1), entries jsonb not null,
 checked_at timestamptz not null default now()
);
alter table public.weekly_ebay_claim_exports enable row level security;
revoke all on public.weekly_ebay_claim_exports from public,anon,authenticated;

create function public.store_ebay_claim_export(_month date,_entries jsonb) returns void
language plpgsql set search_path='' as $$
declare gross bigint;net bigint;target bigint;basis text;begin
 if _month is null or extract(day from _month)<>1 or jsonb_typeof(_entries) is distinct from 'array'
 or jsonb_array_length(_entries)>10000 then raise exception 'Invalid claim export';end if;
 if exists(select 1 from jsonb_to_recordset(_entries) as x(day date,id text,ref text,kind text,gross bigint,net bigint,fees bigint)
 where day is null or day<_month or day>=_month+interval '1 month' or id is null or id!~'^[0-9]{2}-[0-9]{5}-[0-9]{5}$'
 or x.gross is null or x.net is null or fees is null or (ref is not null and ref!~'^[0-9]{5,25}$')
 or (kind is not null and kind not in ('Case','Request','Return')) or (ref is null)<>(kind is null))
 then raise exception 'Unexpected claim row';end if;
 select sum(x.gross),sum(x.net) into gross,net from jsonb_to_recordset(_entries) as x(gross bigint,net bigint);
 select m->>'label',(m->>'cents')::bigint into basis,target from public.weekly_ebay_account_cash c,
 lateral jsonb_array_elements(c.movements) m where c.month=_month and (lower(m->>'label')='gross claims'
 or (c.source='eBay monthly financial statement' and lower(m->>'label')='claims')) order by (lower(m->>'label')='gross claims') desc limit 1;
 if target is null then raise exception 'First add the eBay monthly statement with a claims total.';end if;
 if target is distinct from (case when lower(basis)='claims' then coalesce(net,0) else coalesce(gross,0) end)
 then raise exception 'Claim entries do not match the eBay statement. Use the complete transaction export for this month.';end if;
 insert into public.weekly_ebay_claim_exports(month,entries) values(_month,_entries)
 on conflict(month) do update set entries=excluded.entries,checked_at=now();
end$$;
revoke all on function public.store_ebay_claim_export(date,jsonb) from public,anon,authenticated;
create function public.save_ebay_claim_export(_month date,_entries jsonb) returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin')
 then raise exception 'Active admin access required' using errcode='42501';end if;
 perform public.store_ebay_claim_export(_month,_entries);
end$$;
revoke all on function public.save_ebay_claim_export(date,jsonb) from public,anon;
grant execute on function public.save_ebay_claim_export(date,jsonb) to authenticated;

-- Match the posted reference AND order before attributing a cause. A credit without
-- a reference is real money, but an issue on that order does not prove its cause.
create function public.weekly_ebay_claim_details(_month date) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_agg(jsonb_build_object('id',x.id,'day',x.day,'gross',x.gross,'net',x.net,'fees',x.fees,
 'kind',x.kind,'ref',x.ref,'issue',c.id,'type',case when c.source_lane='inquiry' then 'ITEM_NOT_RECEIVED'
 when c.source_lane='return' then 'RETURN' else c.raw_payload#>>'{ebayDetail,caseType}' end,
 'reason',case when c.source_lane='inquiry' then c.raw_payload#>>'{ebayDetail,creationReason}'
 when c.source_lane='return' then c.return_reason else child.return_reason end,
 'status',c.ebay_status,'seller',c.raw_payload#>>'{ebayDetail,sellerOutcome}','buyer',c.raw_payload#>>'{ebayDetail,buyerOutcome}',
 'opened',c.opened_at,'title',coalesce(c.item_title,(select string_agg(distinct l.item_title,' · ' order by l.item_title)
 from public.ebay_order_lines l where l.order_id=e.id)), 'cancellation',coalesce(nullif(u.changes->>'orderCancelStatus',''),
 e.raw_payload#>>'{order,cancelStatus,cancelState}',e.raw_payload->>'orderCancelStatus'),
 'other_order',mis.order_number,'other_issue',mis.id,'other_type',mis.typ,'other_seller',mis.seller,
 'related',case when x.ref is null then (select jsonb_agg(jsonb_build_object('issue',rc.id,'ref',rc.ebay_return_id,'lane',rc.source_lane)
 order by rc.source_lane,rc.id) from public.ebay_return_cases rc where rc.order_number=x.id and rc.source_lane in ('case','payment_dispute')) end)
 order by x.day desc,x.id,x.gross) from public.weekly_ebay_claim_exports b,
 lateral jsonb_to_recordset(b.entries) x(day date,id text,ref text,kind text,gross bigint,net bigint,fees bigint)
 left join public.ebay_orders e on e.order_number=x.id
 left join public.weekly_ebay_sale_updates u on u.order_number=x.id
 left join lateral (select a.* from public.ebay_return_cases a where a.order_number=x.id and a.ebay_return_id=x.ref
 and a.source_lane=case x.kind when 'Case' then 'case' when 'Request' then 'inquiry' when 'Return' then 'return' end
 and (case a.source_lane when 'case' then a.raw_payload#>>'{ebayDetail,caseId}' when 'inquiry' then a.raw_payload#>>'{ebayDetail,inquiryId}' else a.raw_payload#>>'{ebayDetail,returnId}' end)=x.ref
 order by a.synced_at desc nulls last,a.id limit 1) c on true
 left join lateral (select a.return_reason from public.ebay_return_cases a where c.source_lane='case' and a.source_lane='return'
 and a.ebay_return_id=c.raw_payload#>>'{ebayDetail,returnId}' and a.order_number=x.id order by a.synced_at desc nulls last,a.id limit 1) child on true
 left join lateral (select a.id,a.order_number,a.raw_payload#>>'{ebayDetail,caseType}' typ,a.raw_payload#>>'{ebayDetail,sellerOutcome}' seller
 from public.ebay_return_cases a where a.ebay_return_id=x.ref and a.order_number<>x.id
 and a.source_lane=case x.kind when 'Case' then 'case' when 'Request' then 'inquiry' when 'Return' then 'return' end
 order by a.synced_at desc nulls last,a.id limit 1) mis on c.id is null
 where b.month=_month
$$;
revoke all on function public.weekly_ebay_claim_details(date) from public,anon,authenticated;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure); marker text:='''ebay_cash_statement'',';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected cash report';end if;
 execute replace(f,marker,$add$'ebay_claims',case when _market in ('ebay','all') then (select jsonb_build_object(
 'checked',b.checked_at,'rows',coalesce(public.weekly_ebay_claim_details(m),'[]'::jsonb))
 from public.weekly_ebay_claim_exports b where b.month=m) end,$add$||marker);
end$$;
notify pgrst,'reload schema';
commit;
