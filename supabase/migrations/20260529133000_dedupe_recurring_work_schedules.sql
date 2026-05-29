-- Clean old repeated recurring schedule rows and block future overlap.
-- The schedule UI supports one recurring assignment per worker/weekday/date.

delete from public.work_schedules
where effective_to is not null
  and effective_to < effective_from;

with normalized as (
  select
    ws.id,
    row_number() over (
      partition by
        ws.employee_id,
        ws.weekday,
        ws.start_local,
        ws.end_local,
        ws.effective_from,
        coalesce(ws.effective_to, 'infinity'::date),
        ws.active,
        coalesce(ws.store_id, '00000000-0000-0000-0000-000000000000'::uuid),
        coalesce(ws.note, ''),
        coalesce(ws.allow_clock_in_any_store, false),
        coalesce(ws.allow_clock_out_any_store, false),
        ws.allowed_in_key,
        ws.allowed_out_key
      order by ws.created_at desc, ws.id::text desc
    ) as rn
  from (
    select
      ws.*,
      coalesce((
        select string_agg(route_store.id::text, ',' order by route_store.id::text)
        from (
          select distinct route_id as id
          from unnest(coalesce(ws.allowed_clock_in_store_ids, '{}'::uuid[])) as route(route_id)
          where route_id is not null
        ) route_store
      ), '') as allowed_in_key,
      coalesce((
        select string_agg(route_store.id::text, ',' order by route_store.id::text)
        from (
          select distinct route_id as id
          from unnest(coalesce(ws.allowed_clock_out_store_ids, '{}'::uuid[])) as route(route_id)
          where route_id is not null
        ) route_store
      ), '') as allowed_out_key
    from public.work_schedules ws
  ) ws
),
deleted as (
  delete from public.work_schedules ws
  using normalized n
  where ws.id = n.id
    and n.rn > 1
  returning 1
)
select count(*) as exact_duplicate_rows_removed
from deleted;

do $$
declare
  v_changed integer := 0;
begin
  loop
    with conflicts as (
      select
        older.id,
        min(newer.effective_from) as cutoff
      from public.work_schedules older
      join public.work_schedules newer
        on newer.employee_id = older.employee_id
       and newer.weekday = older.weekday
       and newer.active is true
       and older.active is true
       and newer.id <> older.id
       and (
         older.created_at < newer.created_at
         or (
           older.created_at = newer.created_at
           and older.id::text < newer.id::text
         )
       )
       and daterange(older.effective_from, coalesce(older.effective_to, 'infinity'::date), '[]')
           && daterange(newer.effective_from, coalesce(newer.effective_to, 'infinity'::date), '[]')
      group by older.id
    ),
    removed as (
      delete from public.work_schedules ws
      using conflicts c
      where ws.id = c.id
        and c.cutoff <= ws.effective_from
      returning 1
    ),
    capped as (
      update public.work_schedules ws
      set effective_to = c.cutoff - 1
      from conflicts c
      where ws.id = c.id
        and c.cutoff > ws.effective_from
        and (ws.effective_to is null or ws.effective_to >= c.cutoff)
      returning 1
    )
    select (select count(*) from removed) + (select count(*) from capped)
      into v_changed;

    exit when v_changed = 0;
  end loop;
end
$$;

alter table public.work_schedules
  drop constraint if exists work_schedules_effective_range_check;

alter table public.work_schedules
  add constraint work_schedules_effective_range_check
  check (effective_to is null or effective_to >= effective_from);

create or replace function public.prevent_work_schedule_overlap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.active is not true then
    return new;
  end if;

  if new.effective_to is not null and new.effective_to < new.effective_from then
    raise exception 'Schedule effective_to cannot be before effective_from'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.work_schedules ws
    where ws.employee_id = new.employee_id
      and ws.weekday = new.weekday
      and ws.active is true
      and ws.id <> new.id
      and daterange(ws.effective_from, coalesce(ws.effective_to, 'infinity'::date), '[]')
          && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'A recurring schedule already exists for this worker and weekday in that date range'
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_work_schedule_overlap on public.work_schedules;
create trigger trg_prevent_work_schedule_overlap
before insert or update of employee_id, weekday, effective_from, effective_to, active
on public.work_schedules
for each row
execute function public.prevent_work_schedule_overlap();
