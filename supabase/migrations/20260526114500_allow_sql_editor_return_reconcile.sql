create or replace function public.can_run_ebay_return_admin_maintenance()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    session_user in ('postgres', 'supabase_admin', 'service_role')
    or current_setting('request.jwt.claim.role', true) = 'service_role'
    or public.can_manage_inventory();
$$;

revoke all on function public.can_run_ebay_return_admin_maintenance() from public;
grant execute on function public.can_run_ebay_return_admin_maintenance() to authenticated;

create or replace function public.reconcile_ebay_return_task_duplicates(
  _dry_run boolean default true
)
returns table (
  return_case_id uuid,
  kept_task_id uuid,
  resolved_task_ids uuid[],
  resolved_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_run_ebay_return_admin_maintenance() then
    raise exception 'Not allowed to reconcile eBay return tasks' using errcode = '42501';
  end if;

  if _dry_run then
    return query
    with ranked as (
      select
        t.id,
        t.return_case_id,
        row_number() over (
          partition by t.return_case_id
          order by
            case
              when t.metadata ? 'returnLifecycleStage'
                or t.metadata ? 'sellerActionDue'
                or t.metadata ? 'sellerDecisionRequired'
                then 0
              else 1
            end,
            t.updated_at desc,
            t.created_at desc,
            t.id::text desc
        ) as rn,
        count(*) over (partition by t.return_case_id) as active_count
      from public.ebay_return_tasks t
      where t.task_type in ('return_review', 'return_intake')
        and t.status not in ('resolved', 'cancelled')
    )
    select
      r.return_case_id,
      (array_agg(r.id order by r.id) filter (where r.rn = 1))[1] as kept_task_id,
      coalesce(array_agg(r.id order by r.id) filter (where r.rn > 1), '{}'::uuid[]) as resolved_task_ids,
      coalesce(count(*) filter (where r.rn > 1), 0)::integer as resolved_count
    from ranked r
    where r.active_count > 1
    group by r.return_case_id
    having count(*) filter (where r.rn > 1) > 0;
    return;
  end if;

  return query
  with ranked as (
    select
      t.id,
      t.return_case_id,
      row_number() over (
        partition by t.return_case_id
        order by
          case
            when t.metadata ? 'returnLifecycleStage'
              or t.metadata ? 'sellerActionDue'
              or t.metadata ? 'sellerDecisionRequired'
              then 0
            else 1
          end,
          t.updated_at desc,
          t.created_at desc,
          t.id::text desc
      ) as rn,
      count(*) over (partition by t.return_case_id) as active_count
    from public.ebay_return_tasks t
    where t.task_type in ('return_review', 'return_intake')
      and t.status not in ('resolved', 'cancelled')
  ),
  grouped as (
    select
      r.return_case_id,
      (array_agg(r.id order by r.id) filter (where r.rn = 1))[1] as kept_task_id,
      coalesce(array_agg(r.id order by r.id) filter (where r.rn > 1), '{}'::uuid[]) as resolved_task_ids,
      coalesce(count(*) filter (where r.rn > 1), 0)::integer as resolved_count
    from ranked r
    where r.active_count > 1
    group by r.return_case_id
    having count(*) filter (where r.rn > 1) > 0
  ),
  resolved as (
    update public.ebay_return_tasks t
    set status = 'resolved',
        resolved_at = now(),
        resolved_by = auth.uid(),
        resolved_by_email = 'ebay-return-sync',
        resolution_notes = 'Resolved automatically because another active eBay return task superseded this duplicate.',
        metadata = coalesce(t.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'supersededAt', now(),
            'supersededByReturnTaskId', g.kept_task_id,
            'supersededSource', 'reconcile_ebay_return_task_duplicates'
          ),
        updated_at = now()
    from grouped g
    where t.id = any(g.resolved_task_ids)
    returning t.id, t.return_case_id
  ),
  task_events as (
    insert into public.ebay_return_task_events (
      task_id,
      return_case_id,
      action,
      old_status,
      new_status,
      notes,
      signed_by,
      signed_by_email,
      payload
    )
    select
      r.id,
      r.return_case_id,
      'resolved',
      null,
      'resolved',
      'Resolved automatically because another active eBay return task superseded this duplicate.',
      auth.uid(),
      'ebay-return-sync',
      jsonb_build_object('source', 'reconcile_ebay_return_task_duplicates')
    from resolved r
  )
  select
    g.return_case_id,
    g.kept_task_id,
    g.resolved_task_ids,
    g.resolved_count
  from grouped g;
end;
$$;

revoke all on function public.reconcile_ebay_return_task_duplicates(boolean) from public;
grant execute on function public.reconcile_ebay_return_task_duplicates(boolean) to authenticated;
