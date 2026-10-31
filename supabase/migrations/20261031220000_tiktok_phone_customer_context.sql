begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Phone handoffs need the same identity as the order/completion page.
-- The existing owner/paired-staff RPCs remain the only way to read this payload.
create or replace function public.tiktok_order_phone_camera_payload(_id uuid)
returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('id',s.id,'owner_email',s.owner_email,'phone_email',s.phone_email,
  'phone_seen_at',s.phone_seen_at,'expires_at',s.expires_at,
  'request',case when r.id is null then null else jsonb_build_object(
   'id',r.id,'created_at',r.created_at,'opened_at',r.opened_at,'saved_at',r.saved_at,
   'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'order_id',l.order_id,
    'item_title',l.title,'item_number',l.sku_id,'quantity',l.quantity,
    'order',jsonb_build_object('id',o.id,'order_number',o.order_number,
     'recipient_name',o.recipient_name,'buyer_nickname',o.buyer_nickname,'buyer_username',o.buyer_username)) order by l.id),'[]'::jsonb)
    from public.tiktok_order_lines l join public.tiktok_orders o on o.id=l.order_id where l.id=any(r.line_ids))) end)
 from public.tiktok_order_phone_camera_sessions s left join public.tiktok_order_phone_camera_requests r on r.id=s.current_request_id where s.id=_id;
$$;
revoke all on function public.tiktok_order_phone_camera_payload(uuid) from public,anon,authenticated;
commit;
