begin;
-- This permission is intentionally narrower than general admin access.
create or replace function public.can_revert_order_fulfillment()
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists (
    select 1 from public.employees
    where user_id=auth.uid() and active is true and role in ('admin','manager')
  );
$$;
revoke all on function public.can_revert_order_fulfillment() from public,anon;
grant execute on function public.can_revert_order_fulfillment() to authenticated;
commit;
