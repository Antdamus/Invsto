begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Read-only reference evidence. Photo metadata is independent of the recent notes
-- window, includes hidden receipt tasks, and retains exact item/order provenance.
-- Existing workspace authorization, writes, claims, stock and dispatch are unchanged.
create or replace function public.packaging_detail(_shipment uuid,_orders uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.packaging_shipments; ids uuid[]:=_orders; result jsonb;
begin
 if _shipment is not null then select * into s from public.packaging_shipments where id=_shipment; if not found then raise exception 'Package not found';end if; ids:=s.order_ids;end if;
 if cardinality(ids)>50 then raise exception 'Too many orders';end if;
 select jsonb_build_object('shipment',case when s.id is null then null else to_jsonb(s)||jsonb_build_object('claimed_name',(select display_name from public.employees where user_id=s.claimed_by limit 1)) end,
 'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'buyer_username',o.buyer_username,'buyer_name',o.buyer_name,'sale_date',o.sale_date,'ready',public.packaging_order_ready(o.id),'tracking_number',o.tracking_number,'label_metadata',o.label_metadata,'label_file_path',o.label_file_path,'label_storage_bucket',o.label_storage_bucket)) from public.ebay_orders o where o.id=any(ids)),'[]'),
 'lines',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'order_id',l.order_id,'item_title',l.item_title,'item_number',l.item_number,'custom_label',l.custom_label,'quantity',l.quantity,'fulfilled_quantity',l.fulfilled_quantity,'line_status',l.line_status,'notes',l.notes,
 'packed_quantity',coalesce((select i.quantity from public.packaging_items i where i.order_line_id=l.id and i.shipment_id=_shipment),0),
 'other_quantity',coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=l.id and p.id is distinct from _shipment and p.status<>'cancelled'),0))) from public.ebay_order_lines l where l.order_id=any(ids)),'[]'),
 'bag_photos',coalesce((select jsonb_agg(jsonb_build_object('bucket','photos','path',p.photo_path,'media_type','image','label','Live bag screenshot','created_at',p.captured_at,'lot_id',b.id,
   'order_line_ids',scope.line_ids,'order_ids',scope.order_ids) order by p.captured_at,p.photo_path)
  from public.live_sale_bag_photos p join public.live_sale_lots b on b.id=p.lot_id
  cross join lateral (select array_agg(distinct l.id) line_ids,array_agg(distinct l.order_id) order_ids from public.ebay_order_lines l
   where l.order_id=any(ids) and (b.matched_order_line_id=l.id
    or exists(select 1 from public.live_bag_order_links k where k.lot_id=b.id and k.order_line_id=l.id)
    or exists(select 1 from public.ebay_live_attempts a where a.lot_id=b.id and a.order_line_id=l.id)
    or exists(select 1 from public.shared_inventory_bag_links k where k.lot_id=b.id and k.order_line_id=l.id))) scope
  where cardinality(scope.line_ids)>0),'[]'),
 'reference_events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'order_id',e.order_id,'task_id',e.task_id,
   'task_line_ids',t.order_line_ids,'task_metadata',t.metadata,'photo_attachments',e.photo_attachments,
   'signed_by_email',e.signed_by_email,'created_at',e.created_at,'payload',jsonb_build_object(
    'proof_type',e.payload->'proof_type','order_line_ids',e.payload->'order_line_ids','order_line_id',e.payload->'order_line_id',
    'source',e.payload->'source','item_number',e.payload->'item_number','itemNumber',e.payload->'itemNumber')) order by e.created_at desc,e.id)
  from public.ebay_order_task_events e left join public.ebay_order_tasks t on t.id=e.task_id
  where e.order_id=any(ids) and coalesce(e.payload->>'history_removed','false')<>'true'
   and jsonb_typeof(e.photo_attachments)='array' and e.photo_attachments<>'[]'::jsonb),'[]'),
 'completion_events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'order_ids',array(select x from unnest(e.order_ids) x where x=any(ids)),
   'order_line_ids',array(select l.id from public.ebay_order_lines l where l.id=any(e.order_line_ids) and l.order_id=any(ids)),
   'created_at',e.created_at,'signed_by_email',e.signed_by_email,'photo_attachments',kept.photos) order by e.created_at desc)
  from public.ebay_order_admin_events e cross join lateral (
   select jsonb_agg(p) photos from jsonb_array_elements(case when jsonb_typeof(e.payload->'evidence_photos')='array' then e.payload->'evidence_photos' else '[]'::jsonb end) p
   where not exists(select 1 from public.ebay_order_task_events te where te.order_id=any(ids) and (
    (coalesce(te.payload->>'history_removed','false')='true' and te.photo_attachments @> jsonb_build_array(jsonb_build_object('bucket',p->>'bucket','path',p->>'path')))
    or exists(select 1 from jsonb_array_elements(coalesce(te.payload->'completion_photo_changes','[]'::jsonb)) c
      where c->>'bucket'=p->>'bucket' and c->>'path'=p->>'path')))) kept
  where e.order_ids && ids and kept.photos is not null),'[]'),
 'tasks',coalesce((select jsonb_agg(to_jsonb(t)) from public.ebay_order_tasks t where t.order_id=any(ids) and coalesce(t.metadata->>'hidden_from_task_board','false')<>'true'),'[]'),
 'order_events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select id,task_id,order_id,notes,photo_attachments,signed_by_email,created_at,payload from public.ebay_order_task_events where order_id=any(ids) and coalesce(payload->>'history_removed','false')<>'true' order by created_at desc limit 200) e),'[]'),
 'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.packaging_evidence e where e.shipment_id=_shipment and removed_at is null),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('actor',(select display_name from public.employees where user_id=e.created_by limit 1)) order by created_at desc) from public.packaging_events e where e.shipment_id=_shipment),'[]'),
 'issues',coalesce((select jsonb_agg(jsonb_build_object('task_id',t.id,'title',t.title,'status',t.status,'blocking',i.blocking,'open',t.status not in ('resolved','approved_by_admin','closed','shipped_completed'),'assigned_to_email',t.assigned_to_email)) from public.packaging_issues i join public.ebay_order_tasks t on t.id=i.task_id where i.shipment_id=_shipment),'[]'),
 'related_packages',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'tracking_code',p.tracking_code,'status',p.status)) from public.packaging_shipments p where p.order_ids && ids and p.id is distinct from _shipment and p.status<>'cancelled'),'[]')) into result;
 return result;
end $$;

revoke all on function public.packaging_detail(uuid,uuid[]) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
