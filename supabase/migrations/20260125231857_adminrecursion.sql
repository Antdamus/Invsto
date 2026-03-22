-- 1) Replace is_admin() so it DOES NOT query employees
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;
-- 2) Rebuild employees SELECT policy to avoid is_admin() entirely (no function calls)
-- (Adjust policy names if yours differ)

drop policy if exists "employees_select_self_or_admin" on public.employees;
create policy "employees_select_self_or_admin"
on public.employees
for select
to authenticated
using (
  auth.uid() = user_id
  OR coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin'
);
-- Optional (but recommended): also ensure UPDATE/DELETE policies do NOT call is_admin() if they touch employees;
