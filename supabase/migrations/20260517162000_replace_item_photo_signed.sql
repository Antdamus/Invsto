-- Signed stock photo replacement. Keeps old storage objects intact while the item
-- points at the edited image, so the normal inventory change trail can revert it.

create or replace function public.replace_item_photo(
  _item_id uuid,
  _old_photo_path text,
  _new_photo_path text,
  _reason text default null,
  _signed_by_email text default null
)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_photo text := nullif(btrim(coalesce(_old_photo_path, '')), '');
  v_new_photo text := nullif(btrim(coalesce(_new_photo_path, '')), '');
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_verified_at timestamptz := now();
  v_existing text[];
  v_replaced text[];
  v_next text[];
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to manage inventory photos' using errcode = '42501';
  end if;

  if _item_id is null or v_old_photo is null or v_new_photo is null then
    raise exception 'Item id, old photo path, and new photo path are required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief reason for replacing the photo is required' using errcode = '22023';
  end if;

  select coalesce(photos, '{}'::text[])
    into v_existing
  from public.item_types
  where id = _item_id
  for update;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  if not v_old_photo = any(v_existing) then
    raise exception 'The photo being replaced is not attached to this item' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(
    case when photo_path = v_old_photo then v_new_photo else photo_path end
    order by ord
  ), '{}'::text[])
    into v_replaced
  from unnest(v_existing) with ordinality as source(photo_path, ord)
  where nullif(btrim(photo_path), '') is not null;

  select coalesce(array_agg(photo_path order by first_seen), '{}'::text[])
    into v_next
  from (
    select photo_path, min(ord) as first_seen
    from unnest(v_replaced) with ordinality as source(photo_path, ord)
    where nullif(btrim(photo_path), '') is not null
    group by photo_path
  ) unique_photos;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_signed_by_email, ''), true);
  perform set_config(
    'app.inventory_change_verified_method',
    case when nullif(btrim(coalesce(_signed_by_email, '')), '') is null then 'workflow' else 'password' end,
    true
  );
  perform set_config('app.inventory_change_verified_at', v_verified_at::text, true);

  update public.item_types
  set photos = v_next
  where id = _item_id
  returning photos into v_next;

  return coalesce(v_next, '{}'::text[]);
end;
$$;

revoke all on function public.replace_item_photo(uuid, text, text, text, text) from public;
grant execute on function public.replace_item_photo(uuid, text, text, text, text) to authenticated;
