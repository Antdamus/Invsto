begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create table public.whatnot_orders (
 id text primary key check(id ~ '^[1-9][0-9]{0,18}$'), url text, status text not null,
 buyer_id text, username text, customer_name text, purchased_at timestamptz, source_updated_at timestamptz, cancelled_at timestamptz,
 currency text not null, subtotal numeric not null, shipping numeric not null, tax numeric not null, total numeric not null,
 show_id text,show_title text,show_url text,synced_at timestamptz not null default now(),created_at timestamptz not null default now()
);
create table public.whatnot_order_lines (
 id text primary key check(id ~ '^[1-9][0-9]{0,18}$'),order_id text not null references public.whatnot_orders(id),title text not null,sku text,product_id text,
 quantity integer not null check(quantity>0),unit_price numeric not null check(unit_price>=0),currency text not null,
 shipment_id text,shipment_url text,shipment_status text,tracking_number text,last_mile_tracking text,carrier text,
 ship_by_date date,dropoff_due text,holds jsonb not null default '[]',replacement_shipment_id text,
 work_state text not null default 'pending' check(work_state in('pending','completed','external_history')),
 item_missing boolean not null default false,cgl_pending boolean not null default false,
 completed_at timestamptz,completed_by uuid references auth.users(id),revision integer not null default 1,
 receipt_url text,receipt_saved_by uuid references auth.users(id),receipt_saved_at timestamptz,
 synced_at timestamptz not null default now()
);
create index whatnot_lines_order on public.whatnot_order_lines(order_id);
create index whatnot_lines_tracking on public.whatnot_order_lines(tracking_number);
create index whatnot_orders_buyer on public.whatnot_orders(buyer_id);
create table public.whatnot_order_events (
 id uuid primary key default gen_random_uuid(),order_id text not null references public.whatnot_orders(id),line_id text references public.whatnot_order_lines(id),
 actor uuid references auth.users(id),actor_name text not null,action text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create index whatnot_events_order on public.whatnot_order_events(order_id,created_at desc);
create table public.whatnot_order_files (
 id uuid primary key default gen_random_uuid(),path text not null unique,kind text not null check(kind in('label','item_photo','completion_photo')),
 name text not null,mime text not null,line_ids text[] not null,snapshot jsonb not null,
 actor uuid not null references auth.users(id),actor_name text not null,created_at timestamptz not null default now()
);
create index whatnot_files_lines on public.whatnot_order_files using gin(line_ids);

alter table public.whatnot_orders enable row level security;
alter table public.whatnot_order_lines enable row level security;
alter table public.whatnot_order_events enable row level security;
alter table public.whatnot_order_files enable row level security;
create policy whatnot_orders_read on public.whatnot_orders for select to authenticated using(public.can_manage_inventory());
create policy whatnot_lines_read on public.whatnot_order_lines for select to authenticated using(public.can_manage_inventory());
create policy whatnot_events_read on public.whatnot_order_events for select to authenticated using(public.can_manage_inventory());
create policy whatnot_files_read on public.whatnot_order_files for select to authenticated using(public.can_manage_inventory());
revoke all on public.whatnot_orders,public.whatnot_order_lines,public.whatnot_order_events,public.whatnot_order_files from public,anon,authenticated;
grant select on public.whatnot_orders,public.whatnot_order_lines,public.whatnot_order_events,public.whatnot_order_files to authenticated;
grant all on public.whatnot_orders,public.whatnot_order_lines,public.whatnot_order_events,public.whatnot_order_files to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('whatnot-order-evidence','whatnot-order-evidence',false,15728640,array['image/jpeg','image/png','image/webp','application/pdf']);
create policy whatnot_storage_read on storage.objects for select to authenticated using(bucket_id='whatnot-order-evidence' and public.can_manage_inventory());
create policy whatnot_storage_insert on storage.objects for insert to authenticated with check(bucket_id='whatnot-order-evidence' and public.can_manage_inventory() and split_part(name,'/',1)=auth.uid()::text);

create function public.import_whatnot_order(_record jsonb) returns void language plpgsql security definer set search_path='' as $$
declare r jsonb;old public.whatnot_orders;l public.whatnot_order_lines;oid text:=_record->>'id';changed boolean;initial_state text;
begin
 perform pg_advisory_xact_lock(hashtext('whatnot-import'));
 if jsonb_typeof(_record->'lines') is distinct from 'array' or jsonb_array_length(_record->'lines')<1 then raise exception 'Complete order items required';end if;
 select * into old from public.whatnot_orders where id=oid;
 if old.source_updated_at>(_record->>'source_updated_at')::timestamptz then return;end if;
 insert into public.whatnot_orders(id,url,status,buyer_id,username,customer_name,purchased_at,source_updated_at,cancelled_at,currency,subtotal,shipping,tax,total,show_id,show_title,show_url)
 select x.id,x.url,x.status,x.buyer_id,x.username,x.customer_name,x.purchased_at,x.source_updated_at,x.cancelled_at,x.currency,x.subtotal,x.shipping,x.tax,x.total,x.show_id,x.show_title,x.show_url
 from jsonb_populate_record(null::public.whatnot_orders,_record) x
 on conflict(id) do update set url=excluded.url,status=excluded.status,buyer_id=coalesce(excluded.buyer_id,whatnot_orders.buyer_id),username=coalesce(excluded.username,whatnot_orders.username),customer_name=coalesce(excluded.customer_name,whatnot_orders.customer_name),
 purchased_at=coalesce(excluded.purchased_at,whatnot_orders.purchased_at),source_updated_at=excluded.source_updated_at,cancelled_at=excluded.cancelled_at,currency=excluded.currency,subtotal=excluded.subtotal,shipping=excluded.shipping,tax=excluded.tax,total=excluded.total,
 show_id=excluded.show_id,show_title=excluded.show_title,show_url=excluded.show_url,synced_at=now();
 for r in select value from jsonb_array_elements(_record->'lines') loop
  if r->>'order_id' is distinct from oid then raise exception 'Order item mismatch';end if;
  select * into l from public.whatnot_order_lines where id=r->>'id' for update;
  if found and l.order_id<>oid then raise exception 'Order item moved between orders';end if;
  changed:=l.id is not null and (l.quantity is distinct from (r->>'quantity')::int or l.shipment_id is distinct from r->>'shipment_id' or l.tracking_number is distinct from r->>'tracking_number' or l.holds is distinct from r->'holds');
  initial_state:=case when _record->>'status' in('completed','cancelled') or r->>'shipment_status' in('dropped_off','in_transit','delivered') then 'external_history' else 'pending' end;
  insert into public.whatnot_order_lines(id,order_id,title,sku,product_id,quantity,unit_price,currency,shipment_id,shipment_url,shipment_status,tracking_number,last_mile_tracking,carrier,ship_by_date,dropoff_due,holds,replacement_shipment_id,work_state)
  select x.id,x.order_id,x.title,x.sku,x.product_id,x.quantity,x.unit_price,x.currency,x.shipment_id,x.shipment_url,x.shipment_status,x.tracking_number,x.last_mile_tracking,x.carrier,x.ship_by_date,x.dropoff_due,coalesce(x.holds,'[]'),x.replacement_shipment_id,initial_state
  from jsonb_populate_record(null::public.whatnot_order_lines,r) x
  on conflict(id) do update set title=excluded.title,sku=excluded.sku,product_id=excluded.product_id,quantity=excluded.quantity,unit_price=excluded.unit_price,currency=excluded.currency,
   shipment_id=excluded.shipment_id,shipment_url=excluded.shipment_url,shipment_status=excluded.shipment_status,tracking_number=excluded.tracking_number,last_mile_tracking=excluded.last_mile_tracking,carrier=excluded.carrier,
   ship_by_date=excluded.ship_by_date,dropoff_due=excluded.dropoff_due,holds=excluded.holds,replacement_shipment_id=excluded.replacement_shipment_id,
   work_state=case when changed and whatnot_order_lines.work_state='completed' then 'pending' else whatnot_order_lines.work_state end,
   completed_at=case when changed then null else whatnot_order_lines.completed_at end,completed_by=case when changed then null else whatnot_order_lines.completed_by end,
   revision=whatnot_order_lines.revision+case when changed then 1 else 0 end,synced_at=now();
  if changed then insert into public.whatnot_order_events(order_id,line_id,actor_name,action,details) values(oid,l.id,'Whatnot API','shipment_or_quantity_updated',jsonb_build_object('before',jsonb_build_object('quantity',l.quantity,'shipment_id',l.shipment_id,'tracking_number',l.tracking_number),'after',r,'completion_reopened',l.work_state='completed'));end if;
 end loop;
 -- Never delete absent lines or infer cancellations from a missing page.
 if old.id is null or old.status is distinct from _record->>'status' then
  insert into public.whatnot_order_events(order_id,actor_name,action,details) values(oid,'Whatnot API',case when old.id is null then 'order_imported' else 'status_updated' end,jsonb_build_object('status',_record->>'status','previous_status',old.status));
 end if;
end$$;
revoke all on function public.import_whatnot_order(jsonb) from public,anon,authenticated;
grant execute on function public.import_whatnot_order(jsonb) to service_role;

create function public.whatnot_line_scope(_line public.whatnot_order_lines,_order public.whatnot_orders) returns text language sql immutable set search_path='' as $$
 select case when _order.status='cancelled' then 'history' when _line.work_state<>'pending' then 'history' when _order.status in('pending','failed') or jsonb_array_length(_line.holds)>0 or _line.replacement_shipment_id is not null then 'review' else 'pending' end;
$$;

create function public.whatnot_work_action(_action text,_lines jsonb,_value text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;l public.whatnot_order_lines;o public.whatnot_orders;who text;n int:=0;
begin
 if not coalesce(public.can_manage_inventory(),false) or auth.uid() is null then raise exception 'Inventory staff access required';end if;
 if _action not in('note','missing','found','cgl','cgl_done','receipt','complete','reopen') or jsonb_typeof(_lines) is distinct from 'array' or jsonb_array_length(_lines) not between 1 and 250 then raise exception 'Invalid action or selected items';end if;
 if length(coalesce(_value,''))>4000 then raise exception 'Text is too long';end if;
 if _action in('note','reopen') and length(trim(coalesce(_value,'')))<3 then raise exception 'Enter a note explaining this action';end if;
 if _action='reopen' and not coalesce(public.is_admin(),false) then raise exception 'Administrator access required to reopen';end if;
 if _action='receipt' and coalesce(_value,'')!~'^https://(www\.)?whatnot\.com/' then raise exception 'Use a Whatnot receipt or order link';end if;
 perform 1 from public.whatnot_orders where id in(select order_id from public.whatnot_order_lines where id in(select value->>'id' from jsonb_array_elements(_lines))) order by id for share;
 select coalesce(nullif(display_name,''),email,'Staff') into who from public.employees where user_id=auth.uid() limit 1;
 for r in select value from jsonb_array_elements(_lines) order by value->>'id' loop
  select * into l from public.whatnot_order_lines where id=r->>'id' for update;
  if not found or l.revision is distinct from (r->>'revision')::int then raise exception 'Items changed. Reload and review your selection.';end if;
  select * into o from public.whatnot_orders where id=l.order_id;
  if _action='complete' then
   if l.work_state='completed' then continue;end if;
   if o.status not in('pending_fulfillment','completed') or public.whatnot_line_scope(l,o)<>'pending' or l.item_missing or l.cgl_pending or nullif(l.tracking_number,'') is null then raise exception 'Resolve payment, item, certificate and tracking requirements first';end if;
   if not exists(select 1 from public.whatnot_order_files f where f.kind='label' and l.id=any(f.line_ids) and f.snapshot @> jsonb_build_array(jsonb_build_object('id',l.id,'quantity',l.quantity,'tracking_number',l.tracking_number))) then raise exception 'Attach a verified shipping-label PDF for each selected item';end if;
   if not exists(select 1 from public.whatnot_order_files f where f.kind='completion_photo' and l.id=any(f.line_ids) and f.snapshot @> jsonb_build_array(jsonb_build_object('id',l.id,'quantity',l.quantity))) then raise exception 'Save completion photos for the selected quantities';end if;
  end if;
  update public.whatnot_order_lines set item_missing=case when _action in('missing','found') then _action='missing' else item_missing end,
   cgl_pending=case when _action in('cgl','cgl_done') then _action='cgl' else cgl_pending end,
   receipt_url=case when _action='receipt' then _value else receipt_url end,receipt_saved_by=case when _action='receipt' then auth.uid() else receipt_saved_by end,receipt_saved_at=case when _action='receipt' then now() else receipt_saved_at end,
   work_state=case when _action='complete' then 'completed' when _action='reopen' then 'pending' else work_state end,
   completed_at=case when _action='complete' then now() when _action='reopen' then null else completed_at end,completed_by=case when _action='complete' then auth.uid() when _action='reopen' then null else completed_by end,revision=revision+1 where id=l.id;
  insert into public.whatnot_order_events(order_id,line_id,actor,actor_name,action,details) values(l.order_id,l.id,auth.uid(),coalesce(who,'Staff'),_action,jsonb_build_object('note',_value,'quantity',l.quantity,'tracking_number',l.tracking_number,'marketplace_changed',false));n:=n+1;
 end loop;
 return jsonb_build_object('updated',n);
end$$;

create function public.attach_whatnot_file(_path text,_kind text,_name text,_mime text,_lines jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r jsonb;l public.whatnot_order_lines;ids text[]:='{}';snap jsonb:='[]';who text;fid uuid;
begin
 if not coalesce(public.can_manage_inventory(),false) or auth.uid() is null then raise exception 'Inventory staff access required';end if;
 if split_part(_path,'/',1)<>auth.uid()::text or _path~'\.\.' or length(_path)>200 or _kind not in('label','item_photo','completion_photo') or length(_name)>200 then raise exception 'Invalid attachment';end if;
 if (_kind='label' and _mime<>'application/pdf') or (_kind<>'label' and _mime not in('image/jpeg','image/png','image/webp')) then raise exception 'Unsupported file type';end if;
 if not exists(select 1 from storage.objects where bucket_id='whatnot-order-evidence' and name=_path and metadata->>'mimetype'=_mime) then raise exception 'Upload the file first';end if;
 if jsonb_typeof(_lines) is distinct from 'array' or jsonb_array_length(_lines) not between 1 and 250 then raise exception 'Select exact items';end if;
 select id into fid from public.whatnot_order_files where path=_path;if found then return fid;end if;
 perform 1 from public.whatnot_orders where id in(select order_id from public.whatnot_order_lines where id in(select value->>'id' from jsonb_array_elements(_lines))) order by id for share;
 select coalesce(nullif(display_name,''),email,'Staff') into who from public.employees where user_id=auth.uid() limit 1;
 for r in select value from jsonb_array_elements(_lines) order by value->>'id' loop
  select * into l from public.whatnot_order_lines where id=r->>'id' for update;
  if not found or l.revision is distinct from (r->>'revision')::int then raise exception 'Items changed. Reload before attaching evidence';end if;
  ids:=array_append(ids,l.id);snap:=snap||jsonb_build_array(jsonb_build_object('id',l.id,'quantity',l.quantity,'tracking_number',l.tracking_number));
 end loop;
 insert into public.whatnot_order_files(path,kind,name,mime,line_ids,snapshot,actor,actor_name) values(_path,_kind,_name,_mime,ids,snap,auth.uid(),coalesce(who,'Staff')) returning id into fid;
 for l in select * from public.whatnot_order_lines where id=any(ids) loop
  insert into public.whatnot_order_events(order_id,line_id,actor,actor_name,action,details) values(l.order_id,l.id,auth.uid(),coalesce(who,'Staff'),'file_attached',jsonb_build_object('file_id',fid,'kind',_kind,'name',_name));
 end loop;
 return fid;
end$$;
revoke all on function public.whatnot_work_action(text,jsonb,text),public.attach_whatnot_file(text,text,text,text,jsonb) from public,anon;
grant execute on function public.whatnot_work_action(text,jsonb,text),public.attach_whatnot_file(text,text,text,text,jsonb) to authenticated;

create function public.whatnot_workspace(_view text default 'pending',_search text default '',_filter text default 'all',_offset int default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;today date:=(now() at time zone 'America/New_York')::date;
begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required';end if;
 if _view not in('pending','review','history','all') or _offset<0 or length(_search)>200 then raise exception 'Invalid view';end if;
 with base as (
  select l.*,to_jsonb(o) as order_record,public.whatnot_line_scope(l,o) as scope,coalesce(o.buyer_id,'order:'||o.id) as buyer_key,
   coalesce(o.username,'Buyer not provided') as buyer,coalesce(o.customer_name,'') as customer,
   (coalesce(o.id,'')||' '||coalesce(o.username,'')||' '||coalesce(o.customer_name,'')||' '||l.title||' '||coalesce(l.tracking_number,'')||' '||coalesce(l.last_mile_tracking,'')) ilike '%'||replace(replace(replace(_search,'\','\\'),'%','\%'),'_','\_')||'%' as matches
  from public.whatnot_order_lines l join public.whatnot_orders o on o.id=l.order_id
 ), scoped as (select * from base where (_view='all' or scope=_view)),
 filtered as (select * from scoped where matches and case _filter when 'missing' then item_missing when 'cgl' then cgl_pending when 'overdue' then ship_by_date<today when 'today' then ship_by_date=today when 'tomorrow' then ship_by_date=today+1 when 'no_tracking' then tracking_number is null when 'unknown' then ship_by_date is null else true end),
 buyers as (select buyer_key,min(buyer) as buyer,min(customer) as customer,min(ship_by_date) as due from filtered group by buyer_key),
 page as (select * from buyers order by due nulls last,buyer,buyer_key limit 40 offset _offset),
 groups as (select p.*,coalesce((select jsonb_agg(to_jsonb(f) order by f.order_record->>'purchased_at',f.order_id,f.id) from filtered f where f.buyer_key=p.buyer_key),'[]') as lines from page p)
 select jsonb_build_object('groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.due nulls last,g.buyer,g.buyer_key) from groups g),'[]'),
 'buyers',(select count(*) from buyers),'visible_lines',(select count(*) from filtered),'visible_items',(select coalesce(sum(quantity),0) from filtered),
 'counts',jsonb_build_object('pending',(select count(*) from base where scope='pending'),'review',(select count(*) from base where scope='review'),'history',(select count(*) from base where scope='history')),
 'filters',jsonb_build_object('all',(select count(*) from scoped where matches),'overdue',(select count(*) from scoped where matches and ship_by_date<today),'today',(select count(*) from scoped where matches and ship_by_date=today),'tomorrow',(select count(*) from scoped where matches and ship_by_date=today+1),'missing',(select count(*) from scoped where matches and item_missing),'cgl',(select count(*) from scoped where matches and cgl_pending),'no_tracking',(select count(*) from scoped where matches and tracking_number is null),'unknown',(select count(*) from scoped where matches and ship_by_date is null))) into result;
 return result;
end$$;
revoke all on function public.whatnot_workspace(text,text,text,int) from public,anon;
grant execute on function public.whatnot_workspace(text,text,text,int) to authenticated;
commit;
