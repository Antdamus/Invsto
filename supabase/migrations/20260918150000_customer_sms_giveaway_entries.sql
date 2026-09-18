-- Promote DONE replies into explicit giveaway entry fields for easy admin filtering.

alter table public.customer_sms_subscribers
  add column if not exists instagram_follow_claimed_at timestamptz,
  add column if not exists giveaway_entry_status text,
  add column if not exists giveaway_entry_source text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customer_sms_subscribers_giveaway_entry_status_check'
      and conrelid = 'public.customer_sms_subscribers'::regclass
  ) then
    alter table public.customer_sms_subscribers
      add constraint customer_sms_subscribers_giveaway_entry_status_check
      check (
        giveaway_entry_status is null
        or giveaway_entry_status in ('entered', 'disqualified', 'winner', 'alternate')
      );
  end if;
end;
$$;

update public.customer_sms_subscribers
set
  instagram_follow_claimed_at = nullif(metadata->>'instagram_follow_done_at', '')::timestamptz,
  giveaway_entry_status = coalesce(giveaway_entry_status, 'entered'),
  giveaway_entry_source = coalesce(giveaway_entry_source, 'sms_done')
where instagram_follow_claimed_at is null
  and nullif(metadata->>'instagram_follow_done_at', '') is not null;

create index if not exists customer_sms_subscribers_giveaway_entry_idx
  on public.customer_sms_subscribers(giveaway_entry_status, instagram_follow_claimed_at desc)
  where giveaway_entry_status is not null;

notify pgrst, 'reload schema';
