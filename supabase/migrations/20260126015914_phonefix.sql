-- 1) Ensure the FK points to auth.users (NOT public.users)
alter table public.user_phones
  drop constraint if exists user_phones_user_id_fkey;

alter table public.user_phones
  add constraint user_phones_user_id_fkey
  foreign key (user_id) references auth.users(id)
  on delete cascade;

-- 2) (Optional but recommended) allow admins (via service_role RPC) only
revoke all on table public.user_phones from public;
