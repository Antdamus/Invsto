begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Staff classification is independent of eBay imports and fulfillment status.
create table public.order_line_watch_flags (
 order_line_id uuid primary key references public.ebay_order_lines(id) on delete restrict,
 is_watch boolean not null,
 revision bigint not null default 1,
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 updated_by_email text not null
);
create table public.order_line_watch_events (
 id uuid primary key default gen_random_uuid(),
 order_line_id uuid not null references public.ebay_order_lines(id) on delete restrict,
 is_watch boolean not null,
 revision bigint not null,
 created_at timestamptz not null default now(),
 signed_by uuid references auth.users(id) on delete set null,
 signed_by_email text not null
);
create index order_line_watch_events_line_idx on public.order_line_watch_events(order_line_id,created_at desc);
alter table public.order_line_watch_flags enable row level security;
alter table public.order_line_watch_events enable row level security;
revoke all on public.order_line_watch_flags,public.order_line_watch_events from public,anon,authenticated;
grant select on public.order_line_watch_flags,public.order_line_watch_events to authenticated;
create policy watch_flags_staff_read on public.order_line_watch_flags for select to authenticated using(public.can_manage_inventory());
create policy watch_events_staff_read on public.order_line_watch_events for select to authenticated using(public.can_manage_inventory());

create function public.set_order_line_watch(_order_line_id uuid,_is_watch boolean,_expected_revision bigint default 0)
returns public.order_line_watch_flags language plpgsql security definer set search_path='' as $$
declare line public.ebay_order_lines; saved public.order_line_watch_flags; actor text;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Staff access required' using errcode='42501';
 end if;
 if _is_watch is null or _expected_revision is null or _expected_revision<0 then
  raise exception 'Watch status and revision are required' using errcode='22023';
 end if;
 select * into line from public.ebay_order_lines where id=_order_line_id for update;
 if not found then raise exception 'Order item not found' using errcode='P0002'; end if;
 if line.line_status is null or line.line_status not in ('pending','partially_fulfilled') then
  raise exception 'This item is no longer pending. Refresh the order.' using errcode='22023';
 end if;
 select * into saved from public.order_line_watch_flags where order_line_id=line.id;
 if found and saved.is_watch=_is_watch then return saved; end if;
 if coalesce(saved.revision,0)<>_expected_revision then
  raise exception 'Another teammate changed this Watch marker. Refresh it and try again.' using errcode='40001';
 end if;
 select coalesce(email,'Staff') into actor from auth.users where id=auth.uid();
 insert into public.order_line_watch_flags(order_line_id,is_watch,updated_by,updated_by_email)
 values(line.id,_is_watch,auth.uid(),coalesce(actor,'Staff'))
 on conflict(order_line_id) do update set is_watch=excluded.is_watch,
  revision=public.order_line_watch_flags.revision+1,updated_at=clock_timestamp(),
  updated_by=excluded.updated_by,updated_by_email=excluded.updated_by_email returning * into saved;
 insert into public.order_line_watch_events(order_line_id,is_watch,revision,signed_by,signed_by_email)
 values(line.id,saved.is_watch,saved.revision,auth.uid(),coalesce(actor,'Staff'));
 begin
  perform realtime.send(jsonb_build_object('kind','watch_flag','line_id',line.id),'changed','pending-orders:updates',true);
 exception when others then raise warning 'Watch marker notification unavailable: %',sqlstate;
 end;
 return saved;
end $$;
revoke all on function public.set_order_line_watch(uuid,boolean,bigint) from public,anon;
grant execute on function public.set_order_line_watch(uuid,boolean,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
