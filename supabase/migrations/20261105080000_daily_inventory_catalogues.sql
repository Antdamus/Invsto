-- Dated representative catalogues are separate from customer shopping lists.
-- Preparing a draft never changes the previously published selection.
create table public.inventory_daily_catalogues (
 id uuid primary key default gen_random_uuid(),
 source_date date not null,
 recipient text not null check(length(recipient) between 1 and 80),
 share_token uuid not null unique default gen_random_uuid(),
 draft jsonb not null,
 published jsonb,
 revision bigint not null default 1,
 created_by uuid references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 published_at timestamptz,
 unique(source_date,recipient)
);
alter table public.inventory_daily_catalogues enable row level security;
revoke all on public.inventory_daily_catalogues from anon,authenticated;
grant select on public.inventory_daily_catalogues to authenticated;
grant all on public.inventory_daily_catalogues to service_role;
create policy daily_catalogues_staff_read on public.inventory_daily_catalogues
 for select to authenticated using(public.can_manage_inventory());

create function public.prepare_inventory_daily_catalogue(_date date,_recipient text default 'Manny')
returns public.inventory_daily_catalogues language plpgsql security definer set search_path=public,pg_temp as $$
declare v_items jsonb; v_draft jsonb; v_record public.inventory_daily_catalogues;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required'; end if;
 if _date is null or _date < date '2000-01-01' or _date > (now() at time zone 'America/New_York')::date then
  raise exception 'Choose an inventory date up to today (Eastern time)';
 end if;
 _recipient := btrim(_recipient);
 if _recipient is null or length(_recipient) not between 1 and 80 then raise exception 'Enter a recipient name'; end if;
 -- UTC bounds are independently converted from Eastern midnights for DST.
 -- No pagination limit: every item type created that day is included once.
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',i.id,'name',i.title,'description',coalesce(i.description,''),
  'retail_price',case when i.pricing_status is distinct from 'pending' and i.sale_price>0 then i.sale_price else null end,
  'reference',coalesce(i.barcode,''),'category',public.catalogue_piece_type(i.title,i.categories),
  'material',coalesce(i.metal,''),'purity_basis_points',i.purity_basis_points,
  'weight',to_jsonb(i)->>'weight','photos',p.photos
 ) order by public.catalogue_piece_type(i.title,i.categories),i.title,i.id),'[]'::jsonb)
 into v_items
 from public.item_types i
 cross join lateral (
  select coalesce(jsonb_agg(photo order by first_position),'[]'::jsonb) photos from (
   select photo,min(position) first_position from unnest(coalesce(i.photos,'{}'::text[])||array[i.photo_url]) with ordinality a(photo,position)
   where nullif(btrim(photo),'') is not null group by photo
  ) unique_photos
 ) p
 where i.deleted_at is null
 and i.created_at >= (_date::timestamp at time zone 'America/New_York')
 and i.created_at < ((_date+1)::timestamp at time zone 'America/New_York');
 v_draft := jsonb_build_object('title','New inventory selection','recipient',_recipient,'company','eBay',
  'source_date',_date,'prepared_at',now(),'currency','USD','items',v_items);
 insert into public.inventory_daily_catalogues(source_date,recipient,draft,created_by,updated_by)
 values(_date,_recipient,v_draft,auth.uid(),auth.uid())
 on conflict(source_date,recipient) do update set draft=excluded.draft,revision=inventory_daily_catalogues.revision+1,
  updated_at=now(),updated_by=auth.uid()
 returning * into v_record;
 return v_record;
end $$;

create function public.publish_inventory_daily_catalogue(_id uuid,_revision bigint,_publish boolean default true)
returns public.inventory_daily_catalogues language plpgsql security definer set search_path=public,pg_temp as $$
declare v_record public.inventory_daily_catalogues;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required'; end if;
 select * into v_record from public.inventory_daily_catalogues where id=_id for update;
 if not found then raise exception 'Catalogue not found'; end if;
 if _revision is distinct from v_record.revision then raise exception 'This draft changed. Gather the items again before publishing'; end if;
 if _publish then
  if jsonb_array_length(v_record.draft->'items')=0 then raise exception 'There are no items to publish'; end if;
  if exists(select 1 from jsonb_array_elements(v_record.draft->'items') x where
   (x->>'retail_price')::numeric is null or (x->>'retail_price')::numeric<=0 or jsonb_array_length(x->'photos')=0) then
   raise exception 'Finish missing retail prices or photos in Stock, then gather the items again';
  end if;
 end if;
 update public.inventory_daily_catalogues set published=case when _publish then draft else null end,
  published_at=case when _publish then now() else null end,revision=revision+1,updated_at=now(),updated_by=auth.uid()
 where id=_id returning * into v_record;
 return v_record;
end $$;

create function public.shared_inventory_daily_catalogue(_token uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select c.published || jsonb_build_object('items',coalesce((
  select jsonb_agg(s.item || jsonb_build_object('photos',coalesce((
   select jsonb_agg(p.photo order by p.n) from jsonb_array_elements_text(s.item->'photos') with ordinality p(photo,n)
   where p.photo=any(coalesce(i.photos,'{}'::text[])||array[i.photo_url])
  ),'[]'::jsonb)) order by s.n)
  from jsonb_array_elements(c.published->'items') with ordinality s(item,n)
  join public.item_types i on i.id=(s.item->>'id')::uuid and i.deleted_at is null
 ),'[]'::jsonb))
 from public.inventory_daily_catalogues c where c.share_token=_token and c.published is not null;
$$;
revoke all on function public.prepare_inventory_daily_catalogue(date,text) from public,anon;
revoke all on function public.publish_inventory_daily_catalogue(uuid,bigint,boolean) from public,anon;
revoke all on function public.shared_inventory_daily_catalogue(uuid) from public,anon,authenticated;
grant execute on function public.prepare_inventory_daily_catalogue(date,text) to authenticated;
grant execute on function public.publish_inventory_daily_catalogue(uuid,bigint,boolean) to authenticated;
grant execute on function public.shared_inventory_daily_catalogue(uuid) to service_role;
notify pgrst,'reload schema';
