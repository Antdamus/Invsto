begin;
set local lock_timeout = '3s';

-- Our review of a dispute is separate from eBay's outcome and task completion.
-- Keep every signed change, including a later return to Unreviewed.
create table public.customer_dispute_classifications (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.ebay_return_cases(id) on delete cascade,
  classification text not null check (classification in ('fair','unfair','unreviewed')),
  signed_by uuid not null,
  signer_name text not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index customer_dispute_classifications_latest on public.customer_dispute_classifications(case_id,recorded_at desc,id desc);
alter table public.customer_dispute_classifications enable row level security;
create policy dispute_classification_staff_read on public.customer_dispute_classifications
  for select to authenticated using ((select public.can_access_post_order_issues()));
revoke all on public.customer_dispute_classifications from public,anon,authenticated;
grant select on public.customer_dispute_classifications to authenticated;

create function public.customer_issue_dispute_review(_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare family uuid[]; eligible boolean; mark public.customer_dispute_classifications;
begin
  if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then
    raise exception 'Customer issues access required' using errcode='42501';
  end if;
  select array_agg(c.id order by c.id),bool_or(c.issue_kind='dispute' or c.source_lane in ('case','payment_dispute'))
    into family,eligible from public.ebay_return_cases c
    where c.id in (select public.customer_issue_history_family(_case_id));
  if family is null then raise exception 'Case not found'; end if;
  select * into mark from public.customer_dispute_classifications
    where case_id=any(family) order by recorded_at desc,id desc limit 1;
  return jsonb_build_object('eligible',coalesce(eligible,false),'family_ids',family,
    'classification',coalesce(mark.classification,'unreviewed'),'version',mark.id,
    'signer_name',mark.signer_name,'recorded_at',mark.recorded_at);
end $$;
revoke all on function public.customer_issue_dispute_review(uuid) from public,anon;
grant execute on function public.customer_issue_dispute_review(uuid) to authenticated;

create function public.set_customer_dispute_classification(_case_id uuid,_classification text,_expected_version uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare family uuid[]; previous jsonb; signer text;
begin
  if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then
    raise exception 'Customer issues access required' using errcode='42501';
  end if;
  if _classification is null or _classification not in ('fair','unfair','unreviewed') then
    raise exception 'Choose Fair, Unfair or Unreviewed';
  end if;
  select array_agg(c.id order by c.id) into family from public.ebay_return_cases c
    where c.id in (select public.customer_issue_history_family(_case_id));
  perform 1 from public.ebay_return_cases where id=any(family) order by id for update;
  previous:=public.customer_issue_dispute_review(_case_id);
  if not (previous->>'eligible')::boolean then raise exception 'Select a dispute or its linked customer issue'; end if;
  if previous->>'classification'=_classification then return previous; end if;
  if (previous->>'version')::uuid is distinct from _expected_version then
    raise exception 'Another worker classified this dispute. Refresh it before changing the review.';
  end if;
  select coalesce(nullif(btrim(e.display_name),''),e.email) into signer
    from public.employees e where e.user_id=auth.uid() limit 1;
  insert into public.customer_dispute_classifications(case_id,classification,signed_by,signer_name)
    values(_case_id,_classification,auth.uid(),coalesce(signer,auth.jwt()->>'email',auth.uid()::text));
  return public.customer_issue_dispute_review(_case_id);
end $$;
revoke all on function public.set_customer_dispute_classification(uuid,text,uuid) from public,anon;
grant execute on function public.set_customer_dispute_classification(uuid,text,uuid) to authenticated;

-- Apply classification before pagination and counts. Exact linked request/case
-- records share one review; other disputes on the same order remain independent.
-- The older signatures remain available to already-open pages.
do $$
declare src text:=pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text)'::regprocedure);
begin
  src:=replace(src,'_money_filter text)','_money_filter text, _dispute_review_filter text)');
  src:=replace(src,'c.id,c.source_lane','public.customer_issue_dispute_review(c.id) dispute_review,c.id,c.source_lane');
  src:=replace(src,'scoped as (','scope_base as (');
  src:=replace(src,'classified as (','scoped as (
    select * from scope_base where case when _dispute_review_filter=''all'' then true
      when _dispute_review_filter in (''fair'',''unfair'') then dispute_review->>''classification''=_dispute_review_filter
      else coalesce(dispute_review->>''classification'',''unreviewed'')=''unreviewed'' end
  ), classified as (');
  if strpos(src,'_dispute_review_filter text)')=0 or strpos(src,'dispute_review,c.id')=0
    or strpos(src,'select * from scope_base where case')=0 then
    raise exception 'Review the current issue queue before adding dispute classification';
  end if;
  execute src;
end $$;
revoke all on function public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text,text) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
