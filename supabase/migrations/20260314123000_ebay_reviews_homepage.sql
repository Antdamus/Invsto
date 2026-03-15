create extension if not exists pgcrypto;

create table if not exists public.ebay_reviews (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ebay',
  source_review_id text not null,
  source_item_id text,
  source_order_id text,
  rating_type text not null default 'positive',
  star_rating integer not null default 5,
  review_text text,
  review_date timestamptz,
  source_buyer_display text not null default 'Verified eBay buyer',
  original_buyer_name text,
  review_photo_url text,
  fallback_item_image_url text,
  item_title text,
  has_photo boolean not null default false,
  approved_for_homepage boolean not null default false,
  featured_rank integer,
  is_active boolean not null default true,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ebay_reviews_source_review_id_key unique (source_review_id),
  constraint ebay_reviews_rating_type_check
    check (rating_type in ('positive', 'neutral', 'negative')),
  constraint ebay_reviews_star_rating_check
    check (star_rating between 1 and 5)
);

create table if not exists public.ebay_review_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'ebay',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running',
  total_fetched integer not null default 0,
  total_inserted integer not null default 0,
  total_updated integer not null default 0,
  total_approved integer not null default 0,
  total_skipped integer not null default 0,
  total_with_photos integer not null default 0,
  error_message text,
  meta jsonb,
  constraint ebay_review_sync_runs_status_check
    check (status in ('running', 'succeeded', 'failed'))
);

create index if not exists ebay_reviews_homepage_idx
  on public.ebay_reviews (approved_for_homepage, is_active, rating_type);

create index if not exists ebay_reviews_featured_rank_idx
  on public.ebay_reviews (featured_rank asc nulls last, review_date desc);

create index if not exists ebay_reviews_has_photo_idx
  on public.ebay_reviews (has_photo desc, review_date desc);

create index if not exists ebay_review_sync_runs_status_idx
  on public.ebay_review_sync_runs (status, started_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_reviews_updated_at on public.ebay_reviews;
create trigger trg_ebay_reviews_updated_at
before update on public.ebay_reviews
for each row
execute function public.set_updated_at();

create or replace function public.get_storefront_testimonials(p_limit integer default 8)
returns table (
  id uuid,
  source text,
  source_review_id text,
  source_item_id text,
  rating_type text,
  star_rating integer,
  review_text text,
  review_date timestamptz,
  source_buyer_display text,
  review_photo_url text,
  fallback_item_image_url text,
  item_title text,
  has_photo boolean,
  featured_rank integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    r.source,
    r.source_review_id,
    r.source_item_id,
    r.rating_type,
    r.star_rating,
    r.review_text,
    r.review_date,
    r.source_buyer_display,
    r.review_photo_url,
    r.fallback_item_image_url,
    r.item_title,
    r.has_photo,
    r.featured_rank
  from public.ebay_reviews r
  where r.source = 'ebay'
    and r.rating_type = 'positive'
    and r.approved_for_homepage = true
    and r.is_active = true
  order by r.featured_rank asc nulls last, r.review_date desc nulls last
  limit greatest(coalesce(p_limit, 8), 1);
$$;

revoke all on public.get_storefront_testimonials(integer) from public;
grant execute on function public.get_storefront_testimonials(integer) to anon, authenticated, service_role;
