-- Curated client catalogues. No anonymous table access or arbitrary photo signing.
create table public.inventory_catalogues (
 id uuid primary key default gen_random_uuid(),
 title text not null check (length(title) between 1 and 120),
 introduction text not null default '' check (length(introduction)<=1200),
 credit numeric(12,2) check (credit>=0 and credit<=99999999.99),
 status text not null default 'draft' check (status in ('draft','published')),
 share_token uuid not null unique default gen_random_uuid(),
 items jsonb not null default '[]' check (jsonb_typeof(items)='array' and jsonb_array_length(items)<=100),
 revision bigint not null default 1,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.inventory_catalogues enable row level security;
revoke all on public.inventory_catalogues from anon,authenticated;
grant select on public.inventory_catalogues to authenticated;
create policy catalogue_staff_read on public.inventory_catalogues for select to authenticated using (public.can_manage_inventory());

create function public.catalogue_inventory(_search text default '',_offset integer default 0,_ids uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required'; end if;
 if coalesce(cardinality(_ids),0)>100 then raise exception 'Choose at most 100 pieces';end if;
 with matches as (
  select i.id,i.title,i.description,i.sale_price,i.pricing_status,i.barcode,i.photos,i.photo_url,i.categories,i.created_at
  from public.item_types i where i.deleted_at is null
   and (_ids is null or i.id=any(_ids))
   and (nullif(trim(_search),'') is null or i.title ilike '%'||left(_search,100)||'%' or i.barcode ilike '%'||left(_search,100)||'%')
 ), page as (select * from matches order by created_at desc,id limit (case when _ids is null then 24 else 100 end) offset greatest(0,least(coalesce(_offset,0),100000)))
 select jsonb_build_object('total',(select count(*) from matches),'items',coalesce((select jsonb_agg(to_jsonb(p) - 'created_at') from page p),'[]'::jsonb)) into result;
 return result;
end $$;

create function public.save_inventory_catalogue(_id uuid,_expected_revision bigint,_title text,_introduction text,_credit numeric,_items jsonb,_publish boolean default false)
returns public.inventory_catalogues language plpgsql security definer set search_path=public as $$
declare c public.inventory_catalogues;entry jsonb;i public.item_types;clean jsonb:='[]';paths text[];ids uuid[]:='{}';category text;override_price numeric;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required';end if;
 if _id is not null then
  select * into c from public.inventory_catalogues where id=_id for update;
  if not found then raise exception 'Catalogue not found';end if;
  if c.revision is distinct from _expected_revision then raise exception 'Someone changed this catalogue. Reopen it before saving.';end if;
 end if;
 if nullif(trim(_title),'') is null or length(trim(_title))>120 then raise exception 'Add a title (up to 120 characters)';end if;
 if length(coalesce(_introduction,''))>1200 then raise exception 'Introduction is too long';end if;
 if _credit is not null and (_credit<0 or _credit>99999999.99 or _credit<>round(_credit,2)) then raise exception 'Enter a valid credit with at most two decimal places';end if;
 if jsonb_typeof(_items) is distinct from 'array' or jsonb_array_length(_items)>100 then raise exception 'Choose at most 100 pieces';end if;
 if _publish and jsonb_array_length(_items)=0 then raise exception 'Choose at least one piece before publishing';end if;
 for entry in select value from jsonb_array_elements(_items) loop
  select * into i from public.item_types where id=(entry->>'id')::uuid and deleted_at is null;
  if not found then raise exception 'A selected item is no longer available. Remove it before saving.';end if;
  if i.id=any(ids) then raise exception 'Each piece can only appear once';end if;
  ids:=array_append(ids,i.id);
  if i.pricing_status='pending' or i.sale_price is null or i.sale_price<=0 or i.sale_price='NaN'::numeric then raise exception 'Every piece needs a retail price before it can be included';end if;
  if jsonb_typeof(entry->'photos') is distinct from 'array' then raise exception 'Select the client photos';end if;
  if jsonb_array_length(entry->'photos') not between 1 and 8 then raise exception 'Choose between one and eight photos for each piece';end if;
  select coalesce(array_agg(distinct p),'{}'::text[]) into paths from jsonb_array_elements_text(entry->'photos') p;
  if cardinality(paths) not between 1 and 8 then raise exception 'Choose between one and eight photos for each piece';end if;
  if exists(select 1 from unnest(paths) p where p is null or p='' or not (p=any(coalesce(i.photos,'{}'::text[])||array[coalesce(i.photo_url,'')])) ) then raise exception 'A photo is no longer attached to its inventory item. Refresh the selection.';end if;
  category:=coalesce(entry->>'category','Other');
  if category not in ('Watches','Rings','Necklaces','Bracelets','Earrings','Other') then raise exception 'Choose a valid catalogue category';end if;
  override_price:=nullif(entry->>'retail_override','')::numeric;
  if override_price is not null and (override_price<=0 or override_price>99999999.99 or override_price<>round(override_price,2) or override_price='NaN'::numeric) then raise exception 'Enter a valid custom client price greater than zero';end if;
  -- Rebuild explicitly; never persist caller-supplied costs or internal metadata.
  clean:=clean||jsonb_build_array(jsonb_build_object('id',i.id,'category',category,'photos',entry->'photos','retail_override',override_price));
 end loop;
 if _id is null then
  insert into public.inventory_catalogues(title,introduction,credit,status,items,created_by)
  values(trim(_title),coalesce(_introduction,''),_credit,case when _publish then 'published' else 'draft' end,clean,auth.uid()) returning * into c;
 else
  update public.inventory_catalogues set title=trim(_title),introduction=coalesce(_introduction,''),credit=_credit,
   status=case when _publish then 'published' else 'draft' end,items=clean,revision=revision+1,updated_at=now() where id=_id returning * into c;
 end if;
 return c;
end $$;

create function public.unpublish_inventory_catalogue(_id uuid,_expected_revision bigint)
returns public.inventory_catalogues language plpgsql security definer set search_path=public as $$
declare c public.inventory_catalogues;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required';end if;
 select * into c from public.inventory_catalogues where id=_id for update;
 if not found then raise exception 'Catalogue not found';end if;
 if c.revision is distinct from _expected_revision then raise exception 'Someone changed this catalogue. Reopen it before saving.';end if;
 update public.inventory_catalogues set status='draft',revision=revision+1,updated_at=now() where id=_id returning * into c;
 return c;
end $$;

-- Only the Edge Function's service role can resolve a share token. The frontend
-- receives an allowlist of retail fields; selected private photos are signed there.
create function public.shared_inventory_catalogue(_token uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('title',c.title,'introduction',c.introduction,'credit',c.credit,'currency','USD',
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',i.title,'description',coalesce(i.description,''),
   'retail_price',coalesce((entry->>'retail_override')::numeric,i.sale_price),'category',entry->>'category','photos',
    (select coalesce(jsonb_agg(p),'[]'::jsonb) from jsonb_array_elements_text(entry->'photos') p
     where p=any(coalesce(i.photos,'{}'::text[])||array[coalesce(i.photo_url,'')]))) order by ord)
   from jsonb_array_elements(c.items) with ordinality as chosen(entry,ord)
   join public.item_types i on i.id=(entry->>'id')::uuid
   where i.deleted_at is null and i.pricing_status is distinct from 'pending' and i.sale_price>0 and i.sale_price<>'NaN'::numeric),'[]'::jsonb))
 from public.inventory_catalogues c where c.share_token=_token and c.status='published';
$$;
revoke all on function public.catalogue_inventory(text,integer,uuid[]),public.save_inventory_catalogue(uuid,bigint,text,text,numeric,jsonb,boolean),public.unpublish_inventory_catalogue(uuid,bigint),public.shared_inventory_catalogue(uuid) from public,anon,authenticated;
grant execute on function public.catalogue_inventory(text,integer,uuid[]),public.save_inventory_catalogue(uuid,bigint,text,text,numeric,jsonb,boolean),public.unpublish_inventory_catalogue(uuid,bigint) to authenticated;
grant execute on function public.shared_inventory_catalogue(uuid) to service_role;
