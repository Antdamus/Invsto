begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Report assumptions are separate from stock costs, payment evidence and fulfillment.
create table public.live_sale_report_settings (
 session_id uuid primary key references public.live_sale_sessions(id),
 rates jsonb not null default '{}',
 fee_percent numeric(8,4), fee_fixed numeric(12,2), shipping_per_sale numeric(12,2),
 updated_at timestamptz not null default clock_timestamp(), updated_by uuid not null references auth.users(id)
);
create table public.live_sale_report_costs (
 attempt_id uuid primary key references public.ebay_live_attempts(id),
 mode text not null check(mode in ('auto','manual','metal')),
 base_cost numeric(12,2), material text check(material in ('gold','silver')),
 grams numeric(12,4), purity numeric(5,2), note text not null default '',
 updated_at timestamptz not null default clock_timestamp(), updated_by uuid not null references auth.users(id)
);
alter table public.live_sale_report_settings enable row level security;
alter table public.live_sale_report_costs enable row level security;
revoke all on public.live_sale_report_settings,public.live_sale_report_costs from public,anon,authenticated;
grant select on public.live_sale_report_settings,public.live_sale_report_costs to authenticated;
create policy inventory_read on public.live_sale_report_settings for select to authenticated using(public.can_manage_inventory());
create policy inventory_read on public.live_sale_report_costs for select to authenticated using(public.can_manage_inventory());

create function public.save_live_sale_report_settings(_session_id uuid,_rates jsonb,_fee_percent numeric,_fee_fixed numeric,_shipping_per_sale numeric,_expected_updated_at timestamptz default null)
returns public.live_sale_report_settings language plpgsql security definer set search_path='' as $$
declare old public.live_sale_report_settings; saved public.live_sale_report_settings; k text; v jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('live-report-settings:'||_session_id::text,0));
 if not exists(select 1 from public.ebay_live_connections where session_id=_session_id) then raise exception 'Linked show not found';end if;
 select * into old from public.live_sale_report_settings where session_id=_session_id;
 if old.updated_at is distinct from _expected_updated_at then raise exception 'Report assumptions changed on another device. Refresh and review before saving.' using errcode='40001';end if;
 if _rates is null or jsonb_typeof(_rates)<>'object' then raise exception 'Invalid metal rates';end if;
 for k,v in select * from jsonb_each(_rates) loop
  if k not in ('silver','gold_8','gold_9','gold_10','gold_14','gold_18','gold_21','gold_22','gold_24') or jsonb_typeof(v)<>'number' or (v::text)::numeric not between 0 and 1000000 then raise exception 'Invalid metal rate';end if;
 end loop;
 if (_fee_percent is not null and _fee_percent not between 0 and 100) or (_fee_fixed is not null and _fee_fixed not between 0 and 1000000) or (_shipping_per_sale is not null and _shipping_per_sale not between 0 and 1000000) then raise exception 'Invalid expense assumptions';end if;
 insert into public.live_sale_report_settings(session_id,rates,fee_percent,fee_fixed,shipping_per_sale,updated_by)
 values(_session_id,_rates,_fee_percent,_fee_fixed,_shipping_per_sale,auth.uid())
 on conflict(session_id) do update set rates=excluded.rates,fee_percent=excluded.fee_percent,fee_fixed=excluded.fee_fixed,shipping_per_sale=excluded.shipping_per_sale,updated_at=clock_timestamp(),updated_by=auth.uid() returning * into saved;
 return saved;
end $$;

create function public.save_live_sale_report_cost(_session_id uuid,_attempt_id uuid,_mode text,_base_cost numeric,_material text,_grams numeric,_purity numeric,_note text,_expected_updated_at timestamptz default null)
returns public.live_sale_report_costs language plpgsql security definer set search_path='' as $$
declare old public.live_sale_report_costs; saved public.live_sale_report_costs;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('live-report-cost:'||_attempt_id::text,0));
 if not exists(select 1 from public.ebay_live_attempts a join public.ebay_live_connections c on c.event_id=a.event_id where a.id=_attempt_id and c.session_id=_session_id and a.merged_into is null) then raise exception 'Item does not belong to this show';end if;
 select * into old from public.live_sale_report_costs where attempt_id=_attempt_id;
 if old.updated_at is distinct from _expected_updated_at then raise exception 'This item cost changed on another device. Refresh and review before saving.' using errcode='40001';end if;
 if _mode is null or _mode not in ('auto','manual','metal') or (_base_cost is not null and _base_cost not between 0 and 9999999999.99)
  or (_grams is not null and _grams not between 0.0001 and 99999999) or (_purity is not null and _purity not between 1 and 24)
  or (_material is not null and _material not in ('gold','silver')) or length(coalesce(_note,''))>500 then raise exception 'Invalid item cost';end if;
 if _mode='manual' and _base_cost is null then raise exception 'Enter the total base cost';end if;
 if _mode='metal' and (_material is null or _grams is null or (_material='gold' and _purity is null)) then raise exception 'Enter material, grams and gold purity';end if;
 insert into public.live_sale_report_costs(attempt_id,mode,base_cost,material,grams,purity,note,updated_by)
 values(_attempt_id,_mode,_base_cost,_material,_grams,_purity,coalesce(_note,''),auth.uid())
 on conflict(attempt_id) do update set mode=excluded.mode,base_cost=excluded.base_cost,material=excluded.material,grams=excluded.grams,purity=excluded.purity,note=excluded.note,updated_at=clock_timestamp(),updated_by=auth.uid() returning * into saved;
 return saved;
end $$;

create function public.get_live_sale_report(_session_id uuid) returns jsonb
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
 return dashboard||jsonb_build_object('show',show,'settings',settings,'costs',costs,'evidence',evidence);
end $$;
revoke all on function public.get_live_sale_report(uuid),public.save_live_sale_report_settings(uuid,jsonb,numeric,numeric,numeric,timestamptz),public.save_live_sale_report_cost(uuid,uuid,text,numeric,text,numeric,numeric,text,timestamptz) from public,anon,authenticated;
grant execute on function public.get_live_sale_report(uuid),public.save_live_sale_report_settings(uuid,jsonb,numeric,numeric,numeric,timestamptz),public.save_live_sale_report_cost(uuid,uuid,text,numeric,text,numeric,numeric,text,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
