begin;
create table public.ebay_live_connections (
 event_id text primary key check(event_id ~ '^[A-Za-z0-9_-]{6,100}$'),
 session_id uuid not null unique references public.live_sale_sessions(id),
 active_seller_id uuid references public.employees(id),
 fee_percent numeric(8,4), fee_fixed numeric(10,2), shipping_per_sale numeric(10,2),
 last_received_at timestamptz, source_seen_at timestamptz, capture_ready boolean not null default false,
 health jsonb not null default '{}', linked_by uuid not null default auth.uid(), linked_at timestamptz not null default now(),
 check(fee_percent between 0 and 100 and fee_fixed>=0 and fee_fixed<>'NaN'::numeric and shipping_per_sale>=0 and shipping_per_sale<>'NaN'::numeric)
);
create table public.ebay_live_attempts (
 id uuid primary key default gen_random_uuid(), event_id text not null references public.ebay_live_connections(event_id),
 listing_id text not null, listing_title text not null, ordinal text, buyer text not null, amount numeric(12,2) not null check(amount>=0),
 win_key text, win_time_label text, stream_offset_seconds integer, time_estimated boolean not null default true,
 payment_state text not null default 'waiting' check(payment_state in ('waiting','paid','failed','cancelled','review')),
 payment_source text, paid_at timestamptz, verified_at timestamptz, review_note text,
 seller_id uuid references public.employees(id), claimed_by uuid references auth.users(id), claimed_at timestamptz,
 lot_id uuid unique references public.live_sale_lots(id), closed_at timestamptz, resolved_at timestamptz,
 order_line_id uuid unique references public.ebay_order_lines(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(event_id,win_key)
);
create index ebay_live_attempts_event_listing on public.ebay_live_attempts(event_id,listing_id,created_at desc);
create table public.ebay_live_observations (
 event_id text not null references public.ebay_live_connections(event_id), source_key text not null,
 kind text not null, listing_id text, listing_title text, buyer text, amount numeric(12,2), time_label text,
 observed_at timestamptz not null, source text not null, evidence text,
 attempt_id uuid references public.ebay_live_attempts(id), disposition text not null default 'unmatched',
 received_at timestamptz not null default now(), primary key(event_id,source_key)
);
create index ebay_live_observations_unmatched on public.ebay_live_observations(event_id,disposition,received_at desc);
create table public.ebay_live_audit (
 id bigint generated always as identity primary key, event_id text not null references public.ebay_live_connections(event_id),
 attempt_id uuid references public.ebay_live_attempts(id), action text not null, actor uuid default auth.uid(),
 details jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table public.live_sale_lot_items add column live_unit_cost numeric(12,2), add column live_unit_minimum numeric(12,2);

alter table public.ebay_live_connections enable row level security;
alter table public.ebay_live_attempts enable row level security;
alter table public.ebay_live_observations enable row level security;
alter table public.ebay_live_audit enable row level security;
revoke all on public.ebay_live_connections,public.ebay_live_attempts,public.ebay_live_observations,public.ebay_live_audit from public,anon,authenticated;
grant select on public.ebay_live_connections,public.ebay_live_attempts to authenticated;
create policy inventory_read on public.ebay_live_connections for select to authenticated using(public.can_manage_inventory());
create policy inventory_read on public.ebay_live_attempts for select to authenticated using(public.can_manage_inventory());

create function public.ebay_live_is_admin() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.employees where user_id=auth.uid() and role='admin' and active is distinct from false) $$;
revoke all on function public.ebay_live_is_admin() from public,anon,authenticated;

create function public.link_ebay_live_event(_session_id uuid,_event_id text,_seller_id uuid default null) returns public.ebay_live_connections
language plpgsql security definer set search_path='' as $$
declare v_session public.live_sale_sessions; v_result public.ebay_live_connections;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into v_session from public.live_sale_sessions where id=_session_id and status='active' for update;
 if not found then raise exception 'Select an active show session' using errcode='22023'; end if;
 if _event_id !~ '^[A-Za-z0-9_-]{6,100}$' or _event_id is null then raise exception 'Enter a valid eBay event URL' using errcode='22023'; end if;
 _seller_id:=coalesce(_seller_id,v_session.primary_seller_employee_id);
 if not exists(select 1 from public.employees where id=_seller_id and active is distinct from false) then raise exception 'Select the active seller' using errcode='22023'; end if;
 insert into public.ebay_live_connections(event_id,session_id,active_seller_id) values(_event_id,_session_id,_seller_id)
 on conflict(event_id) do nothing;
 select * into v_result from public.ebay_live_connections where event_id=_event_id;
 if v_result.session_id<>_session_id then raise exception 'This event is already linked to another show' using errcode='22023'; end if;
 insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'event_linked',jsonb_build_object('session_id',_session_id));
 return v_result;
end $$;

create function public.configure_ebay_live_event(_event_id text,_seller_id uuid,_fee_percent numeric default null,_fee_fixed numeric default null,_shipping numeric default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if not exists(select 1 from public.employees where id=_seller_id and active is distinct from false) then raise exception 'Select an active seller' using errcode='22023'; end if;
 if (_fee_percent is not null or _fee_fixed is not null or _shipping is not null) and not public.ebay_live_is_admin() then raise exception 'Only admins configure expense estimates' using errcode='42501'; end if;
 update public.ebay_live_connections set active_seller_id=_seller_id,
 fee_percent=case when public.ebay_live_is_admin() then _fee_percent else fee_percent end,
 fee_fixed=case when public.ebay_live_is_admin() then _fee_fixed else fee_fixed end,
 shipping_per_sale=case when public.ebay_live_is_admin() then _shipping else shipping_per_sale end where event_id=_event_id;
 if not found then raise exception 'Event is not linked' using errcode='22023'; end if;
 insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'settings_changed',jsonb_build_object('seller_id',_seller_id,'fee_percent',_fee_percent,'fee_fixed',_fee_fixed,'shipping',_shipping));
end $$;

create function public.ingest_ebay_live_events(_event_id text,_events jsonb,_health jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
<<ingest>>
declare c public.ebay_live_connections; e jsonb; o public.ebay_live_observations; a public.ebay_live_attempts;
 candidates uuid[]; key text; kind text; listing text; title text; buyer text; amount numeric(12,2); seen timestamptz;
 count_accepted integer:=0; next_state text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if jsonb_typeof(_events) is distinct from 'array' or jsonb_array_length(_events)>100 then raise exception 'Send up to 100 observations' using errcode='22023'; end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Link this eBay event to a show first' using errcode='22023'; end if;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023'; end if;
 seen:=nullif(_health->>'observed_at','')::timestamptz;
 if seen>now()+interval '30 seconds' then seen:=null; end if;
 update public.ebay_live_connections set last_received_at=now(),source_seen_at=greatest(source_seen_at,seen),
 capture_ready=coalesce((_health->>'ready')::boolean,false),
 health=jsonb_build_object('message',left(_health->>'message',250),'version',left(_health->>'version',30),'pending',_health->>'pending') where event_id=_event_id;
 for e in select value from jsonb_array_elements(_events) loop
  key:=e->>'key';kind:=e->>'kind';listing:=nullif(e->>'listing_id','');title:=left(coalesce(e->>'title',''),300);buyer:=left(coalesce(e->>'buyer',''),100);
  if key is null or length(key)>2000 or coalesce(kind,'') not in ('won','paid','failed','cancelled','unknown') or coalesce(e->>'source','') not in ('activity','listing') or octet_length(e::text)>6000 then raise exception 'Invalid stream observation' using errcode='22023'; end if;
  if listing is not null and listing !~ '^[0-9]{8,20}$' then raise exception 'Invalid listing identifier' using errcode='22023'; end if;
  if coalesce(e->>'amount','') ~ '^[0-9]{1,9}([.][0-9]{1,2})?$' then amount:=(e->>'amount')::numeric;else amount:=null;end if;
  insert into public.ebay_live_observations(event_id,source_key,kind,listing_id,listing_title,buyer,amount,time_label,observed_at,source,evidence)
  values(_event_id,key,kind,listing,title,buyer,amount,left(e->>'time_label',40),coalesce(nullif(e->>'observed_at','')::timestamptz,now()),e->>'source',left(e->>'evidence',1000))
  on conflict(event_id,source_key) do nothing;
  select * into o from public.ebay_live_observations where event_id=_event_id and source_key=key for update;
  if o.disposition in ('matched','reviewed') then continue;end if;
  -- A later visible listing tile can supply the ID missing from an activity row.
  if listing is not null and o.listing_id is null then update public.ebay_live_observations set listing_id=listing where event_id=_event_id and source_key=key;end if;
  if listing is null or title='' or buyer='' or amount is null or coalesce(e->>'currency','')<>'USD' or kind='unknown' then continue;end if;
  a:=null;
  if kind='won' then
   select * into a from public.ebay_live_attempts where event_id=_event_id and win_key=key;
   if not found then
    select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=(e->>'amount')::numeric and x.win_key is null and x.resolved_at is null and x.payment_state in ('waiting','paid');
    if cardinality(candidates)=1 then
     update public.ebay_live_attempts set win_key=key,win_time_label=e->>'time_label',updated_at=now() where id=candidates[1] returning * into a;
    else
     insert into public.ebay_live_attempts(event_id,listing_id,listing_title,ordinal,buyer,amount,win_key,win_time_label,stream_offset_seconds,seller_id)
     values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,key,e->>'time_label',case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int end,c.active_seller_id) returning * into a;
    end if;
   end if;
  else
   select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=ingest.amount and x.resolved_at is null;
   if cardinality(candidates)>1 then
    update public.ebay_live_observations set disposition='review' where event_id=_event_id and source_key=key;
    update public.ebay_live_attempts set payment_state='review',review_note='Multiple auction attempts match this notification',updated_at=now() where id=any(candidates);
    continue;
   elsif cardinality(candidates)=1 then
    select * into a from public.ebay_live_attempts where id=candidates[1] for update;
   else
    insert into public.ebay_live_attempts(event_id,listing_id,listing_title,ordinal,buyer,amount,seller_id)
    values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,c.active_seller_id) returning * into a;
   end if;
   next_state:=case when kind='paid' then 'paid' when kind='failed' then 'failed' else 'cancelled' end;
   -- A delayed Paid tile must never resurrect a failed/cancelled attempt.
   if next_state='paid' and a.payment_state in ('failed','cancelled','review') then
    next_state:='review';
   end if;
   update public.ebay_live_attempts set payment_state=next_state,payment_source=e->>'source',
    paid_at=case when next_state='paid' then coalesce(paid_at,now()) else paid_at end,
    review_note=case when next_state='review' then 'Payment evidence conflicts; verify this attempt on eBay' else review_note end,updated_at=now()
   where id=a.id returning * into a;
  end if;
  update public.ebay_live_observations set attempt_id=a.id,disposition='matched' where event_id=_event_id and source_key=key;
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'observation_'||kind,jsonb_build_object('key',key,'payment_state',a.payment_state));
  count_accepted:=count_accepted+1;
 end loop;
 if exists(select 1 from public.ebay_live_observations where event_id=_event_id and disposition in ('unmatched','review')) then
  update public.ebay_live_connections set capture_ready=false,health=health||jsonb_build_object('message','Unmatched notifications need review') where event_id=_event_id;
 end if;
 return jsonb_build_object('accepted',count_accepted);
end $$;

-- Shared enforcement for every inventory reservation path, including old clients.
create function public.guard_ebay_live_reservation() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; increasing boolean;
begin
 if TG_OP='INSERT' then increasing:=NEW.status='reserved';
 else increasing:=NEW.status='reserved' and (OLD.status<>'reserved' or NEW.quantity>OLD.quantity or NEW.lot_id<>OLD.lot_id or NEW.session_id<>OLD.session_id or to_jsonb(NEW)->>'source_stock_location_row_id' is distinct from to_jsonb(OLD)->>'source_stock_location_row_id' or to_jsonb(NEW)->>'item_id' is distinct from to_jsonb(OLD)->>'item_id');end if;
 select ec.* into c from public.ebay_live_connections ec join public.live_sale_lots l on l.session_id=ec.session_id where l.id=NEW.lot_id;
 if not found then return NEW;end if;
 if NEW.session_id<>c.session_id then raise exception 'Bag and show do not match' using errcode='22023';end if;
 select * into a from public.ebay_live_attempts where lot_id=NEW.lot_id for update;
 if TG_OP='UPDATE' and NEW.status='packed' and OLD.status<>'packed' and (a.id is null or a.payment_state<>'paid' or a.resolved_at is not null) then raise exception 'Payment needs review before packing this bag' using errcode='22023';end if;
 if TG_TABLE_NAME='live_sale_lot_items' then
  if TG_OP='UPDATE' and NEW.item_id=OLD.item_id then NEW.live_unit_cost:=OLD.live_unit_cost;NEW.live_unit_minimum:=OLD.live_unit_minimum;end if;
 end if;
 if not increasing then return NEW;end if;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null or a.closed_at is not null then raise exception 'Select a paid, open eBay auction before scanning' using errcode='22023';end if;
 if a.claimed_by is distinct from auth.uid() then raise exception 'This bag is assigned to another scanner' using errcode='42501';end if;
 if not(coalesce(c.capture_ready and c.source_seen_at>now()-interval '30 seconds',false) or coalesce(a.verified_at>now()-interval '2 minutes',false)) then raise exception 'Capture is disconnected. Recheck payment on eBay before scanning' using errcode='22023';end if;
 if TG_TABLE_NAME='live_sale_lot_items' then
  if TG_OP='INSERT' or NEW.item_id<>OLD.item_id then
   select case when cost>=0 and cost<>'NaN'::numeric then cost end,minimum_sale_price into NEW.live_unit_cost,NEW.live_unit_minimum from public.item_types where id=NEW.item_id;
  else NEW.live_unit_cost:=OLD.live_unit_cost;NEW.live_unit_minimum:=OLD.live_unit_minimum;end if;
 end if;
 return NEW;
end $$;
create trigger ebay_live_inventory_gate before insert or update on public.live_sale_lot_items for each row execute function public.guard_ebay_live_reservation();
create trigger ebay_live_manual_gate before insert or update on public.live_sale_manual_lot_items for each row execute function public.guard_ebay_live_reservation();


create function public.sync_ebay_live_lot_status() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if NEW.status in ('cancelled','released') and NEW.status is distinct from OLD.status then
  update public.ebay_live_attempts set payment_state='review',review_note='Bag changed outside the paid queue. Verify payment and physical contents.',updated_at=now() where lot_id=NEW.id and resolved_at is null;
 end if;
 return NEW;
end $$;
create trigger ebay_live_lot_status after update on public.live_sale_lots for each row execute function public.sync_ebay_live_lot_status();
revoke all on function public.sync_ebay_live_lot_status() from public,anon,authenticated;

create function public.claim_ebay_live_bag(_attempt_id uuid) returns public.live_sale_lots language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; l public.live_sale_lots; mail text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null or a.closed_at is not null then raise exception 'Only a paid, open auction can be scanned' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not(coalesce(c.capture_ready and c.source_seen_at>now()-interval '30 seconds',false) or coalesce(a.verified_at>now()-interval '2 minutes',false)) then raise exception 'Capture is disconnected. Verify payment on eBay first' using errcode='22023';end if;
 if a.claimed_by is not null and a.claimed_by<>auth.uid() then raise exception 'Another scanner already has this bag. Ask an admin to release the claim' using errcode='42501';end if;
 select email into mail from auth.users where id=auth.uid();
 if a.lot_id is null then
  l:=public.create_live_sale_lot(c.session_id,'EB-'||coalesce(nullif(a.ordinal,''),a.listing_id)||'-'||substr(replace(a.id::text,'-',''),1,8),'eBay '||a.listing_title||' | Winner '||a.buyer,mail,a.seller_id);
 else select * into l from public.live_sale_lots where id=a.lot_id;end if;
 if l.status not in ('open','reserved') then raise exception 'This bag is no longer available for scanning' using errcode='22023';end if;
 update public.ebay_live_attempts set claimed_by=auth.uid(),claimed_at=coalesce(claimed_at,now()),lot_id=l.id,updated_at=now() where id=a.id;
 insert into public.ebay_live_audit(event_id,attempt_id,action) values(a.event_id,a.id,'bag_claimed');
 return l;
end $$;

create function public.close_ebay_live_bag(_attempt_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null then raise exception 'Payment is not confirmed for this bag' using errcode='22023';end if;
 if a.claimed_by is distinct from auth.uid() then raise exception 'Only the assigned scanner can close this bag' using errcode='42501';end if;
 if a.closed_at is not null then return;end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not(coalesce(c.capture_ready and c.source_seen_at>now()-interval '30 seconds',false) or coalesce(a.verified_at>now()-interval '2 minutes',false)) then raise exception 'Capture is disconnected. Verify payment before closing' using errcode='22023';end if;
 if not exists(select 1 from public.live_sale_lot_items where lot_id=a.lot_id and status='reserved') and not exists(select 1 from public.live_sale_manual_lot_items where lot_id=a.lot_id and status='reserved') then raise exception 'Scan the sold item before closing the bag' using errcode='22023';end if;
 update public.ebay_live_attempts set closed_at=now(),updated_at=now() where id=a.id;
 update public.live_sale_lots set closed_at=now() where id=a.lot_id;
 insert into public.ebay_live_audit(event_id,attempt_id,action) values(a.event_id,a.id,'bag_closed');
end $$;

create function public.resolve_ebay_live_attempt(_attempt_id uuid,_action text,_note text) returns void language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if length(btrim(coalesce(_note,'')))<10 then raise exception 'Describe the payment evidence or physical bag check (at least 10 characters)' using errcode='22023';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found then raise exception 'Auction not found' using errcode='22023';end if;
 if _action='verify_paid' then
  if a.resolved_at is not null then raise exception 'Resolved attempts cannot be reopened. Match the rerun instead' using errcode='22023';end if;
  update public.ebay_live_attempts set payment_state='paid',payment_source='staff_verified',paid_at=coalesce(paid_at,now()),verified_at=now(),review_note=_note,updated_at=now() where id=a.id;
 elsif _action='release_claim' then
  if not public.ebay_live_is_admin() then raise exception 'Only admins can release another scanner claim' using errcode='42501';end if;
  update public.ebay_live_attempts set claimed_by=null,updated_at=now() where id=a.id;
 elsif _action='cancel_release' then
  if a.lot_id is not null then perform public.cancel_live_sale_lot(a.lot_id,_note,(select email from auth.users where id=auth.uid()));end if;
  update public.ebay_live_attempts set payment_state='cancelled',resolved_at=now(),review_note=_note,updated_at=now() where id=a.id;
 else raise exception 'Unknown resolution action' using errcode='22023';end if;
 insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,_action,jsonb_build_object('note',_note));
end $$;


create function public.resolve_ebay_live_observation(_event_id text,_key text,_attempt_id uuid,_note text) returns void
language plpgsql security definer set search_path='' as $$
declare o public.ebay_live_observations;a public.ebay_live_attempts;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if length(btrim(coalesce(_note,'')))<10 then raise exception 'Describe what you verified on eBay' using errcode='22023';end if;
 select * into o from public.ebay_live_observations where event_id=_event_id and source_key=_key for update;
 if not found then raise exception 'Notification not found' using errcode='22023';end if;
 if _attempt_id is not null then
  select * into a from public.ebay_live_attempts where id=_attempt_id and event_id=_event_id for update;
  if not found then raise exception 'Select an auction from this event' using errcode='22023';end if;
  -- Linking uncertain evidence always stops scanning until separately verified.
  update public.ebay_live_attempts set payment_state='review',review_note=_note,updated_at=now() where id=a.id;
 end if;
 update public.ebay_live_observations set attempt_id=_attempt_id,disposition='reviewed' where event_id=_event_id and source_key=_key;
 insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,_attempt_id,'notification_reviewed',jsonb_build_object('key',_key,'note',_note));
end $$;

-- Reconcile against the existing official order import. Only a unique, exact listing,
-- buyer and unit price match in this show's date range may identify an order line.
create function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;ids uuid[];v_state text;started timestamptz;
begin
 select s.started_at into started from public.ebay_live_connections c join public.live_sale_sessions s on s.id=c.session_id where c.event_id=_event_id;
 for a in select * from public.ebay_live_attempts where event_id=_event_id and resolved_at is null for update loop
  if a.order_line_id is null then
   select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=a.listing_id and lower(eo.buyer_username)=lower(a.buyer) and el.quantity=1 and el.sold_for=a.amount
    and eo.sale_date>=started-interval '10 minutes' and eo.sale_date<=coalesce((select ended_at from public.live_sale_sessions s join public.ebay_live_connections c on c.session_id=s.id where c.event_id=_event_id),now())+interval '10 minutes'
    and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
    and not exists(select 1 from public.ebay_live_attempts used where used.order_line_id=el.id);
   if cardinality(ids)<>1 or ids is null then continue;end if;
   update public.ebay_live_attempts set order_line_id=ids[1] where id=a.id;
   a.order_line_id:=ids[1];
  end if;
  select * into l from public.ebay_order_lines where id=a.order_line_id;
  select * into o from public.ebay_orders where id=l.order_id;
  v_state:=null;
  if o.status='cancelled' or l.line_status='cancelled' or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS') then v_state:='cancelled';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}','')) in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') then v_state:='review';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',''))='PAID' then
   v_state:=case when a.payment_state in ('failed','cancelled','review') then 'review' else 'paid' end;
  end if;
  if v_state is not null and v_state<>a.payment_state then
   update public.ebay_live_attempts set payment_state=v_state,payment_source='order_import',paid_at=case when v_state='paid' then coalesce(paid_at,now()) else paid_at end,review_note=case when v_state<>'paid' then 'Order import requires payment/bag review' else review_note end,updated_at=now() where id=a.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'order_reconciled',jsonb_build_object('order_line_id',l.id,'state',v_state));
  end if;
 end loop;
end $$;
create function public.reconcile_ebay_live_orders(_event_id text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.reconcile_ebay_live_orders_internal(_event_id);
end $$;
create function public.ebay_live_order_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare v_order uuid;v_event text;
begin
 if TG_TABLE_NAME='ebay_orders' then v_order:=NEW.id;else v_order:=NEW.order_id;end if;
 for v_event in select distinct a.event_id from public.ebay_live_attempts a join public.ebay_order_lines l on l.item_number=a.listing_id join public.ebay_orders o on o.id=l.order_id where o.id=v_order and lower(o.buyer_username)=lower(a.buyer) loop
  perform public.reconcile_ebay_live_orders_internal(v_event);
 end loop;
 return NEW;
end $$;
create trigger ebay_live_order_payment_changed after insert or update of status,raw_payload on public.ebay_orders for each row execute function public.ebay_live_order_changed();
create trigger ebay_live_order_line_changed after insert or update of line_status,raw_payload,sold_for on public.ebay_order_lines for each row execute function public.ebay_live_order_changed();
revoke all on function public.reconcile_ebay_live_orders_internal(text),public.ebay_live_order_changed() from public,anon,authenticated;
revoke all on function public.resolve_ebay_live_observation(text,text,uuid,text),public.reconcile_ebay_live_orders(text) from public,anon,authenticated;
grant execute on function public.resolve_ebay_live_observation(text,text,uuid,text),public.reconcile_ebay_live_orders(text) to authenticated;

create function public.get_ebay_live_dashboard(_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; rows jsonb; unmatched jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into c from public.ebay_live_connections where session_id=_session_id;
 if not found then return jsonb_build_object('connection',null,'attempts','[]'::jsonb,'unmatched','[]'::jsonb);end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into rows from (
  select a.*,em.display_name seller_name,
   totals.units, totals.minimum_total, totals.cost_total,
   case when a.payment_state='paid' and a.closed_at is not null and a.resolved_at is null then a.amount-totals.minimum_total end above_minimum,
   case when a.payment_state='paid' and a.closed_at is not null and a.resolved_at is null then a.amount-totals.cost_total-(a.amount*c.fee_percent/100)-c.fee_fixed-c.shipping_per_sale end estimated_profit
  from public.ebay_live_attempts a left join public.employees em on em.id=a.seller_id
  left join lateral (
   select coalesce(sum(quantity),0) units,
   case when count(*)>0 and bool_and(live_unit_minimum is not null) and not exists(select 1 from public.live_sale_manual_lot_items m where m.lot_id=a.lot_id and m.status in ('reserved','packed')) then sum(quantity*live_unit_minimum) end minimum_total,
   case when count(*)>0 and bool_and(live_unit_cost is not null) and not exists(select 1 from public.live_sale_manual_lot_items m where m.lot_id=a.lot_id and m.status in ('reserved','packed')) then sum(quantity*live_unit_cost) end cost_total
   from public.live_sale_lot_items li where li.lot_id=a.lot_id and li.status in ('reserved','packed')
  ) totals on true where a.event_id=c.event_id
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into unmatched from (select source_key,kind,listing_title,buyer,amount,time_label,evidence,disposition from public.ebay_live_observations where event_id=c.event_id and disposition in ('unmatched','review') order by received_at desc limit 100) x;
 return jsonb_build_object('connection',to_jsonb(c),'attempts',rows,'unmatched',unmatched,'server_time',now());
end $$;

revoke all on function public.link_ebay_live_event(uuid,text,uuid),public.configure_ebay_live_event(text,uuid,numeric,numeric,numeric),public.ingest_ebay_live_events(text,jsonb,jsonb),public.guard_ebay_live_reservation(),public.claim_ebay_live_bag(uuid),public.close_ebay_live_bag(uuid),public.resolve_ebay_live_attempt(uuid,text,text),public.get_ebay_live_dashboard(uuid) from public,anon,authenticated;
grant execute on function public.link_ebay_live_event(uuid,text,uuid),public.configure_ebay_live_event(text,uuid,numeric,numeric,numeric),public.ingest_ebay_live_events(text,jsonb,jsonb),public.claim_ebay_live_bag(uuid),public.close_ebay_live_bag(uuid),public.resolve_ebay_live_attempt(uuid,text,text),public.get_ebay_live_dashboard(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
