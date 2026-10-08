begin;
set local lock_timeout='3s';
set local statement_timeout='90s';

-- Installed disabled. Activate explicitly after the compatible UI is deployed.
create table public.packaging_settings (
 id boolean primary key default true check(id), enabled boolean not null default false,
 activated_at timestamptz, activated_by uuid
);
insert into public.packaging_settings(id) values(true);
create table public.packaging_handoffs (
 order_id uuid primary key references public.ebay_orders(id),
 created_at timestamptz not null default now(), created_by uuid not null,
 ready_at timestamptz
);
create table public.packaging_shipments (
 id uuid primary key default gen_random_uuid(), tracking_code text not null unique,
 order_ids uuid[] not null check(cardinality(order_ids)>0),
 status text not null default 'in_progress' check(status in ('in_progress','on_hold','ready','dispatched','cancelled')),
 revision integer not null default 1, claimed_by uuid, claimed_until timestamptz,
 created_at timestamptz not null default now(), created_by uuid not null,
 updated_at timestamptz not null default now(), packed_at timestamptz, packed_by uuid,
 dispatch_date date, dispatched_at timestamptz, dispatched_by uuid,
 hold_reason text
);
create table public.packaging_items (
 shipment_id uuid not null references public.packaging_shipments(id),
 order_line_id uuid not null references public.ebay_order_lines(id),
 quantity integer not null check(quantity>0), primary key(shipment_id,order_line_id)
);
create index packaging_items_line_idx on public.packaging_items(order_line_id);
create index packaging_shipments_orders_idx on public.packaging_shipments using gin(order_ids);
create index packaging_shipments_queue_idx on public.packaging_shipments(status,created_at);
create table public.packaging_evidence (
 id uuid primary key default gen_random_uuid(), shipment_id uuid not null references public.packaging_shipments(id),
 bucket text not null, path text not null unique, mime_type text not null,
 media_type text not null check(media_type in ('image','video')), label text,
 created_at timestamptz not null default now(), created_by uuid not null, removed_at timestamptz
);
create table public.packaging_events (
 id uuid primary key default gen_random_uuid(), shipment_id uuid not null references public.packaging_shipments(id),
 request_id uuid not null unique, action text not null, notes text, payload jsonb not null default '{}',
 created_at timestamptz not null default now(), created_by uuid not null
);
create index packaging_events_shipment_idx on public.packaging_events(shipment_id,created_at);
create table public.packaging_issues (
 shipment_id uuid not null references public.packaging_shipments(id), task_id uuid not null references public.ebay_order_tasks(id),
 blocking boolean not null default true, primary key(shipment_id,task_id)
);
create index packaging_issues_task_idx on public.packaging_issues(task_id);

-- No direct writes: all transitions, quantities, claims and evidence are validated below.
do $$ declare t text; begin
 foreach t in array array['packaging_settings','packaging_handoffs','packaging_shipments','packaging_items','packaging_evidence','packaging_events','packaging_issues'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
 end loop;
end $$;

create function public.packaging_order_ready(_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.packaging_handoffs h where h.order_id=_id)
 and exists(select 1 from public.ebay_order_lines l where l.order_id=_id and l.fulfilled_quantity>0 and l.line_status not in ('cancelled','skipped'))
 and not exists(select 1 from public.ebay_order_lines l where l.order_id=_id and l.line_status in ('pending','partially_fulfilled'))
 and exists(select 1 from public.ebay_orders o where o.id=_id and o.status not in ('cancelled','archived'))
$$;

create function public.packaging_local_completion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- External shipped/label updates and pre-activation history never enqueue work.
 if auth.uid() is not null and public.can_manage_inventory()
 and exists(select 1 from public.packaging_settings where enabled and activated_at<=now())
 and old.line_status in ('pending','partially_fulfilled')
 and new.fulfilled_by=auth.uid() and new.fulfilled_at is distinct from old.fulfilled_at
 and (new.fulfilled_quantity>old.fulfilled_quantity or new.line_status='cancelled') then
  insert into public.packaging_handoffs(order_id,created_by) values(new.order_id,auth.uid()) on conflict do nothing;
  update public.ebay_order_tasks set metadata=coalesce(metadata,'{}')||jsonb_build_object('packaging_order_handoff',true)
   where order_id=new.order_id and task_type in ('pending_shipping','pending_packaging') and coalesce(metadata->>'packaging_order_handoff','false')<>'true';
 end if;
 if exists(select 1 from public.packaging_handoffs where order_id=new.order_id) then
  update public.packaging_handoffs set ready_at=case when public.packaging_order_ready(new.order_id) then coalesce(ready_at,now()) else null end where order_id=new.order_id;
  -- A reopened/cancelled line invalidates a box awaiting dispatch, never its inventory.
  if (new.line_status in ('pending','partially_fulfilled','cancelled','skipped') and old.line_status='fulfilled') or new.fulfilled_quantity<old.fulfilled_quantity then
   update public.packaging_shipments set status='on_hold',hold_reason='Order contents changed. Review the order and package again.',revision=revision+1,updated_at=now()
    where new.order_id=any(order_ids) and status in ('in_progress','ready');
  end if;
 end if;
 return new;
end $$;
create trigger packaging_local_completion after update of line_status,fulfilled_quantity,fulfilled_at on public.ebay_order_lines
for each row execute function public.packaging_local_completion();

create function public.packaging_normalize_tracking(_text text) returns text
language plpgsql immutable set search_path='' as $$
declare s text:=upper(regexp_replace(regexp_replace(coalesce(_text,''),'^\][A-Za-z0-9]{2}',''),'[[:space:]\x1d]','','g'));
begin
 if s ~ '^420[0-9]{5}(9[0-9]{19,21})$' then s:=substring(s from 9);
 elsif s ~ '^420[0-9]{9}(9[0-9]{19,21})$' then s:=substring(s from 13);end if;
 return s;
end $$;
-- Enumerate the supported label metadata fields, including multi-label PDFs.
create function public.packaging_tracking_keys(_metadata jsonb) returns text[]
language sql immutable set search_path='' as $$
 select coalesce(array_agg(distinct public.packaging_normalize_tracking(parts.value#>>'{}')) filter(where jsonb_typeof(parts.value)='string' and length(parts.value#>>'{}')>=10),'{}')
 from jsonb_path_query(coalesce(_metadata,'{}'), 'lax $.** ? (@.type() == "object")') obj,
 lateral jsonb_each(obj) fields,
 lateral jsonb_array_elements(case when jsonb_typeof(fields.value)='array' then fields.value else jsonb_build_array(fields.value) end) parts(value)
 where fields.key in ('trackingNumber','tracking_number','trackingNumbers','shippingBarcodeNumber','shippingBarcodeNumbers')
$$;
create index packaging_orders_tracking_idx on public.ebay_orders(public.packaging_normalize_tracking(tracking_number));
create index packaging_orders_label_keys_idx on public.ebay_orders using gin(public.packaging_tracking_keys(label_metadata));
create index packaging_label_event_keys_idx on public.ebay_order_label_events using gin(public.packaging_tracking_keys(label_metadata));

create function public.packaging_label_matches(_tracking text) returns jsonb
language sql stable security definer set search_path='' as $$
 with labels as (
  select o.id order_id,coalesce(nullif(o.label_storage_bucket,'')||'/'||nullif(o.label_file_path,''),'tracking:'||o.id::text) label_key
  from public.ebay_orders o where public.packaging_normalize_tracking(o.tracking_number)=_tracking
    or public.packaging_tracking_keys(o.label_metadata) @> array[_tracking]
  union
  select oid, e.label_storage_bucket||'/'||e.label_file_path from public.ebay_order_label_events e
  cross join lateral unnest(e.order_ids) oid join public.ebay_orders o on o.id=oid
  where public.packaging_tracking_keys(e.label_metadata) @> array[_tracking]
    and (e.action='extra_label' or (e.action in ('attached','replaced','tracking_backfilled') and e.label_file_path=o.label_file_path and e.label_storage_bucket=o.label_storage_bucket))
 ), grouped as (
  select label_key,array_agg(distinct order_id order by order_id) ids from labels group by label_key
 ), dedup as (select distinct ids from grouped)
 select coalesce(jsonb_agg(jsonb_build_object('order_ids',ids,'orders',(
  select jsonb_agg(jsonb_build_object('id',o.id,'order_number',o.order_number,'buyer',coalesce(o.buyer_username,o.buyer_name),'ready',public.packaging_order_ready(o.id))) from public.ebay_orders o where o.id=any(ids)
 ))),'[]') from dedup
$$;

create function public.packaging_detail(_shipment uuid,_orders uuid[]) returns jsonb
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
 'bag_photos',coalesce((select jsonb_agg(jsonb_build_object('bucket','photos','path',p.photo_path,'media_type','image','label','Bag '||coalesce(b.auction_number,b.lot_code)||' · live photo','created_at',p.captured_at,'lot_id',b.id))
  from public.live_sale_bag_photos p join public.live_sale_lots b on b.id=p.lot_id where exists(
   select 1 from public.ebay_order_lines l where l.order_id=any(ids) and (b.matched_order_line_id=l.id or exists(select 1 from public.live_bag_order_links k where k.lot_id=b.id and k.order_line_id=l.id))
  )),'[]'),
 'tasks',coalesce((select jsonb_agg(to_jsonb(t)) from public.ebay_order_tasks t where t.order_id=any(ids) and coalesce(t.metadata->>'hidden_from_task_board','false')<>'true'),'[]'),
 'order_events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select id,task_id,order_id,notes,photo_attachments,signed_by_email,created_at,payload from public.ebay_order_task_events where order_id=any(ids) order by created_at desc limit 200) e),'[]'),
 'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.packaging_evidence e where e.shipment_id=_shipment and removed_at is null),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('actor',(select display_name from public.employees where user_id=e.created_by limit 1)) order by created_at desc) from public.packaging_events e where e.shipment_id=_shipment),'[]'),
 'issues',coalesce((select jsonb_agg(jsonb_build_object('task_id',t.id,'title',t.title,'status',t.status,'blocking',i.blocking,'open',t.status not in ('resolved','approved_by_admin','closed','shipped_completed'),'assigned_to_email',t.assigned_to_email)) from public.packaging_issues i join public.ebay_order_tasks t on t.id=i.task_id where i.shipment_id=_shipment),'[]'),
 'related_packages',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'tracking_code',p.tracking_code,'status',p.status)) from public.packaging_shipments p where p.order_ids && ids and p.id is distinct from _shipment and p.status<>'cancelled'),'[]')) into result;
 return result;
end $$;

create function public.packaging_queue(_view text,_search text,_offset integer) returns jsonb
language sql stable security definer set search_path='' as $$
 with orders as (
  select h.order_id,o.order_number,coalesce(o.buyer_username,o.buyer_name) buyer,h.created_at,
   public.packaging_order_ready(h.order_id) ready
  from public.packaging_handoffs h join public.ebay_orders o on o.id=h.order_id
  where exists(select 1 from public.ebay_order_lines l where l.order_id=h.order_id and l.line_status not in ('cancelled','skipped') and l.fulfilled_quantity>coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=l.id and p.status<>'cancelled'),0))
  and not exists(select 1 from public.packaging_shipments p where h.order_id=any(p.order_ids) and p.status in ('in_progress','on_hold'))
 ), rows as (
  select 'to_package' view,null::uuid shipment_id,order_id,order_number title,buyer subtitle,created_at,false carryover from orders where ready
  union all
  select case p.status when 'ready' then 'sending' when 'dispatched' then 'history' when 'cancelled' then 'history' else p.status end,p.id,null::uuid,p.tracking_code,
   (select string_agg(coalesce(o.buyer_username,o.buyer_name,o.order_number),', ') from public.ebay_orders o where o.id=any(p.order_ids)),p.created_at,p.status='ready' and p.dispatch_date<(now() at time zone 'America/New_York')::date
  from public.packaging_shipments p
 ), filtered as (select * from rows where nullif(btrim(_search),'') is null or title ilike '%'||_search||'%' or subtitle ilike '%'||_search||'%' or exists(select 1 from public.packaging_shipments p join public.ebay_orders o on o.id=any(p.order_ids) where p.id=shipment_id and o.order_number ilike '%'||_search||'%')),
 page as (select * from filtered where view=_view order by carryover desc,created_at,coalesce(shipment_id,order_id) limit 40 offset greatest(0,least(_offset,100000)))
 select jsonb_build_object('enabled',(select enabled from public.packaging_settings),'activated_at',(select activated_at from public.packaging_settings),
 'counts',coalesce((select jsonb_object_agg(view,n) from (select view,count(*) n from filtered group by view) c),'{}'),
 'total',(select count(*) from filtered where view=_view),'rows',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'))
$$;

-- This RPC is the only authenticated write entry point. Requests are replay-safe.
create function public.packaging_workspace(_action text,_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.packaging_shipments; actor public.employees; sid uuid:=nullif(_args->>'shipment_id','')::uuid;
 ids uuid[]:=array(select jsonb_array_elements_text(coalesce(_args->'order_ids','[]'))::uuid);
 tracking text:=public.packaging_normalize_tracking(_args->>'tracking'); matches jsonb; entry jsonb;
 request uuid:=nullif(_args->>'request_id','')::uuid; old_event public.packaging_events;
 line public.ebay_order_lines; oid uuid; qty integer; total_qty integer:=0;
 note text:=nullif(btrim(_args->>'note'),''); task jsonb; metadata jsonb; object_path text; mime text; file_type text;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Active staff access required' using errcode='42501';end if;
 select * into actor from public.employees where user_id=auth.uid() and active is true limit 1;
 if not found then raise exception 'Active employee not found';end if;
 if _action='queue' then return public.packaging_queue(coalesce(_args->>'view','to_package'),left(coalesce(_args->>'search',''),200),coalesce((_args->>'offset')::integer,0))||jsonb_build_object('user_id',auth.uid(),'is_admin',actor.role='admin');end if;
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
  if ids is null or cardinality(ids)>50 then raise exception 'Select the orders in this package';end if;
  matches:=public.packaging_label_matches(tracking);
  if not exists(select 1 from jsonb_array_elements(matches) m where m->'order_ids'=to_jsonb(ids)) then
   -- Unrecognized external labels may be linked explicitly, never guessed by buyer.
   if jsonb_array_length(matches)>0 or coalesce((_args->>'confirm_link')::boolean,false) is not true then raise exception 'Review and confirm the scanned label belongs to these orders';end if;
   if note is null then raise exception 'Explain the external label association';end if;
  end if;
  foreach oid in array ids loop
   perform pg_advisory_xact_lock(hashtextextended(oid::text,2));
   if not public.packaging_order_ready(oid) then raise exception 'An order is still open or was closed before Packaging was activated';end if;
  end loop;
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

create function public.packaging_task_context() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.task_type in ('pending_shipping','pending_packaging') and exists(select 1 from public.packaging_handoffs where order_id=new.order_id) then
  new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('packaging_order_handoff',true);
 end if;
 return new;
end $$;
create trigger packaging_task_context before insert or update of order_id,task_type on public.ebay_order_tasks for each row execute function public.packaging_task_context();

-- Older clients must not mark packaging work shipped merely by closing Pending Orders.
create function public.packaging_guard_shipping_task() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='shipped_completed' and old.status is distinct from new.status and new.task_type in ('pending_shipping','pending_packaging')
 and exists(select 1 from public.packaging_handoffs where order_id=new.order_id)
 and (not exists(select 1 from public.packaging_shipments where new.order_id=any(order_ids) and status='dispatched')
 or exists(select 1 from public.ebay_order_lines l where l.order_id=new.order_id and l.line_status not in ('cancelled','skipped') and l.fulfilled_quantity>coalesce((select sum(i.quantity) from public.packaging_items i join public.packaging_shipments p on p.id=i.shipment_id where i.order_line_id=l.id and p.status='dispatched'),0))) then
  raise exception 'Complete packing and dispatch in Packaging before closing this shipping task';
 end if;
 return new;
end $$;
create trigger packaging_guard_shipping_task before update of status on public.ebay_order_tasks for each row execute function public.packaging_guard_shipping_task();

do $$ declare f record;begin
 for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'packaging_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.name);
 end loop;
end $$;
grant execute on function public.packaging_workspace(text,jsonb) to authenticated;
commit;
