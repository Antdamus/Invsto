begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create index ebay_order_task_events_bag_photo_idx on public.ebay_order_task_events ((payload->>'bag_lot_id'))
 where payload ? 'bag_lot_id';

-- Return photos only after resolving the scanned bag against the chosen pending
-- line. Reused auction numbers never silently choose a bag from another show.
create function public.get_pending_bag_photo_review(_scan text,_order_line_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare code text:=upper(btrim(_scan)); ref text; lookup jsonb; bags jsonb; bag jsonb; photos jsonb;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 lookup:=public.find_pending_order_bag(code);
 if not exists(select 1 from jsonb_array_elements(lookup->'matches') m where m#>>'{line,id}'=_order_line_id::text) then
  raise exception 'This scan no longer matches that pending item. Scan the bag again.' using errcode='22023';end if;
 ref:=regexp_replace(regexp_replace(code,'^#',''),'^0+([0-9])','\1');
 select coalesce(jsonb_agg(to_jsonb(b)),'[]') into bags from (
  select distinct b.id,b.lot_code,b.auction_number
  from public.live_sale_lots b
  left join public.live_bag_order_links k on k.lot_id=b.id
  left join public.ebay_live_attempts a on a.lot_id=b.id
  join public.ebay_order_lines l on l.id=_order_line_id join public.ebay_orders o on o.id=l.order_id
  where b.status not in ('cancelled','released')
   and exists(select 1 from public.live_sale_bag_photos p where p.lot_id=b.id)
   and (b.lot_code=code or (code not like 'LIVE-%' and (
    regexp_replace(regexp_replace(upper(btrim(b.auction_number)),'^#',''),'^0+([0-9])','\1')=ref
    or regexp_replace(upper(substring(a.listing_title from '#\s*([[:alnum:]][[:alnum:]-]*)')),'^0+([0-9])','\1')=ref)))
   and (case when coalesce(b.matched_order_line_id,k.order_line_id,a.order_line_id) is not null
    then coalesce(b.matched_order_line_id,k.order_line_id,a.order_line_id)=l.id
    else b.lot_code=code or (lower(btrim(a.buyer))=lower(btrim(o.buyer_username)) and (
     nullif(a.listing_id,'')=l.item_number or (nullif(lower(btrim(a.listing_title)),'')=lower(btrim(l.item_title)) and abs(a.amount-l.sold_for)<0.01))) end)
  order by b.id limit 2
 ) b;
 if jsonb_array_length(bags)<>1 then return jsonb_build_object('bag',null,'photos','[]'::jsonb,'ambiguous',jsonb_array_length(bags)>1);end if;
 bag:=bags->0;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'photo_path',p.photo_path,'captured_at',p.captured_at,
  'attached',exists(select 1 from public.ebay_order_task_events e where e.payload ? 'bag_lot_id' and e.payload->>'bag_lot_id'=bag->>'id'
    and e.payload->>'order_line_id'=_order_line_id::text and exists(select 1 from jsonb_array_elements(e.photo_attachments) x where x->>'bucket'='photos' and x->>'path'=p.photo_path)),
  'attached_elsewhere',exists(select 1 from public.ebay_order_task_events e where e.payload ? 'bag_lot_id' and e.payload->>'bag_lot_id'=bag->>'id'
    and e.payload->>'order_line_id' is distinct from _order_line_id::text and exists(select 1 from jsonb_array_elements(e.photo_attachments) x where x->>'bucket'='photos' and x->>'path'=p.photo_path))
 ) order by p.created_at,p.id),'[]') into photos from public.live_sale_bag_photos p where p.lot_id=(bag->>'id')::uuid;
 return jsonb_build_object('bag',bag,'photos',photos,'ambiguous',false);
end $$;
revoke all on function public.get_pending_bag_photo_review(text,uuid) from public,anon,authenticated;
grant execute on function public.get_pending_bag_photo_review(text,uuid) to authenticated;

-- Save only the photos actually reviewed. The line/bag locks make retries and
-- two simultaneous scanners idempotent. Existing evidence is never replaced.
create function public.confirm_pending_bag_photos(_scan text,_lot_id uuid,_order_line_id uuid,_photo_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare line public.ebay_order_lines; review jsonb; photos jsonb; ids uuid[]; actor text;
 evt public.ebay_order_task_events; task jsonb; found_item public.pending_order_item_search;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 if coalesce(cardinality(_photo_ids),0) not between 1 and 100 then raise exception 'Review between 1 and 100 bag photos first' using errcode='22023';end if;
 select * into line from public.ebay_order_lines where id=_order_line_id for update;
 if not found or line.line_status not in ('pending','partially_fulfilled') or line.fulfilled_quantity>=line.quantity then
  raise exception 'This item is no longer pending. Refresh before confirming.' using errcode='22023';end if;
 perform 1 from public.live_sale_lots where id=_lot_id for update;
 if not found then raise exception 'Bag not found' using errcode='22023';end if;
 review:=public.get_pending_bag_photo_review(_scan,_order_line_id);
 if review#>>'{bag,id}' is distinct from _lot_id::text then raise exception 'The bag match changed. Scan its unique LIVE code again.' using errcode='40001';end if;
 if exists(select 1 from unnest(_photo_ids) id where id is null or not exists(select 1 from jsonb_array_elements(review->'photos') p where p->>'id'=id::text)) then
  raise exception 'A reviewed photo does not belong to this bag' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(review->'photos') p where (p->>'id')::uuid=any(_photo_ids) and (p->>'attached_elsewhere')::boolean) then
  raise exception 'A bag photo is attached to another order. Review that connection first.' using errcode='22023';end if;
 select array_agg(distinct (p->>'id')::uuid) into ids from jsonb_array_elements(review->'photos') p
  where (p->>'id')::uuid=any(_photo_ids) and not (p->>'attached')::boolean;
 select coalesce(email,'Staff') into actor from auth.users where id=auth.uid();
 if coalesce(cardinality(ids),0)>0 then
  select jsonb_agg(jsonb_build_object('bucket','photos','path',p.photo_path,'label','Live photo · Bag '||(review#>>'{bag,auction_number}'),
   'mime_type','image/jpeg','media_type','photo','created_at',p.captured_at,'signed_by_email',coalesce(u.email,'Staff'),
   'order_line_ids',jsonb_build_array(line.id),'attachment_scope','line',
   'metadata',jsonb_build_object('source','live_bag_video_receipt','bagLotId',p.lot_id,'bagPhotoId',p.id,'capturedAt',p.captured_at,
    'itemNumber',line.item_number,'confirmedBy',auth.uid(),'confirmedAt',now())) order by p.created_at,p.id) into photos
   from public.live_sale_bag_photos p left join auth.users u on u.id=p.created_by where p.id=any(ids);
  select * into evt from public.add_pending_order_line_note(line.id,
   'Bag '||(review#>>'{bag,lot_code}')||' verified against this item. Attached '||cardinality(ids)||' live photo(s).',photos,actor);
  update public.ebay_order_task_events set payload=payload||jsonb_build_object('bag_lot_id',_lot_id,'bag_photo_ids',to_jsonb(ids),'scan',upper(btrim(_scan)))
   where id=evt.id returning * into evt;
  select to_jsonb(t) into task from public.ebay_order_tasks t where id=evt.task_id;
 end if;
 select * into found_item from public.set_pending_order_item_missing(line.id,false);
 -- Confirmation is evidence + item found only; it never packs or closes an order.
 return jsonb_build_object('attached_count',coalesce(cardinality(ids),0),'event',case when evt.id is null then null else to_jsonb(evt) end,
  'task',task,'item_search',to_jsonb(found_item));
end $$;
revoke all on function public.confirm_pending_bag_photos(text,uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.confirm_pending_bag_photos(text,uuid,uuid,uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
