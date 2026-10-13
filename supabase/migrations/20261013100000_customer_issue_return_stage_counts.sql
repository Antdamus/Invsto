begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Count every active return matching search and responsibility, before the
-- selected return stage and pagination. Keep ordinary, focused and dispute
-- queue calls consistent without changing their filters or access checks.
do $$
declare signature text; src text; updated text;
begin
 foreach signature in array array[
  'public.list_customer_issues(text,text,text,integer,integer,text,text)',
  'public.list_customer_issues(text,text,text,integer,integer,text,text,uuid)',
  'public.list_customer_issues(text,text,text,integer,integer,text,text,uuid,text)'
 ] loop
  src:=pg_get_functiondef(signature::regprocedure);
  updated:=replace(src,'jsonb_build_object(''rows''',
   'jsonb_build_object(''return_stages'',coalesce((select jsonb_object_agg(return_stage,n) from (select return_stage,count(*) n from scoped where active and issue_kind=''return'' group by return_stage) stages),''{}''::jsonb)) || jsonb_build_object(''rows''');
  if updated=src or strpos(src,'''return_stages''')>0 then
   raise exception 'Customer issue queue changed; review return stage counts migration: %',signature;
  end if;
  execute updated;
 end loop;
end $$;

notify pgrst,'reload schema';
commit;
