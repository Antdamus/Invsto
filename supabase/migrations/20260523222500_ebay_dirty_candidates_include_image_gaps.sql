-- Include older items in the efficient sync queue when they have stock photos
-- but no recorded public eBay image yet. This lets the new image-prep path catch
-- legacy items without forcing every unchanged listing through eBay forever.

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
      or (
        coalesce(link.last_image_count, 0) = 0
        and (
          cardinality(coalesce(item.photos, '{}'::text[])) > 0
          or nullif(btrim(coalesce(item.photo_url, '')), '') is not null
        )
      )
    )
  order by
    coalesce(link.sync_dirty, true) desc,
    case
      when coalesce(link.last_image_count, 0) = 0
        and (
          cardinality(coalesce(item.photos, '{}'::text[])) > 0
          or nullif(btrim(coalesce(item.photo_url, '')), '') is not null
        )
      then 0
      else 1
    end,
    link.dirty_at asc nulls first,
    item.created_at desc
  limit greatest(1, least(coalesce(_limit, 50), 1000));
$$;

revoke all on function public.get_ebay_sync_candidate_item_ids(integer, boolean) from public;
grant execute on function public.get_ebay_sync_candidate_item_ids(integer, boolean) to authenticated;
