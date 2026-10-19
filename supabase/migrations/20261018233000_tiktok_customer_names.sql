begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table public.tiktok_orders add column recipient_name text not null default '' check(length(recipient_name)<=240);

do $$declare def text;begin
 select pg_get_functiondef('public.import_tiktok_orders(jsonb,text,text,timestamptz)'::regprocedure) into def;
 if position('recovering boolean:=false;' in def)=0 or position('buyer_nickname=coalesce(r->>''buyer_nickname'',''''),' in def)=0 then raise exception 'Missing TikTok import guards';end if;
 def:=replace(def,'recovering boolean:=false;', 'recovering boolean:=false; names_updated integer:=0;');
 def:=replace(def,'select * into imp from public.tiktok_order_imports where file_hash=_file_hash;',
 $patch$if exists(select 1 from jsonb_array_elements(_rows) x where length(coalesce(x->>'recipient_name',''))>240 or (x ? 'recipient_name' and jsonb_typeof(x->'recipient_name') not in('string','null')))
  or exists(select 1 from jsonb_array_elements(_rows) x group by x->>'order_number' having count(distinct coalesce(x->>'recipient_name',''))>1) then raise exception 'Invalid or conflicting customer names';end if;
 select * into imp from public.tiktok_order_imports where file_hash=_file_hash;$patch$);
 -- Re-reading the original report can fill names omitted by older clients. Only
 -- that order's current source import may supply a missing name; work is retained.
 def:=replace(def,'if found then' || E'\n   if coalesce((imp.result',
 $patch$if found then
   for g in select x->>'order_number' num,min(btrim(x->>'recipient_name')) name,min(lower(x->>'buyer_username')) buyer
    from jsonb_array_elements(_rows) x where nullif(btrim(x->>'recipient_name'),'') is not null group by x->>'order_number' loop
    select * into o from public.tiktok_orders where order_number=g.num and recipient_name='' and last_import_id=imp.id and source_snapshot_at=imp.snapshot_at and lower(buyer_username)=g.buyer for update;
    if found then
     update public.tiktok_orders set recipient_name=g.name,revision=revision+1,updated_at=now() where id=o.id;
     insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,auth.uid(),'recipient_name_imported',jsonb_build_object('import_id',imp.id,'snapshot_at',imp.snapshot_at,'before',o.recipient_name,'after',g.name,'actor_email',auth.email()));
     names_updated:=names_updated+1;
    end if;
   end loop;
   if coalesce((imp.result$patch$);
 if position('names_updated:=names_updated+1' in def)=0 then raise exception 'Missing duplicate import recovery';end if;
 def:=replace(def,'else return imp.result||jsonb_build_object(''already_imported'',true);end if;',
  'else return imp.result||jsonb_build_object(''already_imported'',names_updated=0,''recipient_names_updated'',names_updated,''cancelled_recovered'',0);end if;');
 def:=replace(def,'buyer_nickname=coalesce(r->>''buyer_nickname'',''''),',
  'buyer_nickname=coalesce(r->>''buyer_nickname'',''''),recipient_name=coalesce(nullif(btrim(r->>''recipient_name''),''''),recipient_name),');
 def:=replace(def,'update public.tiktok_order_imports set result=import_result',
  'import_result:=import_result||jsonb_build_object(''recipient_names_updated'',names_updated); update public.tiktok_order_imports set result=import_result');
 execute def;
end$$;
notify pgrst,'reload schema';
commit;
