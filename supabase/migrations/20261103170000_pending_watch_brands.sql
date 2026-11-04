begin;
set local lock_timeout='5s';

alter table public.order_line_watch_flags add column brand text
 check(brand is null or (is_watch and brand in ('cartier','rolex','ap','other')));
alter table public.order_line_watch_events add column brand text
 check(brand is null or (is_watch and brand in ('cartier','rolex','ap','other')));

create function public.set_order_line_watch_brand(_order_line_id uuid,_is_watch boolean,_expected_revision bigint,_brand text)
returns public.order_line_watch_flags language plpgsql security definer set search_path='' as $$
declare line public.ebay_order_lines; prior public.order_line_watch_flags; saved public.order_line_watch_flags; actor text; next_brand text;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Staff access required' using errcode='42501';
 end if;
 if _is_watch is null or _expected_revision is null or _expected_revision<0 or
    (_brand is not null and (not _is_watch or _brand not in ('cartier','rolex','ap','other'))) then
  raise exception 'Invalid Watch marker or brand' using errcode='22023';
 end if;
 select * into line from public.ebay_order_lines where id=_order_line_id for update;
 if not found then raise exception 'Order item not found' using errcode='P0002';end if;
 if line.line_status is null or line.line_status not in ('pending','partially_fulfilled') then
  raise exception 'This item is no longer pending. Refresh the order.' using errcode='22023';
 end if;
 select * into prior from public.order_line_watch_flags where order_line_id=line.id;
 -- Older clients can still mark a watch before a teammate identifies its brand.
 if _is_watch then next_brand:=coalesce(_brand,prior.brand);end if;
 if prior.is_watch=_is_watch and prior.brand is not distinct from next_brand then return prior;end if;
 if coalesce(prior.revision,0)<>_expected_revision then
  raise exception 'Another teammate changed this Watch marker. Refresh it and try again.' using errcode='40001';
 end if;
 select email into actor from auth.users where id=auth.uid();
 insert into public.order_line_watch_flags as f(order_line_id,is_watch,brand,updated_by,updated_by_email)
 values(line.id,_is_watch,next_brand,auth.uid(),coalesce(actor,'Staff'))
 on conflict(order_line_id) do update set is_watch=excluded.is_watch,brand=excluded.brand,
  revision=f.revision+1,updated_at=clock_timestamp(),updated_by=excluded.updated_by,updated_by_email=excluded.updated_by_email
 returning * into saved;
 -- Employee Work counts marker additions/removals. Editing the brand only updates the signed current record.
 if prior.is_watch is distinct from saved.is_watch then
  insert into public.order_line_watch_events(order_line_id,is_watch,brand,revision,signed_by,signed_by_email)
  values(line.id,saved.is_watch,saved.brand,saved.revision,auth.uid(),saved.updated_by_email);
 end if;
 begin
  perform realtime.send(jsonb_build_object('kind','watch_flag','line_id',line.id),'changed','pending-orders:updates',true);
 exception when others then raise warning 'Watch marker notification unavailable: %',sqlstate;
 end;
 return saved;
end$$;
revoke all on function public.set_order_line_watch_brand(uuid,boolean,bigint,text) from public,anon;
grant execute on function public.set_order_line_watch_brand(uuid,boolean,bigint,text) to authenticated;

create or replace function public.set_order_line_watch(_order_line_id uuid,_is_watch boolean,_expected_revision bigint default 0)
returns public.order_line_watch_flags language sql security definer set search_path='' as $$
 select public.set_order_line_watch_brand(_order_line_id,_is_watch,_expected_revision,null);
$$;
commit;
notify pgrst,'reload schema';
