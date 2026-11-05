begin;
set local lock_timeout='3s';

-- Resolve saved reviews once, instead of running a family/permission lookup for
-- every case in every count, filter and sort of the queue.
do $$
declare src text:=pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text,text)'::regprocedure);
begin
  src:=replace(src,'public.customer_issue_dispute_review(c.id) dispute_review',
    'jsonb_build_object(''eligible'',c.issue_kind=''dispute'' or c.source_lane in (''case'',''payment_dispute'')
      or dr.mark is not null or exists(select 1 from public.ebay_return_cases linked where linked.source_lane=''case''
        and ((c.source_lane=''inquiry'' and linked.ebay_return_id=c.ebay_return_id)
          or (c.source_lane=''return'' and linked.raw_payload#>>''{ebayDetail,returnId}''=c.ebay_return_id))),
      ''classification'',coalesce(dr.mark->>''classification'',''unreviewed''),''version'',dr.mark->''id'',
      ''signer_name'',dr.mark->''signer_name'',''recorded_at'',dr.mark->''recorded_at'') dispute_review');
  src:=replace(src,'from public.ebay_return_cases c',
    'from public.ebay_return_cases c left join dispute_reviews dr on dr.case_id=c.id');
  src:=replace(src,'with task_rows as (','with dispute_reviews as materialized (
    select distinct on (family.value) family.value::uuid case_id,to_jsonb(m) mark
    from (select distinct on (case_id) * from public.customer_dispute_classifications
      order by case_id,recorded_at desc,id desc) m
    cross join lateral jsonb_array_elements_text(public.customer_issue_dispute_review(m.case_id)->''family_ids'') family(value)
    order by family.value,m.recorded_at desc,m.id desc
  ), task_rows as (');
  if strpos(src,'public.customer_issue_dispute_review(c.id)')>0
    or strpos(src,'with dispute_reviews as materialized')=0 or strpos(src,'left join dispute_reviews dr')=0 then
    raise exception 'Review the current issue queue before optimizing dispute classifications';
  end if;
  execute src;
end $$;
notify pgrst,'reload schema';
commit;
