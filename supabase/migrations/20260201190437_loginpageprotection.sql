/* =========================================================
   OG Jewelers — Rate Limit Buckets (Access Magic Link)
   - 1-minute buckets, 10-minute rolling window
   - 30-second burst buckets
   - Designed for Edge Function proxy enforcement
   ========================================================= */

create table if not exists public.og_rl_ip_minute (
  ip_key text not null,
  bucket_epoch bigint not null,           -- unix epoch rounded down to 60s
  cnt integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip_key, bucket_epoch)
);
create table if not exists public.og_rl_email_minute (
  email_key text not null,
  bucket_epoch bigint not null,           -- unix epoch rounded down to 60s
  cnt integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (email_key, bucket_epoch)
);
create table if not exists public.og_rl_burst_30s (
  ip_key text not null,
  email_key text not null,
  bucket_epoch bigint not null,           -- unix epoch rounded down to 30s
  cnt integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip_key, email_key, bucket_epoch)
);
create index if not exists og_rl_ip_minute_bucket_idx
  on public.og_rl_ip_minute (bucket_epoch desc);
create index if not exists og_rl_email_minute_bucket_idx
  on public.og_rl_email_minute (bucket_epoch desc);
create index if not exists og_rl_burst_30s_bucket_idx
  on public.og_rl_burst_30s (bucket_epoch desc);
/* =========================================================
   OG Jewelers — Cleanup old buckets (Retention)
   ========================================================= */

-- 14 days in seconds
do $$
declare
  cutoff bigint := floor(extract(epoch from now() - interval '14 days'));
begin
  delete from public.og_rl_ip_minute where bucket_epoch < cutoff;
  delete from public.og_rl_email_minute where bucket_epoch < cutoff;
  delete from public.og_rl_burst_30s where bucket_epoch < cutoff;
end $$;
/* =========================================================
   OG Jewelers — RPC helpers for atomic increments
   ========================================================= */

create or replace function public.increment_og_rl_ip_minute(
  p_ip_key text,
  p_bucket_epoch bigint
) returns void
language sql
as $$
  update public.og_rl_ip_minute
  set cnt = cnt + 1,
      updated_at = now()
  where ip_key = p_ip_key
    and bucket_epoch = p_bucket_epoch;
$$;
create or replace function public.increment_og_rl_email_minute(
  p_email_key text,
  p_bucket_epoch bigint
) returns void
language sql
as $$
  update public.og_rl_email_minute
  set cnt = cnt + 1,
      updated_at = now()
  where email_key = p_email_key
    and bucket_epoch = p_bucket_epoch;
$$;
create or replace function public.increment_og_rl_burst_30s(
  p_ip_key text,
  p_email_key text,
  p_bucket_epoch bigint
) returns void
language sql
as $$
  update public.og_rl_burst_30s
  set cnt = cnt + 1,
      updated_at = now()
  where ip_key = p_ip_key
    and email_key = p_email_key
    and bucket_epoch = p_bucket_epoch;
$$;
