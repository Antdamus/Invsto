begin;
set local lock_timeout='1s';
set local statement_timeout='15s';
-- Ending a broadcast opens reconciliation; it does not close the inventory session.
create function public.mark_ebay_live_broadcast_ended(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Event not found' using errcode='22023';end if;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This session is already closed' using errcode='22023';end if;
 if c.broadcast_ended_at is null then
  update public.ebay_live_connections set broadcast_ended_at=clock_timestamp(),broadcast_end_source='staff_confirmed',capture_ready=false where event_id=_event_id;
  insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'broadcast_ended','{"source":"staff_confirmed"}');
 end if;
end $$;
revoke all on function public.mark_ebay_live_broadcast_ended(text) from public,anon,authenticated;
grant execute on function public.mark_ebay_live_broadcast_ended(text) to authenticated;

-- Post-show paid bags remain editable without an advancing stream clock.
-- Unidentified payment problems still block scanning; known failures never qualify.
create function public.ebay_live_scan_evidence_ok(c public.ebay_live_connections,a public.ebay_live_attempts) returns boolean
language sql stable security definer set search_path='' as $$
 select (coalesce(c.capture_ready and c.source_seen_at>now()-interval '30 seconds',false)
  or coalesce(a.verified_at>now()-interval '2 minutes',false)
  or (c.broadcast_ended_at is not null and not exists(select 1 from public.ebay_live_observations
    where event_id=c.event_id and disposition in ('unmatched','review') and kind in ('failed','cancelled','unknown'))))
$$;
revoke all on function public.ebay_live_scan_evidence_ok(public.ebay_live_connections,public.ebay_live_attempts) from public,anon,authenticated;

create function public.ebay_live_post_show_check(_event_id text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'open_paid_bags',(select count(*) from public.ebay_live_attempts a where a.event_id=c.event_id and a.merged_into is null and a.resolved_at is null and a.payment_state='paid' and
    (a.closed_at is null or a.lot_id is null or not exists(select 1 from public.live_sale_lot_items where lot_id=a.lot_id and status in ('reserved','packed')) and not exists(select 1 from public.live_sale_manual_lot_items where lot_id=a.lot_id and status in ('reserved','packed')))),
  'payment_issues',(select count(*) from public.ebay_live_attempts where event_id=c.event_id and merged_into is null and resolved_at is null and payment_state<>'paid'),
  'unmatched_notifications',(select count(*) from public.ebay_live_observations where event_id=c.event_id and disposition in ('unmatched','review')),
  'unlinked_bags',(select count(*) from public.live_sale_lots l where l.session_id=c.session_id and l.status in ('open','reserved') and not exists(select 1 from public.ebay_live_attempts where lot_id=l.id)),
  'paid_bags',(select count(*) from public.ebay_live_attempts where event_id=c.event_id and merged_into is null and resolved_at is null and payment_state='paid'),
  'closed_bags',(select count(*) from public.ebay_live_attempts where event_id=c.event_id and merged_into is null and resolved_at is null and payment_state='paid' and closed_at is not null))
 from public.ebay_live_connections c where event_id=_event_id
$$;
revoke all on function public.ebay_live_post_show_check(text) from public,anon,authenticated;

create function public.reopen_ebay_live_bag(_attempt_id uuid) returns public.live_sale_lots
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;c public.ebay_live_connections;l public.live_sale_lots;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null then raise exception 'Only a paid bag can be reopened' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This session is already closed' using errcode='22023';end if;
 if not public.ebay_live_scan_evidence_ok(c,a) then raise exception 'Verify payment before reopening this bag' using errcode='22023';end if;
 if a.closed_at is null then return public.claim_ebay_live_bag(a.id);end if;
 select * into l from public.live_sale_lots where id=a.lot_id for update;
 if l.status not in ('open','reserved') or l.matched_order_line_id is not null then raise exception 'This bag is already in packing. Review it in Pending Orders' using errcode='22023';end if;
 update public.ebay_live_attempts set closed_at=null,claimed_by=auth.uid(),claimed_at=now(),updated_at=now() where id=a.id;
 update public.live_sale_lots set closed_at=null where id=l.id returning * into l;
 insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(a.event_id,a.id,'bag_reopened_for_review',jsonb_build_object('previous_scanner',a.claimed_by));
 return l;
end $$;
revoke all on function public.reopen_ebay_live_bag(uuid) from public,anon,authenticated;
grant execute on function public.reopen_ebay_live_bag(uuid) to authenticated;

create function public.complete_ebay_live_session(_session_id uuid,_bags_checked boolean,_payments_checked boolean) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;checks jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _bags_checked is distinct from true or _payments_checked is distinct from true then raise exception 'Confirm the physical bags and the final eBay payment review' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where session_id=_session_id for update;
 if not found or c.broadcast_ended_at is null then raise exception 'Mark the broadcast ended before closing the session' using errcode='22023';end if;
 if c.review_completed_at is not null then return;end if;
 if not exists(select 1 from public.live_sale_sessions where id=_session_id and status='active') then raise exception 'This session is already closed' using errcode='22023';end if;
 -- Serialize with capture ingestion and item edits, then recheck the latest payment state.
 perform 1 from public.ebay_live_attempts where event_id=c.event_id order by id for update;
 perform public.reconcile_ebay_live_orders_internal(c.event_id);
 perform 1 from public.live_sale_lots where session_id=_session_id order by id for update;
 checks:=public.ebay_live_post_show_check(c.event_id);
 if (checks->>'open_paid_bags')::int>0 or (checks->>'payment_issues')::int>0 or (checks->>'unmatched_notifications')::int>0 or (checks->>'unlinked_bags')::int>0 then
  raise exception 'Finish all paid bags and resolve outstanding payments, notifications and unlinked bags before closing' using errcode='22023';
 end if;
 if coalesce((c.health->>'pending')::int,0)>0 then raise exception 'The capture helper still has pending notifications. Let them sync before closing' using errcode='22023';end if;
 update public.ebay_live_connections set review_completed_at=now(),review_completed_by=auth.uid() where event_id=c.event_id;
 perform public.end_live_sale_session(_session_id,null,(select email from auth.users where id=auth.uid()));
 insert into public.ebay_live_audit(event_id,action,details) values(c.event_id,'post_show_completed',checks||jsonb_build_object('bags_checked',true,'payments_checked',true));
end $$;
revoke all on function public.complete_ebay_live_session(uuid,boolean,boolean) from public,anon,authenticated;
grant execute on function public.complete_ebay_live_session(uuid,boolean,boolean) to authenticated;

create function public.guard_ebay_live_session_completion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if OLD.status='active' and NEW.status='ended' and exists(select 1 from public.ebay_live_connections where session_id=NEW.id and (broadcast_ended_at is null or review_completed_at is null)) then
  raise exception 'Use the post-show checklist to close this eBay session' using errcode='22023';
 end if;
 return NEW;
end $$;
revoke all on function public.guard_ebay_live_session_completion() from public,anon,authenticated;
create trigger ebay_live_session_completion before update of status on public.live_sale_sessions for each row execute function public.guard_ebay_live_session_completion();


create or replace function public.claim_ebay_live_bag(_attempt_id uuid) returns public.live_sale_lots language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; l public.live_sale_lots; mail text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null or a.closed_at is not null then raise exception 'Only a paid, open auction can be scanned' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not(public.ebay_live_scan_evidence_ok(c,a)) then raise exception 'Capture is disconnected. Verify payment on eBay first' using errcode='22023';end if;
 if a.claimed_by is not null and a.claimed_by<>auth.uid() then raise exception 'Another scanner already has this bag. Ask an admin to release the claim' using errcode='42501';end if;
 select email into mail from auth.users where id=auth.uid();
 if a.lot_id is null then
  l:=public.create_live_sale_lot(c.session_id,'EB-'||coalesce(substring(a.listing_title from '^#([A-Za-z0-9_-]+)'),a.listing_id)||'-'||substr(replace(a.id::text,'-',''),1,8),'eBay '||a.listing_title||' | Winner '||a.buyer,mail,a.seller_id);
 else select * into l from public.live_sale_lots where id=a.lot_id;end if;
 if l.status not in ('open','reserved') then raise exception 'This bag is no longer available for scanning' using errcode='22023';end if;
 update public.ebay_live_attempts set claimed_by=auth.uid(),claimed_at=coalesce(claimed_at,now()),lot_id=l.id,updated_at=now() where id=a.id;
 insert into public.ebay_live_audit(event_id,attempt_id,action) values(a.event_id,a.id,'bag_claimed');
 return l;
end $$;

create or replace function public.close_ebay_live_bag(_attempt_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into a from public.ebay_live_attempts where id=_attempt_id for update;
 if not found or a.payment_state<>'paid' or a.resolved_at is not null then raise exception 'Payment is not confirmed for this bag' using errcode='22023';end if;
 if a.claimed_by is distinct from auth.uid() then raise exception 'Only the assigned scanner can close this bag' using errcode='42501';end if;
 if a.closed_at is not null then return;end if;
 select * into c from public.ebay_live_connections where event_id=a.event_id;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 if not(public.ebay_live_scan_evidence_ok(c,a)) then raise exception 'Capture is disconnected. Verify payment before closing' using errcode='22023';end if;
 if not exists(select 1 from public.live_sale_lot_items where lot_id=a.lot_id and status='reserved') and not exists(select 1 from public.live_sale_manual_lot_items where lot_id=a.lot_id and status='reserved') then raise exception 'Scan the sold item before closing the bag' using errcode='22023';end if;
 update public.ebay_live_attempts set closed_at=now(),updated_at=now() where id=a.id;
 update public.live_sale_lots set closed_at=now() where id=a.lot_id;
 insert into public.ebay_live_audit(event_id,attempt_id,action) values(a.event_id,a.id,'bag_closed');
end $$;

create or replace function public.save_live_sale_manual_item(_lot_id uuid,_item_id uuid,_category text,_description text,_quantity integer,_unit_minimum numeric default null,_photo_path text default null,_expected_revision integer default null) returns public.live_sale_manual_lot_items
language plpgsql security definer set search_path='' as $$
declare l public.live_sale_lots; a public.ebay_live_attempts; c public.ebay_live_connections; prior public.live_sale_manual_lot_items; saved public.live_sale_manual_lot_items; mail text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _item_id is null or nullif(btrim(_category),'') is null or length(_category)>100 or length(coalesce(_description,''))>1000 or _quantity is null or _quantity<0 or _quantity>9999 or (_unit_minimum is not null and (_unit_minimum<0 or _unit_minimum>9999999999.99 or _unit_minimum='NaN'::numeric or round(_unit_minimum,2)<>_unit_minimum)) then raise exception 'Enter a valid item, quantity and break-even price' using errcode='22023';end if;
 _photo_path:=nullif(btrim(_photo_path),'');
 if _photo_path is not null and _photo_path !~ ('^live-manual/'||_lot_id::text||'/'||_item_id::text||'/[a-f0-9-]+[.]jpg$') then raise exception 'Invalid manual item photo' using errcode='22023';end if;
 select * into l from public.live_sale_lots where id=_lot_id;
 if not found then raise exception 'Bag not found' using errcode='22023';end if;
 select * into a from public.ebay_live_attempts where lot_id=_lot_id for update;
 select * into c from public.ebay_live_connections where session_id=l.session_id;
 if c.event_id is not null then
  if a.id is null or a.payment_state<>'paid' or a.closed_at is not null or a.resolved_at is not null then raise exception 'Select a paid, open eBay auction before editing' using errcode='22023';end if;
  if a.claimed_by is distinct from auth.uid() then raise exception 'This bag is assigned to another scanner' using errcode='42501';end if;
  if not(public.ebay_live_scan_evidence_ok(c,a)) then raise exception 'Capture is disconnected. Recheck payment before editing' using errcode='22023';end if;
 end if;
 select * into l from public.live_sale_lots where id=_lot_id for update;
 if l.status not in ('open','reserved') or l.closed_at is not null then raise exception 'This bag is already closed' using errcode='22023';end if;
 if not exists(select 1 from public.live_sale_sessions where id=l.session_id and status='active') then raise exception 'This show has ended' using errcode='22023';end if;
 select email into mail from auth.users where id=auth.uid();
 select * into prior from public.live_sale_manual_lot_items where id=_item_id for update;
 if found then
  if prior.lot_id<>_lot_id or prior.status<>'reserved' then raise exception 'This manual item is no longer editable' using errcode='22023';end if;
  if _expected_revision is null and prior.created_by=auth.uid() and prior.item_category=btrim(_category) and coalesce(prior.item_description,'')=btrim(coalesce(_description,'')) and prior.quantity=_quantity and prior.live_unit_minimum is not distinct from _unit_minimum and prior.photo_path is not distinct from _photo_path then return prior;end if;
  if _expected_revision is distinct from prior.edit_revision then raise exception 'This item changed. Reopen Edit to load the latest details' using errcode='40001';end if;
  update public.live_sale_manual_lot_items set item_category=btrim(_category),item_description=nullif(btrim(_description),''),quantity=greatest(_quantity,1),status=case when _quantity=0 then 'released' else 'reserved' end,live_unit_minimum=_unit_minimum,photo_path=_photo_path where id=_item_id returning * into saved;
 else
  if _expected_revision is not null or _quantity=0 then raise exception 'Manual item not found' using errcode='22023';end if;
  insert into public.live_sale_manual_lot_items(id,lot_id,session_id,item_category,item_description,quantity,live_unit_minimum,photo_path,created_by,created_by_email,show_elapsed_seconds)
   values(_item_id,l.id,l.session_id,btrim(_category),nullif(btrim(_description),''),_quantity,_unit_minimum,_photo_path,auth.uid(),mail,(select greatest(extract(epoch from(now()-started_at))::integer,0) from public.live_sale_sessions where id=l.session_id)) returning * into saved;
 end if;
 update public.live_sale_lots set status='reserved' where id=l.id and status='open';
 insert into public.live_sale_events(session_id,lot_id,event_type,actor_email,payload)
 values(l.session_id,l.id,case when prior.id is null then 'manual_item_added' else 'manual_item_edited' end,mail,jsonb_build_object('manual_lot_item_id',saved.id,'before',case when prior.id is null then null else to_jsonb(prior) end,'after',to_jsonb(saved)));
 return saved;
end $$;

create or replace function public.guard_ebay_live_reservation() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts; c public.ebay_live_connections; increasing boolean;
begin
 if TG_OP='INSERT' then increasing:=NEW.status='reserved';
 else increasing:=NEW.status='reserved' and (OLD.status<>'reserved' or NEW.quantity>OLD.quantity or NEW.lot_id<>OLD.lot_id or NEW.session_id<>OLD.session_id or to_jsonb(NEW)->>'source_stock_location_row_id' is distinct from to_jsonb(OLD)->>'source_stock_location_row_id' or to_jsonb(NEW)->>'item_id' is distinct from to_jsonb(OLD)->>'item_id');end if;
 if TG_TABLE_NAME='live_sale_manual_lot_items' and TG_OP='UPDATE' and NEW.status='reserved' then increasing:=increasing or (to_jsonb(NEW)-array['quantity','edit_revision','notes']) is distinct from (to_jsonb(OLD)-array['quantity','edit_revision','notes']);end if;
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
 if not(public.ebay_live_scan_evidence_ok(c,a)) then raise exception 'Capture is disconnected. Recheck payment on eBay before scanning' using errcode='22023';end if;
 if TG_TABLE_NAME='live_sale_lot_items' then
  if TG_OP='INSERT' or NEW.item_id<>OLD.item_id then
   select case when cost>=0 and cost<>'NaN'::numeric then cost end,minimum_sale_price into NEW.live_unit_cost,NEW.live_unit_minimum from public.item_types where id=NEW.item_id;
  else NEW.live_unit_cost:=OLD.live_unit_cost;NEW.live_unit_minimum:=OLD.live_unit_minimum;end if;
 end if;
 return NEW;
end $$;

create or replace function public.ingest_ebay_live_events(_event_id text,_events jsonb,_health jsonb default '{}') returns jsonb
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
 if _health->>'broadcast_ended'='true' and c.broadcast_ended_at is null then
  update public.ebay_live_connections set broadcast_ended_at=clock_timestamp(),broadcast_end_source='ebay_event_ended',capture_ready=false where event_id=_event_id;
  insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'broadcast_ended','{"source":"ebay_event_ended"}');
 end if;
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
    select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=(e->>'amount')::numeric and x.win_key is null and x.resolved_at is null and x.merged_into is null and (x.payment_state in ('waiting','paid') or exists(select 1 from public.ebay_live_observations prior where prior.attempt_id=x.id and prior.kind in ('failed','cancelled') and prior.time_label=e->>'time_label'));
    if cardinality(candidates)=1 then
     update public.ebay_live_attempts set win_key=key,win_time_label=e->>'time_label',stream_offset_seconds=case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int else stream_offset_seconds end,updated_at=now() where id=candidates[1] returning * into a;
    else
     insert into public.ebay_live_attempts(event_id,listing_id,listing_title,ordinal,buyer,amount,win_key,win_time_label,stream_offset_seconds,seller_id)
     values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,key,e->>'time_label',case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int end,public.ebay_live_seller_at(_event_id,o.observed_at)) returning * into a;
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
    values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,public.ebay_live_seller_at(_event_id,o.observed_at)) returning * into a;
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
 if exists(select 1 from public.ebay_live_observations unresolved where unresolved.event_id=_event_id and unresolved.disposition in ('unmatched','review') and unresolved.kind in ('failed','cancelled','unknown')) then
  update public.ebay_live_connections set capture_ready=false,health=health||jsonb_build_object('message','Unmatched notifications need review') where event_id=_event_id;
 end if;
 return jsonb_build_object('accepted',count_accepted);
end $$;

create or replace function public.get_ebay_live_dashboard(_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
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
    case when count(*)>0 and bool_and(unit_minimum is not null) then sum(quantity*unit_minimum) end minimum_total,
    case when count(*)>0 and bool_and(unit_cost is not null) then sum(quantity*unit_cost) end cost_total
   from (
    select quantity,live_unit_minimum unit_minimum,live_unit_cost unit_cost from public.live_sale_lot_items where lot_id=a.lot_id and status in ('reserved','packed')
    union all
    select quantity,live_unit_minimum,null::numeric from public.live_sale_manual_lot_items where lot_id=a.lot_id and status in ('reserved','packed')
   ) entries
  ) totals on true where a.event_id=c.event_id and a.merged_into is null
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into unmatched from (select source_key,kind,listing_title,buyer,amount,time_label,evidence,disposition,(kind in ('failed','cancelled','unknown')) blocking from public.ebay_live_observations where event_id=c.event_id and disposition in ('unmatched','review') order by received_at desc limit 100) x;
 return jsonb_build_object('connection',to_jsonb(c)||jsonb_build_object('active_seller_name',(select display_name from public.employees where id=c.active_seller_id)),'attempts',rows,'unmatched',unmatched,'post_show',public.ebay_live_post_show_check(c.event_id),'server_time',now());
end $$;

notify pgrst,'reload schema';
commit;
