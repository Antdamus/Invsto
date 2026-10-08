begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- One scoped scan for the entire mailbox, rather than one function call per chat.
create function public.list_email_triage_task_counts()
returns table(conversation_id text,task_count integer,pending_task_count integer)
language sql stable security definer set search_path='' as $$
 with access as materialized (
  select auth.uid() is not null as signed_in,
   public.can_access_email_triage() as team_allowed,public.can_manage_inventory() as orders_allowed
 ), tasks as (
  select t.metadata->>'conversation_id' conversation_id,t.status
   from public.team_tasks t cross join access a
   where a.signed_in and a.team_allowed and t.metadata->>'source'='ebay_conversation_message'
    and t.metadata->>'conversation_id' is not null and t.metadata->>'history_removed_at' is null
  union all
  select t.metadata->>'conversation_id',t.status
   from public.ebay_order_tasks t cross join access a
   where a.signed_in and a.orders_allowed and t.metadata ? 'conversation_id'
    and t.metadata->>'history_removed_at' is null
 )
 select conversation_id,count(*)::integer,
  count(*) filter(where status not in ('resolved','cancelled','approved_by_admin','approved_for_shipping','shipped_completed','closed'))::integer
 from tasks group by conversation_id;
$$;
revoke all on function public.list_email_triage_task_counts() from public,anon;
grant execute on function public.list_email_triage_task_counts() to authenticated;

do $migration$
declare
 signature regprocedure:='public.get_ebay_canonical_mailbox_v2(integer,integer,text,text[],jsonb,jsonb)'::regprocedure;
 definition text:=pg_get_functiondef(signature);
 old_fragment text;
begin
 old_fragment:=substring(definition from 'left join lateral\s*\(\s*select \* from public.email_triage_conversation_task_counts\(c.id\)\) task_stats on true');
 if old_fragment is null or position('with base as materialized (' in definition)=0 then
  raise exception 'Mailbox query changed; inspect before applying bulk task counts';
 end if;
 definition:=replace(definition,'with base as materialized (','with mailbox_task_counts as materialized (select * from public.list_email_triage_task_counts()), base as materialized (');
 execute replace(definition,old_fragment,'left join mailbox_task_counts task_stats on task_stats.conversation_id=c.id::text');
end $migration$;
notify pgrst,'reload schema';
commit;
