-- employee_phones (keyed by employees.id)

create table if not exists public.employee_phones (
  employee_id uuid primary key
    references public.employees(id) on delete cascade,

  phone_e164 text,
  can_sms boolean not null default true,
  updated_at timestamptz not null default now()
);
-- optional: keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_employee_phones_updated_at on public.employee_phones;
create trigger trg_employee_phones_updated_at
before update on public.employee_phones
for each row execute function public.set_updated_at();
alter table public.employee_phones enable row level security;
-- Admin-only access (assumes you already have is_admin() like the rest of your admin area)
drop policy if exists "employee_phones_admin_all" on public.employee_phones;
create policy "employee_phones_admin_all"
on public.employee_phones
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
-- Admin upsert employee phone by employees.id
create or replace function public.admin_upsert_employee_phone(
  _employee_id uuid,
  _phone_e164 text,
  _can_sms boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  insert into public.employee_phones (employee_id, phone_e164, can_sms)
  values (_employee_id, nullif(trim(_phone_e164), ''), coalesce(_can_sms, true))
  on conflict (employee_id)
  do update set
    phone_e164 = excluded.phone_e164,
    can_sms = excluded.can_sms,
    updated_at = now();
end;
$$;
revoke all on function public.admin_upsert_employee_phone(uuid, text, boolean) from public;
grant execute on function public.admin_upsert_employee_phone(uuid, text, boolean) to authenticated;
