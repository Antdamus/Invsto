-- TikTok-only completion evidence and authenticated phone pairing.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
-- An authenticated phone can follow a workstation without reopening the order queue.
create table public.tiktok_order_phone_camera_sessions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id), owner_email text,
  phone_user_id uuid references auth.users(id), phone_email text,
  current_request_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  phone_seen_at timestamptz, closed_at timestamptz
);
create table public.tiktok_order_phone_camera_requests (
  id uuid primary key, session_id uuid not null references public.tiktok_order_phone_camera_sessions(id),
  line_ids uuid[] not null, created_at timestamptz not null default now(),
  opened_at timestamptz, saved_at timestamptz
);
create index on public.tiktok_order_phone_camera_requests(session_id,created_at desc);
alter table public.tiktok_order_phone_camera_sessions enable row level security;
alter table public.tiktok_order_phone_camera_requests enable row level security;
revoke all on public.tiktok_order_phone_camera_sessions, public.tiktok_order_phone_camera_requests from public,anon,authenticated;

create function public.tiktok_order_phone_camera_payload(_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',s.id,'owner_email',s.owner_email,'phone_email',s.phone_email,
    'phone_seen_at',s.phone_seen_at,'expires_at',s.expires_at,
    'request',case when r.id is null then null else jsonb_build_object(
      'id',r.id,'created_at',r.created_at,'opened_at',r.opened_at,'saved_at',r.saved_at,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'order_id',l.order_id,
        'item_title',l.title,'item_number',l.sku_id,'quantity',l.quantity,
        'order',jsonb_build_object('order_number',o.order_number,'buyer_username',o.buyer_username)) order by l.id),'[]'::jsonb)
        from public.tiktok_order_lines l join public.tiktok_orders o on o.id=l.order_id where l.id=any(r.line_ids))) end)
  from public.tiktok_order_phone_camera_sessions s left join public.tiktok_order_phone_camera_requests r on r.id=s.current_request_id where s.id=_id;
$$;
revoke all on function public.tiktok_order_phone_camera_payload(uuid) from public,anon,authenticated;

create function public.send_tiktok_order_to_phone(_session_id uuid,_request_id uuid,_line_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.tiktok_order_phone_camera_sessions; r public.tiktok_order_phone_camera_requests; ids uuid[];
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select array_agg(distinct id order by id) into ids from unnest(_line_ids) id where id is not null;
  if _session_id is null or _request_id is null or coalesce(cardinality(ids),0) not between 1 and 100
    or (select count(*) from public.tiktok_order_lines where id=any(ids)) <> cardinality(ids) then
    raise exception 'Select valid order items for the phone' using errcode='22023';
  end if;
  insert into public.tiktok_order_phone_camera_sessions(id,owner_id,owner_email)
    values(_session_id,auth.uid(),auth.email()) on conflict(id) do nothing;
  select * into s from public.tiktok_order_phone_camera_sessions where id=_session_id for update;
  if s.owner_id<>auth.uid() then raise exception 'This phone belongs to another workstation user' using errcode='42501'; end if;
  if s.closed_at is not null or s.expires_at<=now() then raise exception 'Pair this phone again' using errcode='P0002'; end if;
  select * into r from public.tiktok_order_phone_camera_requests where id=_request_id;
  if found then
    if r.session_id<>s.id or r.line_ids<>ids then raise exception 'Request already used' using errcode='22023'; end if;
    -- A delayed retry must not replace a newer order sent from another tab.
    return public.tiktok_order_phone_camera_payload(s.id);
  end if;
  insert into public.tiktok_order_phone_camera_requests(id,session_id,line_ids) values(_request_id,s.id,ids);
  update public.tiktok_order_phone_camera_sessions set current_request_id=_request_id,updated_at=now(),expires_at=now()+interval '7 days' where id=s.id;
  return public.tiktok_order_phone_camera_payload(s.id);
end $$;

create function public.read_tiktok_order_phone_camera(_session_id uuid,_phone boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.tiktok_order_phone_camera_sessions;
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select * into s from public.tiktok_order_phone_camera_sessions where id=_session_id for update;
  if not found or s.closed_at is not null or s.expires_at<=now() then raise exception 'This pairing has ended. Scan a new QR code from the computer.' using errcode='P0002'; end if;
  if _phone then
    if s.phone_user_id is not null and s.phone_user_id<>auth.uid() then
      raise exception 'A different staff account has already paired this phone link. Ask the computer to disconnect and pair again.' using errcode='42501';
    end if;
    update public.tiktok_order_phone_camera_sessions set phone_user_id=auth.uid(),phone_email=auth.email(),phone_seen_at=now() where id=s.id and (phone_user_id is null or phone_seen_at<now()-interval '30 seconds');
  elsif s.owner_id<>auth.uid() then
    raise exception 'Only the workstation user can read this pairing' using errcode='42501';
  end if;
  return public.tiktok_order_phone_camera_payload(s.id);
end $$;

create function public.mark_tiktok_order_phone_camera_request(_session_id uuid,_request_id uuid,_status text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.tiktok_order_phone_camera_sessions;
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select * into s from public.tiktok_order_phone_camera_sessions where id=_session_id for update;
  if not found or s.closed_at is not null or s.expires_at<=now() then raise exception 'This pairing has ended' using errcode='P0002'; end if;
  if s.phone_user_id is distinct from auth.uid() then raise exception 'Only the paired phone can acknowledge photos' using errcode='42501'; end if;
  if _status not in ('opened','saved') or _status is null then raise exception 'Invalid phone status' using errcode='22023'; end if;
  update public.tiktok_order_phone_camera_requests set
    opened_at=coalesce(opened_at,now()),saved_at=case when _status='saved' then now() else saved_at end
    where id=_request_id and session_id=s.id;
  if not found then raise exception 'Unknown photo request' using errcode='22023'; end if;
  update public.tiktok_order_phone_camera_sessions set phone_seen_at=now() where id=s.id;
end $$;

create function public.disconnect_tiktok_order_phone_camera(_session_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.tiktok_order_phone_camera_sessions;
begin
  if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501'; end if;
  select * into s from public.tiktok_order_phone_camera_sessions where id=_session_id for update;
  if not found then return; end if;
  if s.owner_id<>auth.uid() then raise exception 'Only the workstation user can disconnect' using errcode='42501'; end if;
  update public.tiktok_order_phone_camera_sessions set closed_at=coalesce(closed_at,now()) where id=s.id;
end $$;
revoke all on function public.send_tiktok_order_to_phone(uuid,uuid,uuid[]),public.read_tiktok_order_phone_camera(uuid,boolean),
  public.mark_tiktok_order_phone_camera_request(uuid,uuid,text),public.disconnect_tiktok_order_phone_camera(uuid) from public,anon;
grant execute on function public.send_tiktok_order_to_phone(uuid,uuid,uuid[]),public.read_tiktok_order_phone_camera(uuid,boolean),
  public.mark_tiktok_order_phone_camera_request(uuid,uuid,text),public.disconnect_tiktok_order_phone_camera(uuid) to authenticated;

create table public.tiktok_order_completion_photos (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.tiktok_orders(id),
 created_at timestamptz not null default now(),signed_by uuid not null references auth.users(id),signed_by_email text,
 payload jsonb not null,photo_attachments jsonb not null,
 capture_path text not null,unique(order_id,capture_path)
);
create index on public.tiktok_order_completion_photos(order_id,created_at desc);
alter table public.tiktok_order_completion_photos enable row level security;
revoke all on public.tiktok_order_completion_photos from public,anon,authenticated;
grant select on public.tiktok_order_completion_photos to authenticated;
create policy staff_read on public.tiktok_order_completion_photos for select to authenticated using(public.can_manage_inventory());
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('tiktok-completion-photos','tiktok-completion-photos',false,5242880,array['image/jpeg']);
create policy tiktok_completion_read on storage.objects for select to authenticated using(bucket_id='tiktok-completion-photos' and public.can_manage_inventory());
create policy tiktok_completion_upload on storage.objects for insert to authenticated with check(bucket_id='tiktok-completion-photos' and public.can_manage_inventory() and name ~ ('^'||auth.uid()::text||'/[a-f0-9-]{36}(-thumb)?\.jpg$'));

create function public.validate_tiktok_completion_photo(_photo jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if jsonb_typeof(_photo) is distinct from 'object' or _photo->>'bucket' is distinct from 'tiktok-completion-photos'
  or coalesce(_photo->>'path','') !~ ('^'||auth.uid()::text||'/[a-f0-9-]{36}\.jpg$')
  or _photo->>'thumbnail_path' is distinct from replace(_photo->>'path','.jpg','-thumb.jpg')
  or not exists(select 1 from storage.objects where bucket_id='tiktok-completion-photos' and name=_photo->>'path')
  or not exists(select 1 from storage.objects where bucket_id='tiktok-completion-photos' and name=_photo->>'thumbnail_path')
 then raise exception 'Upload both TikTok completion photo sizes first';end if;
 return jsonb_build_object('bucket','tiktok-completion-photos','path',_photo->>'path','thumbnail_path',_photo->>'thumbnail_path',
  'label',left(coalesce(_photo->>'label','Completion photo'),240),'mime_type','image/jpeg','created_at',now(),'signed_by_email',auth.email());
end$$;
revoke all on function public.validate_tiktok_completion_photo(jsonb) from public,anon,authenticated;

create function public.add_tiktok_order_completion_photos(_order_id uuid,_order_line_ids uuid[],_photo_attachments jsonb,_note text default null,_proof_type text default 'completion_photo',_signed_by_email text default null,_item_scope jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; actual uuid[]; scope jsonb; photo jsonb; saved public.tiktok_order_completion_photos;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501';end if;
 if _proof_type is distinct from 'completion_photo' or jsonb_typeof(_photo_attachments) is distinct from 'array' or jsonb_array_length(_photo_attachments)<>1 then raise exception 'One completion photo is required';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select array_agg(distinct id order by id) into ids from unnest(_order_line_ids) id;
 select array_agg(id order by id),jsonb_agg(jsonb_build_object('id',id,'sku_id',sku_id,'quantity',quantity) order by id) into actual,scope from public.tiktok_order_lines where order_id=_order_id;
 if ids is null or ids is distinct from actual or _item_scope is distinct from scope then raise exception 'The order items changed. Refresh before saving completion photos.';end if;
 photo=public.validate_tiktok_completion_photo(_photo_attachments->0);
 insert into public.tiktok_order_completion_photos(order_id,signed_by,signed_by_email,payload,photo_attachments,capture_path)
  values(_order_id,auth.uid(),auth.email(),jsonb_build_object('proof_type','completion_photo','order_line_ids',ids,'item_scope',scope),jsonb_build_array(photo),photo->>'path')
  on conflict(order_id,capture_path) do nothing returning * into saved;
 if found then insert into public.tiktok_order_events(order_id,actor,action,details) values(_order_id,auth.uid(),'completion_photo_saved',jsonb_build_object('photo_id',saved.id));
 else select * into saved from public.tiktok_order_completion_photos where order_id=_order_id and capture_path=photo->>'path';end if;
 return to_jsonb(saved);
end$$;

create function public.correct_tiktok_order_completion_photo(_event_ids uuid[],_bucket text,_path text,_request_id uuid,_replacement jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; item public.tiktok_order_completion_photos; photo jsonb; changes jsonb; prior jsonb; n integer=0;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501';end if;
 select array_agg(distinct id order by id) into ids from unnest(_event_ids) id;
 if coalesce(cardinality(ids),0) not between 1 and 100 or _request_id is null or _bucket is distinct from 'tiktok-completion-photos'
  or (select count(*) from public.tiktok_order_completion_photos where id=any(ids))<>cardinality(ids) then raise exception 'Select valid TikTok completion photos';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 if _replacement is not null then photo=public.validate_tiktok_completion_photo(_replacement);end if;
 for item in select * from public.tiktok_order_completion_photos where id=any(ids) order by id for update loop
  select change into prior from jsonb_array_elements(coalesce(item.payload->'changes','[]'::jsonb)) change where change->>'request_id'=_request_id::text limit 1;
  if found then
   if prior->>'path' is distinct from _path or prior->>'replacement_path' is distinct from photo->>'path' then raise exception 'Correction request already used';end if;continue;
  end if;
  if not exists(select 1 from jsonb_array_elements(item.photo_attachments) p where p->>'path'=_path) then raise exception 'This photo changed. Refresh and try again.';end if;
  changes=coalesce(item.payload->'changes','[]'::jsonb)||jsonb_build_array(jsonb_build_object('request_id',_request_id,'path',_path,'original',item.photo_attachments,'replacement_path',photo->>'path','actor',auth.uid(),'at',now()));
  update public.tiktok_order_completion_photos set photo_attachments=case when photo is null then '[]'::jsonb else jsonb_build_array(photo) end,payload=payload||jsonb_build_object('changes',changes) where id=item.id;
  insert into public.tiktok_order_events(order_id,actor,action,details) values(item.order_id,auth.uid(),case when photo is null then 'completion_photo_removed' else 'completion_photo_replaced' end,jsonb_build_object('photo_id',item.id,'request_id',_request_id));n=n+1;
 end loop;
 return jsonb_build_object('updated_events',n,'request_id',_request_id);
end$$;

alter table public.tiktok_orders drop constraint tiktok_orders_stage_check;
alter table public.tiktok_orders add constraint tiktok_orders_stage_check check(stage in('pending','preparing','waiting','packed','dispatched','completed'));
create function public.complete_tiktok_orders(_order_ids uuid[],_revisions jsonb,_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; o public.tiktok_orders; scope jsonb; n integer=0;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501';end if;
 select array_agg(distinct id order by id) into ids from unnest(_order_ids) id;
 if _confirmed is distinct from true or coalesce(cardinality(ids),0) not between 1 and 100 or (select count(*) from public.tiktok_orders where id=any(ids))<>cardinality(ids) then raise exception 'Confirm the items, labels and completion photos first';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 for o in select * from public.tiktok_orders where id=any(ids) order by id for update loop
  if o.stage='completed' then continue;end if;
  if (_revisions->>o.id::text)::integer is distinct from o.revision then raise exception 'An order changed. Refresh and review before completing.';end if;
  if o.marketplace_status in('Canceled','Cancelled','Pending','Unpaid') or coalesce(o.cancel_return,'')<>'' then raise exception 'Review the TikTok cancellation, return or payment status first';end if;
  if not exists(select 1 from public.tiktok_order_documents where order_id=o.id and kind='label') then raise exception 'Save the shipping label for every order first';end if;
  select jsonb_agg(jsonb_build_object('id',id,'sku_id',sku_id,'quantity',quantity) order by id) into scope from public.tiktok_order_lines where order_id=o.id;
  if not exists(select 1 from public.tiktok_order_completion_photos p where p.order_id=o.id and p.payload->'item_scope'=scope and jsonb_array_length(p.photo_attachments)>0) then raise exception 'Save a completion photo covering the current items for every order first';end if;
  update public.tiktok_orders set stage='completed',revision=revision+1,updated_at=now() where id=o.id;
  insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'order_completed',jsonb_build_object('from',o.stage,'to','completed','confirmed',true));n=n+1;
 end loop;
 return jsonb_build_object('completed',n);
end$$;

create function public.attach_tiktok_label_batch(_documents jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb; d public.tiktok_order_documents; n integer=0;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Staff access required' using errcode='42501';end if;
 if jsonb_typeof(_documents) is distinct from 'array' or jsonb_array_length(_documents) not between 1 and 100 then raise exception 'Choose the TikTok orders covered by these labels';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 for item in select * from jsonb_array_elements(_documents) loop
  if coalesce(item->>'path','') !~ ('^tiktok-orders/'||auth.uid()::text||'/[a-f0-9]{64}\.pdf$')
   or not exists(select 1 from storage.objects where bucket_id='ebay-labels' and name=item->>'path')
   or not exists(select 1 from public.tiktok_orders where id=(item->>'order_id')::uuid) then raise exception 'Upload a valid TikTok label and select its order first';end if;
  insert into public.tiktok_order_documents(order_id,kind,path,filename,tracking_number,created_by)
   values((item->>'order_id')::uuid,'label',item->>'path',left(coalesce(item->>'filename','TikTok-label.pdf'),240),left(coalesce(item->>'tracking_number',''),100),auth.uid()) on conflict(order_id,path) do nothing returning * into d;
  if found then insert into public.tiktok_order_events(order_id,actor,action,details) values(d.order_id,auth.uid(),'document_attached',jsonb_build_object('document_id',d.id,'kind','label','source','tiktok_label_batch','pages',item->'pages'));n=n+1;end if;
 end loop;
 return jsonb_build_object('attached',n);
end$$;
revoke all on function public.add_tiktok_order_completion_photos(uuid,uuid[],jsonb,text,text,text,jsonb),public.correct_tiktok_order_completion_photo(uuid[],text,text,uuid,jsonb),public.complete_tiktok_orders(uuid[],jsonb,boolean),public.attach_tiktok_label_batch(jsonb) from public,anon;
grant execute on function public.add_tiktok_order_completion_photos(uuid,uuid[],jsonb,text,text,text,jsonb),public.correct_tiktok_order_completion_photo(uuid[],text,text,uuid,jsonb),public.complete_tiktok_orders(uuid[],jsonb,boolean),public.attach_tiktok_label_batch(jsonb) to authenticated;
create or replace function public.import_tiktok_orders(_rows jsonb,_file_hash text,_filename text,_snapshot_at timestamptz) returns jsonb
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
    and o.stage in ('packed','dispatched','completed') then
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

create or replace function public.update_tiktok_order(_order_id uuid,_revision integer,_stage text,_notes text,_ship_by date default null,_confirmed boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.tiktok_orders; updated public.tiktok_orders;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into o from public.tiktok_orders where id=_order_id for update;
 if not found or o.revision<>_revision then raise exception 'This order changed. Refresh before saving.';end if;
 if _stage='completed' and o.stage<>'completed' then raise exception 'Use Complete order after reviewing labels and completion photos';end if;
 if _stage is null or _stage not in ('pending','preparing','waiting','packed','dispatched','completed') or _notes is null or length(_notes)>4000 then raise exception 'Invalid preparation stage or notes';end if;
 if _stage in ('packed','dispatched') and o.stage<>_stage and _confirmed is distinct from true then raise exception 'Confirm the physical contents or carrier handoff first';end if;
 if _stage in ('packed','dispatched') and (o.marketplace_status in ('Canceled','Cancelled','Pending','Unpaid') or coalesce(o.cancel_return,'')<>'') then raise exception 'Review the TikTok cancellation, return or payment status before packing';end if;
 if _stage='waiting' and nullif(trim(_notes),'') is null then raise exception 'Add the reason this order is waiting';end if;
 if o.stage in ('dispatched','completed') and _stage<>o.stage and not(o.stage='completed' and _stage='dispatched') and nullif(trim(_notes),'') is null then raise exception 'Record why the completed or dispatched order is being reopened';end if;
 if _stage='dispatched' and o.stage<>'dispatched' then
  if o.stage<>'completed' then raise exception 'Use Complete order to verify labels, photos and inventory before dispatch';end if;
  if exists(select 1 from public.tiktok_order_lines where order_id=o.id and nullif(trim(tracking_number),'') is null) then raise exception 'Import a fresh TikTok export with tracking before confirming dispatch';end if;
 end if;
 update public.tiktok_orders set stage=_stage,notes=trim(_notes),ship_by_date=_ship_by,
  ship_by_source=case when _ship_by is distinct from o.ship_by_date then 'staff' else ship_by_source end,
  revision=revision+1,updated_at=now() where id=o.id returning * into updated;
 insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'work_update',jsonb_build_object('from',o.stage,'to',_stage,'notes',trim(_notes),'ship_by',_ship_by));
 return to_jsonb(updated);
end$$;

commit;
