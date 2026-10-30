begin;
set local lock_timeout='2s';
set local statement_timeout='25s';

alter table public.live_sale_sessions drop constraint live_sale_sessions_workflow_mode_check;
alter table public.live_sale_sessions add constraint live_sale_sessions_workflow_mode_check check(workflow_mode in ('manual','ebay_live','tiktok_live'));
create table public.tiktok_live_connections (
 event_id text primary key check(event_id ~ '^tiktok-[0-9]{10,25}$'),
 session_id uuid not null unique references public.live_sale_sessions(id),
 active_seller_id uuid not null references public.employees(id),
 source_url text not null, title text not null, account_name text,
 started_at timestamptz, start_label text, last_received_at timestamptz,
 health jsonb not null default '{}', linked_by uuid not null default auth.uid(), linked_at timestamptz not null default now(),
 broadcast_ended_at timestamptz, review_completed_at timestamptz
);
create table public.tiktok_live_attempts (
 id uuid primary key default gen_random_uuid(), event_id text not null references public.tiktok_live_connections(event_id),
 source_key text not null, sku text not null, listing_title text not null, buyer text not null, buyer_name text,
 amount numeric(12,2) not null check(amount>=0 and amount<>'NaN'::numeric), currency text not null default 'USD' check(currency='USD'),
 payment_state text not null check(payment_state in ('paid','waiting','failed','cancelled','review')),
 payment_label text not null, observed_at timestamptz not null, sold_at timestamptz, time_estimated boolean not null default true,
 seller_id uuid not null references public.employees(id), lot_id uuid unique references public.live_sale_lots(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(event_id,source_key)
);
create index tiktok_live_attempts_event on public.tiktok_live_attempts(event_id,created_at);
create table public.tiktok_live_audit (
 id bigint generated always as identity primary key,event_id text not null references public.tiktok_live_connections(event_id),
 attempt_id uuid references public.tiktok_live_attempts(id),action text not null,actor uuid default auth.uid(),
 details jsonb not null default '{}',created_at timestamptz not null default now()
);
alter table public.tiktok_live_connections enable row level security;
alter table public.tiktok_live_attempts enable row level security;
alter table public.tiktok_live_audit enable row level security;
revoke all on public.tiktok_live_connections,public.tiktok_live_attempts,public.tiktok_live_audit from public,anon,authenticated;
grant select on public.tiktok_live_connections,public.tiktok_live_attempts to authenticated;
create policy staff_read on public.tiktok_live_connections for select to authenticated using(public.can_manage_inventory());
create policy staff_read on public.tiktok_live_attempts for select to authenticated using(public.can_manage_inventory());

alter table public.live_sale_bag_photos alter column attempt_id drop not null;
alter table public.live_sale_bag_photos add column tiktok_attempt_id uuid references public.tiktok_live_attempts(id);
alter table public.live_sale_bag_photos add constraint live_photo_one_marketplace check(num_nonnulls(attempt_id,tiktok_attempt_id)=1);
create index live_sale_photos_tiktok_attempt on public.live_sale_bag_photos(tiktok_attempt_id) where tiktok_attempt_id is not null;

create function public.start_tiktok_live_capture(_event_id text,_primary_seller_employee_id uuid,_stream jsonb)
returns public.live_sale_sessions language plpgsql security definer set search_path='' as $$
declare s public.live_sale_sessions;c public.tiktok_live_connections;source_url text;started timestamptz;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _event_id is null or _event_id !~ '^tiktok-[0-9]{10,25}$' or jsonb_typeof(_stream) is distinct from 'object' then raise exception 'Open capture from the TikTok LIVE console' using errcode='22023';end if;
 source_url:=_stream->>'url';
 if source_url is null or source_url !~ '^https://shop[.]tiktok[.]com/streamer/live/product/dashboard([?][A-Za-z0-9_=&%-]+)?$' or length(source_url)>1000 then raise exception 'Invalid TikTok console URL' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('tiktok-live:'||_event_id,0));
 select * into c from public.tiktok_live_connections where event_id=_event_id;
 if found then
  select * into s from public.live_sale_sessions where id=c.session_id;
  if s.status<>'active' or c.review_completed_at is not null then raise exception 'This TikTok show is already closed' using errcode='22023';end if;
  return s;
 end if;
 if _primary_seller_employee_id is null or not exists(select 1 from public.employees where id=_primary_seller_employee_id and active is distinct from false) then raise exception 'Select an active seller' using errcode='22023';end if;
 started:=nullif(_stream->>'started_at','')::timestamptz;
 if started>now()+interval '1 hour' or started<now()-interval '2 years' then raise exception 'Check the show start time' using errcode='22023';end if;
 s:=public.start_live_sale_session('TikTok Live · '||left(coalesce(nullif(_stream->>'title',''),'Show'),150),null,'Captured from TikTok LIVE console',(select email from auth.users where id=auth.uid()),_primary_seller_employee_id,'{}');
 update public.live_sale_sessions set workflow_mode='tiktok_live',started_at=coalesce(started,started_at) where id=s.id returning * into s;
 insert into public.tiktok_live_connections(event_id,session_id,active_seller_id,source_url,title,account_name,started_at,start_label)
 values(_event_id,s.id,_primary_seller_employee_id,source_url,left(coalesce(_stream->>'title','TikTok Live'),200),left(_stream->>'account',100),started,left(_stream->>'start_label',150));
 insert into public.tiktok_live_audit(event_id,action,details) values(_event_id,'show_started',jsonb_build_object('session_id',s.id,'seller_id',_primary_seller_employee_id));
 return s;
end $$;

create function public.prepare_tiktok_live_bag_label(_attempt_id uuid)
returns public.live_sale_lots language plpgsql security definer set search_path='' as $$
declare a public.tiktok_live_attempts;c public.tiktok_live_connections;l public.live_sale_lots;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.tiktok_live_attempts where id=_attempt_id for update;
 if not found then raise exception 'Select a captured TikTok sale' using errcode='22023';end if;
 if a.lot_id is not null then select * into l from public.live_sale_lots where id=a.lot_id;return l;end if;
 select * into c from public.tiktok_live_connections where event_id=a.event_id;
 if c.review_completed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show is already closed' using errcode='22023';end if;
 l:=public.create_live_sale_lot(c.session_id,'TT-'||a.sku||'-'||substr(replace(a.id::text,'-',''),1,8),'TikTok '||a.listing_title||' | Winner @'||a.buyer,(select email from auth.users where id=auth.uid()),a.seller_id);
 update public.tiktok_live_attempts set lot_id=l.id where id=a.id;
 insert into public.tiktok_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,'bag_prepared',jsonb_build_object('lot_id',l.id));
 return l;
end $$;

create function public.ingest_tiktok_live_events(_event_id text,_events jsonb,_health jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.tiktok_live_connections;e jsonb;a public.tiktok_live_attempts;old_state text;observed timestamptz;sold timestamptz;amount numeric;accepted int:=0;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if jsonb_typeof(_events) is distinct from 'array' or jsonb_array_length(_events)>100 or octet_length(_events::text)>600000 or jsonb_typeof(_health) is distinct from 'object' then raise exception 'Invalid capture batch' using errcode='22023';end if;
 select * into c from public.tiktok_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Choose the sellers for this TikTok show first' using errcode='22023';end if;
 if c.review_completed_at is not null or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show is already closed' using errcode='22023';end if;
 for e in select value from jsonb_array_elements(_events) loop
  if coalesce(e->>'key','')='' or length(e->>'key')>1000 or coalesce(e->>'sku','')!~ '^[A-Za-z0-9_-]{1,60}$' or coalesce(e->>'buyer','')!~ '^[A-Za-z0-9._]{1,100}$' or coalesce(e->>'title','')='' or length(e->>'title')>400 or coalesce(e->>'payment_state','') not in ('paid','waiting','failed','cancelled','review') or e->>'currency' is distinct from 'USD' or coalesce(e->>'amount','')!~ '^[0-9]{1,9}([.][0-9]{1,2})?$' or coalesce(e->>'payment_label','')='' or length(e->>'payment_label')>100 then raise exception 'Invalid TikTok sale evidence' using errcode='22023';end if;
  observed:=nullif(e->>'observed_at','')::timestamptz;sold:=nullif(e->>'sold_at','')::timestamptz;amount:=(e->>'amount')::numeric;
  if observed is null or observed>now()+interval '1 minute' or sold>observed+interval '1 minute' then raise exception 'Invalid observation time' using errcode='22023';end if;
  select * into a from public.tiktok_live_attempts where event_id=_event_id and source_key=e->>'key' for update;
  if found then
   if a.sku<>e->>'sku' or lower(a.buyer)<>lower(e->>'buyer') or a.amount<>amount then raise exception 'Sale identity changed; check TikTok before retrying' using errcode='22023';end if;
   if observed<=a.observed_at then continue;end if;
   old_state:=a.payment_state;
   update public.tiktok_live_attempts set payment_state=e->>'payment_state',payment_label=e->>'payment_label',observed_at=observed,updated_at=now(),sold_at=coalesce(sold_at,sold) where id=a.id returning * into a;
   if old_state<>a.payment_state then insert into public.tiktok_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'payment_updated',jsonb_build_object('from',old_state,'to',a.payment_state,'label',a.payment_label,'observed_at',observed));end if;
  else
   insert into public.tiktok_live_attempts(event_id,source_key,sku,listing_title,buyer,buyer_name,amount,payment_state,payment_label,observed_at,sold_at,seller_id)
   values(_event_id,e->>'key',e->>'sku',e->>'title',e->>'buyer',left(e->>'buyer_name',150),amount,e->>'payment_state',e->>'payment_label',observed,sold,c.active_seller_id) returning * into a;
   perform public.prepare_tiktok_live_bag_label(a.id);
   insert into public.tiktok_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'sale_captured',jsonb_build_object('source','sold_items','payment',a.payment_state));
  end if;
  accepted:=accepted+1;
 end loop;
 update public.tiktok_live_connections set last_received_at=now(),health=jsonb_build_object('ready',coalesce((_health->>'ready')::boolean,false),'message',left(_health->>'message',300),'observed_at',_health->>'observed_at','version',left(_health->>'version',30),'pending',_health->>'pending','history_read',coalesce((_health->>'history_read')::boolean,false),'rows_seen',_health->>'rows_seen','source','TikTok sold items') where event_id=_event_id;
 return jsonb_build_object('accepted',accepted);
end $$;

create function public.get_tiktok_live_dashboard(_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.tiktok_live_connections;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into c from public.tiktok_live_connections where session_id=_session_id;
 if not found then raise exception 'Select a TikTok show' using errcode='22023';end if;
 return jsonb_build_object('server_time',now(),'connection',to_jsonb(c),'session',(select to_jsonb(s) from public.live_sale_sessions s where id=_session_id),
 'attempts',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('lot_code',l.lot_code) order by a.sold_at desc nulls last,a.created_at desc) from public.tiktok_live_attempts a left join public.live_sale_lots l on l.id=a.lot_id where a.event_id=c.event_id),'[]'::jsonb),
 'photos',coalesce((select jsonb_agg(to_jsonb(p)) from public.live_sale_bag_photos p join public.tiktok_live_attempts a on a.id=p.tiktok_attempt_id where a.event_id=c.event_id),'[]'::jsonb));
end $$;

create function public.attach_tiktok_live_bag_photo(_attempt_id uuid,_photo_id uuid,_photo_path text,_width integer,_height integer,_captured_at timestamptz)
returns public.live_sale_bag_photos language plpgsql security definer set search_path='' as $$
declare a public.tiktok_live_attempts;p public.live_sale_bag_photos;added int;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.tiktok_live_attempts where id=_attempt_id for update;
 if not found or a.lot_id is null then raise exception 'Select a captured TikTok bag' using errcode='22023';end if;
 if _photo_id is null or _photo_path is distinct from ('live-bags/'||a.lot_id::text||'/'||auth.uid()::text||'/'||_photo_id::text||'.jpg') or _width is null or _height is null or _width not between 160 and 1600 or _height not between 160 and 1600 or _captured_at is null then raise exception 'Invalid bag photo' using errcode='22023';end if;
 if not exists(select 1 from storage.objects where bucket_id='photos' and name=_photo_path and metadata->>'mimetype'='image/jpeg' and (metadata->>'size')::bigint between 1 and 3000000) then raise exception 'Photo upload not complete; retry this capture' using errcode='22023';end if;
 insert into public.live_sale_bag_photos(id,lot_id,tiktok_attempt_id,photo_path,width,height,captured_at,created_by) values(_photo_id,a.lot_id,a.id,_photo_path,_width,_height,_captured_at,auth.uid()) on conflict(id) do nothing;
 get diagnostics added=row_count;
 select * into p from public.live_sale_bag_photos where id=_photo_id;
 if p.tiktok_attempt_id is distinct from a.id or p.photo_path<>_photo_path or p.created_by<>auth.uid() or p.width<>_width or p.height<>_height or p.captured_at<>_captured_at then raise exception 'Photo request belongs to a different capture' using errcode='22023';end if;
 if added=1 then insert into public.tiktok_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,'photo_saved',jsonb_build_object('photo_id',p.id));end if;
 return p;
end $$;

create function public.enqueue_tiktok_live_auto_label(_attempt_id uuid,_station_id uuid,_label_xml text,_printer_roll text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.tiktok_live_attempts;l public.live_sale_lots;j public.label_print_jobs;result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.tiktok_live_attempts where id=_attempt_id for update;
 if not found then raise exception 'Select a TikTok sale' using errcode='22023';end if;
 select * into l from public.live_sale_lots where id=a.lot_id;
 if not found or position(l.lot_code in coalesce(_label_xml,''))=0 then raise exception 'Label does not identify this bag' using errcode='22023';end if;
 select * into j from public.label_print_jobs where request_id=a.id or barcode=l.lot_code order by created_at limit 1;
 if not found then result:=public.enqueue_label_print(_station_id,a.id,_label_xml,1,a.listing_title,l.lot_code,null,_printer_roll);select * into j from public.label_print_jobs where id=(result->>'id')::uuid;end if;
 return jsonb_build_object('id',j.id,'status',j.status,'station_id',j.station_id,'station_name',(select name from public.print_stations where id=j.station_id));
end $$;

create function public.get_tiktok_live_bag_print_status(_event_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(r)) from (
 select a.id attempt_id,j.id job_id,case when j.status='claimed' and j.lease_until<now() then 'uncertain' else j.status end status,s.name station_name,j.printer_roll,j.copies,j.submitted_copies,j.created_at,j.updated_at,j.detail
 from public.tiktok_live_attempts a join public.live_sale_lots l on l.id=a.lot_id join lateral(select * from public.label_print_jobs p where p.barcode=l.lot_code order by p.created_at desc,p.id desc limit 1) j on true join public.print_stations s on s.id=j.station_id where a.event_id=_event_id
 )r),'[]'::jsonb);
end $$;

revoke all on function public.start_tiktok_live_capture(text,uuid,jsonb),public.prepare_tiktok_live_bag_label(uuid),public.ingest_tiktok_live_events(text,jsonb,jsonb),public.get_tiktok_live_dashboard(uuid),public.attach_tiktok_live_bag_photo(uuid,uuid,text,integer,integer,timestamptz),public.enqueue_tiktok_live_auto_label(uuid,uuid,text,text),public.get_tiktok_live_bag_print_status(text) from public,anon,authenticated;
grant execute on function public.start_tiktok_live_capture(text,uuid,jsonb),public.prepare_tiktok_live_bag_label(uuid),public.ingest_tiktok_live_events(text,jsonb,jsonb),public.get_tiktok_live_dashboard(uuid),public.attach_tiktok_live_bag_photo(uuid,uuid,text,integer,integer,timestamptz),public.enqueue_tiktok_live_auto_label(uuid,uuid,text,text),public.get_tiktok_live_bag_print_status(text) to authenticated;
notify pgrst,'reload schema';
commit;
