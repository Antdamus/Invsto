begin;
set local lock_timeout='5s';

-- Retain the deployed inventory/bag reversal implementation and its lock order.
do $$ declare definition text; patched text; begin
  if to_regprocedure('public.admin_revert_ebay_order_lines_audited(uuid[],text,text)') is null then
    alter function public.admin_revert_ebay_order_lines(uuid[],text,text)
      rename to admin_revert_ebay_order_lines_audited;
  end if;
  definition:=pg_get_functiondef('public.admin_revert_ebay_order_lines_audited(uuid[],text,text)'::regprocedure);
  patched:=replace(definition,'if not public.is_admin() then','if not public.can_revert_order_fulfillment() then');
  if patched=definition and position('public.can_revert_order_fulfillment()' in definition)=0 then
    raise exception 'Unrecognized eBay reversal permission check; review before deploying';
  end if;
  patched:=replace(patched,'Only admins can revert eBay order fulfillment','Only active admins and managers can revert eBay order fulfillment');
  execute patched;
end $$;

create or replace function public.admin_revert_ebay_order_lines(
  _order_line_ids uuid[],_notes text,_signed_by_email text default null
) returns table(reverted_lines integer,restored_units integer,updated_orders integer)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  previous_context text:=current_setting('app.ebay_admin_reversal',true);
  signer_email text;
begin
  if not public.can_revert_order_fulfillment() then
    raise exception 'Only active admins and managers can revert orders' using errcode='42501';
  end if;
  if length(btrim(coalesce(_notes,''))) not between 3 and 2000 then
    raise exception 'A reversal note is required (3 to 2000 characters)' using errcode='22023';
  end if;
  if coalesce(cardinality(_order_line_ids),0) not between 1 and 200 then
    raise exception 'Select 1 to 200 order lines to revert' using errcode='22023';
  end if;
  select email::text into signer_email from auth.users where id=auth.uid();
  perform public.lock_shared_inventory();
  perform set_config('app.ebay_admin_reversal','on',true);
  -- The caller's email argument is retained for compatibility, never trusted.
  return query select * from public.admin_revert_ebay_order_lines_audited(
    array(select distinct v from unnest(_order_line_ids) v where v is not null order by v),btrim(_notes),signer_email
  );
  perform set_config('app.ebay_admin_reversal',coalesce(previous_context,''),true);
exception when others then
  perform set_config('app.ebay_admin_reversal',coalesce(previous_context,''),true);
  raise;
end $$;

-- A manager may use the same narrowly scoped CSV exception as an admin. The
-- existing function-owner/context checks continue to reject direct row edits.
do $$ declare name text; definition text; patched text; exception_check text; begin
  exception_check:=$guard$
  if tg_op = 'UPDATE'
    and current_setting('app.ebay_admin_reversal',true) = 'on'
    and public.can_revert_order_fulfillment()
    and current_user = pg_catalog.pg_get_userbyid((select proowner from pg_catalog.pg_proc
      where oid = 'public.admin_revert_ebay_order_lines(uuid[],text,text)'::regprocedure)) then
    return new;
  end if;
  $guard$;
  foreach name in array array['guard_pending_csv_order_import','guard_pending_csv_line_import'] loop
    -- Older installations predate the CSV guards. Do not introduce or replace
    -- unrelated import rules while installing the manager reversal wrapper.
    if to_regprocedure('public.'||name||'()') is null then continue;end if;
    definition:=pg_get_functiondef(('public.'||name||'()')::regprocedure);
    if position('app.ebay_admin_reversal' in definition)>0 then
      patched:=regexp_replace(definition,'coalesce\(public\.is_admin\(\),\s*false\)','public.can_revert_order_fulfillment()','g');
    elsif position('CSV imports cannot reopen completed' in definition)>0 then
      -- Upgrade a pre-wrapper guard without rewriting its import validation.
      patched:=regexp_replace(definition,'\mBEGIN\M', 'begin'||exception_check,'i');
    else
      raise exception 'Unrecognized CSV reversal guard in %',name;
    end if;
    if patched=definition and position('public.can_revert_order_fulfillment()' in definition)=0 then
      raise exception 'Missing audited CSV reversal guard in %',name;
    end if;
    execute patched;
  end loop;
end $$;

drop policy if exists ebay_order_revert_events_admin_select on public.ebay_order_revert_events;
create policy ebay_order_revert_events_admin_select on public.ebay_order_revert_events
for select to authenticated using((select public.can_revert_order_fulfillment()));
drop policy if exists ebay_order_revert_events_admin_insert on public.ebay_order_revert_events;
revoke insert,update,delete,truncate on public.ebay_order_revert_events from authenticated,anon;
grant select on public.ebay_order_revert_events to authenticated;
revoke all on function public.admin_revert_ebay_order_lines_audited(uuid[],text,text) from public,anon,authenticated,service_role;
revoke all on function public.admin_revert_ebay_order_lines(uuid[],text,text) from public,anon,service_role;
grant execute on function public.admin_revert_ebay_order_lines(uuid[],text,text) to authenticated;
notify pgrst,'reload schema';
commit;
