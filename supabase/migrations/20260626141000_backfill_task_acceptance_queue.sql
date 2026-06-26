-- Backfill old completed task responses into the new acceptance queue.
-- Dry-run by default so admins can preview exactly what will be moved.

create or replace function public.backfill_task_acceptance_queue(
  _dry_run boolean default true,
  _since timestamptz default null,
  _limit integer default 500,
  _include_team_tasks boolean default true,
  _include_order_tasks boolean default true
)
returns table (
  task_source text,
  task_id uuid,
  old_status text,
  new_status text,
  title text,
  assigned_to_email text,
  reviewer_email text,
  reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(_limit, 500), 5000));
  v_team record;
  v_order record;
  v_note text;
  v_actor_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
begin
  if not (public.current_user_is_employee_admin() or public.is_admin()) then
    raise exception 'Only admins can backfill task acceptance records' using errcode = '42501';
  end if;

  if _include_team_tasks then
    for v_team in
      select
        t.*,
        coalesce(t.assigned_by_email, t.created_by_email, 'admin') as acceptance_reviewer_email
      from public.team_tasks t
      where t.status = 'resolved'
        and t.metadata ->> 'history_removed_at' is null
        and (_since is null or coalesce(t.resolved_at, t.updated_at, t.created_at) >= _since)
        and (t.assigned_to_user_id is not null or nullif(btrim(coalesce(t.assigned_to_email, '')), '') is not null)
        and (
          t.resolved_by = t.assigned_to_user_id
          or lower(coalesce(t.resolved_by_email, '')) = lower(coalesce(t.assigned_to_email, ''))
          or exists (
            select 1
            from public.team_task_events e
            where e.task_id = t.id
              and e.action in ('resolved', 'status_changed', 'commented')
              and nullif(btrim(coalesce(e.notes, '')), '') is not null
              and (
                e.signed_by = t.assigned_to_user_id
                or lower(coalesce(e.signed_by_email, '')) = lower(coalesce(t.assigned_to_email, ''))
              )
          )
        )
      order by coalesce(t.resolved_at, t.updated_at, t.created_at) desc
      limit v_limit
    loop
      v_note := coalesce(
        nullif(btrim(coalesce(v_team.resolution_notes, '')), ''),
        nullif(btrim(coalesce(v_team.latest_note, '')), ''),
        'Backfilled to needs acceptance after prior completion response.'
      );

      if not _dry_run then
        update public.team_tasks
        set status = 'completed_by_employee',
            resolved_at = null,
            resolved_by = null,
            resolved_by_email = null,
            resolution_notes = v_note,
            latest_note = coalesce(nullif(btrim(v_note), ''), latest_note),
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
              'acceptance_backfilled_at', now(),
              'acceptance_backfilled_by', auth.uid(),
              'acceptance_backfill_source_status', v_team.status,
              'acceptance_backfill_previous_resolved_at', v_team.resolved_at,
              'acceptance_backfill_previous_resolved_by', v_team.resolved_by,
              'acceptance_backfill_previous_resolved_by_email', v_team.resolved_by_email
            )
        where id = v_team.id;

        insert into public.team_task_events (
          task_id,
          action,
          old_status,
          new_status,
          old_assigned_to_user_id,
          new_assigned_to_user_id,
          notes,
          photo_attachments,
          signed_by,
          signed_by_email,
          payload
        )
        values (
          v_team.id,
          'completed_by_employee',
          v_team.status,
          'completed_by_employee',
          v_team.assigned_to_user_id,
          v_team.assigned_to_user_id,
          v_note,
          '[]'::jsonb,
          auth.uid(),
          v_actor_email,
          jsonb_build_object(
            'backfill', true,
            'dry_run', false,
            'acceptance_reviewer_email', v_team.acceptance_reviewer_email,
            'previous_resolved_at', v_team.resolved_at,
            'previous_resolved_by', v_team.resolved_by,
            'previous_resolved_by_email', v_team.resolved_by_email
          )
        );
      end if;

      task_source := 'team';
      task_id := v_team.id;
      old_status := v_team.status;
      new_status := 'completed_by_employee';
      title := v_team.title;
      assigned_to_email := v_team.assigned_to_email;
      reviewer_email := v_team.acceptance_reviewer_email;
      reason := case
        when _dry_run then 'Dry run: prior assignee completion would move to Needs acceptance.'
        else 'Moved prior assignee completion to Needs acceptance.'
      end;
      return next;
    end loop;
  end if;

  if _include_order_tasks then
    for v_order in
      select
        t.*,
        coalesce(t.assigned_by_email, t.created_by_email, 'admin') as acceptance_reviewer_email
      from public.ebay_order_tasks t
      where t.status = 'resolved'
        and t.metadata ->> 'history_removed_at' is null
        and (_since is null or coalesce(t.resolved_at, t.updated_at, t.created_at) >= _since)
        and (t.assigned_to_user_id is not null or nullif(btrim(coalesce(t.assigned_to_email, '')), '') is not null)
        and t.status not in ('cancelled', 'shipped_completed', 'closed')
        and (
          t.resolved_by = t.assigned_to_user_id
          or lower(coalesce(t.resolved_by_email, '')) = lower(coalesce(t.assigned_to_email, ''))
          or exists (
            select 1
            from public.ebay_order_task_events e
            where e.task_id = t.id
              and e.action in ('resolved', 'status_changed', 'progress_update', 'commented')
              and nullif(btrim(coalesce(e.notes, '')), '') is not null
              and (
                e.signed_by = t.assigned_to_user_id
                or lower(coalesce(e.signed_by_email, '')) = lower(coalesce(t.assigned_to_email, ''))
              )
          )
        )
      order by coalesce(t.resolved_at, t.updated_at, t.created_at) desc
      limit v_limit
    loop
      v_note := coalesce(
        nullif(btrim(coalesce(v_order.resolution_notes, '')), ''),
        nullif(btrim(coalesce(v_order.latest_note, '')), ''),
        nullif(btrim(coalesce(v_order.question, '')), ''),
        'Backfilled to needs acceptance after prior completion response.'
      );

      if not _dry_run then
        update public.ebay_order_tasks
        set status = 'completed_by_employee',
            completed_at = coalesce(completed_at, resolved_at, updated_at, now()),
            resolved_at = null,
            resolved_by = null,
            resolved_by_email = null,
            resolution_notes = v_note,
            latest_note = coalesce(nullif(btrim(v_note), ''), latest_note),
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
              'acceptance_backfilled_at', now(),
              'acceptance_backfilled_by', auth.uid(),
              'acceptance_backfill_source_status', v_order.status,
              'acceptance_backfill_previous_resolved_at', v_order.resolved_at,
              'acceptance_backfill_previous_resolved_by', v_order.resolved_by,
              'acceptance_backfill_previous_resolved_by_email', v_order.resolved_by_email
            )
        where id = v_order.id;

        insert into public.ebay_order_task_events (
          task_id,
          order_id,
          action,
          old_status,
          new_status,
          old_assigned_to_user_id,
          new_assigned_to_user_id,
          notes,
          photo_attachments,
          signed_by,
          signed_by_email,
          payload
        )
        values (
          v_order.id,
          v_order.order_id,
          'completed_by_employee',
          v_order.status,
          'completed_by_employee',
          v_order.assigned_to_user_id,
          v_order.assigned_to_user_id,
          v_note,
          '[]'::jsonb,
          auth.uid(),
          v_actor_email,
          jsonb_build_object(
            'backfill', true,
            'dry_run', false,
            'acceptance_reviewer_email', v_order.acceptance_reviewer_email,
            'previous_resolved_at', v_order.resolved_at,
            'previous_resolved_by', v_order.resolved_by,
            'previous_resolved_by_email', v_order.resolved_by_email
          )
        );

        if v_order.parent_task_id is not null and v_order.task_type = 'pending_subtask' then
          update public.ebay_order_tasks
          set status = case
                when public.ebay_order_required_subtasks_complete(v_order.parent_task_id) then 'ready_for_admin_approval'
                else 'waiting_on_subtasks'
              end,
              latest_note = coalesce(v_note, latest_note)
          where id = v_order.parent_task_id
            and status not in ('assigned_for_shipping', 'shipped_completed', 'closed', 'cancelled');
        end if;
      end if;

      task_source := 'order';
      task_id := v_order.id;
      old_status := v_order.status;
      new_status := 'completed_by_employee';
      title := v_order.title;
      assigned_to_email := v_order.assigned_to_email;
      reviewer_email := v_order.acceptance_reviewer_email;
      reason := case
        when _dry_run then 'Dry run: prior assignee completion would move to Needs acceptance.'
        else 'Moved prior assignee completion to Needs acceptance.'
      end;
      return next;
    end loop;
  end if;
end;
$$;

revoke all on function public.backfill_task_acceptance_queue(boolean, timestamptz, integer, boolean, boolean) from public;
grant execute on function public.backfill_task_acceptance_queue(boolean, timestamptz, integer, boolean, boolean) to authenticated;
