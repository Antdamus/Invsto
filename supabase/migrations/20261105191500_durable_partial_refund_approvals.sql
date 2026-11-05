begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

-- Approval is for the refund and items, not the arrival order of eBay feeds.
-- Keep the original signed snapshots intact for the audit trail.
create function public.ebay_refund_review_status_set(values_json jsonb, ignored text[]) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(s order by s),'[]') from (
  select distinct upper(btrim(value)) s from jsonb_array_elements_text(coalesce(values_json,'[]'))
  where nullif(btrim(value),'') is not null and not upper(btrim(value))=any(ignored)
 ) x;
$$;

create function public.ebay_refund_review_core(facts jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select (facts - array['refunds','transactions','payments','cancellations']) || jsonb_build_object(
  'payments',public.ebay_refund_review_status_set(facts->'payments',array['PAID','PARTIALLY_REFUNDED']),
  'cancellations',public.ebay_refund_review_status_set(facts->'cancellations',array['NONE_REQUESTED','NOT_REQUESTED','NO_CANCEL','NOT_CANCELLED','CANCEL_REJECTED','CANCEL_CLOSED_WITHOUT_REFUND']));
$$;

create function public.ebay_refund_review_time(value text) returns numeric
language plpgsql immutable set search_path='' as $$
begin
 -- Require a timezone; never interpret a local timestamp using the server zone.
 if value !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then return null;end if;
 return extract(epoch from value::timestamptz);
exception when others then return null;
end $$;

create function public.ebay_refund_review_evidence(records jsonb,kind text) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(e order by e::text),'[]') from (
 select distinct e,case when e->>'id'='' then n else 0 end unidentified_row from (
 select n,jsonb_build_object(
  'id',coalesce(case when kind='transactions' then t->>'transactionId' else coalesce(t->>'refundId',t->>'refundReferenceId') end,''),
  'amount',case when amount ~ '^-?[0-9]+(\.[0-9]+)?$' then to_jsonb(amount::numeric) else to_jsonb(amount) end,
  'currency',upper(coalesce(t#>>'{amount,currency}',t->>'currency','')),
  'state',case when status=any(array['REFUNDED','SUCCEEDED','COMPLETED','FUNDS_AVAILABLE','FUNDS_AVAILABLE_FOR_PAYOUT','FUNDS_ON_HOLD','FUNDS_PAID_OUT']) then 'SETTLED' else status end,
  'at',public.ebay_refund_review_time(case when kind='transactions' then t->>'transactionDate' else t->>'refundDate' end),
  'booking',case when kind='transactions' then upper(coalesce(t->>'bookingEntry','')) else '' end,
  'lines',case when kind='transactions' then coalesce((select jsonb_agg(v order by v::text) from jsonb_array_elements(case when jsonb_typeof(t->'lineItemIds')='array' then t->'lineItemIds' else '[]'::jsonb end) v),'[]') else '[]'::jsonb end
 ) e from (
  select t,n,coalesce(t#>>'{amount,value}',case when jsonb_typeof(t->'amount') in ('number','string') then t->>'amount' end) amount,
   upper(coalesce(case when kind='transactions' then t->>'transactionStatus' else t->>'refundStatus' end,'')) status
  from jsonb_array_elements(case when jsonb_typeof(records)='array' then records else '[]'::jsonb end) with ordinality t(t,n)
 ) source
 ) normalized) deduplicated;
$$;

create function public.ebay_refund_review_same_receipt(a jsonb,b jsonb) returns boolean
language sql immutable set search_path='' as $$
 -- Cross-feed IDs differ. Require settled, equal money and close timestamps.
 -- Same-source comparisons below still require the exact transaction/refund ID.
 select coalesce(a->>'id'<>'' and b->>'id'<>'' and a->>'state'='SETTLED' and b->>'state'='SETTLED'
  and jsonb_typeof(a->'amount')='number' and a->'amount'=b->'amount'
  and a->>'currency'<>'' and a->'currency'=b->'currency'
  and a->>'booking' in ('','DEBIT') and b->>'booking' in ('','DEBIT')
  and abs((a->>'at')::numeric-(b->>'at')::numeric)<=120,false);
$$;

create function public.ebay_refund_review_evidence_matches(a jsonb,b jsonb,cross_feed boolean) returns boolean
language sql immutable set search_path='' as $$
 select case when not cross_feed then a=b else
  jsonb_array_length(a)>0 and jsonb_array_length(a)=jsonb_array_length(b)
  -- A one-to-one match prevents two equal refunds being mistaken for one.
  and not exists(select 1 from jsonb_array_elements(a) x where (select count(*) from jsonb_array_elements(b) y where public.ebay_refund_review_same_receipt(x,y))<>1)
  and not exists(select 1 from jsonb_array_elements(b) y where (select count(*) from jsonb_array_elements(a) x where public.ebay_refund_review_same_receipt(x,y))<>1)
 end;
$$;

create function public.ebay_refund_review_sources(snapshot jsonb) returns table(path text,kind text,evidence jsonb)
language sql immutable set search_path='' as $$
 select row_path||'.'||k,k,public.ebay_refund_review_evidence(facts->k,k)
 from (
  select 'order' row_path,snapshot->'order' facts
  union all select 'line:'||(l->>'id'),l->'facts' from jsonb_array_elements(coalesce(snapshot->'lines','[]')) l
 ) rows cross join unnest(array['refunds','transactions']) k;
$$;

create function public.ebay_partial_refund_snapshots_match(a jsonb,b jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare a_core jsonb;b_core jsonb;s record;other_snapshot jsonb;
begin
 if a is null or b is null then return false;end if;
 select jsonb_build_object('order',public.ebay_refund_review_core(a->'order'),'lines',coalesce(jsonb_agg(jsonb_build_object('id',l->'id','facts',public.ebay_refund_review_core(l->'facts')) order by l->>'id'),'[]')) into a_core from jsonb_array_elements(coalesce(a->'lines','[]')) l;
 select jsonb_build_object('order',public.ebay_refund_review_core(b->'order'),'lines',coalesce(jsonb_agg(jsonb_build_object('id',l->'id','facts',public.ebay_refund_review_core(l->'facts')) order by l->>'id'),'[]')) into b_core from jsonb_array_elements(coalesce(b->'lines','[]')) l;
 if a_core is distinct from b_core then return false;end if;
 for s in select coalesce(x.kind,y.kind) kind,x.evidence old_evidence,y.evidence new_evidence
  from public.ebay_refund_review_sources(a) x full join public.ebay_refund_review_sources(b) y using(path) loop
  if s.old_evidence=s.new_evidence then continue;end if;
  if jsonb_array_length(coalesce(s.old_evidence,'[]'))>0 and jsonb_array_length(coalesce(s.new_evidence,'[]'))>0 then
   return false; -- An existing refund's ID, amount, status or item assignment changed.
  end if;
  other_snapshot:=case when jsonb_array_length(coalesce(s.old_evidence,'[]'))>0 then b else a end;
  if not exists(select 1 from public.ebay_refund_review_sources(other_snapshot) p
   where public.ebay_refund_review_evidence_matches(
    case when jsonb_array_length(coalesce(s.old_evidence,'[]'))>0 then s.old_evidence else s.new_evidence end,
    p.evidence,s.kind<>p.kind)) then return false;end if;
 end loop;
 return true;
end $$;

-- Apply the same semantic comparison at every server gate, including BEFORE
-- checks against incoming row changes and the password-confirmed approval RPC.
do $$declare def text;sig text;begin
 foreach sig in array array['public.ebay_fulfillment_block(jsonb,jsonb)','public.get_ebay_partial_refund_reviews(uuid[])','public.approve_ebay_partial_refund(uuid,jsonb,text,boolean)','public.invalidate_ebay_partial_refund_approval()'] loop
  select pg_get_functiondef(sig::regprocedure) into def;
  def:=replace(def,'a.snapshot=public.ebay_partial_refund_snapshot(oid)','public.ebay_partial_refund_snapshots_match(a.snapshot,public.ebay_partial_refund_snapshot(oid))');
  def:=replace(def,'a.snapshot=review_snapshot','public.ebay_partial_refund_snapshots_match(a.snapshot,review_snapshot)');
  def:=replace(def,'a.snapshot is distinct from public.ebay_partial_refund_snapshot(oid)','not public.ebay_partial_refund_snapshots_match(a.snapshot,public.ebay_partial_refund_snapshot(oid))');
  def:=replace(def,'_snapshot is distinct from review->''snapshot''','not public.ebay_partial_refund_snapshots_match(_snapshot,review->''snapshot'')');
  def:=replace(def,'public.ebay_refund_review_facts(_order) is distinct from public.ebay_refund_review_facts(o)','not public.ebay_partial_refund_snapshots_match(jsonb_build_object(''order'',public.ebay_refund_review_facts(_order)),jsonb_build_object(''order'',public.ebay_refund_review_facts(o)))');
  def:=replace(def,'public.ebay_refund_review_facts(_line) is distinct from public.ebay_refund_review_facts(stored_line)','not public.ebay_partial_refund_snapshots_match(jsonb_build_object(''order'',public.ebay_refund_review_facts(_line)),jsonb_build_object(''order'',public.ebay_refund_review_facts(stored_line)))');
  execute def;
 end loop;
end $$;

-- Repair only the latest automatically expired approval when its signed facts
-- still match. Preserve who approved it, when, the original snapshot and the
-- erroneous revocation in a separate restoration audit field.
alter table public.ebay_partial_refund_approvals add column sync_restoration jsonb;
with candidates as (
 select a.id,a.order_id,a.revoked_at,a.revocation_reason from public.ebay_partial_refund_approvals a
 where a.revoked_at is not null and a.revocation_reason='Order, refund, or cancellation facts changed'
 and not exists(select 1 from public.ebay_partial_refund_approvals newer where newer.order_id=a.order_id and (newer.revoked_at is null or (newer.approved_at,newer.id)>(a.approved_at,a.id)))
 and public.ebay_partial_refund_snapshots_match(a.snapshot,public.ebay_partial_refund_snapshot(a.order_id))
 and not exists(select 1 from public.ebay_orders o left join public.ebay_order_lines l on l.order_id=o.id where o.id=a.order_id and public.ebay_partial_refund_hard_block(to_jsonb(o),coalesce(to_jsonb(l),'{}')) is not null)
), restored as (
 update public.ebay_partial_refund_approvals a set revoked_at=null,revocation_reason=null,
  sync_restoration=jsonb_build_object('restored_at',now(),'previous_revoked_at',c.revoked_at,'previous_reason',c.revocation_reason,'reason','Same reviewed refund confirmed across eBay feeds; routine sync incorrectly expired approval')
 from candidates c where a.id=c.id returning a.order_id
)
insert into public.ebay_fulfillment_safety_events(order_id,previous_reason,reason,source)
 select order_id,'Partial refund approval expired; review the changed order','Original signed approval restored: same refund, no material change','partial_refund_sync_repair' from restored;

revoke all on function public.ebay_refund_review_status_set(jsonb,text[]),public.ebay_refund_review_core(jsonb),public.ebay_refund_review_time(text),public.ebay_refund_review_evidence(jsonb,text),public.ebay_refund_review_same_receipt(jsonb,jsonb),public.ebay_refund_review_evidence_matches(jsonb,jsonb,boolean),public.ebay_refund_review_sources(jsonb),public.ebay_partial_refund_snapshots_match(jsonb,jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
