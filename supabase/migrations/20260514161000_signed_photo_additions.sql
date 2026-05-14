-- Require signed audit context for stock-page photo additions.

drop function if exists public.append_item_photos(uuid, text[]);

create or replace function public.append_item_photos(
  _item_id uuid,
  _photo_paths text[],
  _reason text default null,
  _signed_by_email text default null
)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_photos text[];
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_verified_at timestamptz := now();
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to manage inventory photos' using errcode = '42501';
  end if;

  if _item_id is null then
    raise exception 'Item id is required' using errcode = '22023';
  end if;

  if coalesce(array_length(_photo_paths, 1), 0) = 0 then
    raise exception 'At least one photo path is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief reason for adding photos is required' using errcode = '22023';
  end if;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_signed_by_email, ''), true);
  perform set_config(
    'app.inventory_change_verified_method',
    case when nullif(btrim(coalesce(_signed_by_email, '')), '') is null then 'workflow' else 'password' end,
    true
  );
  perform set_config('app.inventory_change_verified_at', v_verified_at::text, true);

  update public.item_types it
  set photos = (
    select coalesce(array_agg(photo_path order by first_seen), '{}'::text[])
    from (
      select photo_path, min(ord) as first_seen
      from unnest(coalesce(it.photos, '{}'::text[]) || coalesce(_photo_paths, '{}'::text[]))
        with ordinality as source(photo_path, ord)
      where nullif(btrim(photo_path), '') is not null
      group by photo_path
    ) unique_photos
  )
  where it.id = _item_id
  returning it.photos into next_photos;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  return coalesce(next_photos, '{}'::text[]);
end;
$$;

revoke all on function public.append_item_photos(uuid, text[], text, text) from public;
grant execute on function public.append_item_photos(uuid, text[], text, text) to authenticated;

create or replace function public.append_item_photos(_item_id uuid, _photo_paths text[])
returns text[]
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.append_item_photos(
    _item_id,
    _photo_paths,
    'Added item photos from inventory workflow',
    null
  );
$$;

revoke all on function public.append_item_photos(uuid, text[]) from public;
grant execute on function public.append_item_photos(uuid, text[]) to authenticated;
