-- First-class intake for carved gemstone collectibles.
begin;
alter table public.item_types add column collectible_details jsonb;
alter table public.item_types add constraint item_types_collectible_details_check check (
  collectible_details is null or (jsonb_typeof(collectible_details) = 'object' and watch_details is null and coin_details is null)
);
comment on column public.item_types.collectible_details is 'Carved gemstone identity, measurements, condition, provenance as entered, and selected eBay category specifics.';

create or replace function public.fill_item_type_ebay_metadata()
returns trigger
language plpgsql
as $$
declare
  text_blob text;
  category_id text;
  jewelry_type text;
  jewelry_style text;
  main_stone text;
  stone_color text;
  metal_label text;
  purity_label text;
  inferred_aspects jsonb;
begin
  -- Collectibles use the selected category and condition; never infer jewelry metadata.
  if new.collectible_details is not null then
    new.ebay_category_id := nullif(new.collectible_details #>> '{ebay,categoryId}', '');
    new.ebay_condition := case new.collectible_details #>> '{ebay,conditionId}'
      when '1000' then 'NEW' when '1500' then 'NEW_OTHER' when '1750' then 'NEW_WITH_DEFECTS'
      when '2000' then 'CERTIFIED_REFURBISHED' when '2500' then 'SELLER_REFURBISHED' when '2750' then 'LIKE_NEW'
      when '3000' then 'USED_EXCELLENT' when '4000' then 'USED_VERY_GOOD' when '5000' then 'USED_GOOD'
      when '6000' then 'USED_ACCEPTABLE' when '7000' then 'FOR_PARTS_OR_NOT_WORKING' else null end;
    return new;
  end if;
  -- Collector coins carry their own condition and composition. Jewelry defaults
  -- must not label them NEW, infer stones, or guess a jewelry category.
  if new.coin_details is not null then
    new.ebay_category_id := coalesce(nullif(new.coin_details #>> '{ebay,categoryId}', ''), new.ebay_category_id);
    new.ebay_condition := case new.coin_details #>> '{ebay,conditionId}'
      when '2750' then 'LIKE_NEW' when '4000' then 'USED_VERY_GOOD'
      when '1000' then 'NEW' when '1500' then 'NEW_OTHER' when '1750' then 'NEW_WITH_DEFECTS'
      when '2500' then 'SELLER_REFURBISHED' when '2990' then 'PRE_OWNED_EXCELLENT'
      when '3000' then 'USED_EXCELLENT' when '3010' then 'PRE_OWNED_FAIR'
      when '5000' then 'USED_GOOD' when '6000' then 'USED_ACCEPTABLE' when '7000' then 'FOR_PARTS_OR_NOT_WORKING'
      else null end;
    return new;
  end if;

  -- Watches use explicit facts. Jewelry defaults must not classify them as new.
  if new.watch_details is not null or new.ebay_category_id = '31387' then
    if new.watch_details is not null then
      new.ebay_category_id := '31387';
      new.ebay_condition := nullif(new.watch_details->>'condition', '');
    end if;
    return new;
  end if;

  new.ebay_sync_enabled = coalesce(new.ebay_sync_enabled, true);
  new.ebay_condition = coalesce(nullif(btrim(new.ebay_condition), ''), 'NEW');

  text_blob := lower(concat_ws(
    ' ',
    new.title,
    new.description,
    array_to_string(new.categories, ' '),
    new.stone_type,
    new.item_length,
    new.metal
  ));

  if nullif(btrim(coalesce(new.ebay_category_id, '')), '') is null then
    new.ebay_category_id := case
      when text_blob ~ '(bracelet|bangle|tennis)' then '261988'
      when text_blob ~ '(brooch| pin | pins )' then '261989'
      when text_blob ~ '(earring|earrings|stud|hoop)' then '261990'
      when text_blob ~ '(jewelry set| set )' then '261992'
      when text_blob ~ '(pendant|necklace|charm|chain)' then '261993'
      when text_blob ~ '(toe ring)' then '261995'
      when text_blob ~ '(ring)' then '261994'
      else new.ebay_category_id
    end;
  end if;

  category_id := nullif(btrim(coalesce(new.ebay_category_id, '')), '');

  jewelry_type := case
    when category_id = '261988' then 'Bracelet'
    when category_id = '261990' then 'Earrings'
    when category_id in ('261994', '261995') then 'Ring'
    when category_id = '261992' then 'Jewelry Set'
    when text_blob ~ '(bracelet|tennis)' then 'Bracelet'
    when text_blob ~ '(necklace)' then 'Necklace'
    when text_blob ~ '(pendant|charm)' then 'Pendant'
    when text_blob ~ '(ring)' then 'Ring'
    when text_blob ~ '(earring|earrings)' then 'Earrings'
    when text_blob ~ '(chain)' then 'Chain'
    else 'Jewelry'
  end;

  jewelry_style := case
    when text_blob ~ '(tennis)' then 'Tennis'
    when text_blob ~ '(halo)' then 'Halo'
    when text_blob ~ '(heart)' then 'Heart'
    when text_blob ~ '(cross)' then 'Cross'
    when text_blob ~ '(cuban)' then 'Cuban'
    when text_blob ~ '(link)' then 'Link'
    when category_id = '261988' then 'Tennis'
    when category_id = '261993' then 'Pendant'
    else 'Jewelry'
  end;

  main_stone := case
    when text_blob ~ '(simulated diamond|cubic zirconia| cz )' then 'Simulated Diamond'
    when text_blob ~ 'sapphire' then 'Sapphire'
    when text_blob ~ 'diamond' then 'Diamond'
    when text_blob ~ 'ruby' then 'Ruby'
    when text_blob ~ 'emerald' then 'Emerald'
    when text_blob ~ 'turquoise' then 'Turquoise'
    when text_blob ~ '(no stone|without stone)' then 'No Stone'
    when nullif(btrim(coalesce(new.stone_type, '')), '') is not null then btrim(new.stone_type)
    else 'Unknown'
  end;

  stone_color := case
    when text_blob ~ 'pink' then 'Pink'
    when text_blob ~ 'purple' then 'Purple'
    when text_blob ~ 'blue' then 'Blue'
    when text_blob ~ 'green' then 'Green'
    when text_blob ~ 'red' then 'Red'
    when text_blob ~ 'black' then 'Black'
    when text_blob ~ '(white|clear)' then 'White'
    when text_blob ~ 'yellow' then 'Yellow'
    when text_blob ~ '(multicolor|rainbow)' then 'Multicolor'
    else null
  end;

  metal_label := case
    when lower(coalesce(new.metal, '')) like '%silver%' or text_blob ~ '(silver|925)' then 'Fine Silver'
    when text_blob ~ 'white gold' then 'White Gold'
    when text_blob ~ 'rose gold' then 'Rose Gold'
    when lower(coalesce(new.metal, '')) like '%gold%' or text_blob ~ 'gold' then 'Yellow Gold'
    when lower(coalesce(new.metal, '')) like '%platinum%' or text_blob ~ 'platinum' then 'Platinum'
    else null
  end;

  purity_label := case
    when new.purity_basis_points >= 10000 or text_blob ~ '24k' then '24k'
    when new.purity_basis_points >= 9990 or text_blob ~ '999' then '999'
    when new.purity_basis_points >= 9250 or text_blob ~ '(925|sterling silver)' then '925'
    when new.purity_basis_points >= 9167 or text_blob ~ '22k' then '22k'
    when new.purity_basis_points >= 7500 or text_blob ~ '18k' then '18k'
    when new.purity_basis_points >= 5833 or text_blob ~ '14k' then '14k'
    when new.purity_basis_points >= 4167 or text_blob ~ '10k' then '10k'
    else null
  end;

  inferred_aspects := jsonb_strip_nulls(jsonb_build_object(
    'Brand', to_jsonb(array['Unbranded']::text[]),
    'Type', to_jsonb(array[jewelry_type]::text[]),
    'Style', to_jsonb(array[jewelry_style]::text[]),
    'Main Stone', to_jsonb(array[main_stone]::text[]),
    'Main Stone Color', case
      when stone_color is not null then to_jsonb(array[stone_color]::text[])
      else null
    end,
    'Metal', case
      when metal_label is not null then to_jsonb(array[metal_label]::text[])
      else null
    end,
    'Metal Purity', case
      when purity_label is not null then to_jsonb(array[purity_label]::text[])
      else null
    end,
    'Item Length', case
      when nullif(btrim(coalesce(new.item_length, '')), '') is not null then to_jsonb(array[btrim(new.item_length)]::text[])
      else null
    end,
    'Item Weight', case
      when new.weight is not null and new.weight > 0 then to_jsonb(array[(new.weight::text || ' g')]::text[])
      else null
    end
  ));

  new.ebay_aspects := inferred_aspects || coalesce(new.ebay_aspects, '{}'::jsonb);

  return new;
end;
$$;

create or replace function public.inventory_material_key(_item public.item_types) returns text
language plpgsql immutable set search_path='' as $$
declare k integer;
begin
 if _item.collectible_details is not null or _item.watch_details is not null or _item.coin_details is not null
   or coalesce(_item.title,'') ~* '\m(plated|filled|vermeil|tone|gp|gf|hge|overlay)\M' then return null; end if;
 if lower(_item.metal)='silver' then
   return case when _item.purity_basis_points is null or _item.purity_basis_points=9250 then 'silver' end;
 elsif lower(_item.metal)='gold' then
   if _item.purity_basis_points is null then return 'gold_10'; end if;
   foreach k in array array[8,9,10,14,18,21,22,24] loop
     if abs(k::numeric/24*10000-_item.purity_basis_points)<=1 then return 'gold_'||k; end if;
   end loop;
 end if;
 return null;
end $$;
drop trigger if exists item_types_fill_ebay_metadata on public.item_types;

create trigger item_types_fill_ebay_metadata
before insert or update of
  watch_details,
  coin_details,
  collectible_details,
  title,
  description,
  categories,
  stone_type,
  item_length,
  weight,
  metal,
  purity_basis_points,
  ebay_sync_enabled,
  ebay_category_id,
  ebay_condition,
  ebay_aspects
on public.item_types
for each row
execute function public.fill_item_type_ebay_metadata();
drop trigger if exists item_types_mark_ebay_dirty on public.item_types;

create trigger item_types_mark_ebay_dirty
after insert or update of
  watch_details,
  coin_details,
  collectible_details,
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

commit;
