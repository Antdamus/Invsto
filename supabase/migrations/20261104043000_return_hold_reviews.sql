begin;
set local lock_timeout='5s';

-- Staff review belongs to the eBay return ID, not to a refreshed ledger row or order.
create table public.ebay_return_hold_inspections (
  ref text not null, revision integer not null check(revision>0), inspected boolean not null,
  actor uuid not null, signer text not null, recorded_at timestamptz not null default clock_timestamp(),
  primary key(ref,revision)
);
create table public.ebay_return_hold_task_links (
  request_id uuid primary key, ref text not null, actor uuid not null, input jsonb not null,
  case_task uuid unique references public.ebay_return_tasks(id),
  team_task uuid unique references public.team_tasks(id),
  created_at timestamptz not null default clock_timestamp(),
  check(num_nonnulls(case_task,team_task)=1)
);
create index ebay_return_hold_task_ref on public.ebay_return_hold_task_links(ref);
alter table public.ebay_return_hold_inspections enable row level security;
alter table public.ebay_return_hold_task_links enable row level security;
revoke all on public.ebay_return_hold_inspections,public.ebay_return_hold_task_links from public,anon,authenticated;

create function public.ebay_return_hold_review(_ref text) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('mark',(select jsonb_build_object('inspected',inspected,'revision',revision,'signer',signer,'at',recorded_at)
    from public.ebay_return_hold_inspections where ref=_ref order by revision desc limit 1),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',coalesce(t.id,g.id),'status',coalesce(t.status,g.status),
      'owner',coalesce(e.display_name,t.assigned_to_email,g.assigned_to_email)) order by l.created_at desc)
    from public.ebay_return_hold_task_links l left join public.ebay_return_tasks t on t.id=l.case_task
    left join public.team_tasks g on g.id=l.team_task left join public.employees e on e.user_id=coalesce(t.assigned_to_user_id,g.assigned_to_user_id)
    where l.ref=_ref),'[]'::jsonb))
$$;
revoke all on function public.ebay_return_hold_review(text) from public,anon,authenticated;

create function public.ebay_hold_item_context(_row jsonb,_order uuid,_buyer text,_username text,_ship_name text)
returns jsonb language sql stable set search_path='' as $$
 with matches as materialized (
   select c.id,c.order_id,c.raw_payload,c.buyer_username,nullif(btrim(c.item_title),'') title
   from public.ebay_return_cases c
   where _row->>'kind'='return' and c.source_lane='return' and c.issue_kind='return' and c.ebay_return_id=_row->>'ref'
   and (_row->>'oid' is null or c.order_number is null or c.order_number=_row->>'oid')
   and (_order is null or c.order_id is null or c.order_id=_order)
 ), exact_case as (select * from matches where (select count(*) from matches)=1),
 case_order as (select o.buyer_name,o.buyer_username from public.ebay_orders o where _order is null and o.id=(select order_id from exact_case)),
 titles as (
   select 1 rank,l.id,coalesce(nullif(btrim(l.item_title),''),i.item_title,c.title) title,l.item_number
   from exact_case c join public.ebay_order_lines l on l.order_id=coalesce(c.order_id,_order)
   left join public.ebay_return_items i on i.return_case_id=c.id and i.order_line_id=l.id
   where case when c.raw_payload ? 'manualOrderMatch' then (c.raw_payload#>'{manualOrderMatch,line_ids}') @> to_jsonb(array[l.id])
     else i.id is not null or (c.raw_payload#>'{automaticOrderMatch,line_ids}') @> to_jsonb(array[l.id]) end
   union all select 2,null,title,null from exact_case where title is not null
   union all select 3,l.id,l.item_title,l.item_number from public.ebay_order_lines l where _row->>'kind'<>'return' and l.order_id=_order
 ), best as (select * from titles where rank=(select min(rank) from titles))
 select jsonb_strip_nulls(jsonb_build_object(
   'name',coalesce(nullif(btrim(_buyer),''),(select nullif(btrim(buyer_name),'') from case_order)),
   'ship_name',nullif(btrim(_ship_name),''),
   'user',coalesce(nullif(btrim(_username),''),(select nullif(btrim(buyer_username),'') from exact_case),(select nullif(btrim(buyer_username),'') from case_order)),
   'case_id',(select id from exact_case),
   'source',(select case min(rank) when 1 then 'line' when 2 then 'case' when 3 then 'order' end from best),
   'items',(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('title',title,'number',item_number,'id',id)) order by title,id) from best)))
$$;
revoke all on function public.ebay_hold_item_context(jsonb,uuid,text,text,text) from public,anon,authenticated;

do $$declare s text:=pg_get_functiondef('public.weekly_ebay_hold_snapshot()'::regprocedure);
  marker text:='jsonb_agg(r||case'; begin
  if strpos(s,marker)=0 then raise exception 'Unexpected hold snapshot definition';end if;
  execute replace(s,marker,$sql$jsonb_agg(r||jsonb_build_object('item_context',public.ebay_hold_item_context(r,e.id,
    coalesce(nullif(btrim(e.buyer_name),''),nullif(e.raw_payload#>>'{first_row,Buyer Name}',''),
      nullif(e.raw_payload#>>'{order,buyer,buyerRegistrationAddress,fullName}','')),e.buyer_username,
      coalesce(e.raw_payload#>>'{order,fulfillmentStartInstructions,0,shippingStep,shipTo,fullName}',e.raw_payload#>>'{first_row,Ship To Name}'))) ||case$sql$);
end$$;

-- Include review data in the same guarded weekly report snapshot; never alter eBay amounts.
do $$declare s text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
  marker text:='''ebay_account_holds'','; begin
  if strpos(s,marker)=0 then raise exception 'Unexpected weekly report definition';end if;
  execute replace(s,marker,$sql$'ebay_return_hold_reviews',case when _market in ('ebay','all') then
    (select coalesce(jsonb_object_agg(ref,public.ebay_return_hold_review(ref)),'{}'::jsonb)
     from (select r->>'ref' ref from public.ebay_account_holds h cross join lateral jsonb_array_elements(h.entries) r
       where h.singleton and r->>'kind'='return') active_returns) end,'ebay_account_holds',$sql$);
end$$;

create function public.require_return_hold_admin() returns void
language plpgsql stable set search_path='' as $$begin
  if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin')
    then raise exception 'Active admin access required' using errcode='42501'; end if;
end$$;
revoke all on function public.require_return_hold_admin() from public,anon,authenticated;

create function public.set_return_hold_inspected(_ref text,_inspected boolean,_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.ebay_return_hold_inspections; who text;
begin
  perform public.require_return_hold_admin();
  if _ref is null or _inspected is null or _revision is null or _revision<0 then raise exception 'Invalid inspection'; end if;
  perform pg_advisory_xact_lock(hashtextextended('return-hold:'||_ref,0));
  if not exists(select from public.ebay_account_holds where singleton and entries @> jsonb_build_array(jsonb_build_object('kind','return','ref',_ref)))
    then raise exception 'This return is no longer on hold. Refresh the report.'; end if;
  select * into prior from public.ebay_return_hold_inspections where ref=_ref order by revision desc limit 1;
  if coalesce(prior.inspected,false)=_inspected then return public.ebay_return_hold_review(_ref); end if;
  if _revision<>coalesce(prior.revision,0) then raise exception 'This inspection changed. Refresh the report before trying again.'; end if;
  select coalesce(nullif(btrim(display_name),''),email,auth.uid()::text) into who from public.employees where user_id=auth.uid() and active limit 1;
  insert into public.ebay_return_hold_inspections(ref,revision,inspected,actor,signer) values(_ref,_revision+1,_inspected,auth.uid(),who);
  return public.ebay_return_hold_review(_ref);
end$$;
revoke all on function public.set_return_hold_inspected(text,boolean,integer) from public,anon;
grant execute on function public.set_return_hold_inspected(text,boolean,integer) to authenticated;

create function public.create_return_hold_task(_request uuid,_ref text,_owner uuid,_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare entry jsonb; existing public.ebay_return_hold_task_links; signature jsonb; matched uuid[]; ct uuid; gt uuid; note text:=btrim(_note); context_line text;
begin
  perform public.require_return_hold_admin();
  if _request is null or _owner is null or _ref is null or nullif(note,'') is null or length(note)>4000
    then raise exception 'Choose an employee and describe the follow-up (up to 4,000 characters).'; end if;
  signature:=jsonb_build_object('ref',_ref,'owner',_owner,'note',note);
  perform pg_advisory_xact_lock(hashtextextended('return-hold-task:'||_request,0));
  select * into existing from public.ebay_return_hold_task_links where request_id=_request;
  if found then
    if existing.actor<>auth.uid() or existing.input<>signature then raise exception 'This task request was already used.'; end if;
    return public.ebay_return_hold_review(_ref);
  end if;
  select r into entry from public.ebay_account_holds h cross join lateral jsonb_array_elements(h.entries) r
    where h.singleton and r->>'kind'='return' and r->>'ref'=_ref;
  if entry is null then raise exception 'This return is no longer on hold. Refresh the report.'; end if;
  context_line:='eBay return hold '||_ref||coalesce(' · Order '||(entry->>'oid'),'');
  select array_agg(id) into matched from public.ebay_return_cases
    where ebay_return_id=_ref and source_lane='return' and issue_kind='return' and status not in ('closed','cancelled')
    and (entry->>'oid' is null or order_number is null or order_number=entry->>'oid');
  if cardinality(matched)=1 then
    ct:=public.request_customer_return_followup(_request,matched[1],_owner,'work',context_line||chr(10)||note,null);
  else
    -- A reserve can outlive its case, or arrive before a case is synced.
    gt:=(public.create_task_request('team','work',jsonb_build_object('_title',context_line,'_description',note,
      '_task_type','customer_service','_assigned_to_user_id',_owner,'_signed_by_email',auth.jwt()->>'email'))->>'id')::uuid;
  end if;
  insert into public.ebay_return_hold_task_links(request_id,ref,actor,input,case_task,team_task) values(_request,_ref,auth.uid(),signature,ct,gt);
  return public.ebay_return_hold_review(_ref);
end$$;
revoke all on function public.create_return_hold_task(uuid,text,uuid,text) from public,anon;
grant execute on function public.create_return_hold_task(uuid,text,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
