-- Coin marketplace metadata and audited editing. Existing coins stay opted out until explicitly enabled.
create or replace function public.update_certified_item_details_v3(
  _item_id uuid,
  _title text,
  _description text,
  _weight numeric,
  _stone_type text,
  _item_length text,
  _qr_type text default null,
  _qr_code text default null,
  _cost numeric default null,
  _sale_price numeric default null,
  _price_per_weight numeric default null,
  _stock_batch_size_update numeric default null,
  _dymo_label_url text default null,
  _photos text[] default null,
  _reason text default null,
  _signed_by_email text default null,
  _minimum_sale_price numeric default null,
  _watch_details jsonb default null,
  _coin_details jsonb default null,
  _ebay_sync_enabled boolean default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.item_types;
  v_updated_id uuid;
  v_is_admin boolean := public.is_admin();
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_verified_at timestamptz := now();
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to edit inventory items' using errcode = '42501';
  end if;

  if _item_id is null then
    raise exception 'Item id is required' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(_title, '')), '') is null then
    raise exception 'Title is required' using errcode = '22023';
  end if;

  if v_reason is null or length(v_reason) < 3 then
    raise exception 'A brief reason for the edit is required' using errcode = '22023';
  end if;

  select *
    into v_existing
  from public.item_types
  where id = _item_id
  for update;

  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  perform set_config('app.inventory_change_reason', v_reason, true);
  perform set_config('app.inventory_change_signed_by_email', coalesce(_signed_by_email, ''), true);
  perform set_config('app.inventory_change_verified_method', 'password', true);
  perform set_config('app.inventory_change_verified_at', v_verified_at::text, true);

  update public.item_types
  set
    title = btrim(_title),
    description = coalesce(_description, ''),
    weight = coalesce(_weight, 0),
    stone_type = nullif(btrim(coalesce(_stone_type, '')), ''),
    item_length = nullif(btrim(coalesce(_item_length, '')), ''),
    qr_type = case when v_is_admin then _qr_type else v_existing.qr_type end,
    qr_code = case when v_is_admin then _qr_code else v_existing.qr_code end,
    cost = case when v_is_admin then coalesce(_cost, 0) else v_existing.cost end,
    sale_price = case when v_is_admin then coalesce(_sale_price, 0) else v_existing.sale_price end,
    minimum_sale_price = case when v_is_admin then _minimum_sale_price else v_existing.minimum_sale_price end,
    coin_details = case when v_is_admin then coalesce(_coin_details, v_existing.coin_details) else v_existing.coin_details end,
    ebay_sync_enabled = case when v_is_admin and _coin_details is not null then coalesce(_ebay_sync_enabled, v_existing.ebay_sync_enabled) else v_existing.ebay_sync_enabled end,
    watch_details = case when v_is_admin then coalesce(_watch_details, v_existing.watch_details) else v_existing.watch_details end,
    price_per_weight = case when v_is_admin then coalesce(_price_per_weight, 0) else v_existing.price_per_weight end,
    stock_batch_size_update = case when v_is_admin then coalesce(_stock_batch_size_update, 0) else v_existing.stock_batch_size_update end,
    dymo_label_url = case when v_is_admin then coalesce(_dymo_label_url, v_existing.dymo_label_url) else v_existing.dymo_label_url end,
    photos = case when v_is_admin and _photos is not null then _photos else v_existing.photos end
  where id = _item_id
  returning id into v_updated_id;

  return v_updated_id;
end;
$$;

revoke all on function public.update_certified_item_details_v3(
  uuid, text, text, numeric, text, text, text, text, numeric, numeric, numeric, numeric, text, text[], text, text, numeric, jsonb, jsonb, boolean
) from public;

grant execute on function public.update_certified_item_details_v3(
  uuid, text, text, numeric, text, text, text, text, numeric, numeric, numeric, numeric, text, text[], text, text, numeric, jsonb, jsonb, boolean
) to authenticated;

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


