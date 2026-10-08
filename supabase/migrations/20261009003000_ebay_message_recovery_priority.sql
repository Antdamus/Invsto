-- Drain historical failures in bounded batches while prioritizing new failures.
begin;
do $$
declare signature regprocedure:='public.claim_ebay_message_recovery(uuid)'::regprocedure;
 definition text:=pg_get_functiondef(signature);
begin
 if position('order by recovery_after,received_at limit 3 for update skip locked' in definition)=0 then
  raise exception 'Message recovery claim changed; inspect before applying';
 end if;
 definition:=replace(definition,'order by recovery_after,received_at limit 3 for update skip locked',
  'order by (received_at>now()-interval ''1 day'') desc,recovery_after,received_at desc limit 10 for update skip locked');
 definition:=replace(definition,'returning n.id,n.ebay_conversation_id,n.conversation_type,n.ebay_message_id,n.recovery_attempts',
  'returning n.id,n.ebay_conversation_id,n.conversation_type,n.ebay_message_id,n.recovery_attempts,n.received_at');
 execute replace(definition,'jsonb_agg(to_jsonb(claimed))',
  'jsonb_agg(to_jsonb(claimed) order by (claimed.received_at>now()-interval ''1 day'') desc,claimed.received_at desc)');
end $$;
commit;
