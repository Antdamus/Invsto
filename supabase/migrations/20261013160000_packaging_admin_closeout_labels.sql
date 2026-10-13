begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Historical closeouts can also clear a later backlog at the owner's request.
-- Their audit notes carry the reason; the queue must not invent carrier handoff.
do $$ declare definition text; updated text; begin
 definition:=pg_get_functiondef('public.packaging_queue(text,text,integer)'::regprocedure);
 updated:=replace(definition,'Already sent · prior to rollout','Closed · admin closeout');
 if updated=definition then raise exception 'Review packaging closeout queue labels before deploying'; end if;
 execute updated;
end $$;
commit;
