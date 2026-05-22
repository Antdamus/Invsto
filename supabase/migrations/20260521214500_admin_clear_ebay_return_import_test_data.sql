-- Admin-only cleanup for resetting eBay return export/import test data.
-- This intentionally removes only cases created by the eBay return extension
-- that have not had actual return intake items saved.

create or replace function public.admin_clear_ebay_return_import_test_data(
  _dry_run boolean default true
)
returns table (
  return_cases integer,
  return_tasks integer,
  return_task_events integer,
  return_events integer,
  complaint_storage_objects integer,
  dry_run boolean
)
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_case_ids uuid[] := '{}'::uuid[];
  v_task_ids uuid[] := '{}'::uuid[];
  v_storage_names text[] := '{}'::text[];
begin
  if not public.is_admin() then
    raise exception 'Only admins can clear eBay return import test data' using errcode = '42501';
  end if;

  select coalesce(array_agg(c.id), '{}'::uuid[])
    into v_case_ids
  from public.ebay_return_cases c
  where coalesce(c.raw_payload->>'source', '') = 'ebay_return_extension'
    and not exists (
      select 1
      from public.ebay_return_items i
      where i.return_case_id = c.id
    );

  select coalesce(array_agg(t.id), '{}'::uuid[])
    into v_task_ids
  from public.ebay_return_tasks t
  where t.return_case_id = any(v_case_ids);

  select coalesce(array_agg(distinct image_record->>'path'), '{}'::text[])
    into v_storage_names
  from public.ebay_return_cases c
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(c.raw_payload->'complaintImages', '[]'::jsonb)) = 'array'
        then coalesce(c.raw_payload->'complaintImages', '[]'::jsonb)
      else '[]'::jsonb
    end
    ||
    case
      when jsonb_typeof(coalesce(c.raw_payload->'returnDetails'->'complaintImages', '[]'::jsonb)) = 'array'
        then coalesce(c.raw_payload->'returnDetails'->'complaintImages', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) as image_record
  where c.id = any(v_case_ids)
    and image_record->>'bucket' = 'ebay-return-evidence'
    and image_record->>'path' like 'returns/ebay-complaints/%';

  select count(*)::integer
    into return_cases
  from public.ebay_return_cases
  where id = any(v_case_ids);

  select count(*)::integer
    into return_tasks
  from public.ebay_return_tasks
  where id = any(v_task_ids);

  select count(*)::integer
    into return_task_events
  from public.ebay_return_task_events
  where task_id = any(v_task_ids)
    or return_case_id = any(v_case_ids);

  select count(*)::integer
    into return_events
  from public.ebay_return_events
  where return_case_id = any(v_case_ids);

  select count(*)::integer
    into complaint_storage_objects
  from storage.objects
  where bucket_id = 'ebay-return-evidence'
    and name = any(v_storage_names);

  dry_run := coalesce(_dry_run, true);

  if not dry_run then
    delete from storage.objects
    where bucket_id = 'ebay-return-evidence'
      and name = any(v_storage_names);

    delete from public.ebay_return_cases
    where id = any(v_case_ids);
  end if;

  return next;
end;
$$;

grant execute on function public.admin_clear_ebay_return_import_test_data(boolean) to authenticated;
