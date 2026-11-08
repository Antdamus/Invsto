begin;
set local lock_timeout='5s';

-- Private aggregate evidence. Never return buyer identifiers or distribute an
-- order-level reversal between item lines. The existing financial matcher runs
-- once; this helper enriches its already reconciled orders.
create function public.streamer_commercial_details(_production jsonb,_from date,_until date)
returns jsonb language sql stable set search_path='' as $$
with orders as materialized (
 select r.*,e.id order_id,nullif(lower(btrim(e.buyer_username)),'') buyer,
  k.starts_at,k.airtime_seconds,
  extract(epoch from (r.purchased at time zone 'America/New_York')-k.starts_at) elapsed,
  coalesce(coalesce(e.raw_payload#>>'{date_precision,sale_date}','')<>'day' and
   (e.raw_payload->>'source' ~ '(api|sync)' or e.raw_payload#>>'{date_precision,sale_date}'='timestamp'
    or e.raw_payload#>>'{order,creationDate}' ~ 'T[0-9]{2}:[0-9]{2}'),false) precise
 from jsonb_to_recordset(_production->'orders') r("order" text,"show" text,purchased timestamp,
  show_source text,booked numeric,cancelled numeric,refunded numeric,held numeric,net numeric)
 join public.ebay_orders e on e.order_number=r."order"
 join public.weekly_ebay_show_catalog k on k.event_id=r."show"
 where k.starts_at>=_from::timestamp at time zone 'America/New_York'
  and k.starts_at<_until::timestamp at time zone 'America/New_York'
), timed as materialized (
 select * from orders where precise and elapsed>=0 and elapsed<airtime_seconds
), halves as (
 select "show",floor(elapsed/1800)::int bin,count(*) orders,sum(booked) booked,sum(net) net
 from timed group by "show",floor(elapsed/1800)
), clocks as (
 select "show",extract(hour from purchased)::int as "hour",count(*) orders,sum(net) net
 from timed group by "show",extract(hour from purchased)
), buyers as (
 select "show",buyer,sum(net) net from orders where buyer is not null group by "show",buyer
), ranked as (
 select *,row_number() over(partition by "show" order by net desc,"order") ranking from orders
), raw_lines as materialized (
 select o."show",l.quantity,
  case when coalesce(l.raw_payload#>>'{line,discountedLineItemCost,currency}',l.raw_payload#>>'{line,lineItemCost,currency}',
   l.raw_payload->>'Currency',l.raw_payload->>'Sale Currency','USD')='USD' then
   coalesce(public.weekly_sales_money(l.raw_payload#>>'{line,discountedLineItemCost,value}'),
    public.weekly_sales_money(l.raw_payload#>>'{line,lineItemCost,value}'),public.weekly_sales_money(l.raw_payload->>'Sold For')*l.quantity,
    case when l.raw_payload#>>'{line,lineItemId}' is null and coalesce(l.raw_payload->>'source','')!~*'(api|sync)' then l.sold_for*l.quantity end) end amount,
  case when f.is_watch is true then 'Watch'
   when f.is_watch is false then 'Other / unspecified'
   when i.watch_details is not null or i.ebay_category_id='31387' then 'Watch'
   when i.id is not null then coalesce(nullif(i.categories[1],''),'Other inventory item')
   else 'Item not identified' end category,
  case when f.is_watch is true and f.brand is not null then
    case f.brand when 'cartier' then 'Cartier' when 'rolex' then 'Rolex' when 'ap' then 'Audemars Piguet' else 'Other watch brand' end
   when f.is_watch is distinct from false and (i.watch_details is not null or i.ebay_category_id='31387') then
    coalesce(nullif(btrim(i.watch_details->>'brand'),''),nullif(btrim(i.ebay_aspects#>>'{Brand,0}'),''),'Brand not recorded')
   else 'Not identified' end brand,
  case when f.is_watch is not null then 'Staff classification' when i.id is not null then 'Linked inventory' else 'Not identified' end evidence
 from orders o join public.ebay_order_lines l on l.order_id=o.order_id
 left join public.order_line_watch_flags f on f.order_line_id=l.id
 left join public.item_types i on i.id=l.internal_item_id
), lines as (
 select *,case when amount is null or quantity<=0 then 'Price unavailable'
  when amount/quantity<100 then 'Under $100' when amount/quantity<500 then '$100-$499'
  when amount/quantity<1000 then '$500-$999' when amount/quantity<5000 then '$1,000-$4,999'
  else '$5,000+' end price_band from raw_lines
), mix as (
 select "show",category,brand,evidence,price_band,count(*) lines,sum(quantity) units,
  count(amount) priced_lines,sum(quantity) filter(where amount is not null) priced_units,sum(amount) original_sales
 from lines group by "show",category,brand,evidence,price_band
), totals as (
 select "show",count(*) orders,count(*) filter(where precise) precise_orders,
  count(*) filter(where buyer is null) missing_buyer_orders,
  sum(net) filter(where buyer is null) missing_buyer_net,
  count(*) filter(where precise and elapsed>=0 and elapsed<airtime_seconds) timed_orders,
  sum(net) filter(where precise and elapsed>=0 and elapsed<airtime_seconds) timed_net,
  count(*) filter(where precise and elapsed<0) before_start_orders,
  count(*) filter(where precise and elapsed>=airtime_seconds) after_duration_orders,
  max(net) largest_order_net,sum(net) filter(where ranking<=3) top_three_orders_net
 from ranked group by "show"
)
select coalesce(jsonb_object_agg(t."show",jsonb_build_object(
 'version',1,'orders',t.orders,'precise_orders',t.precise_orders,'timed_orders',t.timed_orders,'timed_net',coalesce(t.timed_net,0),
 'before_start_orders',t.before_start_orders,'after_duration_orders',t.after_duration_orders,
 'missing_buyer_orders',t.missing_buyer_orders,'missing_buyer_net',coalesce(t.missing_buyer_net,0),
 'known_buyers',(select count(*) from buyers b where b."show"=t."show"),
 'largest_buyer_net',(select max(net) from buyers b where b."show"=t."show"),
 'largest_order_net',t.largest_order_net,'top_three_orders_net',t.top_three_orders_net,
 'halves',coalesce((select jsonb_agg(to_jsonb(h)-'show' order by bin) from halves h where h."show"=t."show"),'[]'),
 'clocks',coalesce((select jsonb_agg(to_jsonb(c)-'show' order by c."hour") from clocks c where c."show"=t."show"),'[]'),
 'merchandise',coalesce((select jsonb_agg(to_jsonb(x)-'show' order by category,brand,price_band) from mix x where x."show"=t."show"),'[]')
 )),'{}') from totals t
$$;
revoke all on function public.streamer_commercial_details(jsonb,date,date) from public,anon,authenticated;

do $$declare f text:=pg_get_functiondef('public.get_streamer_performance_history(date,date)'::regprocedure);
begin
 if strpos(f,'production jsonb; result jsonb;')=0 or strpos(f,' with orders as materialized (')=0
  or strpos(f,'k.insights-''metrics'' insights,')=0 then raise exception 'Unexpected streamer history definition';end if;
 f:=replace(f,'production jsonb; result jsonb;','production jsonb; commercial jsonb; result jsonb;');
 f:=replace(f,' with orders as materialized (',' commercial:=public.streamer_commercial_details(production,_from,_until);'||chr(10)||' with orders as materialized (');
 f:=replace(f,'k.insights-''metrics'' insights,','k.insights-''metrics'' insights,coalesce(commercial->s.event_id,jsonb_build_object(''version'',1,''orders'',0,''halves'',''[]''::jsonb,''clocks'',''[]''::jsonb,''merchandise'',''[]''::jsonb)) commercial,');
 execute f;
end$$;
notify pgrst,'reload schema';
commit;
