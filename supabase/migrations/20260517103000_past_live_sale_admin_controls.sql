-- Admin controls for past live-sale review.
-- These keep live-sale edits and archival actions out of silent table updates.

alter table public.live_sale_sessions
  drop constraint if exists live_sale_sessions_status_check;

alter table public.live_sale_sessions
  add constraint live_sale_sessions_status_check
  check (status in ('active', 'ended', 'cancelled', 'archived'));

create or replace function public.admin_update_live_sale_session(
  _session_id uuid,
  _title text,
  _notes text,
  _reason text,
  _signed_by_email text default null
)
returns public.live_sale_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.live_sale_sessions;
  v_session public.live_sale_sessions;
  v_title text := nullif(btrim(coalesce(_title, '')), '');
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit live sale sessions' using errcode = '42501';
  end if;

  if _session_id is null then
    raise exception 'Live sale session is required' using errcode = '22023';
  end if;

  if v_title is null then
    raise exception 'Session title is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief explanation is required' using errcode = '22023';
  end if;

  select *
    into v_old
  from public.live_sale_sessions
  where id = _session_id
  for update;

  if not found then
    raise exception 'Live sale session not found' using errcode = 'P0002';
  end if;

  update public.live_sale_sessions
  set title = v_title,
      notes = nullif(btrim(coalesce(_notes, '')), '')
  where id = v_old.id
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
    'session_admin_updated',
    auth.uid(),
    v_signed_email,
    v_reason,
    jsonb_build_object(
      'old', jsonb_build_object(
        'title', v_old.title,
        'notes', v_old.notes
      ),
      'new', jsonb_build_object(
        'title', v_session.title,
        'notes', v_session.notes
      )
    )
  );

  return v_session;
end;
$$;

create or replace function public.admin_archive_live_sale_session(
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
  v_old public.live_sale_sessions;
  v_session public.live_sale_sessions;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can archive live sale sessions' using errcode = '42501';
  end if;

  if _session_id is null then
    raise exception 'Live sale session is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief explanation is required' using errcode = '22023';
  end if;

  select *
    into v_old
  from public.live_sale_sessions
  where id = _session_id
  for update;

  if not found then
    raise exception 'Live sale session not found' using errcode = 'P0002';
  end if;

  if v_old.status = 'active' then
    raise exception 'Cancel or end the active live sale before archiving it' using errcode = '22023';
  end if;

  update public.live_sale_sessions
  set status = 'archived',
      ended_at = coalesce(ended_at, now()),
      notes = concat_ws(' | ', nullif(notes, ''), v_reason)
  where id = v_old.id
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
    'session_archived',
    auth.uid(),
    v_signed_email,
    v_reason,
    jsonb_build_object(
      'old_status', v_old.status,
      'new_status', v_session.status,
      'archived_at', now()
    )
  );

  return v_session;
end;
$$;

create or replace function public.admin_update_live_sale_lot(
  _lot_id uuid,
  _auction_number text,
  _notes text,
  _reason text,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.live_sale_lots;
  v_lot public.live_sale_lots;
  v_auction_number text := nullif(btrim(coalesce(_auction_number, '')), '');
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can edit live sale bags' using errcode = '42501';
  end if;

  if _lot_id is null then
    raise exception 'Live sale bag is required' using errcode = '22023';
  end if;

  if v_auction_number is null then
    raise exception 'Auction number is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief explanation is required' using errcode = '22023';
  end if;

  select *
    into v_old
  from public.live_sale_lots
  where id = _lot_id
  for update;

  if not found then
    raise exception 'Live sale bag not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.live_sale_lots other_lot
    where other_lot.session_id = v_old.session_id
      and other_lot.id <> v_old.id
      and lower(btrim(other_lot.auction_number)) = lower(v_auction_number)
  ) then
    raise exception 'Auction number already exists in this live sale session' using errcode = '23505';
  end if;

  update public.live_sale_lots
  set auction_number = v_auction_number,
      notes = nullif(btrim(coalesce(_notes, '')), '')
  where id = v_old.id
  returning * into v_lot;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor,
    actor_email,
    notes,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_admin_updated',
    auth.uid(),
    v_signed_email,
    v_reason,
    jsonb_build_object(
      'old', jsonb_build_object(
        'auction_number', v_old.auction_number,
        'notes', v_old.notes
      ),
      'new', jsonb_build_object(
        'auction_number', v_lot.auction_number,
        'notes', v_lot.notes
      )
    )
  );

  return v_lot;
end;
$$;

create or replace function public.record_live_sale_label_reprint(
  _lot_id uuid,
  _label_path text default null,
  _signed_by_email text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.live_sale_lots;
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to record live sale label reprints' using errcode = '42501';
  end if;

  select *
    into v_lot
  from public.live_sale_lots
  where id = _lot_id;

  if not found then
    raise exception 'Live sale bag not found' using errcode = 'P0002';
  end if;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor,
    actor_email,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    'lot_label_reprinted',
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'label_path', coalesce(nullif(btrim(_label_path), ''), v_lot.label_path),
      'auction_number', v_lot.auction_number,
      'lot_code', v_lot.lot_code,
      'reprinted_at', now()
    )
  );
end;
$$;

revoke all on function public.admin_update_live_sale_session(uuid, text, text, text, text) from public;
revoke all on function public.admin_archive_live_sale_session(uuid, text, text) from public;
revoke all on function public.admin_update_live_sale_lot(uuid, text, text, text, text) from public;
revoke all on function public.record_live_sale_label_reprint(uuid, text, text) from public;

grant execute on function public.admin_update_live_sale_session(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_archive_live_sale_session(uuid, text, text) to authenticated;
grant execute on function public.admin_update_live_sale_lot(uuid, text, text, text, text) to authenticated;
grant execute on function public.record_live_sale_label_reprint(uuid, text, text) to authenticated;
