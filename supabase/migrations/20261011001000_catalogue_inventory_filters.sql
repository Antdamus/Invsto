-- Inventory-wide staff filters. Public catalogues still receive only their retail allowlist.
begin;
create or replace function public.catalogue_piece_type(_title text,_categories text[] default '{}')
returns text language plpgsql immutable set search_path=public as $$
declare part text;
begin
 foreach part in array array[coalesce(_title,''),array_to_string(coalesce(_categories,'{}'),' ')] loop
  if part ~* '\m(pendant|pendants|charm|charms)\M' then return 'Pendants';end if;
  if part ~* '\m(watch|watches|wristwatch|wristwatches)\M' then return 'Watches';end if;
  if part ~* '\m(earring|earrings|studs)\M' then return 'Earrings';end if;
  if part ~* '\m(anklet|anklets)\M' then return 'Anklets';end if;
  if part ~* '\m(bracelet|bracelets|bangle|bangles|cuff)\M' then return 'Bracelets';end if;
  if part ~* '\m(chain|chains)\M' then return 'Chains';end if;
  if part ~* '\m(necklace|necklaces)\M' then return 'Necklaces';end if;
  if part ~* '\m(ring|rings)\M' then return 'Rings';end if;
  if part ~* '\m(brooch|brooches)\M' then return 'Brooches';end if;
  if part ~* '\m(set|sets)\M' then return 'Sets';end if;
  if part ~* '\m(coin|coins|bullion)\M' then return 'Coins';end if;
 end loop;
 return 'Other';
end $$;

create or replace function public.browse_catalogue_inventory(
 _search text default '',_offset integer default 0,_material text default '',_purity text default '',_type text default '')
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required';end if;
 return (
 with base as materialized (
  select i.id,i.title,i.description,i.sale_price,i.pricing_status,i.barcode,i.photos,i.photo_url,i.categories,i.created_at,
   coalesce(nullif(lower(trim(i.metal)),''),'unspecified') as material,
   i.purity_basis_points,
   public.catalogue_piece_type(i.title,i.categories) as piece_type
  from public.item_types i
  where i.deleted_at is null
   and (nullif(trim(_search),'') is null or i.title ilike '%'||left(_search,100)||'%' or i.barcode ilike '%'||left(_search,100)||'%')
 ), matches as (
  select * from base b where (coalesce(_material,'')='' or b.material=_material)
   and (coalesce(_purity,'')='' or coalesce(b.purity_basis_points::text,'unspecified')=_purity)
   and (coalesce(_type,'')='' or b.piece_type=_type)
 ), page as (
  select * from matches order by created_at desc,id limit 24 offset greatest(0,least(coalesce(_offset,0),100000))
 )
 select jsonb_build_object('total',(select count(*) from matches),
  'items',coalesce((select jsonb_agg(to_jsonb(p)-'created_at' order by p.created_at desc,p.id) from page p),'[]'::jsonb),
  'facets',jsonb_build_object(
   'materials',coalesce((select jsonb_agg(v order by v) from (select distinct material v from base) m),'[]'::jsonb),
   'types',coalesce((select jsonb_agg(v order by v) from (select distinct piece_type v from base) t),'[]'::jsonb),
   'purities',coalesce((select jsonb_agg(jsonb_build_object('value',v,'material',m) order by m,v) from (
    select distinct coalesce(purity_basis_points::text,'unspecified') v,material m from base
    where coalesce(_material,'')='' or material=_material
   ) p),'[]'::jsonb)
  )
 )
 );
end $$;
revoke all on function public.catalogue_piece_type(text,text[]),public.browse_catalogue_inventory(text,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.browse_catalogue_inventory(text,integer,text,text,text) to authenticated;

create or replace function public.save_inventory_catalogue(_id uuid,_expected_revision bigint,_title text,_introduction text,_credit numeric,_items jsonb,_publish boolean default false)
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
  if category not in ('Watches','Rings','Pendants','Chains','Necklaces','Bracelets','Earrings','Anklets','Brooches','Sets','Coins','Other') then raise exception 'Choose a valid catalogue category';end if;
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


notify pgrst,'reload schema';
commit;
