begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create index if not exists ebay_chat_pending_buyer_idx on public.ebay_conversations
 (seller_account_id,lower(btrim(other_party_username))) where conversation_type='FROM_MEMBERS';
create index if not exists ebay_chat_latest_inbound_idx on public.ebay_conversation_messages
 (conversation_id,created_at_ebay desc nulls last,id desc) where direction='inbound';
create index if not exists ebay_chat_verified_buyer_idx on public.ebay_conversation_links
 (seller_account_id,lower(btrim(coalesce(nullif(buyer_username,''),matched_value))))
 where link_type='buyer_username' and status='confirmed';

create or replace function public.list_pending_order_chat_markers(_line_ids uuid[])
returns table(line_id uuid,buyer_username text,conversation_ids uuid[],unread_conversation_ids uuid[],
 conversation_count integer,unread_count integer,latest_buyer_message_at timestamptz,
 latest_buyer_preview text,latest_conversation_id uuid,match_scope text,checked_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_account uuid;v_accounts integer;
begin
 if v_actor is null or not public.can_manage_inventory() or not public.can_access_email_triage() then
  raise exception 'Pending orders and Email Triage access are required' using errcode='42501';
 end if;
 if coalesce(cardinality(_line_ids),0)>500 then raise exception 'Check at most 500 order lines at a time' using errcode='22023';end if;
 select count(*),(array_agg(a.id))[1] into v_accounts,v_account from public.ebay_seller_accounts a
  where a.status='active' and a.environment='production';
 if v_accounts<>1 then raise exception 'The eBay chat account needs configuration before checking messages';end if;
 return query
 with lines as materialized (
  select l.id,l.order_id,l.item_number,lower(btrim(o.buyer_username)) as buyer,o.buyer_username as display_buyer
  from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
  where l.id=any(_line_ids)
 ), buyers as (select distinct buyer from lines where nullif(buyer,'') is not null),
 candidates as materialized (
  select distinct b.buyer,c.id,c.reference_id,c.latest_message_id
  from buyers b join public.ebay_conversations c on lower(btrim(c.other_party_username))=b.buyer
  where c.seller_account_id=v_account and c.conversation_type='FROM_MEMBERS'
  union
  select distinct b.buyer,c.id,c.reference_id,c.latest_message_id
  from buyers b join public.ebay_conversation_links k on lower(btrim(coalesce(nullif(k.buyer_username,''),k.matched_value)))=b.buyer
  join public.ebay_conversations c on c.id=k.conversation_id and c.seller_account_id=k.seller_account_id
  where k.seller_account_id=v_account and k.link_type='buyer_username' and k.status='confirmed'
   and c.conversation_type='FROM_MEMBERS' and nullif(btrim(c.other_party_username),'') is null
 ), messages as materialized (
  select c.*,m.created_at_ebay as message_at,left(m.message_body_preview,180) as preview,
   (m.id is not null and (r.user_id is null or r.read_state='unread'
    or coalesce(m.created_at_ebay,m.created_at)>coalesce(r.latest_message_created_at,r.read_at,'-infinity'::timestamptz)
    or (m.ebay_message_id=c.latest_message_id and r.latest_message_id is distinct from c.latest_message_id
     and coalesce(m.created_at_ebay,m.created_at)>=coalesce(r.latest_message_created_at,r.read_at,'-infinity'::timestamptz)))) as unread
  from candidates c
  left join lateral (select x.id,x.ebay_message_id,x.created_at_ebay,x.created_at,x.message_body_preview
   from public.ebay_conversation_messages x where x.conversation_id=c.id and x.direction='inbound'
   order by x.created_at_ebay desc nulls last,x.id desc limit 1) m on true
  left join public.ebay_conversation_user_read_states r on r.conversation_id=c.id and r.user_id=v_actor
 ), matched as (
  select l.id as order_line_id,m.id as chat_id,m.message_at,m.preview,m.unread,case when exists(select 1 from public.ebay_conversation_links k
    where k.conversation_id=m.id and k.seller_account_id=v_account and k.status='confirmed'
     and k.match_method<>'buyer_recent_unique_order' and k.ebay_order_line_id=l.id)
    or (nullif(l.item_number,'') is not null and l.item_number=m.reference_id) then 'item'
   when exists(select 1 from public.ebay_conversation_links k where k.conversation_id=m.id and k.seller_account_id=v_account
    and k.status='confirmed' and k.match_method<>'buyer_recent_unique_order' and k.ebay_order_id=l.order_id and k.ebay_order_line_id is null) then 'order'
   else 'buyer' end as scope
  from lines l join messages m on m.buyer=l.buyer
 )
 select l.id,l.display_buyer,coalesce(a.ids,'{}'::uuid[]),coalesce(a.unread_ids,'{}'::uuid[]),
  coalesce(a.total,0)::integer,coalesce(a.unread_total,0)::integer,a.message_at,a.preview,a.conversation_id,a.scope,now()
 from lines l left join lateral (
  select array_agg(m.chat_id order by m.chat_id) as ids,
   array_agg(m.chat_id order by m.chat_id) filter(where m.unread) as unread_ids,
   count(*) as total,count(*) filter(where m.unread) as unread_total,
   (array_agg(m.message_at order by m.unread desc,m.message_at desc nulls last,m.chat_id))[1] as message_at,
   (array_agg(m.preview order by m.unread desc,m.message_at desc nulls last,m.chat_id))[1] as preview,
   (array_agg(m.chat_id order by m.unread desc,m.message_at desc nulls last,m.chat_id))[1] as conversation_id,
   (array_agg(m.scope order by m.unread desc,m.message_at desc nulls last,m.chat_id))[1] as scope
  from matched m where m.order_line_id=l.id
 ) a on true;
end $$;
revoke all on function public.list_pending_order_chat_markers(uuid[]) from public,anon;
grant execute on function public.list_pending_order_chat_markers(uuid[]) to authenticated;

-- Existing owner-only read-state RLS continues to apply to these live updates.
do $$begin
 alter publication supabase_realtime add table public.ebay_conversation_user_read_states;
exception when duplicate_object then null;when undefined_object then null;end $$;
do $$begin
 alter publication supabase_realtime add table public.ebay_conversation_links;
exception when duplicate_object then null;when undefined_object then null;end $$;
notify pgrst,'reload schema';
commit;
