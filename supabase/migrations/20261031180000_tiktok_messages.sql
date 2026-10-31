begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create function public.can_access_tiktok_messages() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.employees e join auth.users u on u.id=e.user_id
 where u.id=auth.uid() and e.active is distinct from false and (e.role='admin' or e.email_triage_access));
$$;
revoke all on function public.can_access_tiktok_messages() from public,anon;
grant execute on function public.can_access_tiktok_messages() to authenticated,service_role;

create table public.tiktok_chat_conversations (
 id uuid primary key default gen_random_uuid(), shop_id text not null, conversation_id text not null check(conversation_id ~ '^\d{10,30}$'),
 buyer_id text not null check(buyer_id ~ '^\d{10,30}$'),buyer_name text not null default '',
 latest_message jsonb,latest_message_id text,latest_message_at timestamptz,latest_preview text not null default '',latest_sender_role text,
 unread_count integer not null default 0 check(unread_count>=0),can_send_message boolean not null default false,
 triage_status text not null default 'open' check(triage_status in('open','waiting','done')),
 triage_updated_by uuid references auth.users(id),triage_updated_at timestamptz,revision integer not null default 1,
 synced_at timestamptz not null default now(),unique(shop_id,conversation_id)
);
create index tiktok_chat_buyer on public.tiktok_chat_conversations(buyer_id);
create index tiktok_chat_recent on public.tiktok_chat_conversations(latest_message_at desc nulls last);
create table public.tiktok_chat_notes (
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.tiktok_chat_conversations(id),
 body text not null check(length(btrim(body)) between 1 and 5000),author uuid not null references auth.users(id),author_name text not null,
 created_at timestamptz not null default now()
);
create index tiktok_chat_notes_thread on public.tiktok_chat_notes(conversation_id,created_at);
create table public.tiktok_chat_sync_state (
 singleton boolean primary key default true check(singleton),enabled boolean not null default true,
 page_token text,last_synced_at timestamptz,last_error text,needs_permission boolean not null default false,
 next_sync_at timestamptz not null default now(),dispatch_token uuid,lease_until timestamptz,claimed boolean not null default false
);
insert into public.tiktok_chat_sync_state(singleton) values(true);
alter table public.tiktok_chat_conversations enable row level security;
alter table public.tiktok_chat_notes enable row level security;
alter table public.tiktok_chat_sync_state enable row level security;
revoke all on public.tiktok_chat_conversations,public.tiktok_chat_notes,public.tiktok_chat_sync_state from public,anon,authenticated;
grant select on public.tiktok_chat_conversations,public.tiktok_chat_notes to authenticated;
grant all on public.tiktok_chat_conversations,public.tiktok_chat_notes,public.tiktok_chat_sync_state to service_role;
create policy tiktok_chats_staff on public.tiktok_chat_conversations for select to authenticated using(public.can_access_tiktok_messages());
create policy tiktok_notes_staff on public.tiktok_chat_notes for select to authenticated using(public.can_access_tiktok_messages());

create function public.list_tiktok_chats(_search text default '',_filter text default 'all',_offset integer default 0) returns setof public.tiktok_chat_conversations
language plpgsql stable security definer set search_path='' as $$
declare pattern text:='%'||replace(replace(replace(left(coalesce(_search,''),200),'\','\\'),'%','\%'),'_','\_')||'%';
begin
 if not public.can_access_tiktok_messages() then raise exception 'Messaging access required';end if;
 return query select c.* from public.tiktok_chat_conversations c where
 (_filter='all' or _filter=c.triage_status or _filter='unread' and c.unread_count>0) and
 (c.buyer_name ilike pattern or c.buyer_id ilike pattern or c.latest_preview ilike pattern or exists(
 select 1 from public.tiktok_orders o where o.api_buyer_id=c.buyer_id and (o.buyer_username ilike pattern or o.order_number ilike pattern or o.recipient_name ilike pattern)))
 order by c.latest_message_at desc nulls last,c.id limit 100 offset greatest(0,least(coalesce(_offset,0),100000));
end$$;
create function public.count_tiktok_chats() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.can_access_tiktok_messages() then raise exception 'Messaging access required';end if;
 return (select jsonb_build_object('all',count(*),'open',count(*) filter(where triage_status='open'),'waiting',count(*) filter(where triage_status='waiting'),'done',count(*) filter(where triage_status='done'),'unread',count(*) filter(where unread_count>0)) from public.tiktok_chat_conversations);
end$$;
revoke all on function public.list_tiktok_chats(text,text,integer),public.count_tiktok_chats() from public,anon;
grant execute on function public.list_tiktok_chats(text,text,integer),public.count_tiktok_chats() to authenticated;

create function public.set_tiktok_chat_triage(_id uuid,_status text,_revision integer) returns public.tiktok_chat_conversations
language plpgsql security definer set search_path='' as $$
declare result public.tiktok_chat_conversations;
begin
 if not public.can_access_tiktok_messages() then raise exception 'Messaging access required';end if;
 if _status not in('open','waiting','done') then raise exception 'Invalid triage status';end if;
 update public.tiktok_chat_conversations set triage_status=_status,triage_updated_by=auth.uid(),triage_updated_at=now(),revision=revision+1
 where id=_id and revision=_revision returning * into result;
 if not found then raise exception 'This chat changed. Refresh before saving.';end if;
 return result;
end$$;
create function public.add_tiktok_chat_note(_id uuid,_body text) returns public.tiktok_chat_notes
language plpgsql security definer set search_path='' as $$
declare result public.tiktok_chat_notes;name text;
begin
 if not public.can_access_tiktok_messages() then raise exception 'Messaging access required';end if;
 select coalesce(nullif(u.raw_user_meta_data->>'full_name',''),u.email,'Staff') into name from auth.users u where u.id=auth.uid();
 insert into public.tiktok_chat_notes(conversation_id,body,author,author_name) values(_id,btrim(_body),auth.uid(),name) returning * into result;
 return result;
end$$;
revoke all on function public.set_tiktok_chat_triage(uuid,text,integer),public.add_tiktok_chat_note(uuid,text) from public,anon;
grant execute on function public.set_tiktok_chat_triage(uuid,text,integer),public.add_tiktok_chat_note(uuid,text) to authenticated;

create function public.claim_tiktok_chat_worker(_token uuid) returns public.tiktok_chat_sync_state
language sql security definer set search_path='' as $$
 update public.tiktok_chat_sync_state set claimed=true where singleton and enabled and dispatch_token=_token and lease_until>now() and not claimed returning *;
$$;
create function public.save_tiktok_chat_page(_token uuid,_shop text,_rows jsonb,_next text) returns void
language plpgsql security definer set search_path='' as $$
declare r jsonb;c public.tiktok_chat_conversations;new_buyer_message boolean;
begin
 perform 1 from public.tiktok_chat_sync_state where singleton and dispatch_token=_token and claimed and lease_until>now() for update;
 if not found then raise exception 'Chat sync lease expired';end if;
 if not exists(select 1 from public.tiktok_api_connection where singleton and shop_id=_shop) then raise exception 'Shop changed';end if;
 if jsonb_typeof(_rows)<>'array' or jsonb_array_length(_rows)>20 then raise exception 'Invalid chat page';end if;
 for r in select value from jsonb_array_elements(_rows) loop
  select * into c from public.tiktok_chat_conversations where shop_id=_shop and conversation_id=r->>'conversation_id' for update;
  if found then
   if c.buyer_id<>r->>'buyer_id' then raise exception 'Conversation buyer changed';end if;
   if c.latest_message_at is not null and (r->>'latest_message_at' is null or (r->>'latest_message_at')::timestamptz<c.latest_message_at) then continue;end if;
   new_buyer_message:=r->>'latest_sender_role'='BUYER' and r->>'latest_message_id' is distinct from c.latest_message_id;
   update public.tiktok_chat_conversations set buyer_name=r->>'buyer_name',latest_message=r->'latest_message',latest_message_id=r->>'latest_message_id',
    latest_message_at=(r->>'latest_message_at')::timestamptz,latest_preview=r->>'latest_preview',latest_sender_role=r->>'latest_sender_role',
    unread_count=(r->>'unread_count')::integer,can_send_message=(r->>'can_send_message')::boolean,synced_at=now(),
    triage_status=case when new_buyer_message then 'open' else triage_status end,revision=revision+1 where id=c.id;
  else
   insert into public.tiktok_chat_conversations(shop_id,conversation_id,buyer_id,buyer_name,latest_message,latest_message_id,latest_message_at,latest_preview,latest_sender_role,unread_count,can_send_message)
   values(_shop,r->>'conversation_id',r->>'buyer_id',r->>'buyer_name',r->'latest_message',r->>'latest_message_id',(r->>'latest_message_at')::timestamptz,r->>'latest_preview',r->>'latest_sender_role',(r->>'unread_count')::integer,(r->>'can_send_message')::boolean);
  end if;
 end loop;
 update public.tiktok_chat_sync_state set page_token=nullif(_next,''),last_error=null,needs_permission=false,
  last_synced_at=case when nullif(_next,'') is null then now() else last_synced_at end,
  next_sync_at=case when nullif(_next,'') is null then now()+interval '5 minutes' else now() end,
  dispatch_token=null,lease_until=null,claimed=false where singleton;
end$$;
create function public.dispatch_tiktok_chat_worker() returns void
language plpgsql security definer set search_path='' as $$
declare c public.tiktok_chat_sync_state;token uuid;
begin
 select * into c from public.tiktok_chat_sync_state where singleton for update skip locked;
 if not found or not c.enabled or c.lease_until>now() or c.next_sync_at>now() or not exists(select 1 from public.tiktok_api_connection where singleton) then return;end if;
 token:=gen_random_uuid();
 update public.tiktok_chat_sync_state set dispatch_token=token,lease_until=now()+interval '2 minutes',claimed=false where singleton;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/tiktok-messages',headers:='{"Content-Type":"application/json"}'::jsonb,body:=jsonb_build_object('workerToken',token),timeout_milliseconds:=60000);
end$$;
create function public.wake_tiktok_chat_sync() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.tiktok_chat_sync_state set next_sync_at=now() where singleton;
 return new;
end$$;
create trigger tiktok_chat_reconnect after insert or update of credentials on public.tiktok_api_connection for each row execute function public.wake_tiktok_chat_sync();
revoke all on function public.claim_tiktok_chat_worker(uuid),public.save_tiktok_chat_page(uuid,text,jsonb,text),public.dispatch_tiktok_chat_worker(),public.wake_tiktok_chat_sync() from public,anon,authenticated;
grant execute on function public.claim_tiktok_chat_worker(uuid),public.save_tiktok_chat_page(uuid,text,jsonb,text),public.dispatch_tiktok_chat_worker() to service_role;
select cron.schedule('invsto-tiktok-chats','* * * * *','select public.dispatch_tiktok_chat_worker();');
commit;
