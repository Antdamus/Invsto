begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Administrative records for orders confirmed sent before packaging adoption.
-- Keep unknown tracking and handoff dates empty rather than inventing them.
alter table public.packaging_shipments add column prior_dispatch boolean not null default false;
alter table public.packaging_shipments alter column tracking_code drop not null;
alter table public.packaging_shipments add constraint packaging_tracking_required
 check(tracking_code is not null or (prior_dispatch and status='dispatched'));

create function public.packaging_prior_dispatch_readonly() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.prior_dispatch then raise exception 'This is a historical closeout. It cannot be reopened as a new package.';end if;
 return new;
end $$;
create trigger packaging_prior_dispatch_readonly before update on public.packaging_shipments
 for each row execute function public.packaging_prior_dispatch_readonly();
revoke all on function public.packaging_prior_dispatch_readonly() from public,anon,authenticated;

do $$ declare definition text; old_fragment text:='p.id,null::uuid,p.order_ids,null::text,p.tracking_code,'; begin
 definition:=pg_get_functiondef('public.packaging_queue(text,text,integer)'::regprocedure);
 if position(old_fragment in definition)=0 then raise exception 'Packaging queue shape changed; review migration';end if;
 execute replace(definition,old_fragment,'p.id,null::uuid,p.order_ids,null::text,coalesce(p.tracking_code,''Already sent · prior to rollout''),');
end $$;
commit;
