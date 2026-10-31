begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create table public.tiktok_chat_sends (
 id uuid primary key,conversation_id uuid not null references public.tiktok_chat_conversations(id),
 author uuid not null references auth.users(id),author_name text not null,conversation_revision integer not null,
 type text not null check(type in('TEXT','IMAGE','ORDER_CARD')),content jsonb not null,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 status text not null default 'sending' check(status in('sending','sent','failed','unknown','not_sent')),
 provider_message_id text check(provider_message_id ~ '^\d{10,30}$'),error text,
 created_at timestamptz not null default now(),finished_at timestamptz,
 reviewed_by uuid references auth.users(id),reviewed_at timestamptz
);
create index tiktok_chat_sends_thread on public.tiktok_chat_sends(conversation_id,created_at desc);
alter table public.tiktok_chat_sends enable row level security;
revoke all on public.tiktok_chat_sends from public,anon,authenticated;
grant select on public.tiktok_chat_sends to authenticated;
grant all on public.tiktok_chat_sends to service_role;
create policy tiktok_sends_staff on public.tiktok_chat_sends for select to authenticated using(public.can_access_tiktok_messages());

create function public.claim_tiktok_chat_send(_id uuid,_conversation uuid,_actor uuid,_type text,_content jsonb,_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.tiktok_chat_conversations;s public.tiktok_chat_sends;staff_name text;
begin
 select coalesce(nullif(u.raw_user_meta_data->>'full_name',''),u.email,'Staff') into staff_name
 from public.employees e join auth.users u on u.id=e.user_id where u.id=_actor and e.active is distinct from false and (e.role='admin' or e.email_triage_access);
 if staff_name is null then raise exception 'Messaging access required';end if;
 select * into c from public.tiktok_chat_conversations where id=_conversation for update;
 if not found or not exists(select 1 from public.tiktok_api_connection where singleton and shop_id=c.shop_id) then raise exception 'Conversation shop changed';end if;
 if _type not in('TEXT','IMAGE','ORDER_CARD') or jsonb_typeof(_content) is distinct from 'object' or octet_length(_content::text)>16384 then raise exception 'Invalid message';end if;
 if _type='TEXT' and (jsonb_typeof(_content->'content') is distinct from 'string' or length(btrim(_content->>'content')) not between 1 and 2000) then raise exception 'Invalid message text';end if;
 if _type='ORDER_CARD' and not exists(select 1 from public.tiktok_orders where order_number=_content->>'order_id' and api_buyer_id=c.buyer_id) then raise exception 'Order does not belong to this buyer';end if;
 update public.tiktok_chat_sends set status='unknown',error='No final receipt was saved. Check TikTok before sending again.' where conversation_id=c.id and status='sending' and created_at<now()-interval '2 minutes';
 select * into s from public.tiktok_chat_sends where id=_id;
 if found then
  if s.conversation_id<>_conversation or s.author<>_actor or s.fingerprint<>_fingerprint or s.type<>_type then raise exception 'Send request does not match its original message';end if;
  return jsonb_build_object('dispatch',false,'attempt',to_jsonb(s));
 end if;
 select * into s from public.tiktok_chat_sends where conversation_id=c.id and fingerprint=_fingerprint and
 (status in('sending','unknown') or status='sent' and created_at>now()-interval '2 minutes') order by created_at desc limit 1;
 if found then return jsonb_build_object('dispatch',false,'attempt',to_jsonb(s));end if;
 if exists(select 1 from public.tiktok_chat_sends where conversation_id=c.id and status='sending') then raise exception 'A message is still being sent to this buyer. Check its status first.';end if;
 if (select count(*) from public.tiktok_chat_sends where author=_actor and created_at>now()-interval '1 minute')>=30 then raise exception 'Please wait before sending more messages.';end if;
 insert into public.tiktok_chat_sends(id,conversation_id,author,author_name,conversation_revision,type,content,fingerprint)
 values(_id,c.id,_actor,staff_name,c.revision,_type,_content,_fingerprint) returning * into s;
 return jsonb_build_object('dispatch',true,'attempt',to_jsonb(s));
end$$;

create function public.finish_tiktok_chat_send(_id uuid,_status text,_message_id text,_error text) returns public.tiktok_chat_sends
language plpgsql security definer set search_path='' as $$
declare s public.tiktok_chat_sends;
begin
 if _status not in('sent','failed','unknown') or _status='sent' and coalesce(_message_id,'')!~'^\d{10,30}$' then raise exception 'Invalid message receipt';end if;
 -- Use the same conversation-then-receipt lock order as claim_tiktok_chat_send.
 perform 1 from public.tiktok_chat_conversations where id=(select conversation_id from public.tiktok_chat_sends where id=_id) for update;
 update public.tiktok_chat_sends set status=_status,provider_message_id=_message_id,error=left(_error,300),finished_at=now()
 where id=_id and status in('sending','unknown') returning * into s;
 if not found then select * into s from public.tiktok_chat_sends where id=_id;return s;end if;
 if _status='sent' then
  update public.tiktok_chat_conversations set triage_status='waiting',triage_updated_by=s.author,triage_updated_at=now(),revision=revision+1
  where id=s.conversation_id and revision=s.conversation_revision;
 end if;
 return s;
end$$;

create function public.review_tiktok_chat_send(_id uuid) returns public.tiktok_chat_sends
language plpgsql security definer set search_path='' as $$
declare s public.tiktok_chat_sends;
begin
 if not public.can_access_tiktok_messages() then raise exception 'Messaging access required';end if;
 update public.tiktok_chat_sends set status='not_sent',reviewed_by=auth.uid(),reviewed_at=now()
 where id=_id and status='unknown' returning * into s;
 if not found then raise exception 'Refresh this chat before reviewing its send status.';end if;
 return s;
end$$;
revoke all on function public.claim_tiktok_chat_send(uuid,uuid,uuid,text,jsonb,text),public.finish_tiktok_chat_send(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.claim_tiktok_chat_send(uuid,uuid,uuid,text,jsonb,text),public.finish_tiktok_chat_send(uuid,text,text,text) to service_role;
revoke all on function public.review_tiktok_chat_send(uuid) from public,anon;
grant execute on function public.review_tiktok_chat_send(uuid) to authenticated;
commit;
