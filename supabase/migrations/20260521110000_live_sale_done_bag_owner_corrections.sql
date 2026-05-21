-- Let completed live-sale bags receive a signed owner correction.

drop function if exists public.update_live_sale_lot_owner(uuid, uuid, text);
drop function if exists public.update_live_sale_lot_owner(uuid, uuid, text, text);

create or replace function public.update_live_sale_lot_owner(
  _lot_id uuid,
  _owner_employee_id uuid,
  _signed_by_email text default null,
  _verified_owner_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.live_sale_lots;
  v_lot public.live_sale_lots;
  v_owner_snapshot jsonb := '{}'::jsonb;
  v_actor_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_verified_owner_email text := nullif(btrim(coalesce(_verified_owner_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update live sale bag owners' using errcode = '42501';
  end if;

  select *
    into v_old
  from public.live_sale_lots
  where id = _lot_id
    and status is distinct from 'cancelled';

  if not found then
    raise exception 'Editable live sale bag not found' using errcode = 'P0002';
  end if;

  if _owner_employee_id is null or not exists (
    select 1 from public.employees e
    where e.id = _owner_employee_id
      and e.active is distinct from false
  ) then
    raise exception 'Select an active owner for this auction bag' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'id', e.id,
    'display_name', e.display_name,
    'email', e.email,
    'role', e.role
  )
    into v_owner_snapshot
  from public.employees e
  where e.id = _owner_employee_id;

  update public.live_sale_lots
  set owner_employee_id = _owner_employee_id,
      owner_snapshot = coalesce(v_owner_snapshot, '{}'::jsonb)
  where id = _lot_id
  returning * into v_lot;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    case
      when v_old.status = 'packed' then 'packed_lot_owner_updated'
      else 'lot_owner_updated'
    end,
    v_actor_email,
    jsonb_build_object(
      'old_owner_employee_id', v_old.owner_employee_id,
      'new_owner_employee_id', v_lot.owner_employee_id,
      'old_owner_snapshot', v_old.owner_snapshot,
      'new_owner_snapshot', v_lot.owner_snapshot,
      'lot_status', v_old.status,
      'verified_owner_email', v_verified_owner_email,
      'verification_method', case when v_verified_owner_email is null then 'signed_in_user_password' else 'owner_password' end
    )
  );

  return v_lot;
end;
$$;

revoke all on function public.update_live_sale_lot_owner(uuid, uuid, text, text) from public;
grant execute on function public.update_live_sale_lot_owner(uuid, uuid, text, text) to authenticated;
