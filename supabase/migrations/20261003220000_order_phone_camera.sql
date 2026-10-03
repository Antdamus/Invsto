-- An authenticated phone can follow a workstation without reopening the order queue.
create table public.order_phone_camera_sessions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id), owner_email text,
  phone_user_id uuid references auth.users(id), phone_email text,
  current_request_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  phone_seen_at timestamptz, closed_at timestamptz
);
create table public.order_phone_camera_requests (
  id uuid primary key, session_id uuid not null references public.order_phone_camera_sessions(id),
  line_ids uuid[] not null, created_at timestamptz not null default now(),
  opened_at timestamptz, saved_at timestamptz
);
create index on public.order_phone_camera_requests(session_id,created_at desc);
alter table public.order_phone_camera_sessions enable row level security;
alter table public.order_phone_camera_requests enable row level security;
revoke all on public.order_phone_camera_sessions, public.order_phone_camera_requests from public,anon,authenticated;

create function public.order_phone_camera_payload(_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',s.id,'owner_email',s.owner_email,'phone_email',s.phone_email,
    'phone_seen_at',s.phone_seen_at,'expires_at',s.expires_at,
    'request',case when r.id is null then null else jsonb_build_object(
      'id',r.id,'created_at',r.created_at,'opened_at',r.opened_at,'saved_at',r.saved_at,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'order_id',l.order_id,
        'item_title',l.item_title,'item_number',l.item_number,
        'order',jsonb_build_object('order_number',o.order_number,'buyer_username',o.buyer_username)) order by l.id),'[]'::jsonb)
        from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id where l.id=any(r.line_ids))) end)
  from public.order_phone_camera_sessions s left join public.order_phone_camera_requests r on r.id=s.current_request_id where s.id=_id;
$$;
revoke all on function public.order_phone_camera_payload(uuid) from public,anon,authenticated;

create function public.send_order_to_phone(_session_id uuid,_request_id uuid,_line_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.order_phone_camera_sessions; r public.order_phone_camera_requests; ids uuid[];
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select array_agg(distinct id order by id) into ids from unnest(_line_ids) id where id is not null;
  if _session_id is null or _request_id is null or coalesce(cardinality(ids),0) not between 1 and 100
    or (select count(*) from public.ebay_order_lines where id=any(ids)) <> cardinality(ids) then
    raise exception 'Select valid order items for the phone' using errcode='22023';
  end if;
  insert into public.order_phone_camera_sessions(id,owner_id,owner_email)
    values(_session_id,auth.uid(),auth.email()) on conflict(id) do nothing;
  select * into s from public.order_phone_camera_sessions where id=_session_id for update;
  if s.owner_id<>auth.uid() then raise exception 'This phone belongs to another workstation user' using errcode='42501'; end if;
  if s.closed_at is not null or s.expires_at<=now() then raise exception 'Pair this phone again' using errcode='P0002'; end if;
  select * into r from public.order_phone_camera_requests where id=_request_id;
  if found then
    if r.session_id<>s.id or r.line_ids<>ids then raise exception 'Request already used' using errcode='22023'; end if;
    -- A delayed retry must not replace a newer order sent from another tab.
    return public.order_phone_camera_payload(s.id);
  end if;
  insert into public.order_phone_camera_requests(id,session_id,line_ids) values(_request_id,s.id,ids);
  update public.order_phone_camera_sessions set current_request_id=_request_id,updated_at=now(),expires_at=now()+interval '7 days' where id=s.id;
  return public.order_phone_camera_payload(s.id);
end $$;

create function public.read_order_phone_camera(_session_id uuid,_phone boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.order_phone_camera_sessions;
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select * into s from public.order_phone_camera_sessions where id=_session_id for update;
  if not found or s.closed_at is not null or s.expires_at<=now() then raise exception 'This pairing has ended. Scan a new QR code from the computer.' using errcode='P0002'; end if;
  if _phone then
    if s.phone_user_id is not null and s.phone_user_id<>auth.uid() then
      raise exception 'A different staff account has already paired this phone link. Ask the computer to disconnect and pair again.' using errcode='42501';
    end if;
    update public.order_phone_camera_sessions set phone_user_id=auth.uid(),phone_email=auth.email(),phone_seen_at=now() where id=s.id;
  elsif s.owner_id<>auth.uid() then
    raise exception 'Only the workstation user can read this pairing' using errcode='42501';
  end if;
  return public.order_phone_camera_payload(s.id);
end $$;

create function public.mark_order_phone_camera_request(_session_id uuid,_request_id uuid,_status text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.order_phone_camera_sessions;
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select * into s from public.order_phone_camera_sessions where id=_session_id for update;
  if not found or s.closed_at is not null or s.expires_at<=now() then raise exception 'This pairing has ended' using errcode='P0002'; end if;
  if s.phone_user_id is distinct from auth.uid() then raise exception 'Only the paired phone can acknowledge photos' using errcode='42501'; end if;
  if _status not in ('opened','saved') or _status is null then raise exception 'Invalid phone status' using errcode='22023'; end if;
  update public.order_phone_camera_requests set
    opened_at=coalesce(opened_at,now()),saved_at=case when _status='saved' then now() else saved_at end
    where id=_request_id and session_id=s.id;
  if not found then raise exception 'Unknown photo request' using errcode='22023'; end if;
  update public.order_phone_camera_sessions set phone_seen_at=now() where id=s.id;
end $$;

create function public.disconnect_order_phone_camera(_session_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.order_phone_camera_sessions;
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select * into s from public.order_phone_camera_sessions where id=_session_id for update;
  if not found then return; end if;
  if s.owner_id<>auth.uid() then raise exception 'Only the workstation user can disconnect' using errcode='42501'; end if;
  update public.order_phone_camera_sessions set closed_at=coalesce(closed_at,now()) where id=s.id;
end $$;
revoke all on function public.send_order_to_phone(uuid,uuid,uuid[]),public.read_order_phone_camera(uuid,boolean),
  public.mark_order_phone_camera_request(uuid,uuid,text),public.disconnect_order_phone_camera(uuid) from public,anon;
grant execute on function public.send_order_to_phone(uuid,uuid,uuid[]),public.read_order_phone_camera(uuid,boolean),
  public.mark_order_phone_camera_request(uuid,uuid,text),public.disconnect_order_phone_camera(uuid) to authenticated;
