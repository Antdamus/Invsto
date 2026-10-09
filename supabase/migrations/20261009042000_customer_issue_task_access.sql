begin;
set local lock_timeout='3s';
create trigger apply_task_request_intent before insert or update of assigned_to_user_id
 on public.ebay_return_tasks for each row execute function public.apply_task_request_intent();
-- Return staff already have explicit access to these cases. Apply that same
-- access to the shared task actions, without granting inventory/team access.
do $$
declare name text;definition text;changed text;source_parameter text;
begin
 foreach name in array array['reply_to_task','respond_task_request','advance_task_workflow'] loop
  select pg_get_functiondef(p.oid) into strict definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name;
  source_parameter:=case when name='reply_to_task' then '_task_source' else '_source' end;
  changed:=replace(definition,'not public.can_manage_inventory()',format('not (public.can_manage_inventory() or (%s=''return'' and public.can_access_post_order_issues()))',source_parameter));
  if changed=definition then raise exception 'Task authorization signature changed: %',name;end if;
  execute changed;
 end loop;
 select pg_get_functiondef('public.prevent_non_admin_task_reassignment()'::regprocedure) into definition;
 changed:=replace(definition,'public.can_manage_inventory() and auth.uid()',
  '(public.can_manage_inventory() or (TG_TABLE_NAME=''ebay_return_tasks'' and public.can_access_post_order_issues())) and auth.uid()');
 if changed=definition then raise exception 'Task reassignment guard changed';end if;
 execute changed;
end $$;
commit;
