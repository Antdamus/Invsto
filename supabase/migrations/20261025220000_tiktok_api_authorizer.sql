begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- OAuth callbacks and scheduled workers have no staff JWT. Verify the bound
-- authorizer against current staff records instead of fabricating JWT claims.
create or replace function public.tiktok_api_authorizer_allowed(_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists (
  select 1 from public.employees e
  join auth.users u on u.id=e.user_id
  where e.user_id=_user and e.role='admin' and e.active is distinct from false
 );
$$;
revoke all on function public.tiktok_api_authorizer_allowed(uuid) from public,anon,authenticated;
grant execute on function public.tiktok_api_authorizer_allowed(uuid) to service_role;
commit;
