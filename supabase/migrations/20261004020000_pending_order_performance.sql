-- Include the metadata previously fetched by a second queue-wide browser request.
create or replace function public.list_pending_ebay_order_queue_v2(
  _status text default 'pending', _include_admin_fields boolean default false,
  _limit integer default 1000, _offset integer default 0
) returns setof jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select to_jsonb(q) || jsonb_build_object(
    'line_raw_payload', coalesce(l.raw_payload, '{}'::jsonb),
    'order_raw_payload', coalesce(o.raw_payload, '{}'::jsonb))
  from public.list_pending_ebay_order_queue(_status,_include_admin_fields,_limit,_offset) q
  join public.ebay_order_lines l on l.id=q.id
  join public.ebay_orders o on o.id=q.order_id;
$$;
revoke all on function public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer) from public,anon;
grant execute on function public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer) to authenticated;

-- The messages contain identifiers only; clients reread through the existing authorized APIs.
create policy "Staff receive pending order updates" on realtime.messages
  for select to authenticated using (
    realtime.topic()='pending-orders:updates' and extension='broadcast'
    and public.can_manage_inventory()
  );

create function public.broadcast_pending_order_update()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare change jsonb;
begin
  if tg_table_name='ebay_order_task_events' then
    if coalesce(new.payload->>'proof_type',old.payload->>'proof_type','') <> 'completion_photo' then return null; end if;
    change:=jsonb_build_object('kind','completion_photo','order_id',coalesce(new.order_id,old.order_id));
  elsif tg_table_name='order_phone_camera_sessions' then
    -- Reading the phone heartbeat must not produce another heartbeat broadcast.
    if tg_op='UPDATE' and new.current_request_id is not distinct from old.current_request_id
      and new.phone_user_id is not distinct from old.phone_user_id
      and new.closed_at is not distinct from old.closed_at then return null; end if;
    change:=jsonb_build_object('kind','phone_camera','session_id',coalesce(new.id,old.id));
  elsif tg_table_name='order_phone_camera_requests' then
    if tg_op='UPDATE' and new.opened_at is not distinct from old.opened_at
      and new.saved_at is not distinct from old.saved_at then return null; end if;
    change:=jsonb_build_object('kind','phone_camera','session_id',coalesce(new.session_id,old.session_id));
  end if;
  perform realtime.send(change,'changed','pending-orders:updates',true);
  return null;
exception when others then
  -- A live-update outage must never roll back a saved photo. Polling remains available.
  raise warning 'Pending order notification unavailable: %', sqlstate;
  return null;
end $$;
revoke all on function public.broadcast_pending_order_update() from public,anon,authenticated;
create trigger pending_order_photo_update after insert or update or delete on public.ebay_order_task_events
  for each row execute function public.broadcast_pending_order_update();
create trigger pending_order_phone_session_update after insert or update or delete on public.order_phone_camera_sessions
  for each row execute function public.broadcast_pending_order_update();
create trigger pending_order_phone_request_update after insert or update or delete on public.order_phone_camera_requests
  for each row execute function public.broadcast_pending_order_update();
