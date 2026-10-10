-- Inventory intake and pricing are separate jobs. This queue never creates tasks.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table public.inventory_pricing_settings (
  singleton boolean primary key default true check (singleton),
  default_owner uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
-- Seed only an unambiguous, active account. Never guess between similar names.
insert into public.inventory_pricing_settings(singleton, default_owner)
select true, case when count(*) = 1 then (array_agg(user_id))[1] end
from public.employees where active is distinct from false and user_id is not null
  and role in ('admin','manager','employee') and lower(btrim(display_name)) = 'otello guillen';
alter table public.inventory_pricing_settings enable row level security;
revoke all on public.inventory_pricing_settings from anon, authenticated;

alter table public.item_types
  add column pricing_status text not null default 'ready' check(pricing_status in ('pending','ready')),
  add column pricing_owner uuid,
  add column pricing_queued_at timestamptz,
  add column pricing_skipped_at timestamptz,
  add column pricing_completed_at timestamptz,
  add column pricing_completed_by uuid,
  add column pricing_revision integer not null default 0,
  add column pricing_resume_ebay boolean not null default false,
  add constraint item_pending_pricing_has_no_prices check (
    pricing_status <> 'pending' or
    (cost is null and sale_price is null and minimum_sale_price is null
      and price_per_weight is null and ebay_sync_enabled is false)
  );
create index item_types_pending_pricing on public.item_types(pricing_owner,pricing_queued_at,id)
  where pricing_status='pending' and deleted_at is null;
create index item_types_priced_recently on public.item_types(pricing_completed_at desc,id)
  where pricing_completed_at is not null and deleted_at is null;

create table public.inventory_pricing_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item_types(id),
  action text not null check(action in ('queued','skipped','reassigned','priced')),
  actor uuid,
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'
);
create index inventory_pricing_events_item on public.inventory_pricing_events(item_id,created_at desc);
alter table public.inventory_pricing_events enable row level security;
revoke all on public.inventory_pricing_events from anon, authenticated;
grant select on public.inventory_pricing_events to authenticated;
create policy pricing_events_staff_read on public.inventory_pricing_events for select to authenticated
  using(public.can_manage_inventory());

create function public.guard_inventory_pricing() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.pricing_status='pending' then
      if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
      new.pricing_owner := coalesce(new.pricing_owner,(select default_owner from public.inventory_pricing_settings where singleton));
      if not exists(select 1 from public.employees where user_id=new.pricing_owner and active is distinct from false and role in ('admin','manager','employee')) then
        raise exception 'Choose an active pricing owner in Pricing settings before saving this item';
      end if;
      new.cost:=null; new.sale_price:=null; new.minimum_sale_price:=null; new.price_per_weight:=null;
      new.pricing_resume_ebay:=coalesce(new.ebay_sync_enabled,false);
      new.ebay_sync_enabled:=false;
      new.pricing_queued_at:=now();new.pricing_revision:=1;
      new.pricing_completed_at:=null;new.pricing_completed_by:=null;new.pricing_skipped_at:=null;
    else
      new.pricing_owner:=null;new.pricing_queued_at:=null;new.pricing_revision:=0;
      new.pricing_completed_at:=null;new.pricing_completed_by:=null;new.pricing_skipped_at:=null;new.pricing_resume_ebay:=false;
    end if;
  elsif row(new.pricing_status,new.pricing_owner,new.pricing_skipped_at,new.pricing_completed_at,new.pricing_completed_by,new.pricing_revision,new.pricing_queued_at,new.pricing_resume_ebay)
       is distinct from row(old.pricing_status,old.pricing_owner,old.pricing_skipped_at,old.pricing_completed_at,old.pricing_completed_by,old.pricing_revision,old.pricing_queued_at,old.pricing_resume_ebay)
       or (old.pricing_status='pending' and row(new.cost,new.sale_price,new.minimum_sale_price,new.price_per_weight,new.ebay_sync_enabled)
         is distinct from row(old.cost,old.sale_price,old.minimum_sale_price,old.price_per_weight,old.ebay_sync_enabled)) then
    -- Only the guarded, row-locked RPC may transition an item in this workflow.
    if current_setting('app.inventory_pricing_item',true) is distinct from old.id::text then
      raise exception 'Use the Pricing queue to price or reassign this item';
    end if;
  end if;
  return new;
end $$;
create trigger zz_guard_inventory_pricing before insert or update on public.item_types
for each row execute function public.guard_inventory_pricing();

create function public.record_inventory_pricing_intake() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.pricing_status='pending' then
    insert into public.inventory_pricing_events(item_id,action,actor,details)
    values(new.id,'queued',auth.uid(),jsonb_build_object('owner',new.pricing_owner));
  end if;
  return new;
end $$;
create trigger item_pricing_intake_audit after insert on public.item_types
for each row execute function public.record_inventory_pricing_intake();

create function public.guard_storefront_pending_pricing() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.published and exists(select 1 from public.item_types where id=new.item_type_id and pricing_status='pending') then
    raise exception 'Finish this item in the Pricing queue before publishing it';
  end if;
  return new;
end $$;
create trigger storefront_requires_completed_pricing before insert or update on public.storefront_listings
for each row execute function public.guard_storefront_pending_pricing();

create function public.inventory_pricing_config() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
  return jsonb_build_object('default_owner',(select default_owner from inventory_pricing_settings where singleton),
    'is_admin',public.is_admin(),'user_id',auth.uid(),
    'owners',(select coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'name',coalesce(nullif(display_name,''),email)) order by display_name),'[]')
      from employees where active is distinct from false and user_id is not null and role in ('admin','manager','employee')));
end $$;

create function public.set_inventory_pricing_owner(_owner uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.can_manage_inventory() or not public.is_admin() then raise exception 'Only an administrator can change the default owner' using errcode='42501'; end if;
  if not exists(select 1 from employees where user_id=_owner and active is distinct from false and role in ('admin','manager','employee')) then raise exception 'Select an active inventory employee'; end if;
  update inventory_pricing_settings set default_owner=_owner,updated_at=now(),updated_by=auth.uid() where singleton;
end $$;

create function public.list_inventory_pricing(_scope text default 'mine',_status text default 'waiting',_search text default '',_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
  if _scope not in ('mine','all') or _status not in ('waiting','skipped','priced') then raise exception 'Invalid pricing filter'; end if;
  with base as materialized (
    select i.* from item_types i where i.deleted_at is null and i.pricing_queued_at is not null
      and (_scope='all' or i.pricing_owner=auth.uid())
      and (btrim(_search)='' or i.title ilike '%'||left(btrim(_search),100)||'%' or i.barcode ilike '%'||left(btrim(_search),100)||'%')
  ), filtered as (
    select * from base where case _status when 'priced' then pricing_status='ready'
      when 'skipped' then pricing_status='pending' and pricing_skipped_at is not null
      else pricing_status='pending' and pricing_skipped_at is null end
  ), page as (
    select * from filtered order by
      case when _status='priced' then pricing_completed_at end desc,
      case when _status='skipped' then pricing_skipped_at else pricing_queued_at end, id
    limit 20 offset greatest(0,least(coalesce(_offset,0),100000))
  ) select jsonb_build_object('counts',jsonb_build_object(
      'waiting',(select count(*) from base where pricing_status='pending' and pricing_skipped_at is null),
      'skipped',(select count(*) from base where pricing_status='pending' and pricing_skipped_at is not null),
      'priced',(select count(*) from base where pricing_status='ready')),
    'total',(select count(*) from filtered),
    'items',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object(
      'owner_name',(select coalesce(nullif(e.display_name,''),e.email) from employees e where e.user_id=p.pricing_owner limit 1),
      'added_by_name',(select coalesce(nullif(e.display_name,''),e.email) from employees e where e.user_id=p.added_by limit 1),
      'can_price',public.is_admin() or p.pricing_owner=auth.uid(),
      'locations',(select coalesce(jsonb_agg(jsonb_build_object('name',l.location_name,'quantity',s.quantity)),'[]')
        from item_stock_locations s join locations l on l.id=s.location_id where s.item_id=p.id and s.quantity>0)
    )) from page p),'[]')) into v_result;
  return v_result;
end $$;

create function public.act_inventory_pricing(_item_id uuid,_revision integer,_action text,
  _cost numeric default null,_retail numeric default null,_minimum numeric default null,_owner uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_item public.item_types; v_details jsonb;
begin
  if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
  select * into v_item from item_types where id=_item_id and deleted_at is null for update;
  if not found then raise exception 'Item is no longer available'; end if;
  if not public.is_admin() and v_item.pricing_owner is distinct from auth.uid() then raise exception 'Only the pricing owner or an administrator can price this item' using errcode='42501'; end if;
  if v_item.pricing_status<>'pending' or v_item.pricing_revision is distinct from _revision then
    raise exception 'This item changed or was already priced. Refresh the queue before continuing.' using errcode='40001'; end if;
  if _action not in ('price','skip','reassign') or _action is null then raise exception 'Invalid pricing action'; end if;
  perform set_config('app.inventory_pricing_item',_item_id::text,true);
  if _action='price' then
    if _cost is null or _cost<0 or _cost::text in ('NaN','Infinity','-Infinity')
      or _retail is null or _retail<=0 or _retail::text in ('NaN','Infinity','-Infinity')
      or (_minimum is not null and (_minimum<0 or _minimum>_retail or _minimum::text in ('NaN','Infinity','-Infinity')))
      or _cost<>round(_cost,2) or _retail<>round(_retail,2) or (_minimum is not null and _minimum<>round(_minimum,2)) then
      raise exception 'Enter a cost of zero or more, a positive retail price, and an optional minimum no higher than retail. Use at most two decimal places.';
    end if;
    perform set_config('app.inventory_change_reason','Pricing queue: initial cost and selling prices',true);
    perform set_config('app.inventory_change_verified_method','authenticated_pricing_owner',true);
    update item_types set cost=_cost,sale_price=_retail,minimum_sale_price=_minimum,
      pricing_status='ready',pricing_completed_at=now(),pricing_completed_by=auth.uid(),
      pricing_revision=pricing_revision+1,ebay_sync_enabled=pricing_resume_ebay where id=_item_id;
    v_details:=jsonb_build_object('cost',_cost,'retail',_retail,'minimum',_minimum,'owner',v_item.pricing_owner);
  elsif _action='skip' then
    update item_types set pricing_skipped_at=now(),pricing_revision=pricing_revision+1 where id=_item_id;
    v_details:=jsonb_build_object('owner',v_item.pricing_owner);
  else
    if not public.is_admin() then raise exception 'Only an administrator can reassign pricing' using errcode='42501'; end if;
    if not exists(select 1 from employees where user_id=_owner and active is distinct from false and role in ('admin','manager','employee')) then raise exception 'Choose an active inventory employee'; end if;
    update item_types set pricing_owner=_owner,pricing_skipped_at=null,pricing_revision=pricing_revision+1 where id=_item_id;
    v_details:=jsonb_build_object('previous_owner',v_item.pricing_owner,'owner',_owner);
  end if;
  insert into inventory_pricing_events(item_id,action,actor,details)
    values(_item_id,case _action when 'price' then 'priced' when 'skip' then 'skipped' else 'reassigned' end,auth.uid(),v_details);
  if _action='price' then
    update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=array[_item_id::text] where id='inventory';
  end if;
  return jsonb_build_object('id',_item_id,'action',_action);
end $$;

revoke all on function public.guard_inventory_pricing(),public.record_inventory_pricing_intake(),public.guard_storefront_pending_pricing(),
  public.inventory_pricing_config(),public.set_inventory_pricing_owner(uuid),
  public.list_inventory_pricing(text,text,text,integer),public.act_inventory_pricing(uuid,integer,text,numeric,numeric,numeric,uuid) from public,anon;
grant execute on function public.inventory_pricing_config(),public.set_inventory_pricing_owner(uuid),
  public.list_inventory_pricing(text,text,text,integer),public.act_inventory_pricing(uuid,integer,text,numeric,numeric,numeric,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
