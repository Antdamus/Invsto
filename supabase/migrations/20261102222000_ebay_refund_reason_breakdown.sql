begin;
alter function public.ebay_health_actor_evidence() rename to ebay_health_actor_evidence_v1;
create function public.ebay_health_actor_evidence() returns jsonb language sql stable set search_path='' as $$
 select public.ebay_health_actor_evidence_v1()||jsonb_build_object('return_reasons',coalesce((
 select jsonb_agg(jsonb_build_object('oid',c.order_number,'id',c.ebay_return_id,'reason',c.return_reason))
 from public.ebay_return_cases c where c.source_lane='return' and nullif(trim(c.return_reason),'') is not null
 and exists(select from public.ebay_health_refunds t where t.order_id=c.order_number and t.reference='Return ID '||c.ebay_return_id and t.day>=current_date-interval '9 months')
 ),'[]'), 'all_decisions',coalesce((
 select jsonb_agg(jsonb_build_object('oid',c.order_number,'id',c.ebay_return_id,'purchase',o.sale_date,
  'decided_at',resolution.stamp,'outcome',c.raw_payload#>>'{ebayDetail,sellerOutcome}'))
 from public.ebay_return_cases c left join public.ebay_orders o on o.order_number=c.order_number
 cross join lateral (select min(h#>>'{date,value}') as stamp from jsonb_array_elements(
 case when jsonb_typeof(c.raw_payload#>'{ebayDetail,caseHistoryDetails,history}')='array'
 then c.raw_payload#>'{ebayDetail,caseHistoryDetails,history}' else '[]' end) h
 where h->>'action'='Claim was resolved.' and h->>'actor' in ('CSR','EBAY')) resolution
 where c.source_lane='case' and c.raw_payload#>>'{ebayDetail,caseId}'=c.ebay_return_id
 and (resolution.stamp is not null or c.raw_payload#>>'{ebayDetail,status}'='CS_CLOSED')
 and (o.sale_date>=current_date-interval '9 months' or resolution.stamp>=(current_date-interval '9 months')::date::text)
 ),'[]'));
$$;
revoke all on function public.ebay_health_actor_evidence() from public,anon,authenticated;
commit;
notify pgrst,'reload schema';
