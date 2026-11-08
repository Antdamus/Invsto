begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table public.customer_followups (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('call','call_followup','manual_return')),
 title text not null check(length(btrim(title)) between 1 and 200),
 channel text not null check(channel in ('ebay','tiktok','other')),
 buyer_username text not null default '', contact jsonb not null default '{}',
 ebay_order_line_id uuid references public.ebay_order_lines(id),
 tiktok_order_line_id uuid references public.tiktok_order_lines(id),
 order_snapshot jsonb not null default '{}', source_context jsonb not null default '{}',
 status text not null default 'open' check(status in ('open','waiting','closed','cancelled')),
 return_stage text not null default 'awaiting_shipment' check(return_stage in ('awaiting_shipment','in_transit','received','resolved')),
 return_quantity integer not null default 1 check(return_quantity>0),
 tracking_number text not null default '' check(length(tracking_number)<=150),
 carrier text not null default '' check(length(carrier)<=80),
 due_at timestamptz, priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
 created_by uuid not null references auth.users(id), created_by_email text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 revision integer not null default 1, request_id uuid not null, request_payload jsonb not null,
 check(num_nonnulls(ebay_order_line_id,tiktok_order_line_id)<=1),
 check(kind<>'manual_return' or num_nonnulls(ebay_order_line_id,tiktok_order_line_id)=1),
 unique(created_by,request_id)
);
create table public.customer_followup_events (
 id uuid primary key default gen_random_uuid(), followup_id uuid not null references public.customer_followups(id),
 action text not null, note text not null default '', photos jsonb not null default '[]',
 before_values jsonb, after_values jsonb, created_by uuid not null references auth.users(id),
 created_by_email text, created_at timestamptz not null default now(), request_id uuid not null, request_payload jsonb not null,
 unique(created_by,request_id)
);
create table public.customer_followup_tasks (
 followup_id uuid not null references public.customer_followups(id),
 task_id uuid primary key references public.team_tasks(id),
 created_by uuid not null references auth.users(id), request_id uuid not null, request_payload jsonb not null,
 unique(created_by,request_id)
);
create index customer_followups_queue on public.customer_followups(status,due_at,created_at desc);
create index customer_followups_buyer on public.customer_followups(channel,lower(buyer_username));
create index customer_followups_ebay_line on public.customer_followups(ebay_order_line_id);
create index customer_followups_tiktok_line on public.customer_followups(tiktok_order_line_id);
create index customer_followup_events_record on public.customer_followup_events(followup_id,created_at);
create index customer_followup_tasks_record on public.customer_followup_tasks(followup_id);

create function public.can_access_customer_followups() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and coalesce(public.can_manage_inventory(),false)
 and exists(select 1 from public.employees where user_id=auth.uid() and active is true);
$$;
revoke all on function public.can_access_customer_followups() from public,anon;
grant execute on function public.can_access_customer_followups() to authenticated;
alter table public.customer_followups enable row level security;
alter table public.customer_followup_events enable row level security;
alter table public.customer_followup_tasks enable row level security;
create policy staff_read on public.customer_followups for select to authenticated using(public.can_access_customer_followups());
create policy staff_read on public.customer_followup_events for select to authenticated using(public.can_access_customer_followups());
create policy staff_read on public.customer_followup_tasks for select to authenticated using(public.can_access_customer_followups());
revoke all on public.customer_followups,public.customer_followup_events,public.customer_followup_tasks from public,anon,authenticated;
grant select on public.customer_followups,public.customer_followup_events,public.customer_followup_tasks to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('customer-followup-photos','customer-followup-photos',false,20971520,
 array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']);
create policy followup_photos_read on storage.objects for select to authenticated
 using(bucket_id='customer-followup-photos' and public.can_access_customer_followups());
create policy followup_photos_upload on storage.objects for insert to authenticated
 with check(bucket_id='customer-followup-photos' and public.can_access_customer_followups()
 and split_part(name,'/',1)=auth.uid()::text);

-- Produce a small, trusted order/contact snapshot; never expose the entire API payload.
create function public.customer_followup_order(_channel text,_line_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o jsonb; l jsonb; raw jsonb; ship jsonb; csv jsonb; contact jsonb;
begin
 if _channel='ebay' then
  select to_jsonb(x),to_jsonb(y) into l,o from public.ebay_order_lines x join public.ebay_orders y on y.id=x.order_id where x.id=_line_id;
 elsif _channel='tiktok' then
  select to_jsonb(x),to_jsonb(y) into l,o from public.tiktok_order_lines x join public.tiktok_orders y on y.id=x.order_id where x.id=_line_id;
 else raise exception 'Choose an eBay or TikTok order item'; end if;
 if l is null then raise exception 'Order item not found'; end if;
 raw:=coalesce(o#>'{raw_payload,order}',o->'raw_payload','{}');
 ship:=coalesce(raw#>'{fulfillmentStartInstructions,0,shippingStep,shipTo}','{}');
 csv:=coalesce(o#>'{raw_payload,first_row}','{}');
 contact:=jsonb_build_object(
  'name',coalesce(nullif(o->>'buyer_name',''),nullif(o->>'recipient_name',''),nullif(ship->>'fullName',''),o->>'buyer_nickname',''),
  'username',coalesce(o->>'buyer_username',''),
  'phone',coalesce(nullif(ship#>>'{primaryPhone,phoneNumber}',''),nullif(raw#>>'{buyer,buyerRegistrationAddress,primaryPhone,phoneNumber}',''),csv->>'Buyer Phone Number',csv->>'Ship To Phone',''),
  'email',coalesce(nullif(o->>'buyer_email',''),nullif(ship->>'email',''),raw#>>'{buyer,email}',csv->>'Buyer Email',''),
  'address',concat_ws(', ',nullif(coalesce(ship#>>'{contactAddress,addressLine1}',csv->>'Ship To Address 1'),''),
   nullif(coalesce(ship#>>'{contactAddress,addressLine2}',csv->>'Ship To Address 2'),''),
   nullif(coalesce(ship#>>'{contactAddress,city}',csv->>'Ship To City'),''),
   nullif(coalesce(ship#>>'{contactAddress,stateOrProvince}',csv->>'Ship To State'),''),
   nullif(coalesce(ship#>>'{contactAddress,postalCode}',csv->>'Ship To Zip'),''),
   nullif(coalesce(ship#>>'{contactAddress,countryCode}',csv->>'Ship To Country'),'')));
 return jsonb_build_object('line_id',_line_id,'channel',_channel,'order_id',o->>'id','order_number',o->>'order_number',
 'buyer_username',o->>'buyer_username','buyer_id',o->>'api_buyer_id','title',coalesce(l->>'item_title',l->>'title'),
 'item_number',coalesce(l->>'item_number',l->>'sku_id'),'quantity',l->'quantity','amount',coalesce(l->'total_price',l->'line_amount'),
 'purchased_at',coalesce(raw->>'creationDate',o->>'sale_date',o->>'created_time'),
 'purchase_precision',case when raw->>'creationDate' is not null then 'timestamp'
  when o#>>'{raw_payload,date_precision,sale_date}'='day' or (csv ? 'Sale Date' and coalesce(o#>>'{raw_payload,date_precision,sale_date}','')<>'timestamp') then 'day'
  when _channel='tiktok' and coalesce(o->>'created_time','') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then 'local' else 'timestamp' end,
 'order_status',coalesce(o->>'status',o->>'marketplace_status'),
 'outbound_tracking',coalesce(o->>'tracking_number',l->>'tracking_number'),'contact',contact,
 'history_link',case when _channel='ebay' then 'ebay-order-history.html?focusOrder='||coalesce(o->>'order_number','')||'&focusLineId='||_line_id::text
 else 'pending-tiktok-orders.html?'||case when o->>'stage'='completed' then 'view=history&' when o->>'marketplace_status' in ('Canceled','Cancelled') then 'view=cancellations&' else '' end||'search='||coalesce(o->>'order_number','') end);
end $$;
revoke all on function public.customer_followup_order(text,uuid) from public,anon,authenticated;

create function public.search_customer_followup_orders(_query text default '',_channel text default 'ebay',_buyer text default '',_line_id uuid default null)
returns setof jsonb language plpgsql stable security definer set search_path='' as $$
declare q text:=lower(btrim(coalesce(_query,''))); buyer text:=lower(btrim(coalesce(_buyer,'')));
begin
 if not public.can_access_customer_followups() then raise exception 'Active staff access required' using errcode='42501'; end if;
 if length(q)>200 or length(buyer)>200 then raise exception 'Search is too long'; end if;
 if _line_id is null and buyer='' and length(q)<2 then return; end if;
 if _channel='ebay' then
  return query select public.customer_followup_order('ebay',l.id) from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
   where (_line_id is null or l.id=_line_id) and (buyer='' or lower(btrim(o.buyer_username))=buyer)
   and (q='' or strpos(lower(concat_ws(' ',o.order_number,o.buyer_username,o.buyer_name,l.item_number,l.item_title)),q)>0)
   order by o.sale_date desc nulls last,l.id limit 41;
 elsif _channel='tiktok' then
  return query select public.customer_followup_order('tiktok',l.id) from public.tiktok_order_lines l join public.tiktok_orders o on o.id=l.order_id
   where (_line_id is null or l.id=_line_id) and (buyer='' or lower(btrim(o.buyer_username))=buyer or o.api_buyer_id=buyer)
   and (q='' or strpos(lower(concat_ws(' ',o.order_number,o.buyer_username,o.recipient_name,l.sku_id,l.title)),q)>0)
   order by o.source_snapshot_at desc,l.id limit 41;
 else raise exception 'Choose an order marketplace'; end if;
end $$;
revoke all on function public.search_customer_followup_orders(text,text,text,uuid) from public,anon;
grant execute on function public.search_customer_followup_orders(text,text,text,uuid) to authenticated;

create function public.validate_customer_followup_photos(_photos jsonb,_request_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if jsonb_typeof(_photos) is distinct from 'array' or jsonb_array_length(_photos)>10 then raise exception 'Choose up to 10 photos per update'; end if;
 if exists(select 1 from jsonb_array_elements(_photos) p where jsonb_typeof(p)<>'object'
  or p->>'bucket' is distinct from 'customer-followup-photos'
  or left(coalesce(p->>'path',''),length(auth.uid()::text||'/'||_request_id::text||'/'))<>auth.uid()::text||'/'||_request_id::text||'/'
  or coalesce(p->>'mime_type','') not in ('image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif')
  or coalesce((p->>'size_bytes')::bigint,0) not between 1 and 20971520
  or not exists(select 1 from storage.objects s where s.bucket_id='customer-followup-photos' and s.name=p->>'path')) then
  raise exception 'Invalid or missing photo upload';
 end if;
end $$;
revoke all on function public.validate_customer_followup_photos(jsonb,uuid) from public,anon,authenticated;

create function public.create_customer_followup(_request_id uuid,_details jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.customer_followups; actor public.employees; ctx jsonb:='{}'; snapshot jsonb:='{}'; c jsonb;
 contact jsonb; buyer text:=btrim(coalesce(_details->>'buyer_username','')); channel text:=coalesce(_details->>'channel','other');
 line_id uuid:=nullif(_details->>'line_id','')::uuid; conversation uuid:=nullif(_details->>'conversation_id','')::uuid;
 photos jsonb:=coalesce(_details->'photos','[]'); note text:=btrim(coalesce(_details->>'note','')); field text;
begin
 if not public.can_access_customer_followups() then raise exception 'Active staff access required' using errcode='42501'; end if;
 if _request_id is null or jsonb_typeof(_details) is distinct from 'object' then raise exception 'Save ID and details required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||_request_id::text,0));
 select * into r from public.customer_followups where created_by=auth.uid() and request_id=_request_id;
 if found then
  if r.request_payload is distinct from _details then raise exception 'This save already created a record. Refresh Customer follow-ups to review it before making changes.'; end if;
  return to_jsonb(r);
 end if;
 select * into actor from public.employees where user_id=auth.uid() and active is true limit 1;
 if length(note)>10000 or note='' then raise exception 'Describe the call or return (up to 10,000 characters)'; end if;
 if _details->>'kind'='manual_return' and line_id is null then raise exception 'Select the exact purchased item for this return'; end if;
 if line_id is not null then
  snapshot:=public.customer_followup_order(channel,line_id);
  if buyer<>'' and lower(buyer)<>lower(snapshot->>'buyer_username') and buyer is distinct from snapshot->>'buyer_id' then raise exception 'This item belongs to a different customer'; end if;
  buyer:=snapshot->>'buyer_username';
 end if;
 if conversation is not null then
  if channel='ebay' then
   if not coalesce(public.can_access_email_triage(),false) then raise exception 'Messages access required' using errcode='42501'; end if;
   ctx:=public.buyer_followup_message_context(buyer,conversation,nullif(_details->>'message_id','')::uuid);
  elsif channel='tiktok' then
   if not coalesce(public.can_access_tiktok_messages(),false) then raise exception 'Messages access required' using errcode='42501'; end if;
   select to_jsonb(x) into c from public.tiktok_chat_conversations x where id=conversation;
   if c is null or (line_id is not null and snapshot->>'buyer_id' is distinct from c->>'buyer_id') then raise exception 'Conversation does not match this customer'; end if;
   if line_id is null then buyer:=c->>'buyer_id'; end if;
   ctx:=jsonb_build_object('conversation_id',conversation,'conversation_link','tiktok-messages.html?conversation='||conversation::text,
    'message_preview',c->>'latest_preview','buyer_name',c->>'buyer_name');
  else raise exception 'Choose the source marketplace'; end if;
 end if;
 contact:=coalesce(snapshot->'contact','{}');
 foreach field in array array['name','phone','email','address'] loop
  if length(coalesce(_details#>>array['contact',field],''))>1000 then raise exception 'Contact field is too long'; end if;
  if nullif(btrim(_details#>>array['contact',field]),'') is not null then contact:=contact||jsonb_build_object(field,btrim(_details#>>array['contact',field])); end if;
 end loop;
 if coalesce(nullif(contact->>'name',''),nullif(buyer,'')) is null then raise exception 'Add the customer or contact name'; end if;
 if length(buyer)>200 then raise exception 'Customer username is too long'; end if;
 if _details->>'kind'='manual_return' and (coalesce((_details->>'return_quantity')::integer,1)<1
  or coalesce((_details->>'return_quantity')::integer,1)>coalesce((snapshot->>'quantity')::integer,0)) then raise exception 'Return quantity must be between 1 and the purchased quantity'; end if;
 perform public.validate_customer_followup_photos(photos,_request_id);
 insert into public.customer_followups(kind,title,channel,buyer_username,contact,ebay_order_line_id,tiktok_order_line_id,order_snapshot,source_context,
 tracking_number,carrier,due_at,priority,created_by,created_by_email,request_id,return_quantity,request_payload)
 values(_details->>'kind',btrim(_details->>'title'),channel,buyer,contact,
 case when channel='ebay' then line_id end,case when channel='tiktok' then line_id end,snapshot,ctx,
 btrim(coalesce(_details->>'tracking_number','')),btrim(coalesce(_details->>'carrier','')),nullif(_details->>'due_at','')::timestamptz,
 coalesce(_details->>'priority','normal'),auth.uid(),actor.email,_request_id,coalesce((_details->>'return_quantity')::integer,1),_details) returning * into r;
 insert into public.customer_followup_events(followup_id,action,note,photos,after_values,created_by,created_by_email,request_id,request_payload)
 values(r.id,'created',note,photos,to_jsonb(r)-'request_payload',auth.uid(),actor.email,_request_id,_details);
 return to_jsonb(r);
end $$;
revoke all on function public.create_customer_followup(uuid,jsonb) from public,anon;
grant execute on function public.create_customer_followup(uuid,jsonb) to authenticated;

create function public.update_customer_followup(_id uuid,_revision integer,_request_id uuid,_details jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.customer_followups; previous jsonb; actor_email text; photos jsonb:=coalesce(_details->'photos','[]');
 note text:=btrim(coalesce(_details->>'note','')); new_contact jsonb; field text;
begin
 if not public.can_access_customer_followups() then raise exception 'Active staff access required' using errcode='42501'; end if;
 if _request_id is null or jsonb_typeof(_details) is distinct from 'object' then raise exception 'Save ID and details required'; end if;
 select * into r from public.customer_followups where id=_id for update;
 if not found then raise exception 'Follow-up not found'; end if;
 if exists(select 1 from public.customer_followup_events where followup_id=_id and created_by=auth.uid() and request_id=_request_id) then
  if exists(select 1 from public.customer_followup_events where followup_id=_id and created_by=auth.uid() and request_id=_request_id and request_payload is distinct from _details) then raise exception 'This update was already saved. Refresh the record before adding another update.'; end if;
  return to_jsonb(r);
 end if;
 if r.revision is distinct from _revision then raise exception 'Someone updated this record. Refresh it before saving.' using errcode='40001'; end if;
 if length(note)>10000 or (note='' and jsonb_array_length(photos)=0) then raise exception 'Add a note or photo to explain this update'; end if;
 if _details->>'status' in ('closed','cancelled') and exists(select 1 from public.customer_followup_tasks f join public.team_tasks t on t.id=f.task_id
 where f.followup_id=_id and t.status not in ('resolved','cancelled')) then raise exception 'Finish or cancel the linked tasks before closing this record'; end if;
 perform public.validate_customer_followup_photos(photos,_request_id);
 if r.kind='manual_return' and _details ? 'return_quantity' and (coalesce((_details->>'return_quantity')::integer,0)<1
  or (_details->>'return_quantity')::integer>(r.order_snapshot->>'quantity')::integer) then raise exception 'Return quantity must be between 1 and the purchased quantity'; end if;
 new_contact:=r.contact;
 foreach field in array array['name','phone','email','address'] loop
  if _details->'contact' ? field then
   if length(coalesce(_details#>>array['contact',field],''))>1000 then raise exception 'Contact field is too long'; end if;
   new_contact:=new_contact||jsonb_build_object(field,btrim(coalesce(_details#>>array['contact',field],'')));
  end if;
 end loop;
 if coalesce(nullif(new_contact->>'name',''),nullif(r.buyer_username,'')) is null then raise exception 'Keep a customer or contact name'; end if;
 previous:=to_jsonb(r)-'request_payload';
 update public.customer_followups set title=coalesce(btrim(_details->>'title'),title),contact=new_contact,
 status=coalesce(_details->>'status',status),return_stage=coalesce(_details->>'return_stage',return_stage),
 return_quantity=coalesce((_details->>'return_quantity')::integer,return_quantity),
 tracking_number=coalesce(btrim(_details->>'tracking_number'),tracking_number),carrier=coalesce(btrim(_details->>'carrier'),carrier),
 due_at=case when _details ? 'due_at' then nullif(_details->>'due_at','')::timestamptz else due_at end,
 priority=coalesce(_details->>'priority',priority),revision=revision+1,updated_at=clock_timestamp() where id=_id returning * into r;
 select email into actor_email from public.employees where user_id=auth.uid() and active is true limit 1;
 insert into public.customer_followup_events(followup_id,action,note,photos,before_values,after_values,created_by,created_by_email,request_id,request_payload)
 values(_id,'updated',note,photos,previous,to_jsonb(r)-'request_payload',auth.uid(),actor_email,_request_id,_details);
 return to_jsonb(r);
end $$;
revoke all on function public.update_customer_followup(uuid,integer,uuid,jsonb) from public,anon;
grant execute on function public.update_customer_followup(uuid,integer,uuid,jsonb) to authenticated;

create function public.create_customer_followup_task(_id uuid,_request_id uuid,_details jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.customer_followups; t jsonb; actor_email text; existing uuid;
begin
 if not public.can_access_customer_followups() then raise exception 'Active staff access required' using errcode='42501'; end if;
 if _request_id is null then raise exception 'Save ID required'; end if;
 select * into r from public.customer_followups where id=_id for update;
 if not found then raise exception 'Follow-up not found'; end if;
 select task_id into existing from public.customer_followup_tasks where created_by=auth.uid() and request_id=_request_id and followup_id=_id;
 if found then
  if exists(select 1 from public.customer_followup_tasks where task_id=existing and request_payload is distinct from _details) then raise exception 'This task was already created. Refresh the record before creating another task.'; end if;
  select to_jsonb(x) into t from public.team_tasks x where id=existing; return t;
 end if;
 if r.status in ('closed','cancelled') then raise exception 'Reopen the record before creating a task'; end if;
 if nullif(btrim(_details->>'title'),'') is null or length(_details->>'title')>200
 or nullif(btrim(_details->>'instructions'),'') is null or length(_details->>'instructions')>10000 then raise exception 'Add a task title and instructions'; end if;
 select email into actor_email from public.employees where user_id=auth.uid() and active is true limit 1;
 t:=public.create_task_request('team','work',jsonb_build_object('_title',btrim(_details->>'title'),
 '_description',btrim(_details->>'instructions'),'_task_type','customer_service','_assigned_to_user_id',_details->>'owner',
 '_due_at',nullif(_details->>'due_at',''),'_priority',coalesce(_details->>'priority',r.priority),'_signed_by_email',actor_email));
 update public.team_tasks set metadata=metadata||jsonb_build_object('source','customer_followup','followup_id',r.id,
 'followup_kind',r.kind,'followup_link','customer-followups.html?id='||r.id::text,'customer_name',r.contact->>'name',
 'buyer_username',case when r.channel='ebay' then r.buyer_username else null end,'order_number',r.order_snapshot->>'order_number',
 'conversation_link',r.source_context->>'conversation_link') where id=(t->>'id')::uuid returning to_jsonb(team_tasks) into t;
 insert into public.customer_followup_tasks values(_id,(t->>'id')::uuid,auth.uid(),_request_id,_details);
 insert into public.customer_followup_events(followup_id,action,note,after_values,created_by,created_by_email,request_id,request_payload)
 values(_id,'task_created',_details->>'instructions',jsonb_build_object('task_id',t->>'id','title',t->>'title','assignee',t->>'assigned_to_email'),auth.uid(),actor_email,_request_id,_details);
 update public.customer_followups set revision=revision+1,updated_at=clock_timestamp() where id=_id;
 return t;
end $$;
revoke all on function public.create_customer_followup_task(uuid,uuid,jsonb) from public,anon;
grant execute on function public.create_customer_followup_task(uuid,uuid,jsonb) to authenticated;

create function public.customer_followup_packet(_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.can_access_customer_followups() then raise exception 'Active staff access required' using errcode='42501'; end if;
 select jsonb_build_object('record',to_jsonb(r),'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id) from public.customer_followup_events e where e.followup_id=r.id),'[]'),
 'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status,'due_at',t.due_at,
 'assigned_to_user_id',t.assigned_to_user_id,'assigned_to_email',t.assigned_to_email,'latest_note',t.latest_note) order by t.created_at)
 from public.customer_followup_tasks f join public.team_tasks t on t.id=f.task_id where f.followup_id=r.id),'[]')) into result
 from public.customer_followups r where r.id=_id;
 if result is null then raise exception 'Follow-up not found'; end if;
 return result;
end $$;
revoke all on function public.customer_followup_packet(uuid) from public,anon;
grant execute on function public.customer_followup_packet(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
