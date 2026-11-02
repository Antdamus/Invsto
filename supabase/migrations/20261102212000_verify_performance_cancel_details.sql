begin;
alter function public.finish_ebay_health_job(uuid,jsonb,integer,text) rename to finish_verified_ebay_health_job;
revoke all on function public.finish_verified_ebay_health_job(uuid,jsonb,integer,text) from public,anon,authenticated;
create function public.finish_ebay_health_job(_ticket uuid,_rows jsonb,_count integer,_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.require_ebay_health_admin();
 if _error is null and exists(
  select from public.ebay_health_jobs j join public.ebay_health_cases c on c.id=j.id
   where j.ticket=_ticket and j.kind='case_detail' and
    (lower(_rows#>>'{0,buyer}') is distinct from c.buyer or not exists
      (select from jsonb_array_elements_text(_rows#>'{0,items}') i(id) where i.id=any(c.items))))
 then raise exception 'Cancellation buyer and item do not match the store register';end if;
 perform public.finish_verified_ebay_health_job(_ticket,_rows,_count,_error);
end$$;
revoke all on function public.finish_ebay_health_job(uuid,jsonb,integer,text) from public,anon,authenticated;
grant execute on function public.finish_ebay_health_job(uuid,jsonb,integer,text) to authenticated;
commit;
notify pgrst,'reload schema';
