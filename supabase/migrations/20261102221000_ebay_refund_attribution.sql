begin;
-- Match requestors to the store's registered cancellations by eBay's cancellation ID.
create table public.ebay_cancel_requestors (
 case_id text primary key, actor text not null check(actor in ('BUYER','SELLER','EBAY','SYSTEM')),
 requested_at timestamptz, close_reason text, verified_at timestamptz not null default now()
);
create table public.ebay_requestor_checks (
 month date primary key, checked timestamptz, due timestamptz not null default now(), error text
);
alter table public.ebay_cancel_requestors enable row level security;
alter table public.ebay_requestor_checks enable row level security;
revoke all on public.ebay_cancel_requestors,public.ebay_requestor_checks from public,anon,authenticated;

create function public.next_ebay_requestor_month() returns date language plpgsql security definer set search_path='' as $$
begin
 insert into public.ebay_requestor_checks(month)
 select distinct date_trunc('month',requested)::date from public.ebay_health_cases where requested>=current_date-interval '8 months' on conflict do nothing;
 return (select month from public.ebay_requestor_checks where due<=now() and month>=date_trunc('month',current_date-interval '8 months')
   order by due,month desc limit 1);
end$$;
create function public.save_ebay_requestors(_ticket uuid,_month date,_rows jsonb,_error text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select from public.ebay_finance_worker where singleton and dispatch_token=_ticket and lease_until>now() and claimed_at is not null)
 then raise exception 'Expired finance worker';end if;
 if jsonb_array_length(_rows)>0 then
  insert into public.ebay_cancel_requestors as a(case_id,actor,requested_at,close_reason)
  select r.id,r.actor,r.requested_at,r.close_reason from jsonb_to_recordset(_rows) r(id text,actor text,requested_at timestamptz,close_reason text)
  join public.ebay_health_cases c on c.id=r.id
  on conflict(case_id) do update set actor=excluded.actor,requested_at=coalesce(excluded.requested_at,a.requested_at),close_reason=excluded.close_reason,verified_at=now();
 end if;
 update public.ebay_requestor_checks set checked=case when _error is null then now() else checked end,error=left(_error,200),
 due=now()+case when _error is not null then interval '2 hours' when _month>=date_trunc('month',current_date) then interval '4 hours' else interval '7 days' end where month=_month;
end$$;
revoke all on function public.next_ebay_requestor_month(),public.save_ebay_requestors(uuid,date,jsonb,text) from public,anon,authenticated;
grant execute on function public.next_ebay_requestor_month(),public.save_ebay_requestors(uuid,date,jsonb,text) to service_role;

-- Finances can also signal recent refunds on purchases outside the rolling sales history.
-- Only Seller Hub entries typed as Refund supply amounts. A finance signal just schedules verification.
create function public.queue_ebay_refund_order_checks(_ticket uuid,_entries jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select from public.ebay_finance_worker where singleton and dispatch_token=_ticket and lease_until>now() and claimed_at is not null)
 then raise exception 'Expired finance worker';end if;
 insert into public.ebay_health_jobs as j(kind,id) select distinct 'payments',e.id from jsonb_to_recordset(_entries) e(id text,posted timestamptz)
 where e.id~'^[0-9]{2}-[0-9]{5}-[0-9]{5}$' and not exists(select from public.ebay_health_jobs done where done.kind='payments' and done.id=e.id and done.verified>=e.posted)
 on conflict(kind,id) do update set due=least(now(),j.due);
end$$;
revoke all on function public.queue_ebay_refund_order_checks(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.queue_ebay_refund_order_checks(uuid,jsonb) to service_role;

create function public.ebay_health_actor_evidence() returns jsonb language sql stable set search_path='' as $$
 with cohort as materialized (select id from public.ebay_health_orders where purchased >= current_date-interval '8 months 2 days'),
 reqs as (
  select o.order_number oid,r->>'cancelRequestId' id,r->>'cancelInitiator' actor,'Fulfillment cancellation request' src,r->>'cancelRequestedDate' requested_at from cohort h
  join public.ebay_orders o on h.id=o.order_number cross join lateral jsonb_array_elements(
   case when jsonb_typeof(o.raw_payload#>'{order,cancelStatus,cancelRequests}')='array' then o.raw_payload#>'{order,cancelStatus,cancelRequests}' else '[]' end) r
  where r->>'cancelInitiator' in ('BUYER','SELLER','EBAY','SYSTEM') and r->>'cancelRequestId' is not null
  union all select null,case_id,actor,'eBay cancellation register API',requested_at::text from public.ebay_cancel_requestors
 ), issues as materialized (
  select c.order_number oid,c.ebay_return_id id,c.source_lane lane,c.raw_payload->'ebayDetail' d
  from public.ebay_return_cases c join cohort h on h.id=c.order_number
  where c.source_lane in ('case','return') and c.ebay_return_id is not null
 ), returns as (
  select oid,id,d#>>'{refundInfo,actualRefundDetail,refundInitiationType}' initiator,
  d#>>'{refundInfo,actualRefundDetail,refundIssuedDate,value}' issued,
  (select jsonb_agg(jsonb_build_object('action',v->>'activity','actor',v->>'author','date',v#>>'{creationDate,value}'))
   from jsonb_array_elements(case when jsonb_typeof(d->'responseHistory')='array' then d->'responseHistory' else '[]' end) v
   where v->>'activity' in ('SELLER_ISSUE_REFUND','SYSTEM_INITIATED_REFUND','BUYER_ESCALATE','SELLER_ESCALATE')) history
  from issues where lane='return' and d is not null
 ), decisions as (
  select oid,id,d->>'returnId' return_id,d->>'sellerOutcome' outcome,
   d->>'status'='CS_CLOSED' or exists(select from jsonb_array_elements(case when jsonb_typeof(d#>'{caseHistoryDetails,history}')='array'
   then d#>'{caseHistoryDetails,history}' else '[]' end) ev where ev->>'actor' in ('CSR','EBAY')
    and ev->>'action' in ('Claim was resolved.','Appeal has been closed.')) as decided
  from issues where lane='case' and d->>'caseId'=id
 )
 select jsonb_build_object('requests',coalesce((select jsonb_agg(to_jsonb(r)) from reqs r),'[]'),
 'returns',coalesce((select jsonb_agg(to_jsonb(r)) from returns r),'[]'),
 'cases',coalesce((select jsonb_agg(to_jsonb(r)) from decisions r),'[]'),
 'payment_times',coalesce((select jsonb_object_agg(o.order_number,o.paid_on_date)
 from public.ebay_orders o join cohort h on h.id=o.order_number where o.paid_on_date is not null and exists
 (select from public.ebay_health_orders ho where ho.id=o.order_number and (ho.status='Canceled' or exists(select from public.ebay_health_cases hc where hc.linked_order=ho.id)))),'{}'),
 'older_refunds',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('purchased',o.sale_date))
 from public.ebay_health_refunds p left join public.ebay_orders o on o.order_number=p.order_id
 where p.day >=current_date-interval '8 months 2 days' and not exists(select from cohort h where h.id=p.order_id)),'[]'),
 'requestor_checks',coalesce((select jsonb_agg(jsonb_build_object('month',month,'checked',checked,'error',error)) from public.ebay_requestor_checks),'[]'));
$$;
revoke all on function public.ebay_health_actor_evidence() from public,anon,authenticated;
alter function public.ebay_health_report() rename to ebay_health_report_before_actors;
revoke all on function public.ebay_health_report_before_actors() from public,anon,authenticated;
create function public.ebay_health_report() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform public.require_ebay_health_admin();
 return public.ebay_health_report_before_actors() || jsonb_build_object('evidence',public.ebay_health_actor_evidence());
end$$;
revoke all on function public.ebay_health_report() from public,anon,authenticated;
grant execute on function public.ebay_health_report() to authenticated;
commit;
notify pgrst,'reload schema';
