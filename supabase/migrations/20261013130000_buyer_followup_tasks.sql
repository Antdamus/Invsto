begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- A customer promise is an ordinary team task with an explicit customer key.
-- Its existing assignment, completion, acceptance and evidence trail remain intact.
create unique index team_tasks_buyer_followup_request_idx
  on public.team_tasks(created_by, (metadata->>'buyer_followup_request_id'))
  where metadata->>'source' = 'buyer_followup';

create function public.create_buyer_followup_task(_buyer_username text, _details jsonb, _request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  buyer text := lower(btrim(_buyer_username));
  actor public.employees;
  details jsonb;
  result jsonb;
  existing public.team_tasks;
begin
  if auth.uid() is null or not coalesce(public.can_manage_inventory(), false) then
    raise exception 'Active staff access required' using errcode = '42501';
  end if;
  select * into actor from public.employees where user_id = auth.uid() and active is true limit 1;
  if not found then raise exception 'Active employee not found' using errcode = '42501'; end if;
  if buyer is null or buyer = '' or length(buyer) > 100 or buyer ~ '[[:space:]<>/@]' then
    raise exception 'Enter the exact eBay username, without a name, @ sign or profile URL' using errcode = '22023';
  end if;
  if _request_id is null or jsonb_typeof(_details) is distinct from 'object' then
    raise exception 'Task details and request ID are required' using errcode = '22023';
  end if;
  if nullif(btrim(_details->>'_title'), '') is null or length(_details->>'_title') > 200
    or nullif(btrim(_details->>'_description'), '') is null or length(_details->>'_description') > 10000 then
    raise exception 'Add a title (up to 200 characters) and specific instructions (up to 10,000 characters)' using errcode = '22023';
  end if;
  details := jsonb_build_object(
    '_title', btrim(_details->>'_title'), '_description', btrim(_details->>'_description'),
    '_task_type', 'customer_service', '_assigned_to_user_id', _details->'_assigned_to_user_id',
    '_priority', coalesce(_details->>'_priority', 'normal'), '_due_at', _details->'_due_at',
    '_photo_attachments', '[]'::jsonb, '_signed_by_email', actor.email);
  -- Retry the same save safely, including after a lost response.
  perform pg_advisory_xact_lock(hashtextextended('buyer-promise:' || buyer, 0));
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || _request_id::text, 0));
  select * into existing from public.team_tasks where created_by = auth.uid()
    and metadata->>'source' = 'buyer_followup' and metadata->>'buyer_followup_request_id' = _request_id::text;
  if found then
    if existing.metadata->>'buyer_username' is distinct from buyer
      or existing.metadata->'buyer_followup_request' is distinct from details then
      raise exception 'This save already created a different task. Open a new customer task to save these changes.' using errcode = '22023';
    end if;
    return to_jsonb(existing);
  end if;

  result := public.create_task_request('team', 'work', details);
  update public.team_tasks set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'source', 'buyer_followup', 'buyer_username', buyer,
    'buyer_followup_request_id', _request_id, 'buyer_followup_request', details)
  where id = (result->>'id')::uuid returning to_jsonb(team_tasks) into result;
  update public.team_task_events set payload = coalesce(payload, '{}'::jsonb)
    || jsonb_build_object('source', 'buyer_followup', 'buyer_username', buyer)
  where task_id = (result->>'id')::uuid and action = 'created';
  return result;
end $$;
revoke all on function public.create_buyer_followup_task(text,jsonb,uuid) from public, anon;
grant execute on function public.create_buyer_followup_task(text,jsonb,uuid) to authenticated;

-- Fulfillment staff need the promise even if a different teammate owns it.
-- This adds read access only to explicitly shared customer promises.
create policy buyer_followup_staff_read on public.team_tasks for select to authenticated
  using (auth.uid() is not null and public.can_manage_inventory() and metadata->>'source' = 'buyer_followup');
create policy buyer_followup_events_staff_read on public.team_task_events for select to authenticated
  using (auth.uid() is not null and public.can_manage_inventory() and exists (
    select 1 from public.team_tasks t where t.id = task_id and t.metadata->>'source' = 'buyer_followup'));

-- Preserve the deployed projection and its RLS, exclusions and evidence logic.
do $$
declare src text; updated text;
begin
  src := pg_get_functiondef('public.list_pending_customer_task_notes(text[])'::regprocedure);
  updated := replace(src, '''source'',a.source,''buyer_username'',a.buyer,',
    '''source'',a.source,''buyer_username'',a.buyer,''buyer_followup'',coalesce(task#>>''{metadata,source}''=''buyer_followup'',false),');
  if updated = src then raise exception 'Review the customer task notes projection before deploying'; end if;
  execute updated;
end $$;

notify pgrst, 'reload schema';
commit;
