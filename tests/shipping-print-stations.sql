-- Run inside BEGIN/ROLLBACK; never creates a real print request.
create function pg_temp.check_print(ok boolean, description text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Print check failed: %',description;end if;end $$;
create function pg_temp.expect_print_error(statement text, pattern text) returns void language plpgsql as $$
declare detail text;
begin
 begin execute statement;exception when others then get stacked diagnostics detail=message_text;end;
 if detail is null or detail !~ pattern then raise exception 'Expected %, got %',pattern,coalesce(detail,'no error');end if;
end $$;
do $checks$
declare actor uuid; path text; station uuid; twin uuid; first_job jsonb; replay jsonb; claim jsonb; retry jsonb;
 token text:=repeat('a',64); request uuid:=gen_random_uuid(); body text:=encode(convert_to('%PDF-1.7 test snapshot','UTF8'),'base64');
begin
 select user_id into actor from public.employees where role='admin' and active is distinct from false limit 1;
 select name into path from storage.objects where bucket_id='ebay-labels' and name like '%.pdf' limit 1;
 perform pg_temp.check_print(actor is not null and path is not null,'existing staff and saved PDF available');
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.print_stations(name,created_by,paired_at,printer_name,printer_model,token_hash) values('ROLLBACK shipping '||gen_random_uuid(),actor,now(),'DYMO LabelWriter 5XL','DYMO LabelWriter 5XL',encode(extensions.digest(token,'sha256'),'hex')) returning id into station;
 insert into public.print_stations(name,created_by,paired_at,printer_name,printer_model,token_hash) values('ROLLBACK twin '||gen_random_uuid(),actor,now(),'DYMO Twin Turbo','DYMO Twin Turbo',encode(extensions.digest(token,'sha256'),'hex')) returning id into twin;
 perform pg_temp.check_print(not has_function_privilege('anon','public.enqueue_shipping_label_print(uuid,uuid,text,integer,text,integer[],text,uuid)','execute'),'anon cannot enqueue');
 perform pg_temp.check_print(not has_table_privilege('authenticated','public.label_print_jobs','select'),'PDF payload stays private');
 perform pg_temp.expect_print_error(format('select public.enqueue_shipping_label_print(%L,%L,%L,1,%L,ARRAY[1])',twin,request,body,path),'5XL');
 perform pg_temp.expect_print_error(format('select public.enqueue_shipping_label_print(%L,%L,%L,1,%L,ARRAY[1])',station,request,body,'does-not-exist.pdf'),'Attach');
 perform pg_temp.expect_print_error(format('select public.enqueue_shipping_label_print(%L,%L,%L,60,%L,ARRAY[1,2])',station,request,body,path),'100 shipping');
 perform pg_temp.expect_print_error(format('select public.enqueue_shipping_label_print(%L,%L,%L,1,%L,ARRAY[1,1])',station,request,body,path),'valid pages');
 first_job:=public.enqueue_shipping_label_print(station,request,body,1,path,ARRAY[2,3],'Test shipping');
 replay:=public.enqueue_shipping_label_print(station,request,body,1,path,ARRAY[2,3],'Test shipping');
 perform pg_temp.check_print(first_job->>'id'=replay->>'id','enqueue retry deduplicates');
 perform pg_temp.expect_print_error(format('select public.enqueue_shipping_label_print(%L,%L,%L,2,%L,ARRAY[2,3])',station,request,body,path),'different destination or content');
 perform pg_temp.expect_print_error(format('select public.poll_print_station(%L,%L,true)',station,repeat('b',64)),'not paired');
 perform pg_temp.check_print(public.poll_print_station(station,token,true,'','1.1.1') is null,'old helper does not claim a PDF');
 perform pg_temp.check_print(public.poll_print_station(twin,token,true,'','1.2.0') is null,'other printer cannot claim shipping job');
 claim:=public.poll_print_station(station,token,true,'','1.2.0');
 perform pg_temp.check_print(claim->>'document_type'='pdf' and claim->>'pdf_base64'=body and (claim->>'pdf_page_count')::int=2,'new helper receives exact snapshot');
 perform pg_temp.check_print(public.poll_print_station(station,token,true,'','1.2.0') is null,'one active claim per station');
 perform pg_temp.check_print(not ((public.list_label_print_jobs(station)->0)?'pdf_base64'),'history never returns document payload');
 perform pg_temp.check_print(exists(select 1 from jsonb_array_elements(public.list_print_stations()) row where row->>'id'=station::text and (row->>'pdf_print_ready')::boolean),'capability visible after heartbeat');
 perform public.report_label_print(station,token,(claim->>'id')::uuid,(claim->>'claim_token')::uuid,'submitted',1,'Test accepted');
 retry:=public.retry_label_print((claim->>'id')::uuid,gen_random_uuid());
 perform pg_temp.check_print(exists(select 1 from public.label_print_jobs where id=(retry->>'id')::uuid and document_type='pdf' and pdf_base64=body and source_pages=ARRAY[2,3] and station_id=station),'explicit reprint retains exact destination and pages');
 perform set_config('request.jwt.claim.sub','',true);
 perform pg_temp.expect_print_error(format('select public.enqueue_shipping_label_print(%L,%L,%L,1,%L,ARRAY[1])',station,gen_random_uuid(),body,path),'Inventory access required');
 raise notice 'Shipping print integration checks passed (rollback only).';
end $checks$;
