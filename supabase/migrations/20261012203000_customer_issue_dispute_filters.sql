begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Classify the same verified provider facts used by the card badges. Local
-- archiving is deliberately separate from the current eBay outcome.
create or replace function public.customer_issue_dispute_state(c jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare
 status text:=upper(coalesce(c->>'ebay_status',''));
 lane text:=c->>'source_lane';
 d jsonb:=case when c#>>'{provider_case,caseId}'=c->>'ebay_return_id' then c->'provider_case' end;
begin
 if c->>'issue_kind' is distinct from 'dispute' then return null; end if;
 if status ~ '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then
  if lane='payment_dispute' then
   if coalesce(c->>'resolution_reason',status)='SELLER_WON' or status='DISPUTE_REVERSED' then return 'closed_won'; end if;
   if coalesce(c->>'resolution_reason',status)='SELLER_LOST' then return 'closed_lost'; end if;
  end if;
  return 'closed_other';
 end if;
 if status='ACTION_NEEDED' or (lane='case' and status='REFUND_AGREED_BUT_FAILED') then return 'response_needed'; end if;
 if lane='payment_dispute' and status='OPEN' then
  if c->>'protection_status'='FULLY_PROTECTED' then return 'protected'; end if;
  if c->>'seller_response'='SELLER_CONTEST' then return 'awaiting_outcome'; end if;
  if c->>'dispute_no_response_needed'='true' then return 'no_response'; end if;
 elsif lane='case' then
  if status='ON_HOLD' or d->>'caseContentOnHold'='true' then return 'on_hold'; end if;
  if status='WAITING_DELIVERY' then return 'awaiting_delivery'; end if;
  if ((status='OPEN' and d->'nextSteps'='[]'::jsonb)
    or (status='WAITING_CS' and coalesce(d->'nextSteps','null'::jsonb) in ('null'::jsonb,'[]'::jsonb)))
   and nullif(c->>'ebay_due_at','') is null and coalesce(d->'sellerResponseDue','null'::jsonb) in ('null'::jsonb,'{}'::jsonb)
   and nullif(c->>'ebay_action','') is null then return 'reviewing'; end if;
 end if;
 return 'open';
end $$;
revoke all on function public.customer_issue_dispute_state(jsonb) from public,anon;
grant execute on function public.customer_issue_dispute_state(jsonb) to authenticated;

-- Extend the existing complete queue, keeping its access checks, source
-- counts, ordering and deep-link page positioning. Filter before pagination.
do $$
declare src text;
begin
 src:=pg_get_functiondef('public.list_customer_issues(text,text,text,integer,integer,text,text,uuid)'::regprocedure);
 src:=replace(src,'_focus_case_id uuid)', '_focus_case_id uuid, _dispute_state text)');
 src:=regexp_replace(src,'\),\s*filtered as \(\s*select \* from scoped where',
  '), classified as (select s.*,public.customer_issue_dispute_state(to_jsonb(s)) dispute_state from scoped s), filtered as (select * from classified where');
 src:=regexp_replace(src,'\),\s*ranked as \(',
  ' and (_view<>''dispute'' or coalesce(_dispute_state,''all'')=''all'' or dispute_state=_dispute_state or (_dispute_state=''closed'' and dispute_state in (''closed_won'',''closed_lost'',''closed_other''))) ), ranked as (');
 src:=regexp_replace(src,'\)\s*select jsonb_build_object\(''rows''',
  ') select jsonb_build_object(''dispute_states'',coalesce((select jsonb_object_agg(dispute_state,n) from (select dispute_state,count(*) n from classified where active and issue_kind=''dispute'' group by dispute_state) states),''{}''::jsonb)) || jsonb_build_object(''rows''');
 if strpos(src,'_dispute_state text)')=0 or strpos(src,'classified as')=0 or strpos(src,'dispute_state=_dispute_state')=0 or strpos(src,'''dispute_states''')=0 then
  raise exception 'Customer issue queue changed; review dispute filter migration';
 end if;
 execute src;
end $$;
revoke all on function public.list_customer_issues(text,text,text,int,int,text,text,uuid,text) from public,anon;
grant execute on function public.list_customer_issues(text,text,text,int,int,text,text,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
