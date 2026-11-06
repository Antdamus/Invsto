begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- The weekly cancellation amount update used `l`, which is also the importer’s
-- PL/pgSQL row variable. PostgreSQL rejects l.order_id as ambiguous on import.
-- Change only the SQL alias, retaining all existing import/fulfillment guards.
do $$
declare
 definition text;
 old_update text := $old$update public.tiktok_order_lines l set api_cancelled_item_amount=(x->>'api_cancelled_item_amount')::numeric
 from jsonb_array_elements(_rows) x,public.tiktok_orders ord where ord.order_number=x->>'order_number'
 and ord.last_import_id=imp and l.order_id=ord.id and l.sku_id=x->>'sku_id' and x ? 'api_cancelled_item_amount';$old$;
 new_update text := $new$update public.tiktok_order_lines imported_line set api_cancelled_item_amount=(x->>'api_cancelled_item_amount')::numeric
 from jsonb_array_elements(_rows) x,public.tiktok_orders ord where ord.order_number=x->>'order_number'
 and ord.last_import_id=imp and imported_line.order_id=ord.id and imported_line.sku_id=x->>'sku_id' and x ? 'api_cancelled_item_amount';$new$;
begin
 definition := pg_get_functiondef('public.import_tiktok_api_order(uuid,jsonb,text)'::regprocedure);
 if strpos(definition, new_update)>0 then return; end if;
 if strpos(definition, old_update)=0 then raise exception 'Unexpected TikTok cancellation amount update; no changes applied'; end if;
 execute replace(definition, old_update, new_update);
end $$;

commit;
