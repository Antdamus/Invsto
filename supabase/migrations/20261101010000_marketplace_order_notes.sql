begin;
set local lock_timeout='5s';

-- Notes use the same append-only activity records as the packing workspace.
create function public.add_marketplace_order_note(_market text,_order_id text,_line_id text,_note text,_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 staff uuid:=auth.uid(); signer text; body text:=nullif(btrim(_note),''); saved uuid;
begin
 if staff is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Inventory staff access required' using errcode='42501';
 end if;
 if body is null or length(body)>4000 or _request_id is null then raise exception 'Enter a note of 1 to 4,000 characters';end if;
 select coalesce(nullif(btrim(e.display_name),''),nullif(btrim(e.email),'')) into signer
 from public.employees e where e.user_id=staff limit 1;
 signer:=coalesce(signer,nullif(auth.email(),''),staff::text);
 if _market='tiktok' then
  _line_id:=(_line_id::uuid)::text;
  if not exists(select 1 from public.tiktok_orders where id=_order_id::uuid)
   or (_line_id is not null and not exists(select 1 from public.tiktok_order_lines where id=_line_id::uuid and order_id=_order_id::uuid))
   then raise exception 'This order or item could not be found';end if;
  insert into public.tiktok_order_events(id,order_id,actor,action,details)
   values(_request_id,_order_id::uuid,staff,'note',jsonb_build_object('note',body,'line_id',_line_id,'actor_name',signer))
   on conflict(id) do nothing returning id into saved;
  if saved is null then
   select id into saved from public.tiktok_order_events where id=_request_id and order_id=_order_id::uuid and actor=staff and action='note'
    and (details->>'line_id') is not distinct from _line_id and details->>'note'=body;
  end if;
 elsif _market='whatnot' then
  if not exists(select 1 from public.whatnot_orders where id=_order_id)
   or (_line_id is not null and not exists(select 1 from public.whatnot_order_lines where id=_line_id and order_id=_order_id))
   then raise exception 'This order or item could not be found';end if;
  insert into public.whatnot_order_events(id,order_id,line_id,actor,actor_name,action,details)
   values(_request_id,_order_id,_line_id,staff,signer,'note',jsonb_build_object('note',body))
   on conflict(id) do nothing returning id into saved;
  if saved is null then
   select id into saved from public.whatnot_order_events where id=_request_id and order_id=_order_id and actor=staff and action='note'
    and line_id is not distinct from _line_id and details->>'note'=body;
  end if;
 else raise exception 'Unknown marketplace';end if;
 if saved is null then raise exception 'That note request was already used';end if;
 return saved;
end$$;
revoke all on function public.add_marketplace_order_note(text,text,text,text,uuid) from public,anon;
grant execute on function public.add_marketplace_order_note(text,text,text,text,uuid) to authenticated;

create index tiktok_notes_by_order on public.tiktok_order_events ((order_id::text),created_at desc,id desc) where action='note';
create index whatnot_notes_by_order on public.whatnot_order_events (order_id,line_id,created_at desc,id desc) where action='note';
create view public.marketplace_order_notes with (security_invoker=true) as
 select 'whatnot'::text as market,e.order_id,e.line_id,l.title as item_title,e.id,e.details->>'note' as body,
  e.actor_name as signer,e.created_at
 from public.whatnot_order_events e left join public.whatnot_order_lines l on l.id=e.line_id and l.order_id=e.order_id
 where e.action='note' and nullif(btrim(e.details->>'note'),'') is not null
 union all
 select 'tiktok',e.order_id::text,e.details->>'line_id',l.title,e.id,e.details->>'note',e.details->>'actor_name',e.created_at
 from public.tiktok_order_events e left join public.tiktok_order_lines l on l.order_id=e.order_id and l.id::text=e.details->>'line_id'
 where e.action='note' and nullif(btrim(e.details->>'note'),'') is not null;

create view public.marketplace_order_note_summaries with (security_invoker=true) as
 select distinct on (market,order_id,line_id) market,order_id,line_id,signer,created_at,left(body,140) as preview,
  count(*) over(partition by market,order_id,line_id) as note_count
 from public.marketplace_order_notes order by market,order_id,line_id,created_at desc,id desc;
revoke all on public.marketplace_order_notes,public.marketplace_order_note_summaries from public,anon,authenticated;
grant select on public.marketplace_order_notes,public.marketplace_order_note_summaries to authenticated;
notify pgrst,'reload schema';
commit;
