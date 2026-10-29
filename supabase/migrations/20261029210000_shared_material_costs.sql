-- Acquisition-cost rates, separate from storefront market/retail pricing.
begin;
create table public.material_cost_settings (
 singleton boolean primary key default true check(singleton),
 rates jsonb not null default '{"gold_10":78,"gold_14":99,"silver":5.8}',
 updated_at timestamptz not null default clock_timestamp(), updated_by uuid references auth.users(id)
);
insert into public.material_cost_settings(singleton) values(true);
create table public.material_cost_events (
 id uuid primary key default gen_random_uuid(), actor uuid references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 old_rates jsonb not null,new_rates jsonb not null,stock_changes jsonb not null default '[]'
);
alter table public.material_cost_settings enable row level security;
alter table public.material_cost_events enable row level security;
revoke all on public.material_cost_settings,public.material_cost_events from public,anon,authenticated;
alter table public.item_types add column material_cost_key text, add column material_cost_manual boolean not null default false;

create function public.inventory_material_key(_item public.item_types) returns text
language plpgsql immutable set search_path='' as $$
declare k integer;
begin
 if _item.watch_details is not null or _item.coin_details is not null
   or coalesce(_item.title,'') ~* '\m(plated|filled|vermeil|tone|gp|gf|hge|overlay)\M' then return null; end if;
 if lower(_item.metal)='silver' then
   return case when _item.purity_basis_points is null or _item.purity_basis_points=9250 then 'silver' end;
 elsif lower(_item.metal)='gold' then
   if _item.purity_basis_points is null then return 'gold_10'; end if;
   foreach k in array array[8,9,10,14,18,21,22,24] loop
     if abs(k::numeric/24*10000-_item.purity_basis_points)<=1 then return 'gold_'||k; end if;
   end loop;
 end if;
 return null;
end $$;

-- A direct cost override disconnects an item from future bulk rate updates.
create function public.guard_material_cost_source() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.pricing_status='pending' then new.material_cost_key:=null;
 elsif tg_op='UPDATE' and current_setting('app.material_cost_item',true) is distinct from new.id::text
   and row(new.cost,new.price_per_weight,new.weight,new.metal,new.purity_basis_points)
     is distinct from row(old.cost,old.price_per_weight,old.weight,old.metal,old.purity_basis_points) then
   new.material_cost_key:=null; new.material_cost_manual:=true;
 end if;
 if new.material_cost_key is not null then
   if new.material_cost_key is distinct from public.inventory_material_key(new) or new.weight is null or new.weight<=0 or new.weight::text in ('NaN','Infinity','-Infinity')
     or new.price_per_weight is null or new.price_per_weight<=0 or new.price_per_weight::text in ('NaN','Infinity','-Infinity') or new.cost is distinct from round(new.weight*new.price_per_weight,2) then
     raise exception 'Material cost must match the item material, grams and cost per gram';
   end if;
   if tg_op='INSERT' and new.price_per_weight is distinct from (select (rates->>new.material_cost_key)::numeric from public.material_cost_settings where singleton) then
     raise exception 'Shared material rates changed. Reload the rates before saving this item.' using errcode='40001';
   end if;
   new.material_cost_manual:=false;
 end if;
 return new;
end $$;
create trigger zy_guard_material_cost_source before insert or update on public.item_types
 for each row execute function public.guard_material_cost_source();

create function public.get_material_cost_settings() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 return (select to_jsonb(s)||jsonb_build_object('can_edit',public.is_admin()) from public.material_cost_settings s where singleton);
end $$;

create function public.validate_material_cost_rates(_rates jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare k text; v jsonb;
begin
 if _rates is null or jsonb_typeof(_rates)<>'object' then raise exception 'Enter material rates';end if;
 if not (_rates ?& array['gold_10','gold_14','silver']) then raise exception '10K, 14K and sterling silver rates are required';end if;
 for k,v in select * from jsonb_each(_rates) loop
   if k<>all(array['silver','gold_8','gold_9','gold_10','gold_14','gold_18','gold_21','gold_22','gold_24'])
     or jsonb_typeof(v)<>'number' then raise exception 'Invalid material rate'; end if;
   if (v::text)::numeric<=0 or (v::text)::numeric>1000000 or (v::text)::numeric<>round((v::text)::numeric,4) then
     raise exception 'Use a cost per gram above zero, up to 1,000,000, with at most four decimals';end if;
 end loop;
end $$;

-- Only current stock with an explicit weight-based cost is eligible. Unknown,
-- manual, deferred, watch, coin and unsupported-purity items require individual review.
create function public.material_cost_stock_preview(_rates jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare changes jsonb; version timestamptz;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 perform public.validate_material_cost_rates(_rates);
 select updated_at into version from public.material_cost_settings where singleton;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'barcode',i.barcode,'key',k.key,'weight',i.weight,
   'quantity',s.qty,'old_cost',i.cost,'old_rate',i.price_per_weight,'new_cost',round(i.weight*(_rates->>k.key)::numeric,2),
   'new_rate',(_rates->>k.key)::numeric,'source',case when i.material_cost_key is not null then 'Shared rate' else 'Existing weight-based cost' end) order by i.id),'[]') into changes
 from public.item_types i
 cross join lateral (select public.inventory_material_key(i) as key) k
 join lateral (select sum(quantity) qty from public.item_stock_locations where item_id=i.id) s on s.qty>0
 where i.deleted_at is null and i.pricing_status='ready' and not i.material_cost_manual
   and i.weight>0 and i.weight::text not in ('NaN','Infinity','-Infinity') and i.price_per_weight>0
   and i.cost=round(i.weight*i.price_per_weight,2) and _rates ? k.key;
 return jsonb_build_object('count',jsonb_array_length(changes),'items',(select coalesce(jsonb_agg(x),'[]') from (select value x from jsonb_array_elements(changes) limit 100) z),
   'old_total',(select coalesce(sum((x->>'old_cost')::numeric*(x->>'quantity')::numeric),0) from jsonb_array_elements(changes) x),
   'new_total',(select coalesce(sum((x->>'new_cost')::numeric*(x->>'quantity')::numeric),0) from jsonb_array_elements(changes) x),
   'token',md5(changes::text||_rates::text||version::text));
end $$;

create function public.save_material_cost_settings(_rates jsonb,_expected_updated_at timestamptz,_apply_stock boolean default false,_preview_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.material_cost_settings; preview jsonb; i public.item_types; k text; new_cost numeric; changes jsonb:='[]'; ids text[]:='{}';
begin
 if auth.uid() is null or not public.can_manage_inventory() or not public.is_admin() then raise exception 'An administrator must update shared material costs' using errcode='42501';end if;
 perform public.validate_material_cost_rates(_rates);
 select * into settings from public.material_cost_settings where singleton for update;
 if settings.updated_at is distinct from _expected_updated_at then raise exception 'Material rates changed. Reload and review before saving.' using errcode='40001';end if;
 if _apply_stock then
   -- Prevent stock/item inserts from entering the update after the reviewed preview.
   -- This short admin transaction also serializes concurrent stock quantity edits.
   lock table public.item_types,public.item_stock_locations in share row exclusive mode;
   -- Lock eligible records and their stock rows before checking the preview again.
   perform 1 from public.item_types t where t.deleted_at is null and t.pricing_status='ready' and not t.material_cost_manual
     and public.inventory_material_key(t) is not null order by t.id for update;
   perform 1 from public.item_stock_locations s join public.item_types t on t.id=s.item_id
     where t.deleted_at is null and t.pricing_status='ready' and not t.material_cost_manual and public.inventory_material_key(t) is not null for update of s;
   preview:=public.material_cost_stock_preview(_rates);
   if _preview_token is null or preview->>'token' is distinct from _preview_token then raise exception 'Stock changed. Preview the current costs again before applying.' using errcode='40001';end if;
   for i in select t.* from public.item_types t where t.deleted_at is null and t.pricing_status='ready' and not t.material_cost_manual
     and t.weight>0 and t.weight::text not in ('NaN','Infinity','-Infinity') and t.price_per_weight>0 and t.cost=round(t.weight*t.price_per_weight,2)
     and _rates ? public.inventory_material_key(t)
     and (select sum(quantity) from public.item_stock_locations where item_id=t.id)>0 order by t.id loop
     k:=public.inventory_material_key(i);new_cost:=round(i.weight*(_rates->>k)::numeric,2);
     perform set_config('app.material_cost_item',i.id::text,true);
     perform set_config('app.inventory_change_reason','Shared material cost rate update',true);
     perform set_config('app.inventory_change_verified_method','authenticated_admin',true);
     update public.item_types set cost=new_cost,price_per_weight=(_rates->>k)::numeric,material_cost_key=k where id=i.id;
     changes:=changes||jsonb_build_array(jsonb_build_object('item_id',i.id,'old_cost',i.cost,'new_cost',new_cost,'old_rate',i.price_per_weight,'new_rate',(_rates->>k)::numeric));
     ids:=array_append(ids,i.id::text);
   end loop;
   perform set_config('app.material_cost_item','',true);
   if cardinality(ids)>0 then update public.metadata set inventory_version=gen_random_uuid()::text,changed_item_ids=ids where id='inventory';end if;
 end if;
 update public.material_cost_settings set rates=_rates,updated_at=clock_timestamp(),updated_by=auth.uid() where singleton;
 insert into public.material_cost_events(actor,old_rates,new_rates,stock_changes) values(auth.uid(),settings.rates,_rates,changes);
 return public.get_material_cost_settings()||jsonb_build_object('updated_items',cardinality(ids));
end $$;

create function public.price_inventory_with_material_rate(_item_id uuid,_revision integer,_retail numeric,_minimum numeric,_expected_rates_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.material_cost_settings; i public.item_types; k text; result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into settings from public.material_cost_settings where singleton for share;
 if settings.updated_at is distinct from _expected_rates_at then raise exception 'Material rates changed. Refresh before pricing.' using errcode='40001';end if;
 select * into i from public.item_types where id=_item_id for update;
 k:=public.inventory_material_key(i);
 if k is null or not(settings.rates ? k) or i.weight is null or i.weight<=0 or i.weight::text in ('NaN','Infinity','-Infinity') then raise exception 'This item needs a manual cost';end if;
 result:=public.act_inventory_pricing(_item_id,_revision,'price',round(i.weight*(settings.rates->>k)::numeric,2),_retail,_minimum,null);
 perform set_config('app.material_cost_item',i.id::text,true);
 update public.item_types set material_cost_key=k,material_cost_manual=false,price_per_weight=(settings.rates->>k)::numeric where id=i.id;
 perform set_config('app.material_cost_item','',true);
 return result;
end $$;

revoke all on function public.inventory_material_key(public.item_types),public.guard_material_cost_source(),public.validate_material_cost_rates(jsonb),public.get_material_cost_settings(),public.material_cost_stock_preview(jsonb),public.save_material_cost_settings(jsonb,timestamptz,boolean,text),public.price_inventory_with_material_rate(uuid,integer,numeric,numeric,timestamptz) from public,anon,authenticated;
-- Trigger calls this pure classifier under the invoking role.
grant execute on function public.inventory_material_key(public.item_types) to authenticated;
grant execute on function public.get_material_cost_settings(),public.material_cost_stock_preview(jsonb),public.save_material_cost_settings(jsonb,timestamptz,boolean,text),public.price_inventory_with_material_rate(uuid,integer,numeric,numeric,timestamptz) to authenticated;
create or replace function public.get_live_sale_report(_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare dashboard jsonb; evidence jsonb; costs jsonb; settings jsonb; show jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 dashboard:=public.get_ebay_live_dashboard(_session_id);
 if dashboard->'connection'='null'::jsonb then raise exception 'Linked show not found';end if;
 select jsonb_build_object('id',id,'title',title,'session_code',session_code,'started_at',started_at,'ended_at',ended_at,'status',status) into show from public.live_sale_sessions where id=_session_id;
 select to_jsonb(s) into settings from public.live_sale_report_settings s where session_id=_session_id;
 select coalesce(jsonb_object_agg(x.attempt_id,to_jsonb(x)),'{}') into costs from public.live_sale_report_costs x
 join public.ebay_live_attempts a on a.id=x.attempt_id join public.ebay_live_connections c on c.event_id=a.event_id where c.session_id=_session_id and a.merged_into is null;
 select coalesce(jsonb_object_agg(a.id,jsonb_build_object(
  'photos',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'photo_path',p.photo_path,'captured_at',p.captured_at,'width',p.width,'height',p.height) order by p.captured_at),'[]') from public.live_sale_bag_photos p where p.attempt_id=a.id),
  'order',case when o.id is not null then jsonb_build_object('id',o.id,'order_number',o.order_number,'buyer_name',o.buyer_name,'status',o.status,'label_metadata',o.label_metadata,'raw_payload',jsonb_build_object('videoReceiptUrl',o.raw_payload->'videoReceiptUrl','videoReceiptURL',o.raw_payload->'videoReceiptURL','videoReceiptUrls',o.raw_payload->'videoReceiptUrls')) end,
  'line',case when l.id is not null then jsonb_build_object('id',l.id,'item_number',l.item_number,'transaction_id',l.transaction_id,'quantity',l.quantity,'raw_payload',l.raw_payload) end
 )),'{}') into evidence from public.ebay_live_attempts a
 join public.ebay_live_connections c on c.event_id=a.event_id
 left join public.ebay_order_lines l on l.id=a.order_line_id left join public.ebay_orders o on o.id=l.order_id
 where c.session_id=_session_id and a.merged_into is null;
 return dashboard||jsonb_build_object('global_material_costs',public.get_material_cost_settings(),'show',show,'settings',settings,'costs',costs,'evidence',evidence);
end $$;

commit;
