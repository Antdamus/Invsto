begin;

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
  'order',case when o.id is not null then jsonb_build_object('id',o.id,'order_number',o.order_number,'buyer_name',o.buyer_name,'status',o.status,'label_metadata',o.label_metadata,'updated_at',o.updated_at,
   'financials',jsonb_build_object(
    'totalMarketplaceFee',o.raw_payload->'order'->'totalMarketplaceFee',
    'totalFeeBasisAmount',o.raw_payload->'order'->'totalFeeBasisAmount',
    'pricingSummary',o.raw_payload->'order'->'pricingSummary',
    'lineItems',(select coalesce(jsonb_agg(jsonb_build_object(
      'lineItemId',j->'lineItemId','legacyItemId',j->'legacyItemId',
      'lineItemCost',j->'lineItemCost','discountedLineItemCost',j->'discountedLineItemCost',
      'deliveryCost',j->'deliveryCost','total',j->'total',
      'ebayCollectAndRemitTaxes',j->'ebayCollectAndRemitTaxes'
    )),'[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(o.raw_payload->'order'->'lineItems')='array' then o.raw_payload->'order'->'lineItems' else '[]'::jsonb end) j)
   ),'raw_payload',jsonb_build_object('videoReceiptUrl',o.raw_payload->'videoReceiptUrl','videoReceiptURL',o.raw_payload->'videoReceiptURL','videoReceiptUrls',o.raw_payload->'videoReceiptUrls')) end,
  'line',case when l.id is not null then jsonb_build_object('id',l.id,'item_number',l.item_number,'transaction_id',l.transaction_id,'quantity',l.quantity,'raw_payload',l.raw_payload) end
 )),'{}') into evidence from public.ebay_live_attempts a
 join public.ebay_live_connections c on c.event_id=a.event_id
 left join public.ebay_order_lines l on l.id=a.order_line_id left join public.ebay_orders o on o.id=l.order_id
 where c.session_id=_session_id and a.merged_into is null;
 return dashboard||jsonb_build_object('global_material_costs',public.get_material_cost_settings(),'show',show,'settings',settings,'costs',costs,'evidence',evidence);
end $$;

commit;
