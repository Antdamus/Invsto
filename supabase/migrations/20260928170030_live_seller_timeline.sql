begin;
set local lock_timeout='500ms';
set local statement_timeout='5s';
create table public.ebay_live_seller_changes(
 id bigint generated always as identity primary key,
 event_id text not null references public.ebay_live_connections(event_id),
 seller_id uuid not null references public.employees(id),
 effective_at timestamptz not null default clock_timestamp(),
 covers_previous boolean not null default false,
 changed_by uuid default auth.uid(),
 reason text
);
alter table public.ebay_live_seller_changes enable row level security;
revoke all on public.ebay_live_seller_changes from public,anon,authenticated;
create index ebay_live_seller_changes_event_time on public.ebay_live_seller_changes(event_id,effective_at desc,id desc);
insert into public.ebay_live_seller_changes(event_id,seller_id,effective_at,covers_previous,reason)
 select event_id,active_seller_id,linked_at,true,'Initial connected seller' from public.ebay_live_connections where active_seller_id is not null;

commit;
