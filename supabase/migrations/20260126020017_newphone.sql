create table if not exists public.employee_phones (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  phone_e164 text,
  can_sms boolean not null default true,
  updated_at timestamptz not null default now()
);
