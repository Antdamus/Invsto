begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Evaluate the same, user-scoped authorization once per statement. No access
-- rules, table grants or row visibility change.
do $$
declare p record;
begin
 for p in select tablename,policyname from pg_policies
  where schemaname='public' and cmd='SELECT'
   and tablename in ('ebay_conversations','ebay_seller_accounts',
    'ebay_conversation_messages','ebay_conversation_links','ebay_conversation_classifications')
   and qual='can_access_email_triage()'
 loop
  execute format('alter policy %I on public.%I using ((select public.can_access_email_triage()))',p.policyname,p.tablename);
 end loop;
end $$;

-- Avoid assembling every message body into search strings while just browsing.
do $migration$
declare
 signature regprocedure:='public.get_ebay_canonical_mailbox_v2(integer,integer,text,text[],jsonb,jsonb)'::regprocedure;
 definition text:=pg_get_functiondef(signature);
begin
 if position('case when cardinality(v_search_terms) > 0 then lower(concat_ws(' in definition)>0 then return;end if;
 if position('lower(concat_ws(' in definition)=0 or position(')) as search_text' in definition)=0 then
  raise exception 'Mailbox search query changed; inspect before applying';
 end if;
 definition:=replace(definition,'lower(concat_ws(','case when cardinality(v_search_terms) > 0 then lower(concat_ws(');
 definition:=replace(definition,')) as search_text', ')) else '''' end as search_text');
 definition:=replace(definition,'string_agg(concat_ws(', 'case when cardinality(v_search_terms) > 0 then string_agg(concat_ws(');
 definition:=replace(definition, '), '' '') as search_text', '), '' '') else '''' end as search_text');
 execute definition;
end $migration$;
notify pgrst,'reload schema';
commit;
