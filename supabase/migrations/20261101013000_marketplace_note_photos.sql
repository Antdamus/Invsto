begin;
set local lock_timeout='5s';

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('marketplace-note-photos','marketplace-note-photos',false,5242880,array['image/jpeg']);
create policy marketplace_note_photo_upload on storage.objects for insert to authenticated
 with check(bucket_id='marketplace-note-photos' and public.can_manage_inventory()
 and name ~ ('^'||auth.uid()::text||'/(tiktok|whatnot)/[a-f0-9-]{36}\.jpg$'));
create policy marketplace_note_photo_read on storage.objects for select to authenticated
 using(bucket_id='marketplace-note-photos' and public.can_manage_inventory());

-- One upload may be signed against several explicitly selected Whatnot lines.
-- Reserve the entire selection atomically so a lost response can be retried.
create table public.marketplace_note_photo_receipts(photo_path text primary key, request_hash bytea not null);
alter table public.marketplace_note_photo_receipts enable row level security;
revoke all on public.marketplace_note_photo_receipts from public,anon,authenticated;

create function public.add_marketplace_order_photo_note(_market text,_targets jsonb,_note text,_photo_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
 staff uuid:=auth.uid(); body text:=coalesce(nullif(btrim(_note),''),'Photo note');
 path text; fingerprint bytea; target jsonb; event_id uuid; metadata jsonb; line public.whatnot_order_lines;
begin
 if staff is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _market is null or _market not in ('tiktok','whatnot') or _photo_id is null or length(body)>4000
  or jsonb_typeof(_targets) is distinct from 'array' then raise exception 'Invalid photo note';end if;
 if jsonb_array_length(_targets) not between 1 and 250 or
  (jsonb_array_length(_targets)>1 and (_market<>'whatnot' or exists(select 1 from jsonb_array_elements(_targets) t where t->>'revision' is null)))
  or exists(select 1 from jsonb_array_elements(_targets) t group by t->>'order_id',t->>'line_id' having count(*)>1)
  then raise exception 'Choose the exact order or items for this note';end if;
 path:=staff::text||'/'||_market||'/'||_photo_id::text||'.jpg';
 if not exists(select 1 from storage.objects o where o.bucket_id='marketplace-note-photos' and o.name=path
  and o.metadata->>'mimetype'='image/jpeg' and (o.metadata->>'size')::bigint between 1 and 5242880)
  then raise exception 'Upload the note photo first';end if;
 fingerprint:=sha256(convert_to(jsonb_build_array(_targets,body)::text,'UTF8'));
 insert into public.marketplace_note_photo_receipts values(path,fingerprint) on conflict do nothing;
 if not found then
  if exists(select 1 from public.marketplace_note_photo_receipts where photo_path=path and request_hash=fingerprint) then return;end if;
  raise exception 'This photo was already saved with a different note. Reopen note history to check it.';
 end if;
 for target in select value from jsonb_array_elements(_targets) order by value->>'order_id',value->>'line_id' loop
  metadata:=jsonb_build_object('note_photo_path',path);
  if target ? 'revision' then
   if _market<>'whatnot' then raise exception 'Invalid selection';end if;
   update public.whatnot_order_lines set revision=revision+1 where id=target->>'line_id' and order_id=target->>'order_id'
    and revision=(target->>'revision')::int returning * into line;
   if not found then raise exception 'Items changed. Reload and review your selection.';end if;
   metadata:=metadata||jsonb_build_object('quantity',line.quantity,'tracking_number',line.tracking_number,'marketplace_changed',false);
  end if;
  event_id:=public.add_marketplace_order_note(_market,target->>'order_id',target->>'line_id',body,gen_random_uuid());
  if _market='tiktok' then update public.tiktok_order_events set details=details||metadata where id=event_id;
  else update public.whatnot_order_events set details=details||metadata where id=event_id;end if;
 end loop;
end$$;
revoke all on function public.add_marketplace_order_photo_note(text,jsonb,text,uuid) from public,anon;
grant execute on function public.add_marketplace_order_photo_note(text,jsonb,text,uuid) to authenticated;

create or replace view public.marketplace_order_notes with (security_invoker=true) as
 select 'whatnot'::text as market,e.order_id,e.line_id,l.title as item_title,e.id,e.details->>'note' as body,
  e.actor_name as signer,e.created_at,e.details->>'note_photo_path' as photo_path
 from public.whatnot_order_events e left join public.whatnot_order_lines l on l.id=e.line_id and l.order_id=e.order_id
 where e.action='note' and nullif(btrim(e.details->>'note'),'') is not null
 union all
 select 'tiktok',e.order_id::text,e.details->>'line_id',l.title,e.id,e.details->>'note',e.details->>'actor_name',e.created_at,e.details->>'note_photo_path'
 from public.tiktok_order_events e left join public.tiktok_order_lines l on l.order_id=e.order_id and l.id::text=e.details->>'line_id'
 where e.action='note' and nullif(btrim(e.details->>'note'),'') is not null;
notify pgrst,'reload schema';
commit;
