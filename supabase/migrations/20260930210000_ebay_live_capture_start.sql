begin;
set local lock_timeout='1s';
set local statement_timeout='15s';

-- Capture supplies the event. Seller selection is the only required show setup.
-- Serialize by event so retries and two capture computers reuse the same show.
create function public.start_ebay_live_capture(
  _event_id text,
  _primary_seller_employee_id uuid,
  _co_seller_employee_ids uuid[] default '{}'
) returns public.live_sale_sessions
language plpgsql security definer set search_path='' as $$
declare s public.live_sale_sessions;
begin
  if not public.can_manage_inventory() then
    raise exception 'Inventory access required' using errcode='42501';
  end if;
  if _event_id is null or _event_id !~ '^[A-Za-z0-9_-]{6,100}$' then
    raise exception 'Open capture from the eBay event dashboard' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ebay-live-capture:'||_event_id,0));
  select ls.* into s from public.ebay_live_connections c
    join public.live_sale_sessions ls on ls.id=c.session_id where c.event_id=_event_id;
  if found then
    if s.status<>'active' or exists(select 1 from public.ebay_live_connections where event_id=_event_id and review_completed_at is not null) then
      raise exception 'This show is already closed. Open the current eBay event to start a new show.' using errcode='22023';
    end if;
    return s;
  end if;
  if _primary_seller_employee_id is null or not exists(
    select 1 from public.employees where id=_primary_seller_employee_id and active is distinct from false
  ) then raise exception 'Select who is selling first' using errcode='22023'; end if;
  if exists(select 1 from unnest(coalesce(_co_seller_employee_ids,'{}')) chosen(id)
    where not exists(select 1 from public.employees e where e.id=chosen.id and e.active is distinct from false)
  ) then raise exception 'One of the selected sellers is no longer active. Refresh the seller list.' using errcode='22023'; end if;
  s:=public.start_ebay_live_session(
    'eBay Live - '||to_char(now() at time zone 'America/New_York','Mon DD, YYYY'),
    null,_event_id,_primary_seller_employee_id,_co_seller_employee_ids,null
  );
  return s;
end $$;
revoke all on function public.start_ebay_live_capture(text,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.start_ebay_live_capture(text,uuid,uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
