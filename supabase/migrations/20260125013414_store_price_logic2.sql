alter table public.item_types
  add column if not exists metal text,
  add column if not exists purity_basis_points integer;
create or replace function public.sync_metal_weight_g()
    returns trigger
    language plpgsql
    as $$
    begin
    if new.metal_weight_g is null then
        new.metal_weight_g := new.weight;
    end if;

        -- if weight changed and metal_weight_g wasn’t intentionally changed, keep them aligned
    if (tg_op = 'UPDATE')
        and (new.weight is distinct from old.weight)
        and (new.metal_weight_g is not distinct from old.metal_weight_g)
    then
        new.metal_weight_g := new.weight;
    end if;

    return new;
    end;
$$;
-- Optional: if your existing it.weight is total piece weight, keep using it.
-- If you want “metal-only weight” separate from stone weight, add this instead:
alter table public.item_types
  add column if not exists metal_weight_g numeric;
create or replace function public.calc_display_price(
  p_pricing_mode text,
  p_fixed_price numeric,
  p_metal text,
  p_weight_g numeric,
  p_purity_bp integer,
  p_premium_bp integer,
  p_labor_fee numeric,
  p_rounding_increment numeric
) returns numeric
language sql
stable
as $$
  select
    case
      when p_pricing_mode = 'metal_spot'
           and p_metal is not null
           and p_weight_g is not null
           and p_weight_g > 0
      then public.round_up_to_increment(
        (
          (sp.price_per_gram * p_weight_g)
          * (coalesce(p_purity_bp, 10000)::numeric / 10000)
          * (1 + (coalesce(p_premium_bp, 0)::numeric / 10000))
          + coalesce(p_labor_fee, 0)
        ),
        coalesce(p_rounding_increment, 1)
      )
      else p_fixed_price
    end
  from public.metal_spot_prices sp
  where sp.metal = p_metal
$$;
-- 0) Drop the old RPC (must match the exact signature)
drop function if exists public.rpc_storefront_catalog(text);
-- 1) (If you want the trigger, you forgot to create it)
drop trigger if exists trg_sync_metal_weight_g on public.item_types;
create trigger trg_sync_metal_weight_g
before insert or update on public.item_types
for each row execute function public.sync_metal_weight_g();
-- Replace the function with a new return shape
drop function if exists public.rpc_storefront_catalog(text);
create function public.rpc_storefront_catalog(p_channel_id text default 'og_main')
returns table(
  channel_id text,
  item_type_id uuid,
  title text,
  description text,
  display_price numeric,
  pricing_mode text,
  badge_flags text[],
  photo_keys text[],
  categories text[],
  material text,          -- ✅ NEW (for your UI filters)
  weight_g numeric,
  stock_label text,
  remaining_count integer
)
language sql
stable
security definer
set search_path = public
as $$
with base as (
  select
    l.channel_id,
    l.sort_rank,
    it.id as item_type_id,

    coalesce(nullif(l.public_title, ''), it.title) as title,
    coalesce(nullif(l.public_description, ''), it.description) as description,

    case
      when array_length(l.public_photo_keys, 1) is not null
       and array_length(l.public_photo_keys, 1) > 0
      then l.public_photo_keys
      else it.photos
    end as photo_keys,

    it.categories::text[] as categories,

    it.metal as material,              -- ✅ Material for filter UI
    it.metal_weight_g as weight_g,     -- uses your synced metal_weight_g

    case
      when coalesce(it.metal,'') <> '' and coalesce(it.metal_weight_g, 0) > 0 then 'metal_spot'
      else 'fixed'
    end as pricing_mode,

    it.metal,
    it.purity_basis_points,

    coalesce(l.labor_fee, 0) as labor_fee,
    coalesce(l.rounding_increment, 1) as rounding_increment,

    l.badge_flags,
    coalesce(s.qty, 0) as qty,

    it.sale_price as fixed_price
  from public.storefront_listings l
  join public.sales_channels c
    on c.id = l.channel_id and c.active = true
  join public.item_types it
    on it.id = l.item_type_id
  left join lateral (
    select sum(isl.quantity)::int as qty
    from public.item_stock_locations isl
    where isl.item_id = it.id
  ) s on true
  where l.published = true
    and l.channel_id = p_channel_id
),
priced as (
  select
    b.*,
    case
      when b.pricing_mode = 'metal_spot' then
        public.round_up_to_increment(
          (
            (
              sp.price_per_gram
              * b.weight_g
              * (coalesce(b.purity_basis_points, 10000)::numeric / 10000)
            )
            * 7.5
            + b.labor_fee
          ),
          b.rounding_increment
        )
      else
        b.fixed_price
    end as display_price
  from base b
  left join public.metal_spot_prices sp
    on sp.metal = b.metal
)
select
  channel_id,
  item_type_id,
  title,
  description,
  display_price,
  pricing_mode,
  badge_flags,
  photo_keys,
  categories,
  material,
  weight_g,
  case
    when qty <= 0 then 'Sold out'
    when qty <= 3 then 'Only ' || qty::text || ' left'
    when qty <= 10 then 'Low stock'
    else 'In stock'
  end as stock_label,
  case when qty between 1 and 3 then qty else null end as remaining_count
from priced
order by sort_rank asc nulls last, title asc;
$$;
-- Public-safe snapshot for UI (works for anon storefront)
create or replace function public.rpc_spot_snapshot()
returns table(
  metal text,
  price_per_gram numeric,
  as_of timestamptz,
  source text
)
language sql
stable
security definer
set search_path = public
as $$
  select m.metal, m.price_per_gram, m.as_of, m.source
  from public.metal_spot_prices m
  where m.metal in ('gold','silver')
  order by case when m.metal='gold' then 1 else 2 end;
$$;
-- Allow storefront callers to execute this RPC
grant execute on function public.rpc_spot_snapshot() to anon;
grant execute on function public.rpc_spot_snapshot() to authenticated;
