begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Username is the grouping identity, never a similar display name. Unknown
-- usernames remain separate. Group before filtering/paging to keep buyers whole.
create or replace function public.packaging_buyer_key(_username text,_order uuid) returns text
language sql immutable set search_path='' as $$
 select coalesce('buyer:'||nullif(lower(btrim(_username)),''),'order:'||_order::text)
$$;

create or replace function public.packaging_ready_orders()
returns table(order_id uuid,order_number text,buyer text,buyer_key text,created_at timestamptz,item_count bigint,tracking_number text)
language sql stable security definer set search_path='' as $$
 select h.order_id,o.order_number,coalesce(nullif(btrim(o.buyer_username),''),nullif(o.buyer_name,''),o.order_number),
  public.packaging_buyer_key(o.buyer_username,o.id),h.created_at,remaining.n,o.tracking_number
 from public.packaging_handoffs h join public.ebay_orders o on o.id=h.order_id
 cross join lateral (select sum(greatest(0,l.fulfilled_quantity-coalesce((select sum(i.quantity)
  from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id
  where i.order_line_id=l.id and p.status<>'cancelled'),0)))::bigint n
  from public.ebay_order_lines l where l.order_id=h.order_id and l.line_status='fulfilled') remaining
 where remaining.n>0 and public.packaging_order_ready(h.order_id)
 and not exists(select 1 from public.packaging_shipments p where h.order_id=any(p.order_ids) and p.status in ('in_progress','on_hold'))
$$;

create or replace function public.packaging_buyer_orders(_order uuid) returns uuid[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(r.order_id order by r.order_id),'{}') from public.packaging_ready_orders() r
 join public.ebay_orders o on o.id=_order and r.buyer_key=public.packaging_buyer_key(o.buyer_username,o.id)
$$;

create or replace function public.packaging_queue(_view text,_search text,_offset integer) returns jsonb
language sql stable security definer set search_path='' as $$
 with search_match as materialized (
  select coalesce(array_agg(distinct oid::uuid),'{}') ids
  from jsonb_array_elements(case when length(public.packaging_normalize_tracking(_search))>=10
   then public.packaging_label_matches(public.packaging_normalize_tracking(_search)) else '[]'::jsonb end) m
  cross join lateral jsonb_array_elements_text(m->'order_ids') oid
 ), grouped as (
  select buyer_key,array_agg(order_id order by order_id) ids,min(buyer) buyer,min(created_at) created_at,
   count(*) order_count,sum(item_count) item_count,string_agg(order_number,' · ' order by order_number) order_numbers,
   string_agg(coalesce(tracking_number,''),' ') tracking_numbers
  from public.packaging_ready_orders() group by buyer_key
 ), rows as (
  select 'to_package' view,null::uuid shipment_id,ids[1] order_id,ids order_ids,buyer_key,buyer title,
   order_count||' order'||case when order_count=1 then '' else 's' end||' · '||item_count||' item'||case when item_count=1 then '' else 's' end subtitle,
   created_at,false carryover,order_count,item_count,order_numbers,tracking_numbers
  from grouped
  union all
  select case p.status when 'ready' then 'sending' when 'dispatched' then 'history' when 'cancelled' then 'history' else p.status end,
   p.id,null::uuid,p.order_ids,null::text,p.tracking_code,
   (select string_agg(distinct coalesce(nullif(btrim(o.buyer_username),''),o.buyer_name,o.order_number),', ') from public.ebay_orders o where o.id=any(p.order_ids)),
   p.created_at,p.status='ready' and p.dispatch_date<(now() at time zone 'America/New_York')::date,
   cardinality(p.order_ids)::bigint,null::numeric,
   (select string_agg(o.order_number,' · ') from public.ebay_orders o where o.id=any(p.order_ids)),p.tracking_code
  from public.packaging_shipments p
 ), filtered as (select * from rows where nullif(btrim(_search),'') is null or title ilike '%'||_search||'%'
  or subtitle ilike '%'||_search||'%' or order_numbers ilike '%'||_search||'%' or tracking_numbers ilike '%'||_search||'%' or order_ids && (select ids from search_match)
  or (shipment_id is not null and public.packaging_normalize_tracking(_search)=title)),
 page as (select * from filtered where view=_view order by carryover desc,created_at,coalesce(shipment_id,order_id) limit 40 offset greatest(0,least(_offset,100000)))
 select jsonb_build_object('enabled',(select enabled from public.packaging_settings),'activated_at',(select activated_at from public.packaging_settings),
 'counts',coalesce((select jsonb_object_agg(view,n) from (select view,count(*) n from filtered group by view) c),'{}'),
 'total',(select count(*) from filtered where view=_view),'order_total',(select coalesce(sum(order_count),0) from filtered where view=_view),
 'rows',coalesce((select jsonb_agg(to_jsonb(p)-'tracking_numbers') from page p),'[]'))
$$;

-- A tracking code saved on several orders for the same username is one candidate,
-- even when each order has its own copy of the PDF. Different buyers stay distinct.
create or replace function public.packaging_label_matches(_tracking text) returns jsonb
language sql stable security definer set search_path='' as $$
 with labels as (
  select o.id order_id,coalesce(nullif(o.label_storage_bucket,'')||'/'||nullif(o.label_file_path,''),'tracking:'||o.id::text) label_key from public.ebay_orders o where public.packaging_normalize_tracking(o.tracking_number)=_tracking
   or public.packaging_tracking_keys(o.label_metadata) @> array[_tracking]
  union
  select oid,e.label_storage_bucket||'/'||e.label_file_path from public.ebay_order_label_events e cross join lateral unnest(e.order_ids) oid join public.ebay_orders o on o.id=oid
  where public.packaging_tracking_keys(e.label_metadata) @> array[_tracking]
   and (e.action='extra_label' or (e.action in ('attached','replaced','tracking_backfilled') and e.label_file_path=o.label_file_path and e.label_storage_bucket=o.label_storage_bucket))
 ), label_groups as (
  select label_key,array_agg(distinct o.id order by o.id) ids,
   case when count(distinct public.packaging_buyer_key(o.buyer_username,o.id))=1 then min(public.packaging_buyer_key(o.buyer_username,o.id)) end buyer_key
  from labels l join public.ebay_orders o on o.id=l.order_id group by label_key
 ), grouped as (
  select buyer_key,array_agg(distinct oid order by oid) ids from label_groups cross join lateral unnest(ids) oid where buyer_key is not null group by buyer_key
  union select buyer_key,ids from label_groups where buyer_key is null
 )
 select coalesce(jsonb_agg(jsonb_build_object('order_ids',ids,'orders',(
  select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'buyer',coalesce(o.buyer_username,o.buyer_name),'ready',public.packaging_order_ready(o.id)) order by o.order_number) from public.ebay_orders o where o.id=any(ids)
 ),'buyer_order_ids',case when buyer_key is not null then public.packaging_buyer_orders(ids[1]) else '{}'::uuid[] end,'buyer_orders',(
  select coalesce(jsonb_agg(jsonb_build_object('id',r.order_id,'order_number',r.order_number,'buyer',r.buyer,'ready',true,'tracking_number',r.tracking_number) order by r.order_number),'[]')
  from public.packaging_ready_orders() r where r.buyer_key=g.buyer_key
 )) order by buyer_key),'[]') from grouped g
$$;

-- Workspace definition is appended below. Existing mutations are preserved;
-- buyer consolidation adds a confirmed, validated start path only.

create or replace function public.packaging_workspace(_action text,_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.packaging_shipments; actor public.employees; sid uuid:=nullif(_args->>'shipment_id','')::uuid;
 ids uuid[]:=array(select jsonb_array_elements_text(coalesce(_args->'order_ids','[]'))::uuid);
 tracking text:=public.packaging_normalize_tracking(_args->>'tracking'); matches jsonb; entry jsonb;
 request uuid:=nullif(_args->>'request_id','')::uuid; old_event public.packaging_events;
 buyer_ids uuid[]; buyer_key text;
 line public.ebay_order_lines; oid uuid; qty integer; total_qty integer:=0;
 note text:=nullif(btrim(_args->>'note'),''); task jsonb; metadata jsonb; object_path text; mime text; file_type text;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Active staff access required' using errcode='42501';end if;
 select * into actor from public.employees where user_id=auth.uid() and active is true limit 1;
 if not found then raise exception 'Active employee not found';end if;
 if _action='queue' then return public.packaging_queue(coalesce(_args->>'view','to_package'),left(coalesce(_args->>'search',''),200),coalesce((_args->>'offset')::integer,0))||jsonb_build_object('user_id',auth.uid(),'is_admin',actor.role='admin');end if;
 if _action='buyer' then
  ids:=public.packaging_buyer_orders((_args->>'buyer_order_id')::uuid);
  if cardinality(ids)=0 then raise exception 'This buyer has no orders waiting to be packaged. Refresh the queue.';end if;
  return public.packaging_detail(null,ids);
 end if;
 if _action='detail' then return public.packaging_detail(sid,ids);end if;
 if _action='scan' then
  if length(tracking)<10 or length(tracking)>50 or tracking !~ '^[A-Z0-9]+$' then raise exception 'Scan the shipping tracking barcode';end if;
  select * into s from public.packaging_shipments where tracking_code=tracking;
  return jsonb_build_object('tracking',tracking,'shipment_id',s.id,'matches',public.packaging_label_matches(tracking));
 end if;
 if _action='staff' then return coalesce((select jsonb_agg(jsonb_build_object('user_id',user_id,'name',coalesce(display_name,email))) from public.employees where active is true and user_id is not null),'[]');end if;
 if request is null then raise exception 'Missing request identity';end if;
 -- Serialize a retry even if it arrives before the original transaction commits.
 perform pg_advisory_xact_lock(hashtextextended(request::text,0));
 select * into old_event from public.packaging_events where request_id=request;
 if found then
  if old_event.created_by<>auth.uid() or old_event.action<>_action or old_event.payload->'request' is distinct from (_args-'request_id') then raise exception 'Request identity already used for another action';end if;
  return public.packaging_detail(old_event.shipment_id,null);
 end if;
 if _action='start' then
  if length(tracking)<10 or length(tracking)>50 or tracking !~ '^[A-Z0-9]+$' then raise exception 'Scan a valid shipping tracking barcode';end if;
  perform pg_advisory_xact_lock(hashtextextended(tracking,1));
  select * into s from public.packaging_shipments where tracking_code=tracking;
  if found then return public.packaging_detail(s.id,null);end if;
  select array_agg(distinct i order by i) into ids from unnest(ids) i;
  if ids is null or cardinality(ids)>500 then raise exception 'Select the orders in this package';end if;
  matches:=public.packaging_label_matches(tracking);
  if coalesce((_args->>'combine_buyer')::boolean,false) then
   if coalesce((_args->>'confirm_buyer')::boolean,false) is not true then raise exception 'Confirm that all buyer orders belong with the recipient on this shipping label';end if;
   select public.packaging_buyer_key(o.buyer_username,o.id) into buyer_key from public.ebay_orders o where o.id=ids[1];
   perform pg_advisory_xact_lock(hashtextextended(buyer_key,3));
   if buyer_key not like 'buyer:%' or exists(select 1 from public.ebay_orders o where o.id=any(ids) and public.packaging_buyer_key(o.buyer_username,o.id)<>buyer_key) then raise exception 'Combine only orders for the same eBay username';end if;
   if jsonb_array_length(matches)>0 and not exists(select 1 from jsonb_array_elements(matches) m
    where array(select jsonb_array_elements_text(m->'order_ids')::uuid) <@ ids) then raise exception 'This label belongs to a different order or buyer';end if;
   if jsonb_array_length(matches)=0 and (coalesce((_args->>'confirm_link')::boolean,false) is not true or note is null) then raise exception 'Review and confirm the external shipping label';end if;
  elsif not exists(select 1 from jsonb_array_elements(matches) m where m->'order_ids'=to_jsonb(ids)) then
   if jsonb_array_length(matches)>0 or coalesce((_args->>'confirm_link')::boolean,false) is not true then raise exception 'Review and confirm the scanned label belongs to these orders';end if;
   if note is null then raise exception 'Explain the external label association';end if;
  end if;
  foreach oid in array ids loop
   perform pg_advisory_xact_lock(hashtextextended(oid::text,2));
   if not public.packaging_order_ready(oid) then raise exception 'An order is still open or was closed before Packaging was activated';end if;
  end loop;
  if coalesce((_args->>'combine_buyer')::boolean,false) then
   buyer_ids:=public.packaging_buyer_orders(ids[1]);
   if ids is distinct from buyer_ids then raise exception 'This buyer group changed or an order is already being packed. Refresh and review all buyer orders.';end if;
  end if;
  if not exists(select 1 from public.ebay_order_lines l where l.order_id=any(ids) and l.line_status='fulfilled'
    and l.fulfilled_quantity>coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=l.id and p.status<>'cancelled'),0)) then
   raise exception 'All items are already assigned to packages. Open the existing package instead.';
  end if;
  insert into public.packaging_shipments(tracking_code,order_ids,claimed_by,claimed_until,created_by)
   values(tracking,ids,auth.uid(),now()+interval '15 minutes',auth.uid()) returning * into s;
  sid:=s.id;
 else
  select * into s from public.packaging_shipments where id=sid for update;
  if not found then raise exception 'Package not found';end if;
  if s.revision is distinct from (_args->>'revision')::integer then raise exception 'This package changed. Refresh before continuing.' using errcode='40001';end if;
  if _action='claim' then
   if s.status not in ('in_progress','on_hold') then raise exception 'This package is already packed';end if;
   if s.claimed_by is distinct from auth.uid() and s.claimed_until>now() then raise exception 'Another employee is working on this package';end if;
   update public.packaging_shipments set claimed_by=auth.uid(),claimed_until=now()+interval '15 minutes' where id=sid;
  elsif _action in ('reopen','cancel') then
   if actor.role<>'admin' then raise exception 'An administrator must correct or reopen a package';end if;
   if note is null then raise exception 'Enter a reason for this correction';end if;
   if s.status='dispatched' and _action='cancel' then raise exception 'A dispatched package must be reopened before it can be cancelled';end if;
   update public.packaging_shipments set status=case when _action='cancel' then 'cancelled' else 'in_progress' end,
    claimed_by=auth.uid(),claimed_until=now()+interval '15 minutes',packed_at=null,packed_by=null,dispatch_date=null,dispatched_at=null,dispatched_by=null,hold_reason=null where id=sid;
  elsif _action='dispatch' then
   if s.status<>'ready' then raise exception 'Pack and review this package before dispatch';end if;
   if s.dispatch_date<>(now() at time zone 'America/New_York')::date then raise exception 'This package carried over. Reconfirm Sending today before dispatch.';end if;
   if exists(select 1 from public.packaging_issues i join public.ebay_order_tasks t on t.id=i.task_id where i.shipment_id=sid and i.blocking and t.status not in ('resolved','approved_by_admin','closed','shipped_completed')) then raise exception 'Resolve and accept blocking tasks before dispatch';end if;
   if exists(select 1 from unnest(s.order_ids) x where not public.packaging_order_ready(x)) then raise exception 'An order has changed. Review it before dispatch';end if;
   update public.packaging_shipments set status='dispatched',dispatched_at=now(),dispatched_by=auth.uid(),claimed_until=null where id=sid;
   -- Finish legacy shipping assignments only after every fulfilled item has left.
   for task in select to_jsonb(t) from public.ebay_order_tasks t where t.order_id=any(s.order_ids)
    and t.task_type in ('pending_shipping','pending_packaging') and t.status not in ('shipped_completed','closed','cancelled','resolved')
    and not exists(select 1 from public.ebay_order_lines l where l.order_id=t.order_id and l.line_status not in ('cancelled','skipped')
      and l.fulfilled_quantity>coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=l.id and p.status='dispatched'),0))
   loop
    update public.ebay_order_tasks set status='shipped_completed',resolved_at=now(),resolved_by=auth.uid(),resolved_by_email=actor.email,
     resolution_notes='All fulfilled items dispatched through Packaging.',updated_at=now() where id=(task->>'id')::uuid;
    insert into public.ebay_order_task_events(task_id,order_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
     values((task->>'id')::uuid,(task->>'order_id')::uuid,'status_changed',task->>'status','shipped_completed','All fulfilled items dispatched through Packaging.',auth.uid(),actor.email,jsonb_build_object('source','packaging_dispatch','shipment_id',sid));
   end loop;
  elsif _action='sending_today' then
   if s.status<>'ready' then raise exception 'Only packed packages can be scheduled';end if;
   update public.packaging_shipments set dispatch_date=(now() at time zone 'America/New_York')::date where id=sid;
  else
   if s.status not in ('in_progress','on_hold') then raise exception 'This package is no longer editable';end if;
   if s.claimed_by is distinct from auth.uid() or s.claimed_until<=now() then raise exception 'Claim this package before editing';end if;
   if _action='contents' then
    if s.status='on_hold' then raise exception 'Resolve the hold before confirming contents';end if;
    if jsonb_typeof(_args->'items') is distinct from 'array' or jsonb_array_length(_args->'items')>200 then raise exception 'Invalid package contents';end if;
    foreach oid in array s.order_ids loop perform pg_advisory_xact_lock(hashtextextended(oid::text,2));end loop;
    delete from public.packaging_items where shipment_id=sid;
    for entry in select * from jsonb_array_elements(_args->'items') loop
     qty:=(entry->>'quantity')::integer;
     if qty is null or qty<0 then raise exception 'Enter whole, nonnegative quantities';end if;
     select * into line from public.ebay_order_lines where id=(entry->>'line_id')::uuid for share;
     if not found or not(line.order_id=any(s.order_ids)) or line.line_status in ('pending','partially_fulfilled','cancelled','skipped') then raise exception 'This order line is not available for packaging';end if;
     if qty>line.fulfilled_quantity-coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=line.id and p.status<>'cancelled'),0) then raise exception 'Some of this item is already in another package';end if;
     if qty>0 then insert into public.packaging_items values(sid,line.id,qty);total_qty:=total_qty+qty;end if;
    end loop;
    if total_qty=0 then raise exception 'Confirm at least one item in this package';end if;
   elsif _action='evidence' then
    if (select count(*) from public.packaging_evidence where shipment_id=sid and removed_at is null)>=30 then raise exception 'Use up to 30 evidence files per package';end if;
    object_path:=_args->>'path';
    if object_path is null or object_path not like 'packaging/'||sid::text||'/'||auth.uid()::text||'/%' then raise exception 'Evidence must be uploaded for this package';end if;
    select o.metadata into metadata from storage.objects o where o.bucket_id='team-task-evidence' and o.name=object_path;
    if metadata is null then raise exception 'The upload has not finished. Retry saving the evidence.';end if;
    mime:=lower(coalesce(metadata->>'mimetype',''));
    file_type:=case when mime in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then 'image' when mime in ('video/mp4','video/quicktime','video/webm') then 'video' else null end;
    if file_type is null or coalesce((metadata->>'size')::bigint,0)<=0 or (metadata->>'size')::bigint>52428800 then raise exception 'Use a photo or video up to 50 MB';end if;
    insert into public.packaging_evidence(shipment_id,bucket,path,mime_type,media_type,label,created_by)
     values(sid,'team-task-evidence',object_path,mime,file_type,left(_args->>'label',200),auth.uid()) on conflict(path) do nothing;
   elsif _action='remove_evidence' then
    update public.packaging_evidence set removed_at=now() where id=(_args->>'evidence_id')::uuid and shipment_id=sid and removed_at is null;
    if not found then raise exception 'Evidence not found';end if;
   elsif _action='note' then
    if note is null or length(note)>10000 then raise exception 'Enter a note up to 10,000 characters';end if;
   elsif _action='issue' then
    if note is null or length(note)>10000 then raise exception 'Describe what needs to be done';end if;
    oid:=(_args->>'order_id')::uuid;
    if oid is null or not(oid=any(s.order_ids)) then raise exception 'Choose an order in this package';end if;
    select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'path',path,'mime_type',mime_type,'media_type',media_type,'label',label)),'[]') into entry from public.packaging_evidence where shipment_id=sid and removed_at is null;
    task:=public.create_task_request('history',coalesce(_args->>'kind','work'),jsonb_build_object('_order_id',oid,'_assigned_to_user_id',_args->>'owner','_priority','high','_question',note,'_due_at',_args->>'due_at','_photo_attachments',entry,'_signed_by_email',actor.email,'_task_scope','order'));
    update public.ebay_order_tasks t set metadata=coalesce(t.metadata,'{}')||jsonb_build_object('packaging_shipment_id',sid) where id=(task->>'id')::uuid;
    insert into public.packaging_issues values(sid,(task->>'id')::uuid,coalesce((_args->>'blocking')::boolean,true));
    if coalesce((_args->>'blocking')::boolean,true) then update public.packaging_shipments set status='on_hold',hold_reason=note where id=sid;end if;
   elsif _action='hold' then
    if note is null then raise exception 'Explain why this package is on hold';end if;
    update public.packaging_shipments set status='on_hold',hold_reason=note where id=sid;
   elsif _action='resume' then
    if exists(select 1 from public.packaging_issues i join public.ebay_order_tasks t on t.id=i.task_id where i.shipment_id=sid and i.blocking and t.status not in ('resolved','approved_by_admin','closed','shipped_completed')) then raise exception 'Resolve and accept blocking tasks before resuming';end if;
    if note is null then raise exception 'Describe how the issue was resolved';end if;
    update public.packaging_shipments set status='in_progress',hold_reason=null where id=sid;
   elsif _action='pack' then
    if s.status='on_hold' then raise exception 'Resolve the hold before packing';end if;
    if not exists(select 1 from public.packaging_items where shipment_id=sid) then raise exception 'Confirm the package contents first';end if;
    if not exists(select 1 from public.packaging_evidence e join storage.objects o on o.bucket_id=e.bucket and o.name=e.path where e.shipment_id=sid and e.removed_at is null and e.media_type='image') then raise exception 'Add at least one packaging photo before finishing';end if;
    if exists(select 1 from public.packaging_issues i join public.ebay_order_tasks t on t.id=i.task_id where i.shipment_id=sid and i.blocking and t.status not in ('resolved','approved_by_admin','closed','shipped_completed')) then raise exception 'Resolve and accept blocking tasks before packing';end if;
    foreach oid in array s.order_ids loop
     perform pg_advisory_xact_lock(hashtextextended(oid::text,2));
     if not public.packaging_order_ready(oid) then raise exception 'An order has changed. Review it before packing';end if;
    end loop;
    if exists(select 1 from public.packaging_items i join public.ebay_order_lines l on l.id=i.order_line_id where i.shipment_id=sid and (l.line_status<>'fulfilled' or l.fulfilled_quantity<(select sum(i2.quantity) from public.packaging_items i2 join public.packaging_shipments p on p.id=i2.shipment_id where i2.order_line_id=l.id and p.status<>'cancelled'))) then raise exception 'Package contents changed. Review quantities';end if;
    update public.packaging_shipments set status='ready',packed_at=now(),packed_by=auth.uid(),dispatch_date=(now() at time zone 'America/New_York')::date,claimed_until=null where id=sid;
   else raise exception 'Unknown packaging action';end if;
  end if;
  update public.packaging_shipments set revision=revision+1,updated_at=now(),claimed_until=case when status in ('in_progress','on_hold') and claimed_by=auth.uid() then now()+interval '15 minutes' else claimed_until end where id=sid;
 end if;
 insert into public.packaging_events(shipment_id,request_id,action,notes,payload,created_by)
 values(sid,request,_action,note,jsonb_build_object('request',_args-'request_id','task_id',task->>'id'),auth.uid());
 return public.packaging_detail(sid,null);
end $$;


-- A buyer group is reviewed whole; do not truncate large groups at 50 orders.
create or replace function public.packaging_detail(_shipment uuid,_orders uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.packaging_shipments; ids uuid[]:=_orders; result jsonb;
begin
 if _shipment is not null then select * into s from public.packaging_shipments where id=_shipment; if not found then raise exception 'Package not found';end if; ids:=s.order_ids;end if;
 if cardinality(ids)>500 then raise exception 'Too many orders';end if;
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

revoke all on function public.packaging_buyer_key(text,uuid),public.packaging_ready_orders(),public.packaging_buyer_orders(uuid) from public,anon,authenticated;
revoke all on function public.packaging_queue(text,text,integer),public.packaging_label_matches(text),public.packaging_detail(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.packaging_workspace(text,jsonb) to authenticated;
commit;
