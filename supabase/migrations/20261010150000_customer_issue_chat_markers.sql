begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- A single read for the visible cases. Does not mark chats read or change links.
create function public.customer_issue_chat_markers(_case_ids uuid[])
returns table(case_id uuid,order_line_id uuid,conversation_count integer,unread_count integer,
 conversation_id uuid,match_scope text,latest_buyer_message_at timestamptz,
 latest_buyer_preview text)
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); account uuid; accounts integer;
begin
 if actor is null or not public.can_access_post_order_issues() or not public.can_access_email_triage() then
  raise exception 'Customer Issues and Email Triage access are required' using errcode='42501';
 end if;
 if coalesce(cardinality(_case_ids),0)>60 then raise exception 'Check at most 60 cases at a time' using errcode='22023';end if;
 select count(*),(array_agg(a.id))[1] into accounts,account from public.ebay_seller_accounts a
 where a.status='active' and a.environment='production';
 if accounts<>1 then raise exception 'The eBay chat account needs configuration';end if;
 return query
 with cases as materialized (
  select c.id,c.order_id,c.order_number,lower(btrim(c.buyer_username)) buyer,
   public.customer_issue_order_line_ids(c.id) line_ids
  from public.ebay_return_cases c where c.id=any(_case_ids)
 ), buyers as (select distinct buyer from cases where nullif(buyer,'') is not null),
 candidates as materialized (
  select b.buyer,v.id,v.reference_id,v.latest_message_id
  from buyers b join public.ebay_conversations v on lower(btrim(v.other_party_username))=b.buyer
  where v.seller_account_id=account and v.conversation_type='FROM_MEMBERS'
  union
  select b.buyer,v.id,v.reference_id,v.latest_message_id
  from buyers b join public.ebay_conversation_links k on lower(btrim(coalesce(nullif(k.buyer_username,''),k.matched_value)))=b.buyer
  join public.ebay_conversations v on v.id=k.conversation_id and v.seller_account_id=k.seller_account_id
  where k.seller_account_id=account and k.link_type='buyer_username' and k.status='confirmed'
   and v.conversation_type='FROM_MEMBERS' and nullif(btrim(v.other_party_username),'') is null
 ), messages as materialized (
  select v.*,coalesce(m.created_at_ebay,m.created_at) message_at,left(m.message_body_preview,180) preview,
   (m.id is not null and (r.user_id is null or r.read_state='unread'
    or coalesce(m.created_at_ebay,m.created_at)>coalesce(r.latest_message_created_at,r.read_at,'-infinity'::timestamptz)
    or (m.ebay_message_id=v.latest_message_id and r.latest_message_id is distinct from v.latest_message_id
     and coalesce(m.created_at_ebay,m.created_at)>=coalesce(r.latest_message_created_at,r.read_at,'-infinity'::timestamptz)))) unread
  from candidates v
  left join lateral (select m.* from public.ebay_conversation_messages m where m.conversation_id=v.id and m.direction='inbound'
   order by m.created_at_ebay desc nulls last,m.id desc limit 1) m on true
  left join public.ebay_conversation_user_read_states r on r.conversation_id=v.id and r.user_id=actor
 ), matched as (
  select c.id case_id,m.*,case
   when exists(select 1 from public.ebay_order_lines l where l.id=any(c.line_ids) and nullif(l.item_number,'')=m.reference_id)
    or exists(select 1 from public.ebay_conversation_links k where k.conversation_id=m.id and k.seller_account_id=account
     and k.status='confirmed' and k.match_method is distinct from 'buyer_recent_unique_order' and k.ebay_order_line_id=any(c.line_ids)) then 'item'
   when nullif(c.order_number,'')=m.reference_id
    or exists(select 1 from public.ebay_conversation_links k where k.conversation_id=m.id and k.seller_account_id=account
     and k.status='confirmed' and k.match_method is distinct from 'buyer_recent_unique_order' and k.ebay_order_id=c.order_id
     and k.ebay_order_line_id is null) then 'order'
   else 'buyer' end scope
  from cases c join messages m on m.buyer=c.buyer
 ), preferred as (
  -- Other purchases by this buyer must not displace a known order conversation.
  select m.* from matched m where m.scope<>'buyer' or not exists(
   select 1 from matched exact where exact.case_id=m.case_id and exact.scope<>'buyer')
 )
 select c.id,c.line_ids[1],coalesce(a.total,0)::integer,coalesce(a.unread_total,0)::integer,a.chat_id,a.scope,a.message_at,a.preview
 from cases c left join lateral (
  select count(*) total,count(*) filter(where p.unread) unread_total,
   (array_agg(p.id order by p.unread desc,p.message_at desc nulls last,p.id))[1] chat_id,
   (array_agg(p.scope order by p.unread desc,p.message_at desc nulls last,p.id))[1] scope,
   (array_agg(p.message_at order by p.unread desc,p.message_at desc nulls last,p.id))[1] message_at,
   (array_agg(p.preview order by p.unread desc,p.message_at desc nulls last,p.id))[1] preview
  from preferred p where p.case_id=c.id
 ) a on true;
end $$;
revoke all on function public.customer_issue_chat_markers(uuid[]) from public,anon;
grant execute on function public.customer_issue_chat_markers(uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
