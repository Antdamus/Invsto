begin;
-- The Seller Hub register may include an older purchase because payment arrived
-- this week. Accept that row only with a matching order, buyer, and sale minute
-- from Invsto's existing records, as well as an in-window payment date.
do $$declare
 src text:=pg_get_functiondef('public.finish_verified_ebay_health_job(uuid,jsonb,integer,text)'::regprocedure);
 guard text:='not between job.id::date and job.id::date+6)';
begin
 if strpos(src,guard)=0 then raise exception 'Unexpected order window validation';end if;
 execute replace(src,guard,$g$not between job.id::date and job.id::date+6
   and not coalesce((r->>'paid')::boolean and (r->>'paid_day')::date between job.id::date and job.id::date+6
    and ((r->>'purchased')::timestamptz at time zone 'America/Los_Angeles')::date < job.id::date
    and (exists(select from public.ebay_orders o where o.order_number=r->>'id' and lower(o.buyer_username)=lower(r->>'buyer')
      and date_trunc('minute',o.sale_date)=date_trunc('minute',(r->>'purchased')::timestamptz))
     or exists(select from public.ebay_health_orders o where o.id=r->>'id' and o.buyer=lower(r->>'buyer')
      and date_trunc('minute',o.purchased)=date_trunc('minute',(r->>'purchased')::timestamptz))),false))$g$);
end$$;
commit;
