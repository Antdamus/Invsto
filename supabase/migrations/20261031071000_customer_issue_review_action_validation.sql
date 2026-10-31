begin;
-- Null is not a save operation; it must not bypass the version check.
do $$ declare src text;begin
 src:=pg_get_functiondef('public.save_customer_issue_ebay_review(uuid,text,text,text,uuid)'::regprocedure);
 src:=replace(src,'if _action not in (','if _action is null or _action not in (');
 if strpos(src,'_action is null or _action not in')=0 then raise exception 'Review action validation update failed';end if;
 execute src;
end $$;
notify pgrst,'reload schema';
commit;
