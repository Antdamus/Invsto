begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Counts alone cannot establish event membership when Sold cards are reused.
create or replace function public.ebay_live_recovery_status(_event_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.ebay_live_connections;history jsonb;phase text;saved integer;paid integer;issues integer;listings integer;unmatched integer;pending integer;captured_total numeric;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 if not found then return null;end if;
 history:=coalesce(c.history_recovery,'{}');phase:=coalesce(history->>'phase','unknown');
 select count(*) filter(where event_exclusion is null),count(*) filter(where payment_state='paid' and resolved_at is null),
  count(*) filter(where payment_state<>'paid' and resolved_at is null),count(distinct listing_id)
  into saved,paid,issues,listings from public.ebay_live_attempts where event_id=_event_id and merged_into is null;
 select count(*) into unmatched from public.ebay_live_observations where event_id=_event_id and disposition in ('unmatched','review');
 pending:=case when coalesce(c.health->>'pending','')~'^[0-9]{1,9}$' then (c.health->>'pending')::int else 0 end;
 if phase='read' and (coalesce((history->>'activity_passes')::int,0)<2 or coalesce((history->>'listing_passes')::int,0)<2
  or history->>'sold_expected' is null or (history->>'sold_expected')::int is distinct from (history->>'sold_seen')::int
  or listings<(history->>'sold_expected')::int) then phase:='needs_review';end if;
 select coalesce(sum(amount),0) into captured_total from public.ebay_live_attempts where event_id=_event_id and merged_into is null and resolved_at is null;
 if phase='read' and history->>'live_sales' is not null and captured_total is distinct from (history->>'live_sales')::numeric then
  phase:='needs_review';history:=history||jsonb_build_object('reason','live_sales');
 end if;
 if phase='live' and c.broadcast_ended_at is not null then phase:='needs_review';end if;
 if phase='reading' and (history->>'observed_at')::timestamptz<now()-interval '30 seconds' then phase:='paused';end if;
 if pending>0 and phase<>'reading' then phase:='syncing';end if;
 return history||jsonb_build_object('phase',phase,'saved_auctions',saved,'paid_auctions',paid,'payment_issues',issues,
  'excluded_listings',(select count(*) from public.ebay_live_attempts where event_id=_event_id and event_exclusion is not null),'captured_total',captured_total,'saved_listings',listings,'unmatched_notifications',unmatched,'pending',pending,
  'can_close',phase not in ('reading','syncing','live'),'requires_manual_note',phase in ('paused','needs_review'));
end $$;

commit;
