-- A bulk eBay sync used to reconcile a complete Live event once per line.
-- Its repeated activity-time repairs could exhaust the statement timeout.
-- Reconcile each affected event once after all lines in the statement are
-- visible. Reservation row triggers and the atomic import remain unchanged.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.ebay_live_activity_time(_start timestamptz,_zone text,_clock text) returns timestamptz
language plpgsql stable set search_path='' as $$
declare parts text[]; dated text[]; local_clock time; result timestamptz; matches integer; month_number integer;
begin
 -- These two canonical zones need no enumeration of every installed zone.
 -- Keep the original exact-name validation for all other zones, and retain
 -- the ambiguity checks below (especially DST overlap and missing clocks).
 if _start is null or _zone is null or nullif(btrim(_clock),'') is null then return null;end if;
 if _zone not in ('America/New_York','UTC')
  and not exists(select 1 from pg_timezone_names where name=_zone) then return null;end if;
 dated:=regexp_match(btrim(_clock),'^([A-Za-z]{3})[[:space:]]+([0-9]{1,2}),[[:space:]]+([0-9]{1,2}:[0-9]{2}[[:space:]]*(AM|PM))$','i');
 if dated is not null then
  month_number:=array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],lower(dated[1]));
  if month_number is null or dated[2]::int not between 1 and 31 then return null;end if;
 end if;
 parts:=regexp_match(coalesce(dated[3],btrim(_clock)),'^([0-9]{1,2}):([0-9]{2})[[:space:]]*(AM|PM)$','i');
 if parts is null or parts[1]::int not between 1 and 12 or parts[2]::int>59 then return null;end if;
 local_clock:=make_time(parts[1]::int%12+case when upper(parts[3])='PM' then 12 else 0 end,parts[2]::int,0);
 with local_dates as (
  select ((_start at time zone _zone)::date+d)+local_clock wall from generate_series(-1,2) d
 ), candidates as (
  select distinct wall,(wall at time zone _zone)+h*interval '30 minutes' instant
  from local_dates cross join generate_series(-4,4) h
 ), valid as (
  select instant from candidates where instant at time zone _zone=wall
   and instant>=_start-interval '2 hours' and instant<_start+interval '22 hours'
   and (dated is null or (extract(month from wall)=month_number and extract(day from wall)=dated[2]::int))
 ) select count(*),min(instant) into matches,result from valid;
 return case when matches=1 then result end;
end $$;

create function public.ebay_live_order_lines_changed_statement()
returns trigger language plpgsql security definer set search_path='' as $$
declare order_ids uuid[]; event_id_to_check text;
begin
 if TG_OP='INSERT' then
  select array_agg(distinct n.order_id) into order_ids from new_lines n;
 else
  select array_agg(distinct n.order_id) into order_ids
  from new_lines n join old_lines o on o.id=n.id
  where n.raw_payload is distinct from o.raw_payload
   or n.sold_for is distinct from o.sold_for
   or (n.line_status='cancelled') is distinct from (o.line_status='cancelled');
 end if;
 if coalesce(cardinality(order_ids),0)=0 then return null;end if;

 -- Same event matching as the previous row trigger. A deterministic event
 -- order also avoids taking multiple event locks in arbitrary row order.
 for event_id_to_check in
  select distinct a.event_id
  from public.ebay_live_attempts a
  join public.ebay_order_lines l on l.item_number=a.listing_id
  join public.ebay_orders o on o.id=l.order_id
  where o.id=any(order_ids) and lower(o.buyer_username)=lower(a.buyer)
  order by a.event_id
 loop
  perform public.reconcile_ebay_live_orders_internal(event_id_to_check);
 end loop;
 return null;
end $$;
revoke all on function public.ebay_live_order_lines_changed_statement() from public,anon,authenticated;

drop trigger if exists ebay_live_order_line_changed on public.ebay_order_lines;
create trigger ebay_live_order_lines_inserted
 after insert on public.ebay_order_lines referencing new table as new_lines
 for each statement execute function public.ebay_live_order_lines_changed_statement();
create trigger ebay_live_order_lines_updated
 after update on public.ebay_order_lines referencing old table as old_lines new table as new_lines
 for each statement execute function public.ebay_live_order_lines_changed_statement();
commit;
