begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

create function public.email_triage_conversation_task_counts(_conversation_id uuid)
returns table(task_count integer,pending_task_count integer)
language sql stable security definer set search_path='' as $$
 select count(*)::integer,
 count(*) filter(where status not in ('resolved','cancelled','approved_by_admin','approved_for_shipping','shipped_completed','closed'))::integer
 from (
  select t.status from public.team_tasks t where auth.uid() is not null and public.can_access_email_triage()
   and t.metadata->>'source'='ebay_conversation_message' and t.metadata->>'conversation_id'=_conversation_id::text
   and t.metadata->>'history_removed_at' is null
  union all
  select t.status from public.ebay_order_tasks t where auth.uid() is not null and public.can_manage_inventory()
   and t.metadata ? 'conversation_id' and t.metadata->>'conversation_id'=_conversation_id::text
   and t.metadata->>'history_removed_at' is null
 ) tasks;
$$;
revoke all on function public.email_triage_conversation_task_counts(uuid) from public,anon;
grant execute on function public.email_triage_conversation_task_counts(uuid) to authenticated;

-- Preserve the deployed mailbox search and classification logic, replacing only
-- the legacy team-only task counter. Fail closed if that known fragment changes.
do $migration$
declare
 signature regprocedure:='public.get_ebay_canonical_mailbox_v2(integer,integer,text,text[],jsonb,jsonb)'::regprocedure;
 definition text:=pg_get_functiondef(signature);
 old_fragment text;
begin
 old_fragment:=substring(definition from 'select\s+count\(\*\)::integer as task_count[\s\S]*?\) task_stats on true');
 if old_fragment is null or position('from public.team_tasks t' in old_fragment)=0 then
  raise exception 'Mailbox task counter changed; inspect before applying';
 end if;
 execute replace(definition,old_fragment,'select * from public.email_triage_conversation_task_counts(c.id)) task_stats on true');
end $migration$;
notify pgrst,'reload schema';
commit;
