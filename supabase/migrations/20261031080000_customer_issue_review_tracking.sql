begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create table public.customer_issue_tracking_history (
 case_id uuid not null references public.ebay_return_cases(id),
 tracking_number text not null,
 direction text not null check(direction in ('outbound','return')),
 carrier text not null default '',
 history_text text not null check(length(history_text) between 1 and 80000),
 source_url text not null,
 captured_at timestamptz not null default now(),
 captured_by uuid not null references auth.users(id),
 primary key(case_id,tracking_number,direction)
);
alter table public.customer_issue_tracking_history enable row level security;
revoke all on public.customer_issue_tracking_history from public,anon,authenticated;
grant select on public.customer_issue_tracking_history to authenticated;
create policy issue_tracking_history_read on public.customer_issue_tracking_history for select to authenticated using(public.can_access_post_order_issues());
create function public.save_customer_issue_tracking_history(_case_id uuid,_tracking_number text,_direction text,_carrier text,_history_text text,_source_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k uuid; tracking text; h public.customer_issue_tracking_history;
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false) then raise exception 'Customer issues access required' using errcode='42501';end if;
 k:=public.customer_issue_review_key(_case_id);
 if not exists(select 1 from public.customer_issue_ebay_reviews where case_id=k and active) then raise exception 'Add this issue to eBay review first';end if;
 tracking:=upper(regexp_replace(coalesce(_tracking_number,''),'[[:space:]-]','','g'));
 if tracking !~ '^[A-Z0-9]{6,50}$' or _direction is null or _direction not in ('outbound','return') or
  coalesce(length(btrim(_history_text)),0) not between 1 and 80000 or coalesce(length(_carrier),0)>100 or
  _source_url is null or length(_source_url)>2000 or _source_url !~ '^https://(tools[.]usps[.]com|www[.]ups[.]com|www[.]fedex[.]com|www[.]dhl[.]com|www[.]17track[.]net)/' then
  raise exception 'Enter the carrier history and its official tracking link';end if;
 insert into public.customer_issue_tracking_history(case_id,tracking_number,direction,carrier,history_text,source_url,captured_by)
 values(k,tracking,_direction,coalesce(_carrier,''),btrim(_history_text),_source_url,auth.uid())
 on conflict(case_id,tracking_number,direction) do update set carrier=excluded.carrier,history_text=excluded.history_text,source_url=excluded.source_url,captured_at=now(),captured_by=auth.uid()
 returning * into h;
 return to_jsonb(h)||jsonb_build_object('captured_by_name',(select coalesce(display_name,email) from public.employees where user_id=auth.uid() limit 1));
end $$;
revoke all on function public.save_customer_issue_tracking_history(uuid,text,text,text,text,text) from public,anon;
grant execute on function public.save_customer_issue_tracking_history(uuid,text,text,text,text,text) to authenticated;
create or replace function public.customer_issue_ebay_review_packet(_case_id uuid) returns jsonb
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
   'order_line_count',(select count(*) from public.ebay_order_lines l where l.order_id=c.order_id),
   'label_events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id) from public.ebay_order_label_events e where c.order_id=any(e.order_ids) or e.order_line_ids && line_ids),'[]'),
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
 return jsonb_build_object('review',to_jsonb(r),'members',members,'tracking_history',coalesce((select jsonb_agg(to_jsonb(h)||jsonb_build_object('captured_by_name',(select coalesce(display_name,email) from public.employees where user_id=h.captured_by limit 1))) from public.customer_issue_tracking_history h where h.case_id=k),'[]'),'generated_at',now());
end $$;
notify pgrst,'reload schema';
commit;
