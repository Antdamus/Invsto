begin;
-- A newer order snapshot can omit an earlier refund. Keep separate refund
-- references and let the newer status/amount replace the same reference.
create function public.weekly_ebay_merge_refunds(older jsonb,newer jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(item order by position),'[]'::jsonb) from (
  select distinct on (identity) item,position from (
   select r as item,i as position,coalesce(nullif(r->>'refundReferenceId',''),nullif(r->>'refundId',''),r::text) as identity
   from jsonb_array_elements((case when jsonb_typeof(older)='array' then older else '[]' end)||
                             (case when jsonb_typeof(newer)='array' then newer else '[]' end)) with ordinality as e(r,i)
  ) matched order by identity,position desc
 ) latest
$$;
revoke all on function public.weekly_ebay_merge_refunds(jsonb,jsonb) from public,anon,authenticated;
create or replace function public.weekly_ebay_adjusted_payload(original jsonb,modified timestamptz,changes jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare
 source_order jsonb:=case when jsonb_typeof(original->'order')='object' then original->'order' else '{}' end;
 payment jsonb:=case when jsonb_typeof(source_order->'paymentSummary')='object' then source_order->'paymentSummary' else '{}' end;
 base_newer boolean:=coalesce(public.weekly_sales_local_time(source_order->>'lastModifiedDate')>modified at time zone 'UTC',false);
 refunds jsonb;
begin
 if modified is null then return original;end if;
 refunds:=case when base_newer then public.weekly_ebay_merge_refunds(changes->'refunds',payment->'refunds')
  else public.weekly_ebay_merge_refunds(payment->'refunds',changes->'refunds') end;
 if jsonb_array_length(refunds)>0 then source_order:=source_order||jsonb_build_object('paymentSummary',payment||jsonb_build_object('refunds',refunds));end if;
 if not base_newer then
  if changes ? 'total' then source_order:=source_order||jsonb_build_object('pricingSummary',
   (case when jsonb_typeof(source_order->'pricingSummary')='object' then source_order->'pricingSummary' else '{}' end)||jsonb_build_object('total',changes->'total'));end if;
  original:=coalesce(original,'{}')||jsonb_strip_nulls(jsonb_build_object('orderPaymentStatus',changes->>'orderPaymentStatus','orderCancelStatus',changes->>'orderCancelStatus'));
 end if;
 return coalesce(original,'{}')||jsonb_build_object('order',source_order);
end$$;
do $$declare f text:=pg_get_functiondef('public.save_weekly_ebay_change_page(uuid,timestamptz,timestamptz,jsonb,boolean,boolean,integer)'::regprocedure);
 old text:='set modified_at=excluded.modified_at,changes=excluded.changes';
 merged text:='(saved.changes||excluded.changes)||jsonb_build_object(''refunds'',public.weekly_ebay_merge_refunds(saved.changes->''refunds'',excluded.changes->''refunds''))';
begin
 if strpos(f,old)=0 then raise exception 'Unexpected financial change upsert';end if;
 f:=replace(f,old,'set modified_at=excluded.modified_at,changes='||merged);
 execute replace(f,'saved.changes is distinct from excluded.changes','saved.changes is distinct from ('||merged||')');
end$$;
notify pgrst,'reload schema';
commit;
