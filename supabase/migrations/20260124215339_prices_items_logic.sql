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
