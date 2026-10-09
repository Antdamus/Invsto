begin;
-- The return lifecycle is terminal even when its last action is ESCALATED.
-- Correct provider facts only: staff tasks and internal case status stay intact.
update public.ebay_return_cases set
 ebay_status='CLOSED_'||coalesce(ebay_status,'UNKNOWN'),ebay_due_at=null,ebay_action=null,
 raw_payload=raw_payload||jsonb_build_object('ebayClosedOnEbay',true),updated_at=now()
where raw_payload->>'returnState' ~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED)($|_)'
and coalesce(ebay_status,'') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)';
commit;
