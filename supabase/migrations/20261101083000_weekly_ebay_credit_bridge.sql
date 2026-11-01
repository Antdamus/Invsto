begin;
set local lock_timeout='8s';
-- An original credit's itemized components are private, just like the credit itself.
alter table public.weekly_ebay_sale_credits add column breakdown jsonb
 check (jsonb_typeof(breakdown)='object');

create function public.weekly_ebay_credit_parts(_raw jsonb,_credit numeric,_booked numeric,_export jsonb)
returns jsonb language sql stable set search_path='' as $$
 with api as (
  select _raw#>'{order,pricingSummary,deliveryCost}' shipping,
   _raw#>'{order,pricingSummary,deliveryDiscount}' discount,_raw#>'{order,totalMarketplaceFee}' fee
 ), amounts as (
  select case when shipping->>'currency'='USD' then public.weekly_sales_money(shipping->>'value') end ship,
   case when discount is null then 0 when discount->>'currency'='USD' then
     (case when left(discount->>'value',1)='-' then -1 else 1 end)*public.weekly_sales_money(regexp_replace(discount->>'value','^-','')) end disc,
   case when fee->>'currency'='USD' then public.weekly_sales_money(fee->>'value') end fee from api
 )
 select case
  when _credit=(_export->>'credit')::numeric and _credit=(_export->>'item')::numeric+(_export->>'shipping')::numeric
   +(_export->>'fees')::numeric+(_export->>'other')::numeric then _export||'{"source":"Seller Hub"}'::jsonb
  when ship+disc>=0 and _credit=_booked+ship+disc-fee then
   jsonb_build_object('item',_booked,'shipping',ship+disc,'fees',-fee,'other',0,'credit',_credit,'source','eBay order')
 end from amounts
$$;
revoke all on function public.weekly_ebay_credit_parts(jsonb,numeric,numeric,jsonb) from public,anon,authenticated;

do $$declare f text:=pg_get_functiondef('public.weekly_ebay_item_payments(date,date,timestamp,jsonb)'::regprocedure);
 cols text:='c.items as hub_items,'; output text:='''user'',o.buyer_username,';
begin
 if strpos(f,cols)=0 or strpos(f,output)=0 then raise exception 'Unexpected weekly item credit definition';end if;
 f:=replace(f,cols,cols||'c.breakdown as credit_parts,');
 execute replace(f,output,output||'''booked'',o.booked,''parts'',public.weekly_ebay_credit_parts(o.raw,o.amount,o.booked,o.credit_parts),');
end$$;
notify pgrst,'reload schema';
commit;
