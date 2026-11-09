begin;
set local lock_timeout='5s';
-- Fulfillment line evidence identifies the originating Live event even when
-- checkout/payment occurs later. Do not infer an auction timestamp from it.
-- Reporting only: no changes to orders, fulfillment, assignments or commissions.
do $$declare f text; sig text; marker text; replacement text;
begin
 foreach sig in array array['public.weekly_ebay_production(jsonb)','public.streamer_performance_orders(jsonb)'] loop
  f:=pg_get_functiondef(sig::regprocedure);
  marker:='a.line_count,a.event_count,a.matched_count,a.event_id exact_event,a.seller_count,a.seller_id,';
  if strpos(f,marker)=0 then raise exception 'Unexpected evidence base %',sig;end if;
  f:=replace(f,marker,marker||'api.api_line_count,api.api_count,api.api_event_count,api.api_matched_count,api.api_event,api.non_live_count,');
  marker:=E') a on true\n  left join lateral (';
  if strpos(f,marker)=0 then raise exception 'Unexpected evidence aggregate %',sig;end if;
  replacement:=$sql$) a on true
  left join lateral (
   select count(*) api_line_count,
    count(nullif(nullif(l.value#>>'{ebayLiveContext,eventId}',''),'UNKNOWN')) api_count,
    count(distinct nullif(nullif(l.value#>>'{ebayLiveContext,eventId}',''),'UNKNOWN')) api_event_count,
    count(s.event_id) filter(where l.value->>'purchaseSource'='EBAY_LIVE') api_matched_count,
    min(s.event_id) api_event,
    count(*) filter(where nullif(l.value->>'purchaseSource','') is not null
     and l.value->>'purchaseSource'<>'EBAY_LIVE') non_live_count
   -- The current API order is canonical. Older CSV/dispute representations can
   -- coexist locally with newer API lines for the same purchased item.
   from jsonb_array_elements(case when jsonb_typeof(e.raw_payload#>'{order,lineItems}')='array'
    and jsonb_array_length(e.raw_payload#>'{order,lineItems}')>0 then e.raw_payload#>'{order,lineItems}'
    else coalesce((select jsonb_agg(l.raw_payload->'line') from public.ebay_order_lines l where l.order_id=e.id),'[]') end) l
   left join shows s on s.event_id=l.value#>>'{ebayLiveContext,eventId}'
  ) api on true
  left join lateral ($sql$;
  f:=replace(f,marker,replacement);
  marker:=' ), matched as (';
  if strpos(f,marker)=0 or strpos(f,' ), attributed as (')=0 then raise exception 'Unexpected match block %',sig;end if;
  replacement:=$sql$ ), evidence as (
  select b.*,api_event_count=1 and api_matched_count=api_line_count and api_line_count>0
   and non_live_count=0 and (event_count=0 or (event_count=1 and exact_event=api_event)) api_complete
  from base b
 ), matched as (
  select b.*,case when verified_show is not null then verified_show
   when non_live_count>0 then null when api_complete then api_event
   when api_count>0 then null
   when event_count=1 and matched_count=line_count then exact_event
   when event_count<=1 and precise and (exact_event is null or exact_event=time_event) then time_event end show_id,
   case when verified_show is not null or api_complete then 'captured'
    when non_live_count>0 then case when non_live_count=api_line_count then 'non_live' else 'mixed' end
    when api_count>0 then case when api_event_count>1 or event_count>1 or exact_event<>api_event then 'multiple' else 'unmatched' end
    when event_count=1 and matched_count=line_count then 'captured'
    when event_count<=1 and precise and time_event is not null and (exact_event is null or exact_event=time_event) then 'time_window'
    when event_count>1 then 'multiple' else 'unmatched' end show_source
  from evidence b
$sql$;
  f:=split_part(f,marker,1)||replacement||' ), attributed as ('||split_part(f,' ), attributed as (',2);
  marker:='when s.starts_at is not null or b.precise then ''time_rule''';
  if strpos(f,marker)=0 then raise exception 'Unexpected seller rule %',sig;end if;
  f:=replace(f,marker,'when b.show_source in (''non_live'',''mixed'',''multiple'') then ''unknown'' '||marker);
  execute f;
 end loop;
 f:=pg_get_functiondef('public.get_streamer_performance_history(date,date)'::regprocedure);
 marker:='''unlinked_net'',(select coalesce(sum(net),0) from orders where "show" is null and day>=_from and day<_until),';
 if strpos(f,marker)=0 then raise exception 'Unexpected history coverage';end if;
 f:=replace(f,marker,marker||$sql$
   'non_live_orders',(select count(*) from orders where show_source='non_live' and day>=_from and day<_until),
   'review_orders',(select count(*) from orders where "show" is null and show_source<>'non_live' and day>=_from and day<_until),$sql$);
 execute f;
 -- Report loading is batched by show dates. Each batch must still see delayed
 -- checkouts through the same report end, including a later calendar quarter.
 marker:='get_streamer_performance_history(_from date, _until date)';
 if strpos(f,marker)=0 then raise exception 'Unexpected history signature';end if;
 f:=replace(f,marker,'get_streamer_performance_history_range(_from date, _until date, _report_until date)');
 marker:='if _until is null or _until<''2000-01-02'' then';
 if strpos(f,marker)=0 then raise exception 'Unexpected history bounds';end if;
 f:=replace(f,marker,$sql$if _report_until is null or _report_until<_until or _report_until-_from>740 then
  raise exception 'Choose a valid report end date';end if;
 $sql$||marker);
 f:=replace(f,'(_until+1)::timestamp','(_report_until+1)::timestamp');
 f:=replace(f,'weekly_sales_order_rows(_from-1,_until+1)','weekly_sales_order_rows(_from-1,_report_until+1)');
 execute f;
end$$;
revoke all on function public.get_streamer_performance_history_range(date,date,date) from public,anon;
grant execute on function public.get_streamer_performance_history_range(date,date,date) to authenticated;
notify pgrst,'reload schema';
commit;
