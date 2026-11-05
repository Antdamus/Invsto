begin;
-- eBay supplies OTHER/OTHER/OTHER even when no appeal occurred. A placeholder
-- closing reason does not establish a completed appeal.
do $$
declare src text:=pg_get_functiondef('public.customer_issue_appeal_facts(jsonb)'::regprocedure);
begin
  src:=replace(src,'nullif(a->>''appealCloseReasonEnum'','''') is not null',
    'upper(coalesce(a->>''appealCloseReasonEnum'','''')) not in ('''',''OTHER'',''UNKNOWN'',''NONE'',''NOT_APPLICABLE'')');
  if strpos(src,'''NOT_APPLICABLE''')=0 then raise exception 'Review appeal evidence parser before applying placeholder guard'; end if;
  execute src;
end $$;
notify pgrst,'reload schema';
commit;
