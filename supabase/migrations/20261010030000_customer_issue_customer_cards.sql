begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Project only identity fields from the exact linked order. Keep each shipping
-- address as one snapshot; never fill its gaps with a registration/seller address.
create or replace function public.customer_issue_order_contact(_buyer_name text,_raw jsonb)
returns jsonb language sql immutable set search_path='' as $$
 with source as (
  select coalesce(_raw,'{}'::jsonb) r
 ), candidates as (
  select priority,ship from source cross join lateral (values
   (1,r#>'{order,fulfillmentStartInstructions,0,shippingStep,shipTo}'),
   (2,r#>'{fulfillmentStartInstructions,0,shippingStep,shipTo}'),
   (3,jsonb_build_object('fullName',r#>>'{first_row,Ship To Name}','contactAddress',jsonb_build_object(
    'addressLine1',r#>>'{first_row,Ship To Address 1}','addressLine2',r#>>'{first_row,Ship To Address 2}',
    'city',r#>>'{first_row,Ship To City}','stateOrProvince',r#>>'{first_row,Ship To State}',
    'postalCode',r#>>'{first_row,Ship To Zip}','countryCode',r#>>'{first_row,Ship To Country}')))
  ) s(priority,ship)
 ), shipping as (
  select ship from candidates where jsonb_typeof(ship->'contactAddress')='object' and exists (
   select 1 from jsonb_each_text(case when jsonb_typeof(ship->'contactAddress')='object' then ship->'contactAddress' else '{}'::jsonb end) a where a.key in ('addressLine1','addressLine2','city','stateOrProvince','postalCode','countryCode') and nullif(btrim(a.value),'') is not null
  ) order by priority limit 1
 ) select jsonb_build_object(
  'customer_name',coalesce(nullif(btrim(_buyer_name),''),nullif(btrim(r#>>'{first_row,Buyer Name}'),''),
   nullif(btrim(r#>>'{order,fulfillmentStartInstructions,0,shippingStep,shipTo,fullName}'),''),
   nullif(btrim(r#>>'{fulfillmentStartInstructions,0,shippingStep,shipTo,fullName}'),''),
   nullif(btrim(r#>>'{order,buyer,buyerRegistrationAddress,fullName}'),''),
   nullif(btrim(r#>>'{buyer,buyerRegistrationAddress,fullName}'),''),nullif(btrim(r#>>'{first_row,Ship To Name}'),'')),
  'shipping_name',nullif(btrim((select ship->>'fullName' from shipping)),''),
  'shipping_address',(select jsonb_strip_nulls(jsonb_build_object(
   'line1',nullif(btrim(ship#>>'{contactAddress,addressLine1}'),''),'line2',nullif(btrim(ship#>>'{contactAddress,addressLine2}'),''),
   'city',nullif(btrim(ship#>>'{contactAddress,city}'),''),'state',nullif(btrim(ship#>>'{contactAddress,stateOrProvince}'),''),
   'postal_code',nullif(btrim(ship#>>'{contactAddress,postalCode}'),''),'country',nullif(btrim(ship#>>'{contactAddress,countryCode}'),''))) from shipping)
 ) from source
$$;
revoke all on function public.customer_issue_order_contact(text,jsonb) from public,anon;
grant execute on function public.customer_issue_order_contact(text,jsonb) to authenticated;

create or replace function public.list_customer_issues(_view text,_scope text,_search text,_offset int,_limit int,_sort text)
returns jsonb language sql stable security invoker set search_path='' as $$
 with task_rows as (
  select t.return_case_id,t.id,t.status,t.assigned_to_user_id,t.assigned_by,t.created_by,t.due_at,t.priority,
   case when t.status='deferred' and t.metadata->>'customer_issue_watch'='true' then null when t.status in ('completed_by_employee','pending_admin_review','ready_for_admin_approval','waiting_on_admin') or t.metadata->>'request_kind'='decision'
    then public.customer_issue_task_reviewer(t.id) else t.assigned_to_user_id end next_user,
   (t.status='deferred' and t.metadata->>'customer_issue_watch'='true') watching,
   t.status not in ('resolved','cancelled','closed','approved_by_admin') active
  from public.ebay_return_tasks t
 ), summaries as (
  select c.id,c.source_lane,c.issue_kind,c.ebay_return_id,c.order_id,c.order_number,c.buyer_username,c.return_reason,c.status,c.ebay_status,c.ebay_action,c.ebay_due_at,c.synced_at,c.sync_error,coalesce(nullif(c.item_title,''),price.item_title) item_title,c.item_image_url,c.opened_at,c.updated_at,o.sale_date order_placed_at,
   case when c.source_lane='payment_dispute' and c.raw_payload#>>'{ebayDetail,paymentDisputeId}'=c.ebay_return_id then c.raw_payload#>>'{ebayDetail,sellerResponse}' end seller_response,
   contact.data->>'customer_name' customer_name,
   case when c.issue_kind='return' then contact.data->>'shipping_name' end shipping_name,
   case when c.issue_kind='return' then contact.data->'shipping_address' end shipping_address,
   price.item_value,price.item_currency,price.linked_line_count,
   coalesce(ts.open_tasks,0) open_tasks,coalesce(ts.watching_tasks,0) watching_tasks,ts.next_user,ts.task_id,coalesce(ts.mine,false) mine,coalesce(ts.following,false) following,
   coalesce(ts.unassigned,true) unassigned,ts.follow_up_at,
   (c.status not in ('closed','cancelled') or coalesce(ts.open_tasks,0)>0) active,
   coalesce(c.ebay_due_at<now() and coalesce(c.ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)',false) overdue,
   (c.synced_at is null or c.synced_at<now()-interval '30 minutes') stale
  from public.ebay_return_cases c
  left join public.ebay_orders o on o.id=c.order_id
  left join lateral (select public.customer_issue_order_contact(o.buyer_name,o.raw_payload) data) contact on true
  left join lateral (
   select count(*)::int linked_line_count,string_agg(item_title,' · ' order by id) item_title,
    case when count(value)=count(*) and count(distinct currency)=1 then sum(value) end item_value,
    case when count(distinct currency)=1 then min(currency) end item_currency
   from (
    select l.id,l.item_title,nullif(l.sold_for,0)*l.quantity value,
     coalesce(nullif(l.raw_payload#>>'{line,total,currency}',''),nullif(l.raw_payload#>>'{line,lineItemCost,currency}',''),'USD') currency
    from public.ebay_order_lines l where l.order_id=c.order_id and (
     exists(select 1 from public.ebay_return_items i where i.return_case_id=c.id and i.order_line_id=l.id)
     or exists(select 1 from public.ebay_return_tasks t where t.return_case_id=c.id and l.id=any(t.order_line_ids))
     or coalesce(c.raw_payload->'manualOrderMatch'->'line_ids','[]') @> to_jsonb(array[l.id])
     or (not(c.raw_payload ? 'manualOrderMatch') and coalesce(c.raw_payload->'automaticOrderMatch'->'line_ids','[]') @> to_jsonb(array[l.id]))
    )
   ) matched
  ) price on true
  left join lateral (
   select count(*) filter(where t.active)::int open_tasks,count(*) filter(where t.active and t.watching)::int watching_tasks,
    (array_agg(t.next_user order by (t.active and not coalesce(t.watching,false)) desc,t.active desc,t.due_at nulls last,t.id))[1] next_user,
    (array_agg(t.id order by (t.active and not coalesce(t.watching,false)) desc,t.active desc,t.due_at nulls last,t.id))[1] task_id,
    bool_or(t.active and t.next_user=auth.uid()) mine,
    bool_or(t.active and (auth.uid() in (t.assigned_to_user_id,t.assigned_by,t.created_by) or exists(select 1 from public.task_followers f where f.source='return' and f.task_id=t.id and f.user_id=auth.uid())) and t.next_user is distinct from auth.uid()) following,
    bool_or(t.active and not coalesce(t.watching,false) and t.next_user is null) unassigned,
    min(t.due_at) filter(where t.active) follow_up_at
   from task_rows t where t.return_case_id=c.id
  ) ts on true
  where public.can_access_post_order_issues()
   and (nullif(btrim(_search),'') is null or strpos(lower(concat_ws(' ',c.buyer_username,contact.data->>'customer_name',c.order_number,c.ebay_return_id,c.item_title,c.return_reason,c.return_tracking_number)),lower(btrim(_search)))>0)
 ), scoped as (
  select * from summaries where _scope='all' or (_scope='mine' and mine) or (_scope='following' and following) or (_scope='unassigned' and unassigned and active) or (_scope='due' and active and ebay_due_at<=now()+interval '48 hours' and public.customer_issue_requires_action(to_jsonb(summaries))) or (_scope='monitoring' and watching_tasks>0)
 ), filtered as (
  select * from scoped where case when _view='history' then not active else active and (_view='attention' or issue_kind=_view) end
 ), page as (
  select * from filtered order by
   case when _sort='oldest' then opened_at end asc nulls last,
   case when _sort='order_newest' then order_placed_at end desc nulls last,
   case when _sort='order_oldest' then order_placed_at end asc nulls last,
   case when _sort='due_soonest' and coalesce(ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then ebay_due_at end asc nulls last,
   case when _sort='due_latest' and coalesce(ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then ebay_due_at end desc nulls last,
   case when _sort in ('value_highest','value_lowest') then item_value is null end asc,
   case when _sort in ('value_highest','value_lowest') then item_currency end asc nulls last,
   case when _sort='value_highest' then item_value end desc nulls last,
   case when _sort='value_lowest' then item_value end asc nulls last,
   opened_at desc nulls last,id
  offset greatest(0,_offset) limit least(100,greatest(1,_limit))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'),
  'total',(select count(*) from filtered),'counts',(select jsonb_build_object('attention',count(*) filter(where active),'request',count(*) filter(where active and issue_kind='request'),
  'return',count(*) filter(where active and issue_kind='return'),'dispute',count(*) filter(where active and issue_kind='dispute'),'history',count(*) filter(where not active)) from scoped))
$$;
revoke all on function public.list_customer_issues(text,text,text,int,int,text) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,int,int,text) to authenticated;


-- Keep cached clients working while the new sort control rolls out.
create or replace function public.list_customer_issues(_view text default 'attention',_scope text default 'all',_search text default '',_offset int default 0,_limit int default 30)
returns jsonb language sql stable security invoker set search_path='' as $$
 select public.list_customer_issues(_view,_scope,_search,_offset,_limit,'newest')
$$;
revoke all on function public.list_customer_issues(text,text,text,int,int) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,int,int) to authenticated;


notify pgrst, 'reload schema';
commit;
