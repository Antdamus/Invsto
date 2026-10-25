begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create table public.tiktok_api_connection (
 singleton boolean primary key default true check(singleton),
 shop_id text not null, shop_cipher text not null, shop_name text not null,
 credentials text not null check(credentials like 'v1.%'),
 authorized_by uuid not null references auth.users(id), connected_at timestamptz not null default now(),
 enabled boolean not null default true, access_expires_at timestamptz not null, authorization_expires_at timestamptz not null,
 last_synced_at timestamptz, last_error text, next_sync_at timestamptz not null default now(),
 cursor_at timestamptz, window_from timestamptz, window_to timestamptz, page_token text,
 dispatch_token uuid, lease_until timestamptz, claimed boolean not null default false
);
create table public.tiktok_api_oauth_states (
 state_hash text primary key check(state_hash ~ '^[a-f0-9]{64}$'),
 requested_by uuid not null references auth.users(id), expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table public.tiktok_api_connection enable row level security;
alter table public.tiktok_api_oauth_states enable row level security;
revoke all on public.tiktok_api_connection,public.tiktok_api_oauth_states from public,anon,authenticated;
grant select,insert,update,delete on public.tiktok_api_connection,public.tiktok_api_oauth_states to service_role;
alter table public.tiktok_order_imports add column source text not null default 'csv' check(source in('csv','api'));
alter table public.tiktok_orders add column api_buyer_id text;
alter table public.tiktok_orders add column api_update_time timestamptz;
create index tiktok_orders_api_buyer on public.tiktok_orders(api_buyer_id) where api_buyer_id is not null;

create function public.consume_tiktok_oauth_state(_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
 delete from public.tiktok_api_oauth_states where state_hash=_hash and expires_at>now() returning requested_by into actor;
 delete from public.tiktok_api_oauth_states where expires_at<=now();
 return actor;
end$$;

create function public.tiktok_api_authorizer_allowed(_user uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare allowed boolean; previous_claims text:=current_setting('request.jwt.claims',true); previous_sub text:=current_setting('request.jwt.claim.sub',true);
begin
 perform set_config('request.jwt.claim.sub',_user::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',_user,'role','authenticated')::text,true);
 allowed:=coalesce(public.is_admin(),false) and coalesce(public.can_manage_inventory(),false);
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 return allowed;
end$$;

create function public.install_tiktok_api_connection(_shop_id text,_shop_cipher text,_shop_name text,_credentials text,_actor uuid,_access_expires timestamptz,_authorization_expires timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare c public.tiktok_api_connection;
begin
 perform pg_advisory_xact_lock(hashtext('tiktok-api-install'));
 select * into c from public.tiktok_api_connection where singleton for update;
 if found and (c.shop_id<>_shop_id or c.lease_until>now()) then raise exception 'Connection changed or sync is running. Reconnect after it finishes.';end if;
 if not public.tiktok_api_authorizer_allowed(_actor) or _shop_id='7494924429697648413' or _shop_name ilike 'SANDBOX%' then raise exception 'Real US shop and administrator authorization required';end if;
 insert into public.tiktok_api_connection(singleton,shop_id,shop_cipher,shop_name,credentials,authorized_by,access_expires_at,authorization_expires_at)
 values(true,_shop_id,_shop_cipher,_shop_name,_credentials,_actor,_access_expires,_authorization_expires)
 on conflict(singleton) do update set shop_cipher=excluded.shop_cipher,shop_name=excluded.shop_name,credentials=excluded.credentials,
 authorized_by=excluded.authorized_by,access_expires_at=excluded.access_expires_at,authorization_expires_at=excluded.authorization_expires_at,
 connected_at=now(),enabled=true,last_error=null,next_sync_at=now(),dispatch_token=null,lease_until=null,claimed=false;
end$$;

create function public.claim_tiktok_api_worker(_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.tiktok_api_connection;
begin
 update public.tiktok_api_connection set claimed=true,
  window_from=coalesce(window_from,cursor_at-interval '5 minutes',now()-interval '90 days'),
  window_to=coalesce(window_to,date_trunc('second',now()-interval '10 seconds'))
 where singleton and enabled and dispatch_token=_token and lease_until>now() and not claimed returning * into c;
 if not found then return null;end if;
 return to_jsonb(c);
end$$;

create function public.import_tiktok_api_order(_token uuid,_rows jsonb,_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.tiktok_api_connection; result jsonb; r jsonb; imp uuid; o public.tiktok_orders; l public.tiktok_order_lines;
 previous_claims text:=current_setting('request.jwt.claims',true); previous_sub text:=current_setting('request.jwt.claim.sub',true); actor_email text;
begin
 select * into c from public.tiktok_api_connection where singleton for update;
 if not found or not c.enabled or not c.claimed or c.dispatch_token is distinct from _token or c.lease_until<=now() then raise exception 'TikTok sync lease expired';end if;
 if jsonb_typeof(_rows) is distinct from 'array' or jsonb_array_length(_rows) not between 1 and 10000
  or (select count(distinct value->>'order_number') from jsonb_array_elements(_rows))<>1 then raise exception 'Import one complete TikTok order';end if;
 select email into actor_email from auth.users where id=c.authorized_by;
 -- Existing importer validates the authorizing staff account and all fulfillment guards.
 -- Audit records explicitly identify automated API work under this authorization.
 perform set_config('request.jwt.claim.sub',c.authorized_by::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',c.authorized_by,'role','authenticated','email',actor_email)::text,true);
 perform pg_advisory_xact_lock(hashtext('tiktok-orders'));
 select * into o from public.tiktok_orders where order_number=_rows->0->>'order_number';
 -- API does not supply CSV usernames, seller notes or all package metadata. Preserve known values.
 select jsonb_agg(x || jsonb_build_object(
  'buyer_username',coalesce(nullif(o.buyer_username,''),x->>'buyer_username'),
  'buyer_nickname',coalesce(nullif(x->>'buyer_nickname',''),o.buyer_nickname,''),
  'seller_note',o.seller_note,'ship_by_date',case when o.ship_by_source='staff' then null else x->>'ship_by_date' end,
  'shipped_time',coalesce(x->>'shipped_time',o.shipped_time),
  'package_id',coalesce(nullif(x->>'package_id',''),saved.package_id),
  'tracking_number',coalesce(nullif(x->>'tracking_number',''),saved.tracking_number)
 )) into _rows from jsonb_array_elements(_rows) x
 left join public.tiktok_order_lines saved on saved.order_id=o.id and saved.sku_id=x->>'sku_id';
 result:=public.import_tiktok_orders(_rows,_hash,'TikTok API · '||c.shop_name,c.window_to);
 imp:=(result->>'import_id')::uuid;
 if coalesce((result->>'already_imported')::boolean,false) or coalesce((result->>'stale')::integer,0)>0 then
  perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);return result;
 end if;
 update public.tiktok_order_imports set source='api' where id=imp;
 select * into o from public.tiktok_orders where order_number=_rows->0->>'order_number' and last_import_id=imp;
 if found then
  update public.tiktok_orders set api_buyer_id=_rows->0->>'api_buyer_id',api_update_time=(_rows->0->>'api_update_time')::timestamptz,
   ship_by_source=case when _rows->0->>'ship_by_date' is not null then 'TikTok API' else ship_by_source end where id=o.id;
  -- Once an API buyer is linked to a known CSV handle, reconcile only provisional labels.
  -- Do not replace staff/CSV handles, even when the buyer's display nickname changes.
  if o.buyer_username<>'TikTok buyer '||(_rows->0->>'api_buyer_id') then
   with reconciled as (
    update public.tiktok_orders set buyer_username=o.buyer_username,revision=revision+1,updated_at=now()
    where api_buyer_id=_rows->0->>'api_buyer_id' and buyer_username='TikTok buyer '||(_rows->0->>'api_buyer_id') returning id
   ) insert into public.tiktok_order_events(order_id,actor,action,details)
    select id,c.authorized_by,'api_buyer_linked',jsonb_build_object('source','api','automatic',true,'import_id',imp,'buyer_username',o.buyer_username) from reconciled;
  end if;
  for r in select value from jsonb_array_elements(_rows) loop
   if r->>'api_cancelled'='true' then
    select * into l from public.tiktok_order_lines where order_id=o.id and sku_id=r->>'sku_id';
    if l.cancelled_at is null then
     update public.tiktok_order_lines set cancelled_at=now(),cancellation_record=jsonb_build_object('source','api','import_id',imp,'reason','TikTok API confirms item cancellation','confirmed_at',now(),'authorized_by',c.authorized_by) where id=l.id;
     insert into public.tiktok_order_events(order_id,actor,action,details) values(o.id,c.authorized_by,'line_cancellation_imported',jsonb_build_object('source','api','automatic',true,'line_id',l.id,'sku_id',l.sku_id,'import_id',imp,'inventory_changed',false));
    end if;
   end if;
  end loop;
  update public.tiktok_order_events set details=details||jsonb_build_object('source','api','automatic',true,'authorized_by',c.authorized_by,'shop_id',c.shop_id)
   where order_id=o.id and details->>'import_id'=imp::text;
 end if;
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 return result;
end$$;

create function public.dispatch_tiktok_api_worker() returns void
language plpgsql security definer set search_path='' as $$
declare c public.tiktok_api_connection; token uuid;
begin
 select * into c from public.tiktok_api_connection where singleton for update skip locked;
 if not found or not c.enabled or c.lease_until>now() or c.next_sync_at>now() then return;end if;
 token:=gen_random_uuid();
 update public.tiktok_api_connection set dispatch_token=token,lease_until=now()+interval '3 minutes',claimed=false where singleton;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/tiktok-order-sync',
  headers:='{"Content-Type":"application/json"}'::jsonb,body:=jsonb_build_object('workerToken',token),timeout_milliseconds:=120000);
end$$;

revoke all on function public.install_tiktok_api_connection(text,text,text,text,uuid,timestamptz,timestamptz),public.tiktok_api_authorizer_allowed(uuid),public.consume_tiktok_oauth_state(text),public.claim_tiktok_api_worker(uuid),public.import_tiktok_api_order(uuid,jsonb,text),public.dispatch_tiktok_api_worker() from public,anon,authenticated;
grant execute on function public.install_tiktok_api_connection(text,text,text,text,uuid,timestamptz,timestamptz),public.tiktok_api_authorizer_allowed(uuid),public.consume_tiktok_oauth_state(text),public.claim_tiktok_api_worker(uuid),public.import_tiktok_api_order(uuid,jsonb,text),public.dispatch_tiktok_api_worker() to service_role;
select cron.schedule('invsto-tiktok-orders','* * * * *','select public.dispatch_tiktok_api_worker();');
commit;
