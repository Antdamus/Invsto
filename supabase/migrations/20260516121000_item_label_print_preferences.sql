-- Track whether a newly-added item received individual labels or only one collective label.

alter table public.item_types
  add column if not exists label_print_strategy text not null default 'unreviewed',
  add column if not exists labels_per_order integer not null default 2,
  add column if not exists label_print_quantity integer,
  add column if not exists label_printed_at timestamptz,
  add column if not exists label_printed_by uuid references auth.users(id) on delete set null,
  add column if not exists label_printed_by_email text,
  add column if not exists collective_label_only boolean not null default false,
  add column if not exists label_print_notes text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'item_types_label_print_strategy_check'
      and conrelid = 'public.item_types'::regclass
  ) then
    alter table public.item_types
      add constraint item_types_label_print_strategy_check
      check (label_print_strategy in ('unreviewed', 'individual_batch', 'collective_only', 'deferred'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'item_types_labels_per_order_check'
      and conrelid = 'public.item_types'::regclass
  ) then
    alter table public.item_types
      add constraint item_types_labels_per_order_check
      check (labels_per_order >= 1);
  end if;
end $$;

create index if not exists item_types_label_print_strategy_idx
  on public.item_types(label_print_strategy, created_at desc);

create or replace function public.set_item_label_print_preference(
  _item_id uuid,
  _strategy text,
  _labels_per_order integer default null,
  _label_print_quantity integer default null,
  _notes text default null
)
returns public.item_types
language plpgsql
security definer
set search_path = public
as $$
declare
  v_strategy text := lower(nullif(btrim(coalesce(_strategy, '')), ''));
  v_labels_per_order integer := greatest(1, coalesce(_labels_per_order, 2));
  v_label_print_quantity integer := case
    when _label_print_quantity is null then null
    else greatest(0, _label_print_quantity)
  end;
  v_email text;
  v_item public.item_types;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update item label preference' using errcode = '42501';
  end if;

  if v_strategy not in ('individual_batch', 'collective_only', 'deferred') then
    raise exception 'Invalid label print strategy: %', coalesce(_strategy, '') using errcode = '22023';
  end if;

  begin
    v_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
  exception when others then
    v_email := null;
  end;

  update public.item_types
  set
    label_print_strategy = v_strategy,
    labels_per_order = v_labels_per_order,
    label_print_quantity = case
      when v_strategy = 'deferred' then null
      else v_label_print_quantity
    end,
    label_printed_at = case
      when v_strategy = 'deferred' then label_printed_at
      else now()
    end,
    label_printed_by = auth.uid(),
    label_printed_by_email = v_email,
    collective_label_only = (v_strategy = 'collective_only'),
    label_print_notes = nullif(btrim(coalesce(_notes, '')), '')
  where id = _item_id
  returning * into v_item;

  if v_item.id is null then
    raise exception 'Item was not found' using errcode = 'P0002';
  end if;

  return v_item;
end;
$$;

revoke all on function public.set_item_label_print_preference(uuid, text, integer, integer, text) from public;
grant execute on function public.set_item_label_print_preference(uuid, text, integer, integer, text) to authenticated;
