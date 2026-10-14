begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Staff can finish their part without marking an eBay case or refund complete.
create table public.customer_return_reviews (
 return_case_id uuid primary key references public.ebay_return_cases(id) on delete cascade,
 status text not null check(status in ('pending','changes_requested','approved')),
 reviewer_id uuid not null references auth.users(id),
 submitted_by uuid not null references auth.users(id),
 submitted_by_email text,
 submitted_at timestamptz not null default now(),
 submission_note text not null,
 manual_refund_date date,
 ebay_refund_due_at timestamptz,
 reviewed_by uuid references auth.users(id),
 reviewed_by_email text,
 reviewed_at timestamptz,
 review_note text,
 version uuid not null default gen_random_uuid(),
 updated_at timestamptz not null default now()
);
alter table public.customer_return_reviews enable row level security;
create policy customer_return_reviews_read on public.customer_return_reviews for select to authenticated
 using ((select public.can_access_post_order_issues()));
revoke all on public.customer_return_reviews from anon,authenticated;
grant select on public.customer_return_reviews to authenticated;
grant all on public.customer_return_reviews to service_role;
create index customer_return_reviews_pending on public.customer_return_reviews(reviewer_id,status) where status<>'approved';
do $$
declare rule text;
begin
 select pg_get_constraintdef(oid) into rule from pg_constraint where conrelid='public.ebay_return_events'::regclass and conname='ebay_return_events_action_check';
 if rule is null then raise exception 'Return event action constraint not found';end if;
 alter table public.ebay_return_events drop constraint ebay_return_events_action_check;
 execute 'alter table public.ebay_return_events add constraint ebay_return_events_action_check check (action=''final_review'' or ('||substring(rule from 7)||'))';
end $$;

-- Only the seller's refund action establishes a refund deadline. Initial
-- response, buyer shipment and escalation deadlines must not be relabelled.
-- https://developer.ebay.com/Devzone/post-order/post-order_v2_return-returnid__get.html
create function public.customer_return_refund_deadline(_lane text,_id text,_status text,_raw jsonb)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare due jsonb; value text;
begin
 if _lane is distinct from 'return' or nullif(_id,'') is null
  or coalesce(_status,'') ~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED)($|_)'
  or coalesce(public.customer_issue_return_refund(_lane,_id,_status,_raw),'')='refunded' then return null;end if;
 if coalesce(_raw#>>'{ebaySummary,returnId}',_raw#>>'{ebayDetail,returnId}',_raw->>'ebayReturnId') is distinct from _id
  or coalesce(_raw#>>'{ebayDetail,returnId}',_id) is distinct from _id
  or coalesce(_raw->>'ebayReturnId',_id) is distinct from _id then return null;end if;
 due:=coalesce(_raw#>'{ebaySummary,sellerResponseDue}',_raw#>'{ebayDetail,sellerResponseDue}');
 if due->>'activityDue' is distinct from 'SELLER_ISSUE_REFUND' then return null;end if;
 value:=coalesce(due#>>'{respondByDate,value}',case when jsonb_typeof(due->'respondByDate')='string' then due->>'respondByDate' end);
 if value is null or value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then return null;end if;
 return value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then return null;
end $$;
revoke all on function public.customer_return_refund_deadline(text,text,text,jsonb) from public,anon;
grant execute on function public.customer_return_refund_deadline(text,text,text,jsonb) to authenticated;

create function public.customer_return_review_details(_case_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('final_review',to_jsonb(r),'refund_due_at',coalesce(due.value,r.ebay_refund_due_at,
  (r.manual_refund_date+time '23:59:59') at time zone 'America/New_York'),
  'refund_deadline_source',case when coalesce(due.value,r.ebay_refund_due_at) is not null then 'ebay' when r.manual_refund_date is not null then 'manual' end)
 from public.ebay_return_cases c left join public.customer_return_reviews r on r.return_case_id=c.id
 left join lateral(select public.customer_return_refund_deadline(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) value) due on true
 where c.id=_case_id and public.can_access_post_order_issues()
$$;
revoke all on function public.customer_return_review_details(uuid) from public,anon;
grant execute on function public.customer_return_review_details(uuid) to authenticated;

create function public.save_customer_return_review(_request_id uuid,_case_id uuid,_action text,_owner uuid,
 _note text,_expected_version uuid,_manual_refund_date date,_confirmed boolean,_expected_case_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;r public.customer_return_reviews;receipt public.customer_return_receipts;
 signature jsonb; result jsonb; owner uuid; next_status text; stamp timestamptz:=now();
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then raise exception 'Customer issues access required' using errcode='42501';end if;
 if _request_id is null or _action is null or _action not in ('submit','approve','changes','reassign') then raise exception 'Choose a review action';end if;
 if _confirmed is distinct from true or nullif(btrim(_note),'') is null or length(_note)>10000 then raise exception 'Add your notes and confirm the review handoff';end if;
 signature:=jsonb_build_object('action','final_review','case',_case_id,'operation',_action,'owner',_owner,'note',_note,'version',_expected_version,'date',_manual_refund_date,'case_version',_expected_case_updated_at);
 perform pg_advisory_xact_lock(hashtextextended('return-receipt:'||_request_id::text,0));
 select * into receipt from public.customer_return_receipts where id=_request_id;
 if found then
  if receipt.actor<>auth.uid() or receipt.input<>signature then raise exception 'This request was already used for different details';end if;
  return receipt.result;
 end if;
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found or c.source_lane<>'return' then raise exception 'Choose a physical return';end if;
 if c.updated_at is distinct from _expected_case_updated_at then raise exception 'The return information changed. Refresh and review it before continuing';end if;
 select * into r from public.customer_return_reviews where return_case_id=c.id for update;
 if r.version is distinct from _expected_version then raise exception 'The review changed. Refresh this case before continuing';end if;
 if _action='submit' then
  if r.status='pending' then raise exception 'This return is already awaiting final review';end if;
  owner:=_owner;
  if owner is null then
   select case when count(distinct user_id)=1 then (array_agg(user_id))[1] end into owner
    from public.employees where active is true and user_id is not null and lower(btrim(display_name))='otello guillen';
  end if;
  next_status:='pending';
 else
  if r.return_case_id is null or r.status='approved' then raise exception 'This return is not awaiting review';end if;
  if not coalesce(public.is_admin(),false) and auth.uid() is distinct from r.reviewer_id then raise exception 'Only the assigned reviewer or an administrator can make this decision' using errcode='42501';end if;
  if _action in ('approve','changes') and r.status<>'pending' then raise exception 'Wait for the worker to resubmit the return';end if;
  owner:=case when _action='reassign' then _owner else r.reviewer_id end;
  next_status:=case _action when 'approve' then 'approved' when 'changes' then 'changes_requested' else r.status end;
 end if;
 if owner is null or not exists(select 1 from public.employees where user_id=owner and active is true) then raise exception 'Choose an active reviewer. Otello is the default when available';end if;
 insert into public.customer_return_reviews(return_case_id,status,reviewer_id,submitted_by,submitted_by_email,submitted_at,submission_note,manual_refund_date,ebay_refund_due_at)
 values(c.id,next_status,owner,auth.uid(),auth.jwt()->>'email',stamp,btrim(_note),_manual_refund_date,public.customer_return_refund_deadline(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload))
 on conflict(return_case_id) do update set status=next_status,reviewer_id=owner,
  submitted_by=case when _action='submit' then auth.uid() else r.submitted_by end,
  submitted_by_email=case when _action='submit' then auth.jwt()->>'email' else r.submitted_by_email end,
  submitted_at=case when _action='submit' then stamp else r.submitted_at end,
  submission_note=case when _action='submit' then btrim(_note) else r.submission_note end,
  manual_refund_date=_manual_refund_date,
  ebay_refund_due_at=coalesce(excluded.ebay_refund_due_at,r.ebay_refund_due_at),
  reviewed_by=case when _action in ('approve','changes') then auth.uid() when _action='submit' then null else r.reviewed_by end,
  reviewed_by_email=case when _action in ('approve','changes') then auth.jwt()->>'email' when _action='submit' then null else r.reviewed_by_email end,
  reviewed_at=case when _action in ('approve','changes') then stamp when _action='submit' then null else r.reviewed_at end,
  review_note=case when _action in ('approve','changes') then btrim(_note) when _action='submit' then null else r.review_note end,
  version=gen_random_uuid(),updated_at=stamp;
 -- A distinct event records the handoff without claiming a physical inspection.
 insert into public.ebay_return_events(return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
 values(c.id,c.order_id,'final_review',case _action when 'submit' then 'Work finished · sent for final review. ' when 'approve' then 'Final review approved. ' when 'changes' then 'Final review · changes requested. ' else 'Final reviewer updated. ' end||btrim(_note),
  auth.uid(),auth.jwt()->>'email',jsonb_build_object('source','return_final_review','action',_action,'previous_review',to_jsonb(r),'reviewer_id',owner,'status',next_status,'manual_refund_date',_manual_refund_date));
 update public.ebay_return_cases set updated_at=stamp where id=c.id;
 result:=public.customer_return_review_details(c.id);
 insert into public.customer_return_receipts(id,actor,input,result) values(_request_id,auth.uid(),signature,result);
 return result;
end $$;
revoke all on function public.save_customer_return_review(uuid,uuid,text,uuid,text,uuid,date,boolean,timestamptz) from public,anon;
grant execute on function public.save_customer_return_review(uuid,uuid,text,uuid,text,uuid,date,boolean,timestamptz) to authenticated;

-- Extend every paged queue overload. Pending reviews stay visible even after
-- eBay closes its case. Responsibility and filtering happen before paging.
do $$
declare signature text;src text;
begin
 foreach signature in array array['public.list_customer_issues(text,text,text,integer,integer,text,text)',
  'public.list_customer_issues(text,text,text,integer,integer,text,text,uuid)',
  'public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text)'] loop
  src:=pg_get_functiondef(signature::regprocedure);
  if strpos(src,'ts.next_user,ts.task_id')=0 or strpos(src,'issue_kind=_view')=0 then raise exception 'Review queue definition changed: %',signature;end if;
  src:=replace(src,'c.id,c.source_lane', 'to_jsonb(r) final_review,r.status review_status,coalesce(due.value,r.ebay_refund_due_at,(r.manual_refund_date+time ''23:59:59'') at time zone ''America/New_York'') refund_due_at,case when coalesce(due.value,r.ebay_refund_due_at) is not null then ''ebay'' when r.manual_refund_date is not null then ''manual'' end refund_deadline_source,c.id,c.source_lane');
  src:=replace(src,'from public.ebay_return_cases c','from public.ebay_return_cases c left join public.customer_return_reviews r on r.return_case_id=c.id left join lateral(select public.customer_return_refund_deadline(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) value) due on true');
  src:=replace(src,'ts.next_user,ts.task_id','case when r.status=''pending'' then r.reviewer_id when r.status=''changes_requested'' then r.submitted_by else ts.next_user end next_user,ts.task_id');
  src:=replace(src,'coalesce(ts.mine,false) mine','case when r.status in (''pending'',''changes_requested'') then case when r.status=''pending'' then r.reviewer_id else r.submitted_by end=auth.uid() else coalesce(ts.mine,false) end mine');
  src:=replace(src,'coalesce(ts.following,false) following','(coalesce(ts.following,false) or coalesce(r.status in (''pending'',''changes_requested'') and auth.uid() in (r.submitted_by,r.reviewer_id),false)) following');
  src:=replace(src,'coalesce(ts.unassigned,true) unassigned','(coalesce(ts.unassigned,true) and coalesce(r.status not in (''pending'',''changes_requested''),true)) unassigned');
  src:=replace(src,'or coalesce(ts.open_tasks,0)>0) active','or coalesce(ts.open_tasks,0)>0 or coalesce(r.status in (''pending'',''changes_requested''),false)) active');
  src:=replace(src,'issue_kind=_view','issue_kind=_view or (_view=''final_review'' and review_status in (''pending'',''changes_requested''))');
  src:=replace(src,'''history'',count(*) filter(where not active)', '''final_review'',count(*) filter(where review_status in (''pending'',''changes_requested'')),''history'',count(*) filter(where not active)');
  src:=replace(src,'case when _sort=''oldest''', 'case when _sort=''review_due'' then refund_due_at end asc nulls first,case when _sort=''oldest''');
  -- Final-review deadlines also participate in the existing due-soon filter.
  src:=replace(src,'or (_scope=''monitoring''', 'or (_scope=''due'' and review_status in (''pending'',''changes_requested'') and (refund_due_at is null or refund_due_at<=now()+interval ''48 hours'')) or (_scope=''monitoring''');
  if strpos(src,'''final_review'',count(*)')=0 or strpos(src,'coalesce(r.status in (''pending'',''changes_requested''),false)) active')=0 then raise exception 'Review queue extension incomplete: %',signature;end if;
  execute src;
 end loop;
end $$;

-- Both modern and older clients must finish the review before archiving.
do $$
declare signature text;src text;
begin
 foreach signature in array array['public.close_resolved_customer_issue(uuid,timestamptz,jsonb,boolean,text)','public.finish_customer_issue(uuid,text)'] loop
  src:=pg_get_functiondef(signature::regprocedure);
  src:=regexp_replace(src,'if not found then raise exception ''Case not found'';\s*end if;',
   'if not found then raise exception ''Case not found'';end if; if exists(select 1 from public.customer_return_reviews where return_case_id=_case_id and status in (''pending'',''changes_requested'')) then raise exception ''Complete the final review before archiving this return'';end if;');
  if strpos(src,'Complete the final review before archiving')=0 then raise exception 'Closeout guard could not be installed';end if;
  execute src;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
