-- Harden receiver lookup so the transfer page can show every active employee
-- with an auth login, even when normal employees RLS only exposes the caller.

create or replace function public.list_store_transfer_receivers()
returns table (
  employee_id uuid,
  user_id uuid,
  display_name text,
  email text,
  role text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.id as employee_id,
    e.user_id,
    coalesce(nullif(btrim(e.display_name), ''), nullif(btrim(e.email), ''), u.email) as display_name,
    coalesce(nullif(btrim(e.email), ''), u.email) as email,
    e.role
  from public.employees e
  left join auth.users u on u.id = e.user_id
  where public.can_manage_inventory()
    and e.active is distinct from false
    and e.user_id is not null
    and coalesce(nullif(btrim(e.email), ''), u.email) is not null
  order by coalesce(nullif(btrim(e.display_name), ''), nullif(btrim(e.email), ''), u.email), coalesce(nullif(btrim(e.email), ''), u.email);
$$;

revoke all on function public.list_store_transfer_receivers() from public;
grant execute on function public.list_store_transfer_receivers() to authenticated;
