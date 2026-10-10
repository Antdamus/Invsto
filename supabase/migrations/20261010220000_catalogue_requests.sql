begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Client requests are not orders or synthetic tasks. Only staff checkout moves stock.
create table public.catalogue_requests (
 id uuid primary key default gen_random_uuid(),
 catalogue_id uuid not null references public.inventory_catalogues(id),
 receipt_token uuid not null unique,
 catalogue_title text not null,
 customer_name text not null check(length(customer_name) between 2 and 120),
 contact text not null check(length(contact) between 5 and 254),
 delivery text not null check(delivery in ('discuss','pickup','shipping')),
 customer_note text not null default '' check(length(customer_note)<=2000),
 items jsonb not null,
 total numeric(14,2) not null,
 credit_applied numeric(14,2) not null,
 balance numeric(14,2) not null,
 status text not null default 'pending_review' check(status in ('pending_review','changes_requested','approved','fulfilled','declined','cancelled')),
 public_message text not null default '',
 fulfillment_reference text,
 revision bigint not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id),
 check(total>=0 and credit_applied>=0 and balance=total-credit_applied and balance>=0)
);
create index catalogue_requests_queue on public.catalogue_requests(status,created_at desc);
create index catalogue_requests_catalogue on public.catalogue_requests(catalogue_id,status);
create table public.catalogue_request_events (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.catalogue_requests(id),
 revision bigint not null,
 status text not null,
 actor_id uuid references auth.users(id),
 message text not null default '',
 snapshot jsonb not null,
 created_at timestamptz not null default now(),
 unique(request_id,revision)
);
alter table public.catalogue_requests enable row level security;
alter table public.catalogue_request_events enable row level security;
create policy catalogue_requests_staff_read on public.catalogue_requests for select to authenticated using(public.can_manage_inventory());
create policy catalogue_request_events_staff_read on public.catalogue_request_events for select to authenticated using(public.can_manage_inventory());
grant select on public.catalogue_requests,public.catalogue_request_events to authenticated;
revoke all on public.catalogue_requests,public.catalogue_request_events from anon;

-- Serialize budget decisions using the parent catalogue row. Credits are a
-- catalogue allowance, not money movement or an assertion that payment was made.
create function public.catalogue_available_credit(_id uuid) returns numeric
language sql stable security definer set search_path='' as $$
 select case when c.credit is null then null else greatest(0,c.credit-coalesce((
  select sum(r.credit_applied) from public.catalogue_requests r where r.catalogue_id=c.id and r.status in ('approved','fulfilled')
 ),0)) end from public.inventory_catalogues c where c.id=_id;
$$;

create or replace function public.shared_inventory_catalogue(_token uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('title',c.title,'introduction',c.introduction,'credit',public.catalogue_available_credit(c.id),'currency','USD',
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',i.title,'description',coalesce(i.description,''),
   'retail_price',coalesce((entry->>'retail_override')::numeric,i.sale_price),'category',entry->>'category','photos',
    (select coalesce(jsonb_agg(p),'[]'::jsonb) from jsonb_array_elements_text(entry->'photos') p
     where p=any(coalesce(i.photos,'{}'::text[])||array[coalesce(i.photo_url,'')]))) order by ord)
   from jsonb_array_elements(c.items) with ordinality as chosen(entry,ord)
   join public.item_types i on i.id=(entry->>'id')::uuid
   where i.deleted_at is null and i.pricing_status is distinct from 'pending' and i.sale_price>0 and i.sale_price<>'NaN'::numeric),'[]'::jsonb))
 from public.inventory_catalogues c where c.share_token=_token and c.status='published';
$$;

-- A separate secret is required to read a request. A catalogue link can never
-- enumerate submissions or expose another client's name/contact/selection.
create function public.catalogue_request_receipt(_token uuid,_receipt uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('reference',upper(left(replace(r.id::text,'-',''),8)),
  'title',r.catalogue_title,'status',r.status,'revision',r.revision,'message',r.public_message,
  'total',r.total,'credit_applied',r.credit_applied,'balance',r.balance,'currency','USD',
  'delivery',r.delivery,'created_at',r.created_at,'updated_at',r.updated_at,
  'items',(select jsonb_agg(jsonb_build_object('id',i->>'id','name',i->>'name','retail_price',(i->>'retail_price')::numeric)) from jsonb_array_elements(r.items)i))
 from public.catalogue_requests r join public.inventory_catalogues c on c.id=r.catalogue_id
 where c.share_token=_token and r.receipt_token=_receipt;
$$;

create function public.submit_catalogue_request(_token uuid,_receipt uuid,_revision bigint,_name text,_contact text,_delivery text,_note text,_items jsonb,_expected_credit numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.inventory_catalogues; r public.catalogue_requests; public_data jsonb; clean jsonb; expected jsonb;
 total_price numeric; applied numeric; remaining numeric; resubmitting boolean:=false;
begin
 select * into c from public.inventory_catalogues where share_token=_token for update;
 if not found then raise exception 'catalogue_unavailable';end if;
 select * into r from public.catalogue_requests where receipt_token=_receipt for update;
 if found then
  if r.catalogue_id<>c.id then raise exception 'invalid_request';end if;
  -- Network retries return the original receipt, including after staff acted.
  if r.status<>'changes_requested' or _revision is distinct from r.revision then
   return public.catalogue_request_receipt(_token,_receipt);
  end if;
  resubmitting:=true;
 end if;
 if c.status<>'published' then raise exception 'catalogue_unavailable';end if;
 if _receipt is null or _name is null or length(trim(_name)) not between 2 and 120 or _contact is null or length(trim(_contact)) not between 5 and 254
  or _delivery is null or _delivery not in ('discuss','pickup','shipping') or length(coalesce(_note,''))>2000 then raise exception 'invalid_contact';end if;
 if _items is null or jsonb_typeof(_items)<>'array' or jsonb_array_length(_items) not between 1 and 100 then raise exception 'invalid_selection';end if;
 if (select count(distinct i->>'id') from jsonb_array_elements(_items)i)<>jsonb_array_length(_items) then raise exception 'invalid_selection';end if;
 -- Per-link bound protects the queue. Parent lock prevents concurrent bypass.
 if (select count(*) from public.catalogue_request_events e join public.catalogue_requests q on q.id=e.request_id
     where q.catalogue_id=c.id and e.actor_id is null and e.created_at>now()-interval '1 hour')>=10 then raise exception 'request_limit';end if;
 public_data:=public.shared_inventory_catalogue(_token);
 select jsonb_agg(i order by i->>'id'),sum((i->>'retail_price')::numeric) into clean,total_price
 from jsonb_array_elements(public_data->'items')i where i->>'id' in(select x->>'id' from jsonb_array_elements(_items)x);
 select jsonb_agg(jsonb_build_object('id',i->>'id','retail_price',(i->>'retail_price')::numeric) order by i->>'id') into expected from jsonb_array_elements(_items)i;
 if clean is null or jsonb_array_length(clean)<>jsonb_array_length(_items) or expected is distinct from
  (select jsonb_agg(jsonb_build_object('id',i->>'id','retail_price',(i->>'retail_price')::numeric) order by i->>'id') from jsonb_array_elements(clean)i)
 then raise exception 'selection_changed';end if;
 remaining:=public.catalogue_available_credit(c.id);
 if remaining is distinct from _expected_credit then raise exception 'selection_changed';end if;
 applied:=least(total_price,coalesce(remaining,0));
 if resubmitting then
  update public.catalogue_requests set customer_name=trim(_name),contact=trim(_contact),delivery=_delivery,customer_note=coalesce(_note,''),
   items=clean,total=total_price,credit_applied=applied,balance=total_price-applied,status='pending_review',public_message='',
   revision=revision+1,updated_at=now(),catalogue_title=c.title where id=r.id returning * into r;
 else
  insert into public.catalogue_requests(catalogue_id,receipt_token,catalogue_title,customer_name,contact,delivery,customer_note,items,total,credit_applied,balance)
   values(c.id,_receipt,c.title,trim(_name),trim(_contact),_delivery,coalesce(_note,''),clean,total_price,applied,total_price-applied) returning * into r;
 end if;
 insert into public.catalogue_request_events(request_id,revision,status,snapshot) values(r.id,r.revision,r.status,to_jsonb(r)-'receipt_token');
 -- A purposeful inbox notice, never an automatically generated task or SMS.
 if c.created_by is not null then
  insert into public.task_notifications(recipient_user_id,source,task_id,notification_type,title,body,metadata)
  values(c.created_by,'catalogue',r.id,'catalogue_request',case when resubmitting then 'Selection updated' else 'New client selection' end,
   c.title||' · '||jsonb_array_length(clean)||' pieces to review',jsonb_build_object('request_id',r.id,'revision',r.revision));
 end if;
 return public.catalogue_request_receipt(_token,_receipt);
end $$;

create function public.review_catalogue_request(_id uuid,_revision bigint,_action text,_message text default '',_reference text default '')
returns public.catalogue_requests language plpgsql security definer set search_path='' as $$
declare r public.catalogue_requests; c public.inventory_catalogues; target_status text;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Inventory staff access required';end if;
 select c0.* into c from public.inventory_catalogues c0 join public.catalogue_requests q on q.catalogue_id=c0.id where q.id=_id for update of c0;
 select * into r from public.catalogue_requests where id=_id for update;
 if not found then raise exception 'Request not found';end if;
 if r.revision is distinct from _revision then raise exception 'This request changed. Refresh before continuing.';end if;
 if length(coalesce(_message,''))>2000 then raise exception 'Keep the client message under 2000 characters';end if;
 target_status:=case _action when 'approve' then 'approved' when 'changes' then 'changes_requested' when 'decline' then 'declined' when 'fulfill' then 'fulfilled' when 'cancel' then 'cancelled' end;
 if target_status is null or not (
  (r.status='pending_review' and _action in ('approve','changes','decline')) or
  (r.status='changes_requested' and _action in ('cancel','decline')) or
  (r.status='approved' and _action in ('fulfill','cancel'))
 ) then raise exception 'This action is not available for the current status';end if;
 if _action in ('changes','decline','cancel') and length(trim(coalesce(_message,'')))<3 then raise exception 'Add a clear message for the client';end if;
 if _action='approve' then
  if c.status<>'published' then raise exception 'This catalogue is not published. Reopen its link before approval.';end if;
  if coalesce(public.catalogue_available_credit(c.id),0)<r.credit_applied then raise exception 'Catalogue credit changed. Request a revised selection before approval.';end if;
  if exists(select 1 from jsonb_array_elements(r.items)i left join public.item_types t on t.id=(i->>'id')::uuid
   where t.id is null or t.deleted_at is not null or t.pricing_status='pending') then raise exception 'An item is unavailable or awaiting pricing. Request changes first.';end if;
 end if;
 if _action='fulfill' and length(trim(coalesce(_reference,''))) not between 3 and 200 then raise exception 'Enter the completed stock checkout or sales reference';end if;
 update public.catalogue_requests set status=target_status,public_message=coalesce(_message,''),revision=revision+1,updated_at=now(),reviewed_by=auth.uid(),
  fulfillment_reference=case when _action='fulfill' then trim(_reference) else fulfillment_reference end where id=_id returning * into r;
 insert into public.catalogue_request_events(request_id,revision,status,actor_id,message,snapshot)
  values(r.id,r.revision,r.status,auth.uid(),coalesce(_message,''),to_jsonb(r)-'receipt_token');
 return r;
end $$;

revoke all on function public.catalogue_available_credit(uuid),public.catalogue_request_receipt(uuid,uuid),public.submit_catalogue_request(uuid,uuid,bigint,text,text,text,text,jsonb,numeric),public.review_catalogue_request(uuid,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.catalogue_request_receipt(uuid,uuid),public.submit_catalogue_request(uuid,uuid,bigint,text,text,text,text,jsonb,numeric) to service_role;
grant execute on function public.review_catalogue_request(uuid,bigint,text,text,text) to authenticated;

-- Preserve every existing type when extending the constraint.
do $$ declare definition text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='public.task_notifications'::regclass and conname='task_notifications_notification_type_check';
 execute 'alter table public.task_notifications drop constraint task_notifications_notification_type_check';
 execute 'alter table public.task_notifications add constraint task_notifications_notification_type_check check (notification_type=''catalogue_request'' or '||substring(definition from 7)||')';
end $$;
alter table public.task_notifications drop constraint task_notifications_source_check;
alter table public.task_notifications add constraint task_notifications_source_check check(source in ('team','order','return','catalogue'));

create or replace function public.notification_inbox(_category text default 'all', _view text default 'unread', _limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; recipient uuid:=auth.uid(); page_limit integer:=greatest(coalesce(_limit,30),1);
begin
 if recipient is null then raise exception 'Sign in to see your updates'; end if;
 if _category is null or _category not in ('all','tasks','buyers','returns','system','catalogues') or _view is null or _view not in ('unread','recent') then
  raise exception 'Unknown notification filter';
 end if;
 with notices as materialized (
  select n.id,n.recipient_user_id,n.source,n.task_id,n.notification_type,n.title,n.body,n.actor_email,n.priority,n.read_at,n.created_at,n.metadata,
   case when n.notification_type='catalogue_request' then 'catalogues' when n.notification_type='customer_issue_sync' then 'system'
    when n.notification_type in ('customer_issue_action','customer_issue_deadline') then
     case when coalesce(c.issue_kind,c.source_lane)='return' then 'returns' else 'buyers' end
    else 'tasks' end category
  from public.task_notifications n
  left join public.ebay_return_tasks t on n.source='return' and t.id=n.task_id
  left join public.ebay_return_cases c on c.id=coalesce(
   case when n.metadata->>'case_id' ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then (n.metadata->>'case_id')::uuid end,t.return_case_id)
   and n.notification_type in ('customer_issue_action','customer_issue_deadline')
  where n.recipient_user_id=recipient and (_view='recent' or n.read_at is null)
   -- Retain old notices in the audit data, but do not show synthetic task noise.
   and (t.id is null or public.customer_issue_is_employee_task(to_jsonb(t))
    or n.notification_type in ('customer_issue_action','customer_issue_deadline','customer_issue_sync'))
 ), visible as (select * from notices where (_category='all' or category=_category) and (_view='recent' or read_at is null))
 select jsonb_build_object(
  'unread_count',(select count(*) from notices where read_at is null),
  'counts',(select jsonb_build_object('all',count(*),'tasks',count(*) filter(where category='tasks'),'buyers',count(*) filter(where category='buyers'),
    'returns',count(*) filter(where category='returns'),'system',count(*) filter(where category='system'),'catalogues',count(*) filter(where category='catalogues')) from notices where read_at is null),
  'total',(select count(*) from visible),
  'entries',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from (select * from visible order by created_at desc,id desc limit page_limit)p),'[]'::jsonb),
  'unread',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from (select * from notices where read_at is null order by created_at desc,id desc limit 30)p),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.notification_inbox(text,text,integer) from public,anon;
grant execute on function public.notification_inbox(text,text,integer) to authenticated;

notify pgrst,'reload schema';
commit;
