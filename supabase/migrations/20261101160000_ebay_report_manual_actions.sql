begin;
set local lock_timeout='8s';
-- Timestamp the outcome, not the reservation for the next background attempt.
alter table public.ebay_claim_report_checks add column result_at timestamptz;
alter table public.ebay_report_browser_state add column seller_attention_at timestamptz;
create function public.ebay_report_seller_blocked(msg text) returns boolean language sql immutable set search_path='' as $$
 select coalesce(msg~*'sign in to the ogjewelers|seller account could not be verified|check (that ogjewelers is signed in|the signed-in eBay account)',false)
$$;
update public.ebay_report_browser_state set seller_attention_at=completed where public.ebay_report_seller_blocked(note);
create function public.stamp_ebay_seller_attention() returns trigger language plpgsql set search_path='' as $$
begin
 if public.ebay_report_seller_blocked(new.note) then new.seller_attention_at:=new.completed;
 elsif new.note~*'([1-9][0-9]* order pages checked|hold entr(y|ies) verified)' then new.seller_attention_at:=null;
 end if;
 return new;
end$$;
create trigger stamp_ebay_seller_attention before update of completed on public.ebay_report_browser_state
 for each row execute function public.stamp_ebay_seller_attention();
create function public.stamp_ebay_claim_report_result() returns trigger language plpgsql set search_path='' as $$
begin
 new.result_at:=now();
 if public.ebay_report_seller_blocked(new.note) then update public.ebay_report_browser_state set seller_attention_at=now() where singleton;
 end if;return new;
end$$;
create trigger stamp_ebay_claim_report_result before update of note on public.ebay_claim_report_checks
 for each row execute function public.stamp_ebay_claim_report_result();

-- Cheap enough for the collapsed dashboard: no transaction rows, credentials or money amounts.
create function public.ebay_report_manual_actions(_month date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
 today date:=(now() at time zone 'America/Los_Angeles')::date;
 first_day date:=date_trunc('month',today)::date;
 previous_month date:=(first_day-interval '1 month')::date;
 actions jsonb:='[]'; rec record; h public.ebay_account_holds%rowtype; b public.ebay_report_browser_state%rowtype;
 active_job boolean; login_needed boolean;
begin
 if auth.uid() is null or not exists(select from public.employees where user_id=auth.uid() and active and lower(role)='admin')
 then raise exception 'Active admin access required' using errcode='42501';end if;
 if _month is null or extract(day from _month)<>1 then raise exception 'Choose a purchase month';end if;
 select * into b from public.ebay_report_browser_state where singleton;
 select * into h from public.ebay_account_holds where singleton;
 active_job:=coalesce(b.lease_until>now(),false);
 login_needed:=b.seller_attention_at is not null and (h.verified_at is null or h.verified_at<=b.seller_attention_at);
 if login_needed then actions:=actions||jsonb_build_object('kind','seller');
 elsif not active_job then
  if (h.verified_at is null and (b.completed is not null or h.api_at<now()-interval '3 hours'))
    or h.verified_at<now()-interval '9 hours'
    or (h.api_at>h.verified_at and h.api_cents<>h.ledger_cents and h.verified_at<now()-interval '90 minutes'
        and (b.completed>h.api_at or b.completed is null or b.completed<now()-interval '3 hours')) then
   actions:=actions||jsonb_build_object('kind','holds','reason',case when h.verified_at is null then 'missing'
    when h.api_at>h.verified_at and h.api_cents<>h.ledger_cents then 'changed' else 'stale' end,'verified',h.verified_at);
  end if;
 end if;
 -- A generated CSV still being prepared at eBay is not an operator task.
 for rec in select k.month from public.ebay_claim_report_checks k
  join public.weekly_ebay_account_cash c using(month) left join public.weekly_ebay_claim_exports x using(month)
  where k.month<first_day and (x.checked_at is null or x.checked_at<k.result_at)
   and exists(select from jsonb_array_elements(c.movements) m where lower(m->>'label') in ('gross claims','claims') and (m->>'cents')::bigint<>0)
   and k.note~*'did not match the statement|could not verify the complete monthly CSV|date selector unavailable|could not verify the requested date|monthly date range was not accepted|filter does not include all activity'
  order by k.month desc loop
  actions:=actions||jsonb_build_object('kind','claims','month',rec.month);
 end loop;
 for rec in select c.month from public.weekly_ebay_account_cash c join public.ebay_verified_statements v using(month)
  where c.opening<>v.opening or c.closing<>v.closing or
   (select sum((r->>'cents')::bigint) from jsonb_array_elements(c.movements) r where lower(r->>'label')='payouts') is distinct from
   (select sum((r->>'cents')::bigint) from jsonb_array_elements(v.movements) r where lower(r->>'label')='payouts') order by c.month desc loop
  actions:=actions||jsonb_build_object('kind','statement','reason','mismatch','month',rec.month);
 end loop;
 -- The browser reads the latest published statement; older, skipped periods need a file.
 for rec in select distinct m from unnest(array[_month,previous_month]) s(m) where m<first_day
  and (m<previous_month or today>=first_day+7 or exists(select from public.weekly_ebay_account_cash where month>m))
  and not exists(select from public.weekly_ebay_account_cash where month=m)
  and exists(select from public.ebay_orders where sale_date>=m::timestamp at time zone 'America/New_York'
   and sale_date<(m+interval '1 month') at time zone 'America/New_York') order by m desc loop
  actions:=actions||jsonb_build_object('kind','statement','month',rec.m);
 end loop;
 -- A pending scope application or an API retry cannot be fixed by reconnecting.
 if exists(select from public.weekly_ebay_earnings_sync where connected_at is not null and last_error='eBay earnings authorization required')
 then actions:=actions||jsonb_build_object('kind','earnings');end if;
 return actions;
end$$;
revoke all on function public.ebay_report_manual_actions(date) from public,anon,authenticated;
grant execute on function public.ebay_report_manual_actions(date) to authenticated;
commit;
notify pgrst,'reload schema';
