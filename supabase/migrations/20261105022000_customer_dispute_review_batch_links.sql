begin;
set local lock_timeout='3s';
do $$
declare src text:=pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text,text)'::regprocedure);
begin
  src:=replace(src,'with dispute_reviews as materialized (','with dispute_case_links as materialized (
    select id,source_lane,ebay_return_id,raw_payload#>>''{ebayDetail,returnId}'' return_id
    from public.ebay_return_cases where source_lane in (''case'',''inquiry'',''return'')
  ), dispute_eligible as materialized (
    select distinct related.id from dispute_case_links related join dispute_case_links parent
      on parent.source_lane=''case'' and (
        (related.source_lane=''inquiry'' and related.ebay_return_id=parent.ebay_return_id)
        or (related.source_lane=''return'' and related.ebay_return_id=parent.return_id))
  ), dispute_reviews as materialized (');
  src:=regexp_replace(src,'or dr.mark is not null or exists\(select 1 from public.ebay_return_cases linked[\s\S]*?=c.ebay_return_id\)\)\)',
    'or dr.mark is not null or de.id is not null');
  src:=replace(src,'left join dispute_reviews dr on dr.case_id=c.id',
    'left join dispute_reviews dr on dr.case_id=c.id left join dispute_eligible de on de.id=c.id');
  src:=replace(src,'jsonb_build_object(''eligible'',c.issue_kind',
    'coalesce(dr.mark->>''classification'',''unreviewed'') dispute_review_classification,jsonb_build_object(''eligible'',c.issue_kind');
  src:=replace(src,'dispute_review->>''classification''','dispute_review_classification');
  if strpos(src,'from public.ebay_return_cases linked')>0 or strpos(src,'or de.id is not null')=0
    or strpos(src,'with dispute_case_links as materialized')=0 or strpos(src,'dispute_review_classification,jsonb_build_object')=0 then
    raise exception 'Review the case linkage query before applying batched eligibility';
  end if;
  execute src;
end $$;
notify pgrst,'reload schema';
commit;
