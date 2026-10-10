begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Internal notes use the existing append-only case audit trail. They never
-- alter task ownership, case status, provider data, orders or stock.
alter table public.ebay_return_events drop constraint ebay_return_events_action_check;
alter table public.ebay_return_events add constraint ebay_return_events_action_check
 check(action in ('return_created','return_received','item_inspected','restocked','closed','cancelled','admin_override','note_added'));
create index customer_issue_notes_case_idx on public.ebay_return_events(return_case_id,created_at desc,id desc) where action='note_added';

create function public.add_customer_issue_note(_request_id uuid,_case_id uuid,_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases; e public.ebay_return_events; body text:=btrim(_note);
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then raise exception 'Customer issues access required' using errcode='42501';end if;
 if _request_id is null or nullif(body,'') is null or char_length(body)>10000 then raise exception 'Enter a note between 1 and 10,000 characters';end if;
 select * into c from public.ebay_return_cases where id=_case_id;
 if not found then raise exception 'Case not found';end if;
 insert into public.ebay_return_events(id,return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
 values(_request_id,c.id,c.order_id,'note_added',body,auth.uid(),auth.jwt()->>'email','{"source":"customer_issue_note"}')
 on conflict(id) do nothing;
 select * into e from public.ebay_return_events where id=_request_id;
 if e.return_case_id is distinct from c.id or e.action<>'note_added' or e.signed_by is distinct from auth.uid() or e.notes is distinct from body then
  raise exception 'This note request was already used. Reopen Notes before adding a different note';
 end if;
 return jsonb_build_object('id',e.id,'return_case_id',e.return_case_id,'notes',e.notes,'created_at',e.created_at,'signed_by',e.signed_by,'signed_by_email',e.signed_by_email,
  'note_count',(select count(*) from public.ebay_return_events n where n.return_case_id=c.id and n.action='note_added'));
end $$;

-- A bounded batch for the visible cards, with pagination for a case's history.
-- RLS on both cases and events still applies to the read.
create function public.customer_issue_notes(_case_ids uuid[],_limit int default 1,_offset int default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('case_id',c.id,'note_count',
  (select count(*) from public.ebay_return_events e where e.return_case_id=c.id and e.action='note_added'),
  'notes',coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id desc) from (
   select e.id,e.notes,e.created_at,e.signed_by,e.signed_by_email
   from public.ebay_return_events e where e.return_case_id=c.id and e.action='note_added'
   order by e.created_at desc,e.id desc limit least(50,greatest(1,coalesce(_limit,1))) offset greatest(0,coalesce(_offset,0))
  ) n),'[]'::jsonb))),'[]'::jsonb)
 from public.ebay_return_cases c where c.id=any(_case_ids[1:100]) and (select public.can_access_post_order_issues())
$$;
revoke all on function public.add_customer_issue_note(uuid,uuid,text),public.customer_issue_notes(uuid[],int,int) from public,anon;
grant execute on function public.add_customer_issue_note(uuid,uuid,text),public.customer_issue_notes(uuid[],int,int) to authenticated;
notify pgrst,'reload schema';
commit;
