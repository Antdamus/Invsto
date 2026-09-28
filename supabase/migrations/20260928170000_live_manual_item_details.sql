begin;
set local lock_timeout='500ms';
set local statement_timeout='5s';
alter table public.live_sale_manual_lot_items
 add column live_unit_minimum numeric(12,2) check(live_unit_minimum>=0 and live_unit_minimum<>'NaN'::numeric),
 add column photo_path text,
 add column edit_revision integer not null default 1;
create function public.touch_live_manual_revision() returns trigger language plpgsql set search_path='' as $$
begin NEW.edit_revision:=OLD.edit_revision+1;return NEW;end $$;
create trigger live_manual_revision before update on public.live_sale_manual_lot_items for each row execute function public.touch_live_manual_revision();
revoke all on function public.touch_live_manual_revision() from public,anon,authenticated;


commit;
