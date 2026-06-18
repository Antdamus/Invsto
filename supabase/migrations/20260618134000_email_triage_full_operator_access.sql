-- Finish widening Email Triage from "page can open" to "operator can use it".
-- New migration on purpose: deployed Supabase databases do not replay edited old files.

do $$
declare
  v_fn record;
  v_sql text;
  v_updated text;
begin
  for v_fn in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'reconcile_ebay_conversation_classification_runs',
        'create_ebay_conversation_message_task',
        'list_ebay_conversation_message_task_status',
        'list_team_task_assignees',
        'get_ebay_canonical_mailbox',
        'get_ebay_canonical_mailbox_v2',
        'count_ebay_unclassified_conversations',
        'get_ebay_unclassified_conversation_queue',
        'mark_ebay_conversation_read',
        'mark_ebay_conversation_unread'
      )
  loop
    v_sql := pg_get_functiondef(v_fn.oid);
    v_updated := replace(v_sql, 'public.can_manage_inventory()', 'public.can_access_email_triage()');
    v_updated := replace(v_updated, 'if not public.is_admin() then', 'if not public.can_access_email_triage() then');

    if v_updated is distinct from v_sql then
      execute v_updated;
    end if;
  end loop;
end $$;

comment on function public.can_access_email_triage()
  is 'Returns true for active admins and active employees explicitly granted Email Triage access; used by Email Triage UI, RPCs, and Edge Function operators.';
