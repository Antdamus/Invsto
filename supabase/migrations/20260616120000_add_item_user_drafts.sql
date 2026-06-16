-- Persist the in-progress Add Item assisted draft per logged-in inventory user.
-- This lets a phone upload be resumed from another device on the same account.

create table if not exists public.add_item_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  draft_key text not null default 'default',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint add_item_drafts_user_key_unique unique (user_id, draft_key),
  constraint add_item_drafts_key_not_blank check (length(trim(draft_key)) > 0),
  constraint add_item_drafts_payload_object check (jsonb_typeof(payload) = 'object')
);

create index if not exists add_item_drafts_user_updated_idx
  on public.add_item_drafts(user_id, updated_at desc);

alter table public.add_item_drafts enable row level security;

drop policy if exists "add_item_drafts_select_own_inventory_staff" on public.add_item_drafts;
create policy "add_item_drafts_select_own_inventory_staff"
on public.add_item_drafts
for select
to authenticated
using (user_id = auth.uid() and public.can_manage_inventory());

drop policy if exists "add_item_drafts_insert_own_inventory_staff" on public.add_item_drafts;
create policy "add_item_drafts_insert_own_inventory_staff"
on public.add_item_drafts
for insert
to authenticated
with check (user_id = auth.uid() and public.can_manage_inventory());

drop policy if exists "add_item_drafts_update_own_inventory_staff" on public.add_item_drafts;
create policy "add_item_drafts_update_own_inventory_staff"
on public.add_item_drafts
for update
to authenticated
using (user_id = auth.uid() and public.can_manage_inventory())
with check (user_id = auth.uid() and public.can_manage_inventory());

drop policy if exists "add_item_drafts_delete_own_inventory_staff" on public.add_item_drafts;
create policy "add_item_drafts_delete_own_inventory_staff"
on public.add_item_drafts
for delete
to authenticated
using (user_id = auth.uid() and public.can_manage_inventory());

drop trigger if exists trg_add_item_drafts_updated_at on public.add_item_drafts;
create trigger trg_add_item_drafts_updated_at
before update on public.add_item_drafts
for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.add_item_drafts to authenticated;

drop policy if exists "Inventory staff read assisted add item uploads" on storage.objects;
create policy "Inventory staff read assisted add item uploads"
on storage.objects
for select
to authenticated
using (bucket_id in ('InventoryUpload', 'capture-photos') and public.can_manage_inventory());
