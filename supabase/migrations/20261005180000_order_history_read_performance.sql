-- PostgREST prepares the status list as a parameter. A generic plan cannot
-- prove the closed-status predicate on the existing partial history index.
-- The date comparison does imply IS NOT NULL, including for generic plans.
create index if not exists ebay_order_lines_history_date_idx
  on public.ebay_order_lines (fulfilled_at desc, id desc)
  where fulfilled_at is not null;

create index if not exists ebay_order_admin_events_created_at_idx
  on public.ebay_order_admin_events (created_at desc);
create index if not exists ebay_order_admin_events_line_ids_idx
  on public.ebay_order_admin_events using gin (order_line_ids);
create index if not exists ebay_order_label_events_line_ids_idx
  on public.ebay_order_label_events using gin (order_line_ids);

-- These no-argument, row-independent authorization checks have the same
-- result for every row in a statement. InitPlans avoid repeating the employee
-- lookup. Preserve roles, policy commands, WITH CHECK and row-scoped rules.
do $history_read_policies$
declare
  policy record;
  optimized text;
begin
  for policy in
    select tablename, policyname, qual
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'ebay_orders', 'ebay_order_lines', 'ebay_order_admin_events',
        'ebay_order_revert_events', 'ebay_order_label_events',
        'ebay_order_tasks', 'ebay_order_task_events',
        'ebay_return_cases', 'ebay_return_items', 'ebay_return_events'
      ])
      and cmd in ('SELECT', 'ALL')
      and qual in (
        'can_manage_inventory()', 'is_admin()', 'can_access_post_order_issues()',
        '(can_manage_inventory() OR can_access_post_order_issues())'
      )
  loop
    optimized := replace(policy.qual, 'can_manage_inventory()', '(select public.can_manage_inventory())');
    optimized := replace(optimized, 'is_admin()', '(select public.is_admin())');
    optimized := replace(optimized, 'can_access_post_order_issues()', '(select public.can_access_post_order_issues())');
    execute format('alter policy %I on public.%I using (%s)', policy.policyname, policy.tablename, optimized);
  end loop;
end
$history_read_policies$;

notify pgrst, 'reload schema';
