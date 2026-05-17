-- Receiver directory for inter-store transfer custody handoff.
-- Direct employees SELECT can be restricted by RLS on some pages, so expose only
-- the active users needed by inventory staff to assign a receiver.

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
    coalesce(nullif(btrim(e.display_name), ''), e.email) as display_name,
    e.email,
    e.role
  from public.employees e
  where public.can_manage_inventory()
    and e.active is distinct from false
    and e.user_id is not null
    and nullif(btrim(coalesce(e.email, '')), '') is not null
  order by coalesce(nullif(btrim(e.display_name), ''), e.email), e.email;
$$;

revoke all on function public.list_store_transfer_receivers() from public;
grant execute on function public.list_store_transfer_receivers() to authenticated;
