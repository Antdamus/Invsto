begin;
set local lock_timeout = '3s';

-- Staff confirmations are independent of eBay's refund status and return intake.
create table public.customer_return_money_marks (
  case_id uuid not null references public.ebay_return_cases(id) on delete cascade,
  revision integer not null check (revision > 0),
  marked boolean not null,
  signed_by uuid not null,
  signer_name text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (case_id, revision)
);
alter table public.customer_return_money_marks enable row level security;
create policy money_marks_staff_read on public.customer_return_money_marks
  for select to authenticated using ((select public.can_access_post_order_issues()));
revoke all on public.customer_return_money_marks from public, anon, authenticated;
grant select on public.customer_return_money_marks to authenticated;

create function public.set_customer_return_money_mark(_case_id uuid, _marked boolean, _expected_revision integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  previous public.customer_return_money_marks;
  signer text;
begin
  if auth.uid() is null or not coalesce(public.can_access_post_order_issues(), false) then
    raise exception 'Customer issues access required' using errcode='42501';
  end if;
  if _marked is null or _expected_revision is null or _expected_revision < 0 then
    raise exception 'Choose a valid return mark';
  end if;
  perform 1 from public.ebay_return_cases
    where id = _case_id and issue_kind = 'return' for update;
  if not found then raise exception 'Select a physical return'; end if;

  select * into previous from public.customer_return_money_marks
    where case_id = _case_id order by revision desc limit 1;
  if previous.marked = _marked then return to_jsonb(previous); end if;
  if _expected_revision <> coalesce(previous.revision, 0) then
    raise exception 'Another worker updated this mark. Refresh the return before changing it.';
  end if;
  if previous.revision is null and not _marked then return null; end if;
  select coalesce(nullif(btrim(e.display_name),''), e.email) into signer
    from public.employees e where e.user_id = auth.uid() limit 1;
  insert into public.customer_return_money_marks(case_id, revision, marked, signed_by, signer_name)
    values (_case_id, _expected_revision + 1, _marked, auth.uid(),
      coalesce(signer, auth.jwt()->>'email', auth.uid()::text))
    returning * into previous;
  return to_jsonb(previous);
end $$;
revoke all on function public.set_customer_return_money_mark(uuid,boolean,integer) from public, anon;
grant execute on function public.set_customer_return_money_mark(uuid,boolean,integer) to authenticated;

-- Extend the current queue query before sorting, pagination and stage counts.
-- Keep its older signatures available for pages already open.
do $$
declare
  src text := pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text)'::regprocedure);
  predicate text := '(_money_filter = ''all'' or (_money_filter = ''marked'') = coalesce((money_mark->>''marked'')::boolean,false))';
begin
  src := replace(src, '_dispute_state text)', '_dispute_state text, _money_filter text)');
  src := replace(src, 'c.id,c.source_lane', 'to_jsonb(mm) money_mark,c.id,c.source_lane');
  src := replace(src, 'from public.ebay_return_cases c', 'from public.ebay_return_cases c
    left join lateral (select m.marked, m.revision, m.signer_name, m.recorded_at
      from public.customer_return_money_marks m where m.case_id=c.id
      order by m.revision desc limit 1) mm on true');
  src := replace(src, 'or return_stage=_return_stage)', 'or return_stage=_return_stage)
    and (_view<>''return'' or ' || predicate || ')');
  src := replace(src, 'group by return_stage', 'and (_view<>''return'' or ' || predicate || ') group by return_stage');
  if strpos(src, '_money_filter text)') = 0 or strpos(src, 'to_jsonb(mm) money_mark') = 0
    or strpos(src, 'm.case_id=c.id') = 0 or regexp_count(src, '_money_filter = ''marked''') <> 2 then
    raise exception 'Review the current customer issue queue before applying the money filter';
  end if;
  execute src;
end $$;
revoke all on function public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text) from public, anon;
grant execute on function public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
