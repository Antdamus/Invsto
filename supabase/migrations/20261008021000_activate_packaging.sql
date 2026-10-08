-- Run only after packaging.html and the matching task/checkout UI are deployed.
-- This establishes a cutoff; it does not enqueue or alter historical orders.
begin;
set local lock_timeout='3s';
update public.packaging_settings
set enabled=true,activated_at=coalesce(activated_at,clock_timestamp()),activated_by=coalesce(activated_by,auth.uid())
where id=true and enabled=false;
commit;
