-- Show the same customer name in the authenticated phone handoff as in the order queue.
create or replace function public.order_phone_camera_payload(_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',s.id,'owner_email',s.owner_email,'phone_email',s.phone_email,
    'phone_seen_at',s.phone_seen_at,'expires_at',s.expires_at,
    'request',case when r.id is null then null else jsonb_build_object(
      'id',r.id,'created_at',r.created_at,'opened_at',r.opened_at,'saved_at',r.saved_at,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'order_id',l.order_id,
        'item_title',l.item_title,'item_number',l.item_number,
        'order',jsonb_build_object('order_number',o.order_number,'buyer_username',o.buyer_username,
          'buyer_name',coalesce(nullif(btrim(o.buyer_name),''),
            nullif(btrim(o.raw_payload #>> '{fulfillmentStartInstructions,0,shippingStep,shipTo,fullName}'),''),
            nullif(btrim(o.raw_payload #>> '{buyer,buyerRegistrationAddress,fullName}'),''),
            nullif(btrim(o.raw_payload->>'buyer_name'),'')))) order by l.id),'[]'::jsonb)
        from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id where l.id=any(r.line_ids))) end)
  from public.order_phone_camera_sessions s left join public.order_phone_camera_requests r on r.id=s.current_request_id where s.id=_id;
$$;
revoke all on function public.order_phone_camera_payload(uuid) from public,anon,authenticated;
