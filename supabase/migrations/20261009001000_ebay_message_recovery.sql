begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
alter table public.ebay_message_notifications add column if not exists recovery_attempts integer not null default 0;
alter table public.ebay_message_notifications add column if not exists recovery_after timestamptz not null default now();
create index if not exists ebay_message_notification_recovery_idx on public.ebay_message_notifications(recovery_after,received_at)
 where signature_verified and processing_status in ('received','sync_failed','sync_requested');
create index if not exists ebay_message_id_lookup_idx on public.ebay_conversation_messages(ebay_message_id,ebay_conversation_id);
alter table public.ebay_conversations add column if not exists message_recheck_after timestamptz;

create table public.ebay_message_recovery_worker (
 singleton boolean primary key default true check(singleton),
 dispatch_token uuid,lease_until timestamptz,claimed_at timestamptz,
 last_started_at timestamptz,last_completed_at timestamptz,last_error text,
 discovery_offset integer not null default 0,discovery_turn integer not null default 0,
 discovery_after timestamptz not null default now(),last_discovery_at timestamptz
);
insert into public.ebay_message_recovery_worker(singleton) values(true);
alter table public.ebay_message_recovery_worker enable row level security;
revoke all on public.ebay_message_recovery_worker from public,anon,authenticated;
grant all on public.ebay_message_recovery_worker to service_role;

create function public.claim_ebay_message_recovery(_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare worker public.ebay_message_recovery_worker; retries jsonb; recent jsonb; old_chat jsonb; discovery jsonb;
begin
 select * into worker from public.ebay_message_recovery_worker where singleton for update;
 if worker.dispatch_token is distinct from _token or _token is null or worker.lease_until<=now() or worker.claimed_at is not null then return null;end if;
 update public.ebay_message_recovery_worker set claimed_at=now(),last_started_at=now() where singleton;
 -- A prior attempt may already have ingested the notified message before its
 -- request timed out. Verify that evidence before spending another eBay call.
 update public.ebay_message_notifications n set processing_status='sync_succeeded',processed_at=now()
 where signature_verified and processing_status in ('received','sync_failed','sync_requested')
  and exists(select 1 from public.ebay_conversation_messages m where m.ebay_message_id=n.ebay_message_id and m.ebay_conversation_id=n.ebay_conversation_id);
 with picked as (
  select id from public.ebay_message_notifications
  where signature_verified and processing_status in ('received','sync_failed','sync_requested')
   and ebay_conversation_id is not null and recovery_after<=now() and received_at<now()-interval '2 minutes'
   and (processing_status<>'sync_requested' or coalesce(processed_at,received_at)<now()-interval '3 minutes')
  order by recovery_after,received_at limit 3 for update skip locked
 ), claimed as (
  update public.ebay_message_notifications n set recovery_attempts=recovery_attempts+1,recovery_after=now()+interval '4 minutes'
  from picked p where p.id=n.id returning n.id,n.ebay_conversation_id,n.conversation_type,n.ebay_message_id,n.recovery_attempts
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into retries from claimed;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into recent from (
  select ebay_conversation_id,conversation_type from public.ebay_conversations
  where conversation_type='FROM_MEMBERS' and latest_message_created_at>now()-interval '7 days'
   and coalesce(message_recheck_after,'epoch')<=now()
   and coalesce(last_detail_synced_at,'epoch')<now()-interval '2 minutes'
  order by last_detail_synced_at nulls first,id limit 2
 )c;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into old_chat from (
  select ebay_conversation_id,conversation_type from public.ebay_conversations
  where conversation_type='FROM_MEMBERS' and coalesce(last_detail_synced_at,'epoch')<now()-interval '1 day'
   and coalesce(message_recheck_after,'epoch')<=now()
  order by last_detail_synced_at nulls first,id limit 1
 )c;
 -- An unavailable/deleted old conversation must not starve the next one.
 update public.ebay_conversations c set message_recheck_after=now()+interval '5 minutes'
  where exists(select 1 from jsonb_array_elements(recent) x where x->>'ebay_conversation_id'=c.ebay_conversation_id);
 update public.ebay_conversations c set message_recheck_after=now()+interval '1 day'
  where exists(select 1 from jsonb_array_elements(old_chat) x where x->>'ebay_conversation_id'=c.ebay_conversation_id);
 if worker.discovery_after<=now() then
  discovery:=jsonb_build_object('offset',case when worker.discovery_turn%2=0 then 0 else worker.discovery_offset end,
   'archive',worker.discovery_turn%2=1);
 end if;
 return jsonb_build_object('retries',retries,'conversations',recent||old_chat,'discovery',discovery);
end $$;
revoke all on function public.claim_ebay_message_recovery(uuid) from public,anon,authenticated;
grant execute on function public.claim_ebay_message_recovery(uuid) to service_role;

create function public.finish_ebay_message_recovery(_token uuid,_error text default null,_discovery jsonb default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.ebay_message_recovery_worker set dispatch_token=null,lease_until=null,claimed_at=null,
  last_completed_at=case when _error is null then now() else last_completed_at end,last_error=left(_error,1000),
  discovery_offset=case when _discovery->>'archive'='true' then greatest(coalesce((_discovery->>'nextOffset')::integer,0),0) else discovery_offset end,
  discovery_turn=discovery_turn+case when _discovery is not null then 1 else 0 end,
  discovery_after=case when _discovery is not null then now()+interval '5 minutes' else discovery_after end,
  last_discovery_at=case when _discovery is not null then now() else last_discovery_at end
 where singleton and dispatch_token=_token and claimed_at is not null;
 return found;
end $$;
revoke all on function public.finish_ebay_message_recovery(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_ebay_message_recovery(uuid,text,jsonb) to service_role;

create function public.get_ebay_message_recovery_health() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(public.can_access_email_triage(),false) then raise exception 'not_authorized';end if;
 return (select jsonb_build_object('last_check',w.last_started_at,'last_completed',w.last_completed_at,
  'retrying',w.last_error is not null,'pending_retries',(select count(*) from public.ebay_message_notifications
    where signature_verified and processing_status in ('received','sync_requested','sync_failed')))
  from public.ebay_message_recovery_worker w where singleton);
end $$;
revoke all on function public.get_ebay_message_recovery_health() from public,anon;
grant execute on function public.get_ebay_message_recovery_health() to authenticated;
notify pgrst,'reload schema';
commit;
