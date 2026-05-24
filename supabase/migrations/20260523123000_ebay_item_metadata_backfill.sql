-- Add durable eBay metadata to item_types and backfill existing inventory with
-- conservative values based on the fields workers already enter today.

alter table public.item_types
  add column if not exists ebay_sync_enabled boolean not null default true,
  add column if not exists ebay_category_id text,
  add column if not exists ebay_condition text,
  add column if not exists ebay_aspects jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'item_types_ebay_condition_check'
      and conrelid = 'public.item_types'::regclass
  ) then
    alter table public.item_types
      add constraint item_types_ebay_condition_check
      check (
        ebay_condition is null
        or ebay_condition in (
          'NEW',
          'LIKE_NEW',
          'NEW_OTHER',
          'NEW_WITH_DEFECTS',
          'MANUFACTURER_REFURBISHED',
          'CERTIFIED_REFURBISHED',
          'EXCELLENT_REFURBISHED',
          'VERY_GOOD_REFURBISHED',
          'GOOD_REFURBISHED',
          'SELLER_REFURBISHED',
          'USED_EXCELLENT',
          'USED_VERY_GOOD',
          'USED_GOOD',
          'USED_ACCEPTABLE',
          'FOR_PARTS_OR_NOT_WORKING'
        )
      );
  end if;
end $$;

create index if not exists item_types_ebay_sync_enabled_idx
  on public.item_types(ebay_sync_enabled, created_at desc)
  where deleted_at is null;

create index if not exists item_types_ebay_category_id_idx
  on public.item_types(ebay_category_id)
  where ebay_category_id is not null;

with source as (
  select
    id,
    case
      when lower(coalesce(metal, '')) like '%silver%' then 'silver'
      when lower(coalesce(metal, '')) like '%gold%' then 'gold'
      else lower(nullif(btrim(coalesce(metal, '')), ''))
    end as current_metal,
    purity_basis_points as current_purity_bp,
    lower(concat_ws(
      ' ',
      title,
      description,
      array_to_string(categories, ' '),
      stone_type
    )) as text_blob
  from public.item_types
  where deleted_at is null
),
inferred as (
  select
    id,
    case
      when text_blob ~ '(bracelet|tennis)' then '261988'
      when text_blob ~ '(pendant|necklace|charm|chain)' then '261993'
      else null
    end as category_id,
    coalesce(
      nullif(current_metal, ''),
      case
        when text_blob ~ '(sterling silver|fine silver|925|silver)' then 'silver'
        when text_blob ~ '(10k|14k|18k|22k|24k|yellow gold|white gold|rose gold| gold)' then 'gold'
        else null
      end
    ) as metal,
    coalesce(
      current_purity_bp,
      case
        when text_blob ~ '(fine silver|999)' then 9990
        when text_blob ~ '(sterling silver|925)' then 9250
        when text_blob ~ '24k' then 10000
        when text_blob ~ '22k' then 9167
        when text_blob ~ '18k' then 7500
        when text_blob ~ '14k' then 5833
        when text_blob ~ '10k' then 4167
        else null
      end
    ) as purity_bp,
    case
      when text_blob ~ '(bracelet|tennis)' then 'Bracelet'
      when text_blob ~ '(necklace)' then 'Necklace'
      when text_blob ~ '(pendant|charm)' then 'Pendant'
      when text_blob ~ '(ring)' then 'Ring'
      when text_blob ~ '(earring)' then 'Earrings'
      when text_blob ~ '(chain)' then 'Chain'
      else 'Jewelry'
    end as jewelry_type,
    case
      when text_blob ~ '(tennis|bracelet)' then 'Tennis'
      when text_blob ~ 'halo' then 'Halo'
      when text_blob ~ 'heart' then 'Heart'
      when text_blob ~ 'cross' then 'Cross'
      when text_blob ~ '(pendant|necklace|charm)' then 'Pendant'
      else 'Jewelry'
    end as jewelry_style,
    case
      when text_blob ~ '(simulated diamond|cubic zirconia|cz)' then 'Simulated Diamond'
      when text_blob ~ 'sapphire' then 'Sapphire'
      when text_blob ~ 'diamond' then 'Diamond'
      when text_blob ~ 'ruby' then 'Ruby'
      when text_blob ~ 'emerald' then 'Emerald'
      when text_blob ~ '(no stone|without stone)' then 'No Stone'
      else 'Unknown'
    end as main_stone,
    case
      when text_blob ~ 'pink' then 'Pink'
      when text_blob ~ 'purple' then 'Purple'
      when text_blob ~ 'blue' then 'Blue'
      when text_blob ~ 'green' then 'Green'
      when text_blob ~ 'red' then 'Red'
      when text_blob ~ 'black' then 'Black'
      when text_blob ~ '(white|clear)' then 'White'
      else null
    end as stone_color
  from source
)
update public.item_types item
set
  ebay_category_id = coalesce(item.ebay_category_id, inferred.category_id),
  ebay_condition = coalesce(item.ebay_condition, 'NEW'),
  metal = coalesce(nullif(item.metal, ''), inferred.metal),
  purity_basis_points = coalesce(item.purity_basis_points, inferred.purity_bp),
  ebay_aspects = jsonb_strip_nulls(
    jsonb_build_object(
      'Brand', to_jsonb(array['Unbranded']::text[]),
      'Type', to_jsonb(array[inferred.jewelry_type]::text[]),
      'Style', to_jsonb(array[inferred.jewelry_style]::text[]),
      'Main Stone', to_jsonb(array[inferred.main_stone]::text[]),
      'Metal', case
        when inferred.metal = 'silver' then to_jsonb(array['Fine Silver']::text[])
        when inferred.metal = 'gold' then to_jsonb(array['Yellow Gold']::text[])
        else null
      end,
      'Metal Purity', case
        when inferred.purity_bp = 9990 then to_jsonb(array['999']::text[])
        when inferred.purity_bp = 9250 then to_jsonb(array['925']::text[])
        when inferred.purity_bp = 10000 then to_jsonb(array['24k']::text[])
        when inferred.purity_bp = 9167 then to_jsonb(array['22k']::text[])
        when inferred.purity_bp = 7500 then to_jsonb(array['18k']::text[])
        when inferred.purity_bp = 5833 then to_jsonb(array['14k']::text[])
        when inferred.purity_bp = 4167 then to_jsonb(array['10k']::text[])
        else null
      end,
      'Main Stone Color', case
        when inferred.stone_color is not null then to_jsonb(array[inferred.stone_color]::text[])
        else null
      end
    )
  ) || coalesce(item.ebay_aspects, '{}'::jsonb)
from inferred
where item.id = inferred.id;
