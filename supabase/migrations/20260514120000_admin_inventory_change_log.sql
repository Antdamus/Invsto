-- Admin-facing inventory change log.
-- Captures before/after field values for item, stock placement, and location edits.

create table if not exists public.inventory_change_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  item_id uuid references public.item_types(id) on delete set null,
  item_title text,
  item_barcode text,
  location_id uuid references public.locations(id) on delete set null,
  location_name text,
  store_id uuid references public.store_locations(id) on delete set null,
  store_name text,
  worker_id uuid references auth.users(id) on delete set null,
  worker_email text,
  changed_fields jsonb not null default '{}'::jsonb,
  old_data jsonb,
  new_data jsonb,
  summary text,
  changed_at timestamptz not null default now()
);

create index if not exists inventory_change_log_changed_at_idx
  on public.inventory_change_log(changed_at desc);

create index if not exists inventory_change_log_worker_idx
  on public.inventory_change_log(worker_id, changed_at desc);

create index if not exists inventory_change_log_store_idx
  on public.inventory_change_log(store_id, changed_at desc);

create index if not exists inventory_change_log_item_idx
  on public.inventory_change_log(item_id, changed_at desc);

alter table public.inventory_change_log enable row level security;

drop policy if exists "inventory_change_log_admin_select" on public.inventory_change_log;
create policy "inventory_change_log_admin_select"
on public.inventory_change_log
for select
to authenticated
using (public.is_admin());

grant select on table public.inventory_change_log to authenticated;
grant select, insert, update, delete on table public.inventory_change_log to service_role;

create or replace function public.log_inventory_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  v_changed_fields jsonb := '{}'::jsonb;
  v_key text;
  v_action text := lower(tg_op);
  v_record_id uuid;
  v_item_id uuid;
  v_item_title text;
  v_item_barcode text;
  v_location_id uuid;
  v_location_name text;
  v_store_id uuid;
  v_store_name text;
  v_worker_id uuid := auth.uid();
  v_worker_email text;
  v_jwt_email text;
  v_summary text;
begin
  if tg_op = 'UPDATE' then
    for v_key in
      select key
      from jsonb_object_keys((v_old - array['updated_at','last_updated','confirmed_at']::text[]) || (v_new - array['updated_at','last_updated','confirmed_at']::text[])) as key
    loop
      if (v_old -> v_key) is distinct from (v_new -> v_key) then
        v_changed_fields := jsonb_set(
          v_changed_fields,
          array[v_key],
          jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key),
          true
        );
      end if;
    end loop;

    if v_changed_fields = '{}'::jsonb then
      return new;
    end if;
  elsif tg_op = 'INSERT' then
    v_changed_fields := jsonb_build_object('record', jsonb_build_object('from', null, 'to', v_new));
  elsif tg_op = 'DELETE' then
    v_changed_fields := jsonb_build_object('record', jsonb_build_object('from', v_old, 'to', null));
  end if;

  v_record_id := coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid);

  if tg_table_name = 'item_types' then
    v_item_id := v_record_id;
    v_location_id := null;
  elsif tg_table_name = 'item_stock_locations' then
    v_item_id := coalesce((v_new ->> 'item_id')::uuid, (v_old ->> 'item_id')::uuid);
    v_location_id := coalesce((v_new ->> 'location_id')::uuid, (v_old ->> 'location_id')::uuid);
  elsif tg_table_name = 'locations' then
    v_location_id := v_record_id;
  end if;

  if v_worker_id is null then
    v_worker_id := nullif(coalesce(v_new ->> 'added_by', v_old ->> 'added_by'), '')::uuid;
  end if;

  if v_item_id is not null then
    select it.title, it.barcode
      into v_item_title, v_item_barcode
    from public.item_types it
    where it.id = v_item_id;
  end if;

  if tg_table_name = 'item_types' then
    v_item_title := coalesce(v_item_title, v_new ->> 'title', v_old ->> 'title');
    v_item_barcode := coalesce(v_item_barcode, v_new ->> 'barcode', v_old ->> 'barcode');
  end if;

  if v_location_id is not null then
    select l.location_name, l.store_id
      into v_location_name, v_store_id
    from public.locations l
    where l.id = v_location_id;
  end if;

  if tg_table_name = 'locations' then
    v_location_name := coalesce(v_location_name, v_new ->> 'location_name', v_old ->> 'location_name');
    v_store_id := coalesce(v_store_id, nullif(coalesce(v_new ->> 'store_id', v_old ->> 'store_id'), '')::uuid);
  end if;

  if v_store_id is not null then
    select s.name
      into v_store_name
    from public.store_locations s
    where s.id = v_store_id;
  end if;

  select e.email
    into v_worker_email
  from public.employees e
  where e.user_id = v_worker_id
  limit 1;

  begin
    v_jwt_email := (current_setting('request.jwt.claims', true)::jsonb ->> 'email');
  exception when others then
    v_jwt_email := null;
  end;

  v_worker_email := coalesce(
    v_worker_email,
    v_new ->> 'added_by_email',
    v_old ->> 'added_by_email',
    v_new ->> 'confirmation_email',
    v_old ->> 'confirmation_email',
    v_jwt_email
  );

  v_summary := case
    when tg_table_name = 'item_types' and v_action = 'insert' then 'Created item type'
    when tg_table_name = 'item_types' and v_action = 'update' then 'Updated item type'
    when tg_table_name = 'item_types' and v_action = 'delete' then 'Deleted item type'
    when tg_table_name = 'item_stock_locations' and v_action = 'insert' then 'Added stock placement'
    when tg_table_name = 'item_stock_locations' and v_action = 'update' then 'Updated stock placement'
    when tg_table_name = 'item_stock_locations' and v_action = 'delete' then 'Removed stock placement'
    when tg_table_name = 'locations' and v_action = 'insert' then 'Created location or tray'
    when tg_table_name = 'locations' and v_action = 'update' then 'Updated location or tray'
    when tg_table_name = 'locations' and v_action = 'delete' then 'Deleted location or tray'
    else initcap(v_action) || ' ' || tg_table_name
  end;

  insert into public.inventory_change_log (
    table_name,
    record_id,
    action,
    item_id,
    item_title,
    item_barcode,
    location_id,
    location_name,
    store_id,
    store_name,
    worker_id,
    worker_email,
    changed_fields,
    old_data,
    new_data,
    summary
  )
  values (
    tg_table_name,
    v_record_id,
    v_action,
    v_item_id,
    v_item_title,
    v_item_barcode,
    v_location_id,
    v_location_name,
    v_store_id,
    v_store_name,
    v_worker_id,
    v_worker_email,
    v_changed_fields,
    nullif(v_old, '{}'::jsonb),
    nullif(v_new, '{}'::jsonb),
    v_summary
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_item_types_inventory_change_log on public.item_types;
create trigger trg_item_types_inventory_change_log
after insert or update or delete on public.item_types
for each row
execute function public.log_inventory_change();

drop trigger if exists trg_item_stock_locations_inventory_change_log on public.item_stock_locations;
create trigger trg_item_stock_locations_inventory_change_log
after insert or update or delete on public.item_stock_locations
for each row
execute function public.log_inventory_change();

drop trigger if exists trg_locations_inventory_change_log on public.locations;
create trigger trg_locations_inventory_change_log
after insert or update or delete on public.locations
for each row
execute function public.log_inventory_change();
