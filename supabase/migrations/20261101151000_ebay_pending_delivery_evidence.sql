begin;
-- Expose the same delivery evidence in the already authorized order queue without
-- copying it into fulfillment records or changing what a worker can complete.
do $$declare f text:=pg_get_functiondef('public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer)'::regprocedure);
 marker text:='coalesce(o.raw_payload, ''{}''::jsonb),';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected pending order queue definition';end if;
 execute replace(f,marker,'(coalesce(o.raw_payload, ''{}''::jsonb) || jsonb_strip_nulls(jsonb_build_object(''report_delivery'',public.ebay_report_delivery(o.order_number)))),');
end$$;
notify pgrst,'reload schema';
commit;
