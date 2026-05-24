-- Track only the eBay items that actually need work. Item/product edits, photo
-- changes, and stock quantity changes mark an item dirty; successful sync clears it.

alter table public.ebay_inventory_links
  add column if not exists sync_dirty boolean not null default true,
  add column if not exists dirty_reason text,
  add column if not exists dirty_at timestamptz;

update public.ebay_inventory_links
set
  sync_dirty = case
    when last_inventory_hash is null or status = 'error' then true
    else false
  end,
  dirty_reason = case
    when last_inventory_hash is null then 'never synced'
    when status = 'error' then 'last sync failed'
    else null
  end,
  dirty_at = case
    when last_inventory_hash is null or status = 'error' then coalesce(updated_at, now())
    else null
  end
where dirty_at is null;

create index if not exists ebay_inventory_links_sync_dirty_idx
  on public.ebay_inventory_links(sync_dirty, dirty_at desc nulls last);

create or replace function public.mark_ebay_item_dirty(_item_id uuid, _reason text default 'changed')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
begin
  select nullif(btrim(barcode), '')
    into v_sku
  from public.item_types
  where id = _item_id
    and deleted_at is null
    and coalesce(ebay_sync_enabled, true) is true;

  if v_sku is null then
    return;
  end if;

  insert into public.ebay_inventory_links (
    item_type_id,
    sku,
    status,
    sync_dirty,
    dirty_reason,
    dirty_at,
    updated_at
  )
  values (
    _item_id,
    v_sku,
    'pending',
    true,
    nullif(btrim(coalesce(_reason, 'changed')), ''),
    now(),
    now()
  )
  on conflict (item_type_id) do update
  set
    sku = excluded.sku,
    sync_dirty = true,
    dirty_reason = excluded.dirty_reason,
    dirty_at = excluded.dirty_at,
    updated_at = now();
end;
$$;

revoke all on function public.mark_ebay_item_dirty(uuid, text) from public;
grant execute on function public.mark_ebay_item_dirty(uuid, text) to authenticated;

create or replace function public.mark_ebay_item_dirty_from_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  if coalesce(new.ebay_sync_enabled, true) is true and new.deleted_at is null then
    perform public.mark_ebay_item_dirty(new.id, 'item changed');
  elsif new.id is not null then
    update public.ebay_inventory_links
    set
      sync_dirty = false,
      dirty_reason = null,
      dirty_at = null,
      status = 'skipped',
      updated_at = now()
    where item_type_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists item_types_mark_ebay_dirty on public.item_types;

create trigger item_types_mark_ebay_dirty
after insert or update of
  title,
  description,
  sale_price,
  barcode,
  photos,
  photo_url,
  categories,
  weight,
  metal,
  purity_basis_points,
  stone_type,
  item_length,
  ebay_sync_enabled,
  ebay_category_id,
  ebay_condition,
  ebay_aspects,
  deleted_at
on public.item_types
for each row
execute function public.mark_ebay_item_dirty_from_item();

create or replace function public.mark_ebay_item_dirty_from_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.mark_ebay_item_dirty(old.item_id, 'stock changed');
    return old;
  end if;

  perform public.mark_ebay_item_dirty(new.item_id, 'stock changed');
  return new;
end;
$$;

drop trigger if exists item_stock_locations_mark_ebay_dirty on public.item_stock_locations;

create trigger item_stock_locations_mark_ebay_dirty
after insert or update of quantity or delete
on public.item_stock_locations
for each row
execute function public.mark_ebay_item_dirty_from_stock();

create or replace function public.get_ebay_sync_candidate_item_ids(
  _limit integer default 50,
  _dirty_only boolean default true
)
returns table(item_id uuid)
language sql
security definer
set search_path = public
as $$
  select item.id
  from public.item_types item
  left join public.ebay_inventory_links link
    on link.item_type_id = item.id
  where item.deleted_at is null
    and coalesce(item.ebay_sync_enabled, true) is true
    and nullif(btrim(coalesce(item.barcode, '')), '') is not null
    and (
      coalesce(_dirty_only, true) is false
      or link.item_type_id is null
      or link.sync_dirty is true
      or link.last_checked_at is null
    )
  order by
    coalesce(link.sync_dirty, true) desc,
    link.dirty_at asc nulls first,
    item.created_at desc
  limit greatest(1, least(coalesce(_limit, 50), 1000));
$$;

revoke all on function public.get_ebay_sync_candidate_item_ids(integer, boolean) from public;
grant execute on function public.get_ebay_sync_candidate_item_ids(integer, boolean) to authenticated;
