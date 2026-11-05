-- Keep named, forward-looking selections independent of the daily catalogue.
alter table public.inventory_daily_catalogues
 add column catalogue_key text not null default 'daily',
 add column source_start_at timestamptz;
alter table public.inventory_daily_catalogues
 drop constraint inventory_daily_catalogues_source_date_recipient_key,
 add constraint inventory_catalogues_scope_unique unique(source_date,recipient,catalogue_key),
 add constraint inventory_catalogues_scope_check check(
  (catalogue_key='daily' and source_start_at is null) or
  (catalogue_key<>'daily' and source_start_at is not null));
create unique index inventory_catalogues_named_unique
 on public.inventory_daily_catalogues(recipient,catalogue_key) where catalogue_key<>'daily';

-- Shared projection keeps costs and internal fields out of every draft.
create function public.inventory_catalogue_items(_start timestamptz,_end timestamptz)
returns jsonb language sql stable set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',i.id,'name',i.title,'description',coalesce(i.description,''),
  'retail_price',case when i.pricing_status is distinct from 'pending' and i.sale_price>0 then i.sale_price else null end,
  'reference',coalesce(i.barcode,''),'category',public.catalogue_piece_type(i.title,i.categories),
  'material',coalesce(i.metal,''),'purity_basis_points',i.purity_basis_points,
  'weight',to_jsonb(i)->>'weight','photos',p.photos
 ) order by public.catalogue_piece_type(i.title,i.categories),i.title,i.id),'[]'::jsonb)
 from public.item_types i
 cross join lateral (
  select coalesce(jsonb_agg(photo order by first_position),'[]'::jsonb) photos from (
   select photo,min(position) first_position from unnest(coalesce(i.photos,'{}'::text[])||array[i.photo_url]) with ordinality a(photo,position)
   where nullif(btrim(photo),'') is not null group by photo
  ) unique_photos
 ) p
 where i.deleted_at is null and i.created_at>=_start and i.created_at<_end;
$$;
revoke all on function public.inventory_catalogue_items(timestamptz,timestamptz) from public,anon,authenticated;

create or replace function public.prepare_inventory_daily_catalogue(_date date,_recipient text default 'Manny')
returns public.inventory_daily_catalogues language plpgsql security definer set search_path=public,pg_temp as $$
declare v_draft jsonb; v_record public.inventory_daily_catalogues;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required'; end if;
 if _date is null or _date < date '2000-01-01' or _date > (now() at time zone 'America/New_York')::date then
  raise exception 'Choose an inventory date up to today (Eastern time)';
 end if;
 _recipient:=btrim(_recipient);
 if _recipient is null or length(_recipient) not between 1 and 80 then raise exception 'Enter a recipient name'; end if;
 v_draft:=jsonb_build_object('title','New inventory selection','recipient',_recipient,'company','eBay',
  'source_date',_date,'prepared_at',now(),'currency','USD','items',
  public.inventory_catalogue_items(_date::timestamp at time zone 'America/New_York',(_date+1)::timestamp at time zone 'America/New_York'));
 insert into public.inventory_daily_catalogues(source_date,recipient,draft,created_by,updated_by)
 values(_date,_recipient,v_draft,auth.uid(),auth.uid())
 on conflict(source_date,recipient,catalogue_key) do update set draft=excluded.draft,revision=inventory_daily_catalogues.revision+1,
  updated_at=now(),updated_by=auth.uid()
 returning * into v_record;
 return v_record;
end $$;

-- The requested start is fixed when the collection is created, never moved by
-- reopening or gathering tomorrow. Use created_at, not restock/update dates.
insert into public.inventory_daily_catalogues(source_date,recipient,catalogue_key,source_start_at,draft)
values(date '2026-11-05','Manny','rare-finds',timestamptz '2026-11-05 18:33:00+00',
 jsonb_build_object('title','Rare Finds','recipient','Manny','company','eBay',
  'catalogue_key','rare-finds','source_date','2026-11-05','source_start_at','2026-11-05T18:33:00Z',
  'prepared_at',now(),'currency','USD','items','[]'::jsonb));

create function public.prepare_inventory_collection_catalogue(_key text)
returns public.inventory_daily_catalogues language plpgsql security definer set search_path=public,pg_temp as $$
declare v_record public.inventory_daily_catalogues; v_end timestamptz:=statement_timestamp();
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required'; end if;
 select * into v_record from public.inventory_daily_catalogues
 where catalogue_key=_key and catalogue_key<>'daily' and recipient='Manny' for update;
 if not found then raise exception 'Collection not found'; end if;
 update public.inventory_daily_catalogues set
  draft=jsonb_build_object('title',v_record.draft->>'title','recipient',recipient,'company','eBay',
   'catalogue_key',catalogue_key,'source_date',source_date,'source_start_at',source_start_at,
   'prepared_at',v_end,'currency','USD','items',public.inventory_catalogue_items(source_start_at,v_end)),
  revision=revision+1,updated_at=now(),updated_by=auth.uid()
 where id=v_record.id returning * into v_record;
 return v_record;
end $$;
revoke all on function public.prepare_inventory_collection_catalogue(text) from public,anon;
grant execute on function public.prepare_inventory_collection_catalogue(text) to authenticated;
notify pgrst,'reload schema';
