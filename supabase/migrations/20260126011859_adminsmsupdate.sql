create or replace function public.admin_upsert_user_phone(
  _user_id uuid,
  _phone_e164 text,
  _can_sms boolean default true
)
returns void
language plpgsql
security definer
as $$
begin
  -- basic sanity
  if _phone_e164 is null or length(trim(_phone_e164)) = 0 then
    raise exception 'Phone cannot be empty';
  end if;

  -- upsert
  insert into public.user_phones (
    user_id,
    phone_e164,
    can_sms,
    verified_at
  )
  values (
    _user_id,
    _phone_e164,
    _can_sms,
    null
  )
  on conflict (user_id)
  do update set
    phone_e164 = excluded.phone_e164,
    can_sms = excluded.can_sms,
    verified_at = case
      when user_phones.phone_e164 <> excluded.phone_e164 then null
      else user_phones.verified_at
    end;
end;
$$;

-- lock it down
revoke all on function public.admin_upsert_user_phone(uuid, text, boolean) from public;
grant execute on function public.admin_upsert_user_phone(uuid, text, boolean) to service_role;
