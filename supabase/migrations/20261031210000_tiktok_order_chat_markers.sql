begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Compact buyer-level markers, never message bodies or a guessed username match.
create function public.list_tiktok_order_chat_markers(_order_ids uuid[])
returns table(order_id uuid, buyer_linked boolean, chats jsonb)
language plpgsql stable security definer set search_path='' as $$
declare shop text;
begin
 if auth.uid() is null or not public.can_manage_inventory() or not public.can_access_tiktok_messages() then
  raise exception 'Inventory and messaging access required' using errcode='42501';
 end if;
 if coalesce(cardinality(_order_ids),0)>500 then raise exception 'Request at most 500 orders';end if;
 select c.shop_id into shop from public.tiktok_api_connection c where c.singleton;
 if shop is null then raise exception 'TikTok shop connection unavailable';end if;
 return query
 select o.id, nullif(o.api_buyer_id,'') is not null,
  coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'unread_count',c.unread_count,
    'latest_message_at',c.latest_message_at,'synced_at',c.synced_at)
    order by (c.unread_count>0) desc,c.latest_message_at desc nulls last,c.id)
   from public.tiktok_chat_conversations c where c.buyer_id=o.api_buyer_id and c.shop_id=shop),'[]'::jsonb)
 from public.tiktok_orders o where o.id=any(_order_ids);
end;
$$;
revoke all on function public.list_tiktok_order_chat_markers(uuid[]) from public,anon;
grant execute on function public.list_tiktok_order_chat_markers(uuid[]) to authenticated;

-- Realtime follows the existing chat SELECT policy; polling also catches missed events.
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
  select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tiktok_chat_conversations') then
  alter publication supabase_realtime add table public.tiktok_chat_conversations;
 end if;
end$$;
commit;
