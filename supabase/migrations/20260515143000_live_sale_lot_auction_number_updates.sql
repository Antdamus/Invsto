-- Allow the live-sale scanner to create a low-friction temporary bag first,
-- then confirm or correct the auction number immediately before label print.

create or replace function public.update_live_sale_lot_auction_number(
  _lot_id uuid,
  _auction_number text,
  _notes text default null,
  _signed_by_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.live_sale_lots;
  v_lot public.live_sale_lots;
  v_auction text := nullif(btrim(coalesce(_auction_number, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update live sale auction numbers' using errcode = '42501';
  end if;

  if v_auction is null then
    raise exception 'Auction number is required' using errcode = '22023';
  end if;

  select *
    into v_existing
  from public.live_sale_lots
  where id = _lot_id;

  if not found then
    raise exception 'Live sale lot not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.live_sale_lots other_lot
    where other_lot.session_id = v_existing.session_id
      and other_lot.auction_number = v_auction
      and other_lot.id <> v_existing.id
  ) then
    raise exception 'Auction number already exists in this live sale session' using errcode = '23505';
  end if;

  update public.live_sale_lots
  set auction_number = v_auction,
      label_path = case
        when auction_number is distinct from v_auction then null
        else label_path
      end,
      notes = coalesce(nullif(btrim(coalesce(_notes, '')), ''), notes)
  where id = v_existing.id
  returning * into v_lot;

  if v_existing.auction_number is distinct from v_lot.auction_number then
    insert into public.live_sale_events (
      session_id,
      lot_id,
      event_type,
      actor_email,
      notes,
      payload
    )
    values (
      v_lot.session_id,
      v_lot.id,
      'lot_auction_number_updated',
      nullif(btrim(coalesce(_signed_by_email, '')), ''),
      nullif(btrim(coalesce(_notes, '')), ''),
      jsonb_build_object(
        'old_auction_number', v_existing.auction_number,
        'new_auction_number', v_lot.auction_number,
        'lot_code', v_lot.lot_code
      )
    );
  end if;

  return v_lot;
end;
$$;
revoke all on function public.update_live_sale_lot_auction_number(uuid, text, text, text) from public;
grant execute on function public.update_live_sale_lot_auction_number(uuid, text, text, text) to authenticated;
