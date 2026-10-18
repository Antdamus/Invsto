-- TikTok is additive: no eBay tables, triggers, RPCs, sales or stock are modified.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
create table public.tiktok_order_imports (
 id uuid primary key default gen_random_uuid(), file_hash text not null unique check(file_hash ~ '^[a-f0-9]{64}$'),
 filename text not null, snapshot_at timestamptz not null, imported_at timestamptz not null default now(),
 imported_by uuid not null references auth.users(id), result jsonb not null default '{}'
);
create table public.tiktok_orders (
 id uuid primary key default gen_random_uuid(), order_number text not null unique check(order_number ~ '^[0-9]{10,24}$'),
 buyer_username text not null, buyer_nickname text not null default '',
 marketplace_status text not null, marketplace_substatus text not null,
 order_amount numeric(14,2), created_time text, paid_time text, shipped_time text,
 seller_note text, buyer_message text, shipping_method text, cancel_return text,
 stage text not null default 'pending' check(stage in ('pending','preparing','waiting','packed','dispatched')),
 notes text not null default '', ship_by_date date, ship_by_source text,
 revision integer not null default 1, last_import_id uuid references public.tiktok_order_imports(id),
 source_snapshot_at timestamptz not null, updated_at timestamptz not null default now()
);
create table public.tiktok_order_lines (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.tiktok_orders(id),
 sku_id text not null check(sku_id ~ '^[0-9]{10,24}$'), product_id text, seller_sku text, title text not null, variation text,
 quantity integer not null check(quantity between 1 and 99999), line_amount numeric(14,2),
 package_id text, tracking_number text, unique(order_id,sku_id)
);
create table public.tiktok_order_events (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.tiktok_orders(id),
 actor uuid not null references auth.users(id), action text not null, details jsonb not null,
 created_at timestamptz not null default now()
);
create table public.tiktok_order_documents (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.tiktok_orders(id),
 kind text not null check(kind in ('label','packet')), path text not null, filename text not null,
 tracking_number text, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(order_id,path)
);
create index tiktok_orders_queue on public.tiktok_orders(stage,source_snapshot_at desc);
create index tiktok_lines_order on public.tiktok_order_lines(order_id);
create index tiktok_events_order on public.tiktok_order_events(order_id,created_at desc);
do $$declare t text;begin
 foreach t in array array['tiktok_orders','tiktok_order_lines','tiktok_order_imports','tiktok_order_events','tiktok_order_documents'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy staff_read on public.%I for select to authenticated using (public.can_manage_inventory())',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end$$;

create function public.import_tiktok_orders(_rows jsonb,_file_hash text,_filename text,_snapshot_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare imp public.tiktok_order_imports; o public.tiktok_orders; r jsonb; g record; oldlines jsonb;
 added integer:=0; refreshed integer:=0; stale integer:=0; skipped integer:=0; import_result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _snapshot_at is null or _snapshot_at>now()+interval '10 minutes' or _snapshot_at<now()-interval '366 days' then raise exception 'Choose the actual export time from the last 12 months';end if;
 if _file_hash is null or _file_hash!~'^[a-f0-9]{64}$' or nullif(trim(_filename),'') is null then raise exception 'Choose a valid CSV file';end if;
 if jsonb_typeof(_rows) is distinct from 'array' or jsonb_array_length(_rows) not between 1 and 10000 then raise exception 'Import 1–10,000 item rows';end if;
 -- Serialize imports and worker updates through the same lock. A file is all-or-nothing.
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into imp from public.tiktok_order_imports where file_hash=_file_hash;
 if found then return imp.result||jsonb_build_object('already_imported',true);end if;
 for r in select value from jsonb_array_elements(_rows) loop
  if coalesce(r->>'order_number','')!~'^[0-9]{10,24}$' or coalesce(r->>'sku_id','')!~'^[0-9]{10,24}$'
   or coalesce(r->>'quantity','')!~'^[1-9][0-9]{0,4}$' or nullif(trim(r->>'title'),'') is null or nullif(trim(r->>'buyer_username'),'') is null
   or length(r::text)>20000 then raise exception 'Invalid TikTok order row';end if;
  if coalesce(r->>'marketplace_status','') not in ('To ship','Shipped','Completed','Canceled','Cancelled','Pending','Unpaid')
   or (r->>'marketplace_status'='To ship' and coalesce(r->>'marketplace_substatus','') not in ('Awaiting shipment','Awaiting collection','Partially shipped')) then raise exception 'Unsupported TikTok status';end if;
  if (r->>'order_amount' is not null and r->>'order_amount'!~'^[0-9]+(\.[0-9]{1,2})?$')
   or (r->>'line_amount' is not null and r->>'line_amount'!~'^[0-9]+(\.[0-9]{1,2})?$') then raise exception 'Invalid money amount';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(_rows) x group by x->>'order_number',x->>'sku_id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(_rows) x group by x->>'order_number' having count(distinct jsonb_build_array(x->>'buyer_username',x->>'marketplace_status',x->>'marketplace_substatus',x->>'order_amount'))>1)
 then raise exception 'Duplicate or conflicting order rows';end if;
 insert into public.tiktok_order_imports(file_hash,filename,snapshot_at,imported_by) values(_file_hash,left(_filename,240),_snapshot_at,auth.uid()) returning * into imp;
 for g in select x->>'order_number' num,jsonb_agg(x) items from jsonb_array_elements(_rows) x group by x->>'order_number' order by x->>'order_number' loop
  r:=g.items->0;
  select * into o from public.tiktok_orders where order_number=g.num for update;
  if found then
   if o.source_snapshot_at>=_snapshot_at then stale:=stale+1;continue;end if;
   -- A changed item set needs a new packing review, without silently reopening a dispatch.
   if exists(select 1 from jsonb_array_elements(g.items) x left join public.tiktok_order_lines l on l.order_id=o.id and l.sku_id=x->>'sku_id'
    where l.id is null or l.quantity<>(x->>'quantity')::integer)
    and o.stage in ('packed','dispatched') then
    update public.tiktok_orders set stage=case when o.stage='dispatched' then 'dispatched' else 'waiting' end,
     notes=concat_ws(E'\n',nullif(notes,''),'Imported item quantities changed. Review this order before any further shipment.') where id=o.id;
    insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'items_changed',jsonb_build_object('previous_stage',o.stage));
   end if;
   refreshed:=refreshed+1;
  else
   if r->>'marketplace_status'<>'To ship' then skipped:=skipped+1;continue;end if;
   insert into public.tiktok_orders(order_number,buyer_username,marketplace_status,marketplace_substatus,source_snapshot_at)
    values(g.num,r->>'buyer_username',r->>'marketplace_status',r->>'marketplace_substatus',_snapshot_at) returning * into o;
   added:=added+1;
  end if;
  update public.tiktok_orders set buyer_username=r->>'buyer_username',buyer_nickname=coalesce(r->>'buyer_nickname',''),
   marketplace_status=r->>'marketplace_status',marketplace_substatus=r->>'marketplace_substatus',order_amount=(r->>'order_amount')::numeric,
   created_time=r->>'created_time',paid_time=r->>'paid_time',shipped_time=r->>'shipped_time',seller_note=r->>'seller_note',buyer_message=r->>'buyer_message',
   shipping_method=r->>'shipping_method',cancel_return=r->>'cancel_return',source_snapshot_at=_snapshot_at,last_import_id=imp.id,
   ship_by_date=coalesce((r->>'ship_by_date')::date,ship_by_date),ship_by_source=case when r->>'ship_by_date' is not null then 'TikTok order page' else ship_by_source end,
   revision=revision+1,updated_at=now() where id=o.id;
  -- Preserve stable line IDs while refreshing marketplace data.
  for r in select value from jsonb_array_elements(g.items) loop
   insert into public.tiktok_order_lines(order_id,sku_id,product_id,seller_sku,title,variation,quantity,line_amount,package_id,tracking_number)
    values(o.id,r->>'sku_id',r->>'product_id',r->>'seller_sku',r->>'title',r->>'variation',(r->>'quantity')::integer,(r->>'line_amount')::numeric,r->>'package_id',r->>'tracking_number')
    on conflict(order_id,sku_id) do update set product_id=excluded.product_id,seller_sku=excluded.seller_sku,title=excluded.title,variation=excluded.variation,
     quantity=excluded.quantity,line_amount=excluded.line_amount,package_id=excluded.package_id,tracking_number=excluded.tracking_number;
  end loop;
  -- Filtered reports may omit items. Absence never deletes a saved line or closes an order.
  insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'import',jsonb_build_object('import_id',imp.id,'snapshot_at',_snapshot_at));
 end loop;
 import_result:=jsonb_build_object('added',added,'refreshed',refreshed,'stale',stale,'history_skipped',skipped,'import_id',imp.id);
 update public.tiktok_order_imports set result=import_result where id=imp.id;
 return import_result;
end$$;

create function public.update_tiktok_order(_order_id uuid,_revision integer,_stage text,_notes text,_ship_by date default null,_confirmed boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.tiktok_orders; updated public.tiktok_orders;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into o from public.tiktok_orders where id=_order_id for update;
 if not found or o.revision<>_revision then raise exception 'This order changed. Refresh before saving.';end if;
 if _stage is null or _stage not in ('pending','preparing','waiting','packed','dispatched') or _notes is null or length(_notes)>4000 then raise exception 'Invalid preparation stage or notes';end if;
 if _stage in ('packed','dispatched') and o.stage<>_stage and _confirmed is distinct from true then raise exception 'Confirm the physical contents or carrier handoff first';end if;
 if _stage in ('packed','dispatched') and (o.marketplace_status in ('Canceled','Cancelled','Pending','Unpaid') or coalesce(o.cancel_return,'')<>'') then raise exception 'Review the TikTok cancellation, return or payment status before packing';end if;
 if _stage='waiting' and nullif(trim(_notes),'') is null then raise exception 'Add the reason this order is waiting';end if;
 if o.stage='dispatched' and _stage<>'dispatched' and nullif(trim(_notes),'') is null then raise exception 'Record why the dispatched order is being reopened';end if;
 if _stage='dispatched' and o.stage<>'dispatched' then
  if o.stage<>'packed' then raise exception 'Confirm the contents and mark the order packed first';end if;
  if exists(select 1 from public.tiktok_order_lines where order_id=o.id and nullif(trim(tracking_number),'') is null) then raise exception 'Import a fresh TikTok export with tracking before confirming dispatch';end if;
 end if;
 update public.tiktok_orders set stage=_stage,notes=trim(_notes),ship_by_date=_ship_by,
  ship_by_source=case when _ship_by is distinct from o.ship_by_date then 'staff' else ship_by_source end,
  revision=revision+1,updated_at=now() where id=o.id returning * into updated;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'work_update',jsonb_build_object('from',o.stage,'to',_stage,'notes',trim(_notes),'ship_by',_ship_by));
 return to_jsonb(updated);
end$$;

create function public.attach_tiktok_order_document(_order_id uuid,_path text,_filename text,_kind text,_tracking text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.tiktok_order_documents;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _kind is null or _kind not in ('label','packet') or _path is null or _path not like 'tiktok-orders/'||auth.uid()::text||'/%'
  or _path like '%..%' or not exists(select 1 from storage.objects where bucket_id='ebay-labels' and name=_path)
 then raise exception 'Upload a TikTok PDF first';end if;
 if not exists(select 1 from public.tiktok_orders where id=_order_id) then raise exception 'Order not found';end if;
 insert into public.tiktok_order_documents(order_id,kind,path,filename,tracking_number,created_by)
  values(_order_id,_kind,_path,left(coalesce(_filename,'TikTok.pdf'),240),left(coalesce(_tracking,''),100),auth.uid())
  on conflict(order_id,path) do update set filename=excluded.filename returning * into d;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(_order_id,auth.uid(),'document_attached',jsonb_build_object('document_id',d.id,'kind',d.kind));
 return to_jsonb(d);
end$$;
revoke all on function public.import_tiktok_orders(jsonb,text,text,timestamptz),public.update_tiktok_order(uuid,integer,text,text,date,boolean),public.attach_tiktok_order_document(uuid,text,text,text,text) from public,anon;
grant execute on function public.import_tiktok_orders(jsonb,text,text,timestamptz),public.update_tiktok_order(uuid,integer,text,text,date,boolean),public.attach_tiktok_order_document(uuid,text,text,text,text) to authenticated;
commit;
