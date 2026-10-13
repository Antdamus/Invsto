begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Only explicit staff actions establish a team read. Provider read flags and
-- opening a timeline are deliberately not evidence that a staff member read it.
create table public.ebay_message_team_reads (
 message_id uuid primary key references public.ebay_conversation_messages(id) on delete cascade,
 is_read boolean not null,
 first_read_by uuid,
 first_read_name text,
 first_read_at timestamptz,
 last_read_by uuid,
 last_read_name text,
 last_read_at timestamptz,
 changed_by uuid not null,
 changed_at timestamptz not null default now()
);
create table public.ebay_message_read_events (
 id uuid primary key default gen_random_uuid(),
 message_id uuid not null references public.ebay_conversation_messages(id) on delete cascade,
 conversation_id uuid not null references public.ebay_conversations(id) on delete cascade,
 is_read boolean not null,
 actor_user_id uuid not null,
 actor_name text not null,
 created_at timestamptz not null default now()
);
create index ebay_message_read_events_conversation_idx on public.ebay_message_read_events(conversation_id,created_at desc);
alter table public.ebay_message_team_reads enable row level security;
alter table public.ebay_message_read_events enable row level security;
revoke all on public.ebay_message_team_reads,public.ebay_message_read_events from public,anon,authenticated;
grant select on public.ebay_message_team_reads,public.ebay_message_read_events to authenticated;
create policy team_read_select on public.ebay_message_team_reads for select to authenticated using ((select public.can_access_email_triage()));
create policy read_event_select on public.ebay_message_read_events for select to authenticated using ((select public.can_access_email_triage()));

-- Preserve the explicit personal read receipts that already exist. Only
-- messages present at the time of that action can inherit that receipt.
insert into public.ebay_message_team_reads(message_id,is_read,first_read_by,first_read_name,first_read_at,last_read_by,last_read_name,last_read_at,changed_by,changed_at)
select m.id,true,first_read.user_id,first_read.reader,first_read.read_at,last_read.user_id,last_read.reader,last_read.read_at,last_read.user_id,last_read.read_at
from public.ebay_conversation_messages m
cross join lateral (
 select r.user_id,r.read_at,coalesce(nullif(e.display_name,''),e.email,'Staff member') reader
 from public.ebay_conversation_user_read_states r left join public.employees e on e.user_id=r.user_id
 where r.conversation_id=m.conversation_id and r.read_at is not null
  and m.created_at<=r.read_at and coalesce(m.created_at_ebay,m.created_at)<=least(r.read_at,coalesce(r.latest_message_created_at,r.read_at))
 order by r.read_at,r.user_id limit 1
) first_read
cross join lateral (
 select r.user_id,r.read_at,coalesce(nullif(e.display_name,''),e.email,'Staff member') reader
 from public.ebay_conversation_user_read_states r left join public.employees e on e.user_id=r.user_id
 where r.conversation_id=m.conversation_id and r.read_at is not null
  and m.created_at<=r.read_at and coalesce(m.created_at_ebay,m.created_at)<=least(r.read_at,coalesce(r.latest_message_created_at,r.read_at))
 order by r.read_at desc,r.user_id limit 1
) last_read
where m.direction<>'outbound';
insert into public.ebay_message_read_events(message_id,conversation_id,is_read,actor_user_id,actor_name,created_at)
select r.message_id,m.conversation_id,true,r.first_read_by,r.first_read_name,r.first_read_at
from public.ebay_message_team_reads r join public.ebay_conversation_messages m on m.id=r.message_id;
insert into public.ebay_message_read_events(message_id,conversation_id,is_read,actor_user_id,actor_name,created_at)
select r.message_id,m.conversation_id,true,r.last_read_by,r.last_read_name,r.last_read_at
from public.ebay_message_team_reads r join public.ebay_conversation_messages m on m.id=r.message_id
where r.last_read_at>r.first_read_at or r.last_read_by is distinct from r.first_read_by;

create function public.get_ebay_team_read_status(_conversation_ids uuid[])
returns table(conversation_id uuid,is_read boolean,read_by text,read_at timestamptz,message_states jsonb)
language sql stable security definer set search_path='' as $$
 select c.id,
  coalesce(s.incoming>0 and s.unread=0,false)
   and (c.latest_message_id is null or exists(select 1 from public.ebay_conversation_messages latest where latest.conversation_id=c.id and latest.ebay_message_id=c.latest_message_id)),
  s.read_by,s.read_at,coalesce(s.message_states,'[]'::jsonb)
 from public.ebay_conversations c
 left join lateral (
  select count(*) incoming,count(*) filter(where not coalesce(r.is_read,false)) unread,
   (array_agg(r.last_read_name order by r.last_read_at desc nulls last) filter(where r.last_read_at is not null))[1] read_by,
   max(r.last_read_at) read_at,
   jsonb_agg(jsonb_build_object('message_id',m.id,'is_read',coalesce(r.is_read,false),'read_by',r.last_read_name,'read_at',r.last_read_at,'first_read_by',r.first_read_name,'first_read_at',r.first_read_at)) message_states
  from public.ebay_conversation_messages m left join public.ebay_message_team_reads r on r.message_id=m.id
  where m.conversation_id=c.id and m.direction<>'outbound'
 ) s on true
 where auth.uid() is not null and public.can_access_email_triage() and c.id=any(_conversation_ids)
$$;

create function public.set_ebay_team_read_state(_conversation_id uuid,_read_state text,_message_id uuid default null,_latest_message_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); reader text; c public.ebay_conversations; m record; reading boolean; stamp timestamptz:=now();
begin
 if actor is null or not public.can_access_email_triage() then raise exception 'Email triage access required' using errcode='42501'; end if;
 if _read_state not in ('read','unread') or _read_state is null then raise exception 'Invalid read state'; end if;
 reading:=_read_state='read';
 select * into c from public.ebay_conversations where id=_conversation_id for update;
 if not found then raise exception 'Conversation not found'; end if;
 if _message_id is null and c.latest_message_id is distinct from _latest_message_id then
  raise exception 'A new message arrived. Refresh the conversation before marking it read.';
 end if;
 if _message_id is null and (not exists(select 1 from public.ebay_conversation_messages where conversation_id=c.id and direction<>'outbound')
  or (c.latest_message_id is not null and not exists(select 1 from public.ebay_conversation_messages where conversation_id=c.id and ebay_message_id=c.latest_message_id))) then
  raise exception 'Open and refresh this conversation to load the latest messages before marking read.';
 end if;
 if _message_id is not null and not exists(select 1 from public.ebay_conversation_messages where id=_message_id and conversation_id=c.id and direction<>'outbound') then
  raise exception 'Incoming message not found in this conversation';
 end if;
 select coalesce(nullif(display_name,''),email,'Staff member') into reader from public.employees where user_id=actor limit 1;
 reader:=coalesce(reader,'Staff member');
 for m in select id from public.ebay_conversation_messages where conversation_id=c.id and direction<>'outbound' and (_message_id is null or id=_message_id) order by id loop
  insert into public.ebay_message_team_reads as r(message_id,is_read,first_read_by,first_read_name,first_read_at,last_read_by,last_read_name,last_read_at,changed_by,changed_at)
  values(m.id,reading,case when reading then actor end,case when reading then reader end,case when reading then stamp end,case when reading then actor end,case when reading then reader end,case when reading then stamp end,actor,stamp)
  on conflict(message_id) do update set is_read=excluded.is_read,
   first_read_by=coalesce(r.first_read_by,excluded.first_read_by),first_read_name=coalesce(r.first_read_name,excluded.first_read_name),first_read_at=coalesce(r.first_read_at,excluded.first_read_at),
   last_read_by=coalesce(excluded.last_read_by,r.last_read_by),last_read_name=coalesce(excluded.last_read_name,r.last_read_name),last_read_at=coalesce(excluded.last_read_at,r.last_read_at),changed_by=actor,changed_at=stamp;
  insert into public.ebay_message_read_events(message_id,conversation_id,is_read,actor_user_id,actor_name,created_at) values(m.id,c.id,reading,actor,reader,stamp);
 end loop;
 return (select to_jsonb(s) from public.get_ebay_team_read_status(array[c.id]) s);
end $$;

create function public.get_ebay_daily_read_activity(_date date,_state text default 'all',_offset int default 0,_limit int default 30)
returns jsonb language sql stable security definer set search_path='' as $$
 with candidates as materialized (
  select c.id,c.other_party_username,c.conversation_title,c.latest_message_preview,c.latest_message_id,
   greatest(c.latest_message_created_at,c.last_message_created_at,(select max(coalesce(m.created_at_ebay,m.created_at)) from public.ebay_conversation_messages m where m.conversation_id=c.id),c.first_message_created_at) activity_at
  from public.ebay_conversations c where auth.uid() is not null and public.can_access_email_triage()
 ), dated as materialized (
  select * from candidates where (activity_at at time zone 'America/New_York')::date=_date
 ), classified as materialized (
  select d.*,s.is_read,s.read_by,s.read_at from dated d
  join public.get_ebay_team_read_status(array(select id from dated)) s on s.conversation_id=d.id
 ), filtered as (
  select * from classified where _state='all' or (_state='read' and is_read) or (_state='unread' and not is_read)
 ), page as (
  select * from filtered order by activity_at desc,id offset greatest(0,_offset) limit least(100,greatest(1,_limit))
 ) select jsonb_build_object('date',_date,'timezone','America/New_York',
  'counts',(select jsonb_build_object('all',count(*),'read',count(*) filter(where is_read),'unread',count(*) filter(where not is_read)) from classified),
  'total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(p) order by activity_at desc,id) from page p),'[]'::jsonb))
$$;
create function public.get_ebay_read_history(_conversation_id uuid,_offset int default 0)
returns table(actor_name text,is_read boolean,created_at timestamptz,subject text,message_body_preview text)
language sql stable security definer set search_path='' as $$
 select e.actor_name,e.is_read,e.created_at,m.subject,m.message_body_preview
 from public.ebay_message_read_events e join public.ebay_conversation_messages m on m.id=e.message_id
 where auth.uid() is not null and public.can_access_email_triage() and e.conversation_id=_conversation_id
 order by e.created_at desc,e.id offset greatest(0,_offset) limit 50
$$;
revoke all on function public.get_ebay_team_read_status(uuid[]),public.set_ebay_team_read_state(uuid,text,uuid,text),public.get_ebay_daily_read_activity(date,text,int,int),public.get_ebay_read_history(uuid,int) from public,anon;
grant execute on function public.get_ebay_team_read_status(uuid[]),public.set_ebay_team_read_state(uuid,text,uuid,text),public.get_ebay_daily_read_activity(date,text,int,int),public.get_ebay_read_history(uuid,int) to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.ebay_message_team_reads;
 end if;
end $$;
notify pgrst,'reload schema';
commit;
