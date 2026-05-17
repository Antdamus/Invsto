-- Cancel an active live-sale session with a complete audit trail.
-- This is intentionally a soft delete: the session disappears from active work,
-- while the historical session/lots/events remain available for review.

create or replace function public.cancel_live_sale_session(
  _session_id uuid,
  _reason text,
  _signed_by_email text default null
)
returns public.live_sale_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sale_sessions;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_cancelled_lots integer := 0;
  v_cancelled_items integer := 0;
  v_packed_lots integer := 0;
  v_item_ids uuid[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to cancel live sale sessions' using errcode = '42501';
  end if;

  if _session_id is null then
    raise exception 'Live sale session is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief explanation is required to cancel a live sale session' using errcode = '22023';
  end if;

  select *
    into v_session
  from public.live_sale_sessions
  where id = _session_id
    and status = 'active'
  for update;

  if not found then
    raise exception 'Active live sale session not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct item_id) filter (where item_id is not null), '{}'::uuid[])
    into v_item_ids
  from public.live_sale_lot_items
  where session_id = v_session.id
    and status = 'reserved';

  update public.live_sale_lot_items
  set status = 'cancelled',
      notes = concat_ws(' | ', nullif(notes, ''), v_reason)
  where session_id = v_session.id
    and status = 'reserved';
  get diagnostics v_cancelled_items = row_count;

  update public.live_sale_lots
  set status = 'cancelled',
      closed_at = coalesce(closed_at, now()),
      notes = concat_ws(' | ', nullif(notes, ''), v_reason)
  where session_id = v_session.id
    and status in ('open', 'reserved');
  get diagnostics v_cancelled_lots = row_count;

  select count(*)::integer
    into v_packed_lots
  from public.live_sale_lots
  where session_id = v_session.id
    and status = 'packed';

  update public.live_sale_sessions
  set status = 'cancelled',
      ended_at = now(),
      notes = concat_ws(' | ', nullif(notes, ''), v_reason)
  where id = v_session.id
  returning * into v_session;

  insert into public.live_sale_events (
    session_id,
    event_type,
    actor,
    actor_email,
    notes,
    payload
  )
  values (
    v_session.id,
    'session_cancelled',
    auth.uid(),
    v_signed_email,
    v_reason,
    jsonb_build_object(
      'session_code', v_session.session_code,
      'title', v_session.title,
      'store_id', v_session.store_id,
      'cancelled_lots', v_cancelled_lots,
      'cancelled_reserved_items', v_cancelled_items,
      'packed_lots_left_unchanged', coalesce(v_packed_lots, 0),
      'affected_item_ids', coalesce(to_jsonb(v_item_ids), '[]'::jsonb),
      'cancelled_by_email', v_signed_email,
      'cancelled_at', now()
    )
  );

  return v_session;
end;
$$;

revoke all on function public.cancel_live_sale_session(uuid, text, text) from public;
grant execute on function public.cancel_live_sale_session(uuid, text, text) to authenticated;
