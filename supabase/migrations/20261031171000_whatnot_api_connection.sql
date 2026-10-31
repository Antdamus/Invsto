begin;
create table public.whatnot_api_connection (
 singleton boolean primary key default true check(singleton),seller_id text not null,seller_name text not null,
 credentials text not null check(credentials like 'v1.%'),authorized_by uuid not null references auth.users(id),connected_at timestamptz not null default now(),expires_at timestamptz,
 enabled boolean not null default true,last_synced_at timestamptz,last_full_sync_at timestamptz,last_error text,next_sync_at timestamptz not null default now(),
 page_cursor text,full_in_progress boolean not null default true,orders_processed integer not null default 0,
 dispatch_token uuid,lease_until timestamptz,claimed boolean not null default false
);
alter table public.whatnot_api_connection enable row level security;
revoke all on public.whatnot_api_connection from public,anon,authenticated;
grant all on public.whatnot_api_connection to service_role;
create function public.whatnot_api_authorizer_allowed(_user uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.employees e join auth.users u on u.id=e.user_id where e.user_id=_user and e.role='admin' and e.active is distinct from false);
$$;
create function public.install_whatnot_connection(_seller text,_name text,_credentials text,_actor uuid,_expires timestamptz) returns void language plpgsql security definer set search_path='' as $$
declare c public.whatnot_api_connection;
begin
 perform pg_advisory_xact_lock(hashtext('whatnot-install'));
 select * into c from public.whatnot_api_connection where singleton for update;
 if not public.whatnot_api_authorizer_allowed(_actor) then raise exception 'Active administrator required';end if;
 if found and (c.seller_id<>_seller or c.lease_until>now()) then raise exception 'Different account or sync in progress';end if;
 if lower(_name)<>'ogjewelers' then raise exception 'Connect the ogjewelers seller account';end if;
 insert into public.whatnot_api_connection(singleton,seller_id,seller_name,credentials,authorized_by,expires_at)
 values(true,_seller,_name,_credentials,_actor,_expires)
 on conflict(singleton) do update set credentials=excluded.credentials,authorized_by=excluded.authorized_by,expires_at=excluded.expires_at,connected_at=now(),enabled=true,last_error=null,next_sync_at=now();
end$$;
create function public.claim_whatnot_worker(_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.whatnot_api_connection;
begin
 update public.whatnot_api_connection set claimed=true,full_in_progress=full_in_progress or last_full_sync_at is null or last_full_sync_at<now()-interval '6 hours'
 where singleton and enabled and dispatch_token=_token and lease_until>now() and not claimed returning * into c;
 if not found then return null;end if;return to_jsonb(c);
end$$;
create function public.import_whatnot_worker_order(_token uuid,_record jsonb) returns void language plpgsql security definer set search_path='' as $$
declare c public.whatnot_api_connection;
begin
 select * into c from public.whatnot_api_connection where singleton for update;
 if not found or not c.enabled or not c.claimed or c.dispatch_token is distinct from _token or c.lease_until<=now() then raise exception 'Sync lease expired';end if;
 perform public.import_whatnot_order(_record);
end$$;
create function public.dispatch_whatnot_worker() returns void language plpgsql security definer set search_path='' as $$
declare c public.whatnot_api_connection;t uuid;
begin
 select * into c from public.whatnot_api_connection where singleton for update skip locked;
 if not found or not c.enabled or c.lease_until>now() or c.next_sync_at>now() then return;end if;
 t:=gen_random_uuid();update public.whatnot_api_connection set dispatch_token=t,lease_until=now()+interval '3 minutes',claimed=false where singleton;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/whatnot-order-sync',headers:='{"Content-Type":"application/json"}'::jsonb,body:=jsonb_build_object('workerToken',t),timeout_milliseconds:=120000);
end$$;
revoke all on function public.whatnot_api_authorizer_allowed(uuid),public.install_whatnot_connection(text,text,text,uuid,timestamptz),public.claim_whatnot_worker(uuid),public.import_whatnot_worker_order(uuid,jsonb),public.dispatch_whatnot_worker() from public,anon,authenticated;
grant execute on function public.whatnot_api_authorizer_allowed(uuid),public.install_whatnot_connection(text,text,text,uuid,timestamptz),public.claim_whatnot_worker(uuid),public.import_whatnot_worker_order(uuid,jsonb),public.dispatch_whatnot_worker() to service_role;
select cron.schedule('invsto-whatnot-orders','* * * * *','select public.dispatch_whatnot_worker();');
commit;
