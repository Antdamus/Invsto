begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create or replace function public.customer_issue_evidence(_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.ebay_return_cases; lines uuid[]; pack jsonb; result jsonb;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 select * into c from public.ebay_return_cases where id=_case_id;
 if not found then raise exception 'Case not found';end if;
 lines:=public.customer_issue_order_line_ids(c.id);
 if c.order_id is not null then pack:=public.packaging_detail(null,array[c.order_id]);end if;
 select jsonb_build_object('case',jsonb_build_object('id',c.id,'ebay_return_id',c.ebay_return_id,'source_lane',c.source_lane,
  'buyer_username',c.buyer_username,'order_number',c.order_number,'ebay_status',c.ebay_status,'ebay_due_at',c.ebay_due_at,'synced_at',c.synced_at,'return_reason',c.return_reason),
 'orders',coalesce(pack->'orders','[]'),
 'lines',coalesce((select jsonb_agg(l) from jsonb_array_elements(coalesce(pack->'lines','[]')) l where (l->>'id')::uuid=any(lines)),'[]'),
 'bag_photos',coalesce((select jsonb_agg(p) from jsonb_array_elements(coalesce(pack->'bag_photos','[]')) p where exists(select 1 from jsonb_array_elements_text(p->'order_line_ids') x where x::uuid=any(lines))),'[]'),
 'reference_events',coalesce(pack->'reference_events','[]'),'completion_events',coalesce(pack->'completion_events','[]'),
 'return_photos',coalesce((select jsonb_agg(photo) from (
  select p||jsonb_build_object('created_at',e.created_at) photo from public.ebay_return_events e cross join lateral jsonb_array_elements(e.evidence_photos) p where e.return_case_id=c.id
  union all select p||jsonb_build_object('created_at',e.created_at) from public.ebay_return_task_events e cross join lateral jsonb_array_elements(e.photo_attachments) p where e.return_case_id=c.id) photos),'[]'),
 'packages',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'tracking_code',p.tracking_code,'status',p.status,'updated_at',p.updated_at)) from public.packaging_shipments p where c.order_id=any(p.order_ids) and p.status<>'cancelled'),'[]'),
 'packaging_photos',coalesce((select jsonb_agg(jsonb_build_object('bucket',e.bucket,'path',e.path,'mime_type',e.mime_type,'media_type',e.media_type,'label',e.label,'created_at',e.created_at)) from public.packaging_evidence e join public.packaging_shipments p on p.id=e.shipment_id where c.order_id=any(p.order_ids) and p.status<>'cancelled' and e.removed_at is null),'[]'),
 'certificates',coalesce((select jsonb_agg(jsonb_build_object('order_line_id',q.order_line_id,'certificate_url',q.certificate_url,'report_number',q.report_number,'watch_serial',q.watch_serial,'attachments',q.attachments)) from public.ebay_order_line_certificates q where q.order_line_id=any(lines) and q.voided_at is null),'[]'),
 -- Inquiry/escalation history is already persisted in the full provider detail.
 -- Project only public case activity; never include our internal staff updates.
 'case_history',coalesce((select jsonb_agg(h.entry order by h.when_text desc nulls last,h.ordinality desc) from (
  select jsonb_build_object('actor',e->>'actor','action',e->>'action','description',e->>'description',
   'date',coalesce(e#>>'{date,value}',case when jsonb_typeof(e->'date')='string' then e->>'date' end)) entry,
   coalesce(e#>>'{date,value}',case when jsonb_typeof(e->'date')='string' then e->>'date' end) when_text,ordinality
  from jsonb_array_elements(case
   when c.source_lane='inquiry' and c.raw_payload#>>'{ebayDetail,inquiryId}'=c.ebay_return_id
    and jsonb_typeof(c.raw_payload#>'{ebayDetail,inquiryHistoryDetails,history}')='array'
    then c.raw_payload#>'{ebayDetail,inquiryHistoryDetails,history}'
   when c.source_lane='case' and c.raw_payload#>>'{ebayDetail,caseId}'=c.ebay_return_id
    and jsonb_typeof(c.raw_payload#>'{ebayDetail,caseHistoryDetails,history}')='array'
    then c.raw_payload#>'{ebayDetail,caseHistoryDetails,history}'
   else '[]'::jsonb end) with ordinality as h(e,ordinality)
  where jsonb_typeof(e)='object' order by when_text desc nulls last,ordinality desc limit 501
 ) h),'[]'),
 'case_messages',coalesce((select jsonb_agg(to_jsonb(m)) from (select direction,message_body,sent_at,message_status from public.ebay_return_messages where return_case_id=c.id and direction<>'internal' and message_status in ('sent','imported') order by sent_at desc limit 501) m),'[]'),
 'buyer_messages',coalesce((select jsonb_agg(to_jsonb(m)) from (select m.id,m.sender_username,m.direction,m.message_body,m.created_at_ebay from public.ebay_conversation_messages m join public.ebay_conversations v on v.id=m.conversation_id
 where lower(v.other_party_username)=lower(c.buyer_username) and v.conversation_type='FROM_MEMBERS' and (v.reference_id=c.order_number or exists(select 1 from public.ebay_order_lines l where l.id=any(lines) and l.item_number=v.reference_id))
 order by m.created_at_ebay desc limit 501) m),'[]')) into result;
 return result;
end $$;
revoke all on function public.customer_issue_evidence(uuid) from public,anon;
grant execute on function public.customer_issue_evidence(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
