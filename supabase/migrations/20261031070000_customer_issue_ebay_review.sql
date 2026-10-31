begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.customer_issue_ebay_reviews (
 case_id uuid primary key references public.ebay_return_cases(id),
 active boolean not null default true,
 position text not null default '' check(char_length(position)<=30000),
 requested_resolution text not null default '' check(char_length(requested_resolution)<=5000),
 marked_by uuid references auth.users(id),marked_at timestamptz not null default now(),
 updated_by uuid references auth.users(id),updated_at timestamptz not null default now(),
 position_updated_by uuid references auth.users(id),position_updated_at timestamptz,
 version uuid not null default gen_random_uuid()
);
create table public.customer_issue_ebay_review_events (
 id uuid primary key default gen_random_uuid(),case_id uuid not null references public.customer_issue_ebay_reviews(case_id),
 action text not null check(action in ('marked','removed','position_saved')),
 actor uuid references auth.users(id),actor_email text,created_at timestamptz not null default now(),
 previous_value jsonb,new_value jsonb
);
alter table public.customer_issue_ebay_reviews enable row level security;
alter table public.customer_issue_ebay_review_events enable row level security;
create policy issue_review_read on public.customer_issue_ebay_reviews for select to authenticated using(public.can_access_post_order_issues());
create policy issue_review_events_read on public.customer_issue_ebay_review_events for select to authenticated using(public.can_access_post_order_issues());
grant select on public.customer_issue_ebay_reviews,public.customer_issue_ebay_review_events to authenticated;

-- A request and its escalation are one entry. Do not merge unrelated cases
-- simply because they have the same customer or order number.
create function public.customer_issue_review_key(_case_id uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select c.id from public.ebay_return_cases c where c.id in(select public.customer_issue_history_family(_case_id))
 order by exists(select 1 from public.customer_issue_ebay_reviews r where r.case_id=c.id) desc,(c.source_lane='case') desc,c.id limit 1
$$;

create function public.save_customer_issue_ebay_review(_case_id uuid,_action text,_position text default null,_resolution text default null,_version uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k uuid;r public.customer_issue_ebay_reviews;prior jsonb;event_action text;
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then raise exception 'Customer issues access required' using errcode='42501';end if;
 if _action not in ('mark','remove','save') then raise exception 'Choose a valid review action';end if;
 k:=public.customer_issue_review_key(_case_id);if k is null then raise exception 'Case not found';end if;
 -- Serialize first-time marks as well as later edits.
 perform 1 from public.ebay_return_cases where id=k for update;
 select * into r from public.customer_issue_ebay_reviews where case_id=k for update;prior:=to_jsonb(r);
 if _action='mark' and r.active then return to_jsonb(r);end if;
 if _action<>'mark' and (r.case_id is null or _version is distinct from r.version) then raise exception 'This review was changed by someone else. Reload it before saving';end if;
 if _action='save' and (not r.active or _position is null or _resolution is null or char_length(_position)>30000 or char_length(_resolution)>5000) then raise exception 'Choose an active review and keep the position within 30,000 characters and request within 5,000';end if;
 if _action='mark' then
  insert into public.customer_issue_ebay_reviews(case_id,marked_by,updated_by) values(k,auth.uid(),auth.uid())
  on conflict(case_id) do update set active=true,marked_by=auth.uid(),marked_at=now(),updated_by=auth.uid(),updated_at=now(),version=gen_random_uuid();event_action:='marked';
 elsif _action='remove' then
  update public.customer_issue_ebay_reviews set active=false,updated_by=auth.uid(),updated_at=now(),version=gen_random_uuid() where case_id=k;event_action:='removed';
 else
  update public.customer_issue_ebay_reviews set position=btrim(_position),requested_resolution=btrim(_resolution),position_updated_by=auth.uid(),position_updated_at=now(),updated_by=auth.uid(),updated_at=now(),version=gen_random_uuid() where case_id=k;event_action:='position_saved';
 end if;
 select * into r from public.customer_issue_ebay_reviews where case_id=k;
 insert into public.customer_issue_ebay_review_events(case_id,action,actor,actor_email,previous_value,new_value)
 values(k,event_action,auth.uid(),auth.jwt()->>'email',prior,to_jsonb(r));
 return to_jsonb(r);
end $$;

create function public.list_customer_issue_ebay_reviews() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then raise exception 'Customer issues access required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object(
  'case_ids',(select jsonb_agg(x) from public.customer_issue_history_family(r.case_id) x),
  'buyer_username',c.buyer_username,'order_number',c.order_number,'case_number',c.ebay_return_id,'ebay_status',c.ebay_status,
  'marked_by_name',(select coalesce(display_name,email) from public.employees where user_id=r.marked_by limit 1),
  'position_by_name',(select coalesce(display_name,email) from public.employees where user_id=r.position_updated_by limit 1),
  'updated_by_name',(select coalesce(display_name,email) from public.employees where user_id=r.updated_by limit 1)) order by r.marked_at,r.case_id)
  from public.customer_issue_ebay_reviews r join public.ebay_return_cases c on c.id=r.case_id where r.active),'[]');
end $$;

create function public.customer_issue_ebay_review_packet(_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare k uuid;c public.ebay_return_cases;r public.customer_issue_ebay_reviews;d jsonb;members jsonb:='[]';line_ids uuid[];
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then raise exception 'Customer issues access required' using errcode='42501';end if;
 k:=public.customer_issue_review_key(_case_id);
 select * into r from public.customer_issue_ebay_reviews where case_id=k and active;
 if not found then raise exception 'Add this issue to eBay review first';end if;
 for c in select * from public.ebay_return_cases where id in(select public.customer_issue_history_family(k)) order by opened_at,id loop
  line_ids:=public.customer_issue_order_line_ids(c.id);
  d:=public.customer_issue_evidence(c.id);
  d:=d||jsonb_build_object('case',to_jsonb(c),'outcome',public.customer_issue_final_outcome(to_jsonb(c)),
   'refund_status',public.customer_issue_return_refund(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload),
   'orders',coalesce((select jsonb_agg(to_jsonb(o)) from public.ebay_orders o where o.id=c.order_id),'[]'),
   'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.ebay_order_lines l where l.id=any(line_ids) and l.order_id=c.order_id),'[]'),
   -- Full saved exchanges, not the 501-entry preview used in the issue panel.
   'case_messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.sent_at) from public.ebay_return_messages m where m.return_case_id=c.id and m.direction<>'internal' and m.message_status in ('sent','imported')),'[]'),
   'buyer_messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at_ebay) from public.ebay_conversation_messages m join public.ebay_conversations v on v.id=m.conversation_id
    where lower(v.other_party_username)=lower(c.buyer_username) and v.conversation_type='FROM_MEMBERS'
    and (v.reference_id=c.order_number or exists(select 1 from public.ebay_order_lines l where l.id=any(line_ids) and l.item_number=v.reference_id))),'[]'),
   'internal_events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('author_name',(select coalesce(display_name,email) from public.employees where user_id=e.signed_by limit 1)) order by e.created_at) from public.ebay_return_events e where e.return_case_id=c.id),'[]'),
   'task_events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('author_name',(select coalesce(display_name,email) from public.employees where user_id=e.signed_by limit 1)) order by e.created_at) from public.ebay_return_task_events e where e.return_case_id=c.id),'[]'),
   'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at) from public.ebay_return_tasks t where t.return_case_id=c.id),'[]'));
  members:=members||jsonb_build_array(d);
 end loop;
 return jsonb_build_object('review',to_jsonb(r),'members',members,'generated_at',now());
end $$;
revoke all on function public.customer_issue_review_key(uuid) from public,anon,authenticated;
revoke all on function public.save_customer_issue_ebay_review(uuid,text,text,text,uuid),public.list_customer_issue_ebay_reviews(),public.customer_issue_ebay_review_packet(uuid) from public,anon;
grant execute on function public.save_customer_issue_ebay_review(uuid,text,text,text,uuid),public.list_customer_issue_ebay_reviews(),public.customer_issue_ebay_review_packet(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
