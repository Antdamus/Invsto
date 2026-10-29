import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

let db,day;
const sid='00000000-0000-4000-8000-000000000001',event='ORDERPAID',listing='287690196492';
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const observation=(kind,extra={})=>({key:kind,kind,source:'activity',listing_id:listing,title:'#032 - Citizen Watch',
 buyer:'buyer32',amount:199,currency:'USD',ordinal:'32',time_label:'04:54 PM',observed_at:day+'T17:10:00Z',...extra});
const ingest=events=>db.query('select ingest_ebay_live_events($1,$2::jsonb,$3::jsonb)',[event,JSON.stringify(events),JSON.stringify({observed_at:day+'T17:15:00Z'})]);
const reconcile=()=>db.query('select reconcile_ebay_live_orders_internal($1)',[event]);
const rows=async()=> (await db.query('select * from ebay_live_attempts where merged_into is null order by id')).rows;
const unread=()=>observation('unknown',{key:'unread-card',source:'listing',payment_snapshot:true,time_label:null});
async function officialOrder({status='PAID',payment='16:54:20',checked='17:20:00',cancel='NONE_REQUESTED'}={}){
 const payload={orderPaymentStatus:status,orderCancelStatus:cancel,
  ebay_order_evidence:{source:'ebay_fulfillment_api',checked_at:day+'T'+checked+'Z',order_number:'26-15331-22945'}};
 await db.query(`insert into ebay_orders(id,buyer_username,status,raw_payload,sale_date,paid_on_date,order_number)
  values($1,'buyer32','pending',$2,$3,$4,'26-15331-22945')`,[sid,payload,day+'T16:54:10Z',payment?day+'T'+payment+'Z':null]);
 await db.query(`insert into ebay_order_lines(id,order_id,item_number,quantity,amount,line_status,raw_payload)
  values($1,$1,$2,1,199,'pending',$3)`,[sid,listing,{source:'ebay_fulfillment_api',orderPaymentStatus:status,orderCancelStatus:cancel}]);
}
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select '${sid}'::uuid$$;
 create function can_manage_inventory() returns boolean language sql as $$select true$$;
 create table auth.users(id uuid primary key);create table employees(id uuid primary key);
 create table live_sale_sessions(id uuid primary key,status text,started_at timestamptz);
 create table live_sale_lots(id uuid primary key);
 create table ebay_orders(id uuid primary key,buyer_username text,status text,raw_payload jsonb,sale_date timestamptz,paid_on_date timestamptz,order_number text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,quantity integer,amount numeric,line_status text,raw_payload jsonb);
 create function ebay_live_order_buyer_matches(o ebay_orders,b text) returns boolean language sql as $$select lower(o.buyer_username)=lower(b)$$;
 create function ebay_live_order_item_amount(l ebay_order_lines) returns numeric language sql as $$select l.amount$$;
 create function ebay_live_seller_at(text,timestamptz) returns uuid language sql as $$select null::uuid$$;
 create function reconcile_ebay_live_buyer_aliases_internal(text) returns void language plpgsql as $$begin return;end$$;
 create function reconcile_ebay_live_history_duplicates_internal(text) returns void language plpgsql as $$begin return;end$$;
 create function reconcile_ebay_live_event_scope_internal(text) returns void language plpgsql as $$begin return;end$$;
 create function apply_ebay_live_stream_metadata(text,jsonb) returns void language plpgsql as $$begin return;end$$;
 create function normalize_ebay_live_diagnostics(jsonb) returns jsonb language sql as $$select $1$$;
 create function normalize_ebay_live_recovery(jsonb,timestamptz) returns jsonb language sql as $$select $1$$;
 create function ebay_live_recovery_status(text) returns jsonb language sql as $$select '{}'::jsonb$$;`);
 const base=await read('20260928120000_ebay_live_payment_queue.sql');
 await db.exec(base.slice(base.indexOf('create table public.ebay_live_connections'),base.indexOf('alter table public.live_sale_lot_items')));
 await db.exec(`alter table ebay_live_connections add column broadcast_ended_at timestamptz,add column broadcast_end_source text,
 add column review_completed_at timestamptz,add column stream_start_at timestamptz,add column stream_metadata jsonb,add column history_recovery jsonb;
 alter table ebay_live_attempts add column merged_into uuid,add column event_exclusion jsonb,add column sold_at timestamptz,add column sale_time_source text,add column sale_time_precision text;
 alter table ebay_live_observations add column occurred_at timestamptz;`);
 const clock=await read('20260930220000_ebay_live_original_times.sql');
 await db.exec(clock.slice(clock.indexOf('create function public.ebay_live_activity_time'),clock.indexOf('create function public.apply_ebay_live_stream_metadata')));
 const official=await read('20261005000000_ebay_live_automatic_order_check.sql');
 await db.exec(official.slice(official.indexOf('create or replace function public.reconcile_ebay_live_orders_internal'),official.indexOf('create or replace function public.ebay_live_recovery_status')));
 for(const migration of ['20261007170000_ebay_live_paid_retry.sql','20261007173000_ebay_live_paid_retry_badges.sql',
  '20261009030000_ebay_live_current_payment.sql','20261029223000_live_unknown_payment_preserves_evidence.sql',
  '20261029230000_live_history_payment_evidence.sql'])await db.exec(await read(migration));
 day=(await db.query("select to_char(now()-interval '1 day','YYYY-MM-DD') as day")).rows[0].day;
});
beforeEach(async()=>{
 await db.exec(`truncate ebay_live_listing_payments,ebay_live_audit,ebay_live_observations,ebay_live_attempts,ebay_live_connections,
 live_sale_sessions,live_sale_lots,ebay_order_lines,ebay_orders cascade;
 insert into live_sale_sessions values('${sid}','active','${day}T14:00:00Z');
 insert into ebay_live_connections(event_id,session_id,stream_start_at,stream_metadata,broadcast_ended_at)
 values('${event}','${sid}','${day}T14:00:00Z','{"activity_timezone":"UTC"}','${day}T17:00:00Z');`);
});
after(async()=>db?.close());

test('official paid order survives unknown cards and replay of a same-minute failed retry',async()=>{
 await ingest([observation('won')]);await officialOrder();await reconcile();
 assert.equal((await rows())[0].payment_state,'paid');
 await ingest([unread(),observation('failed')]);await reconcile();
 assert.equal((await rows()).length,1);assert.equal((await rows())[0].payment_state,'paid');
 await ingest([unread(),observation('failed')]);await reconcile();
 assert.equal((await rows())[0].payment_state,'paid');
 assert.equal((await db.query("select count(*)::int n from ebay_live_audit where action='order_reconciled' and details->>'historical_failure_resolved'='true'")).rows[0].n,1);
});

test('automatic capture audit history does not masquerade as an operator hold',async()=>{
 await ingest([observation('won'),unread()]);
 const a=(await rows())[0];
 for(const action of ['current_listing_payment','current_paid_duplicate_combined','live_paid_retry_reconciled'])
  await db.query('insert into ebay_live_audit(event_id,attempt_id,action) values($1,$2,$3)',[event,a.id,action]);
 await ingest([observation('failed')]);await officialOrder();await reconcile();
 assert.equal((await rows())[0].payment_state,'paid');
});

test('line-level official payment evidence is usable despite a matched unread card',async()=>{
 await ingest([observation('won'),unread()]);await officialOrder();
 await db.exec("update ebay_orders set raw_payload=raw_payload-'orderPaymentStatus'");
 await reconcile();assert.equal((await rows())[0].payment_state,'paid');
});

for(const [name,change] of [
 ['unknown Activity evidence',()=>ingest([observation('unknown',{key:'uncertain-notification'})])],
 ['unmatched unread listing',()=>db.exec("update ebay_live_observations set disposition='unmatched' where kind='unknown'")],
 ['manual notification review',async()=>db.query("insert into ebay_live_audit(event_id,attempt_id,action) values($1,$2,'notification_reviewed')",[event,(await rows())[0].id])],
 ['failure after payment',()=>ingest([observation('failed',{key:'later-failure',time_label:'04:55 PM'})])],
 ['failure with unknown time',()=>ingest([observation('failed',{key:'undated-failure',time_label:null})])],
 ['ambiguous repeated win',()=>ingest([observation('won',{key:'second-win',time_label:'04:56 PM'})])],
 ['order checked before the payment minute ended',()=>db.query("update ebay_orders set raw_payload=jsonb_set(raw_payload,'{ebay_order_evidence,checked_at}',to_jsonb($1::text))",[day+'T16:54:30Z'])],
 ['different buyer',()=>db.exec("update ebay_orders set buyer_username='anotherBuyer'")],
 ['different amount',()=>db.exec('update ebay_order_lines set amount=200')],
])test(`${name} cannot be silently cleared`,async()=>{
 await ingest([observation('won'),unread(),observation('failed')]);await officialOrder();await change();await reconcile();
 assert.ok((await rows()).every(a=>a.payment_state!=='paid'));
});

for(const status of ['PENDING','FULLY_REFUNDED','PARTIALLY_REFUNDED'])test(`${status} stays outside confirmed paid totals`,async()=>{
 await ingest([observation('won'),unread(),observation('failed')]);await officialOrder({status});await reconcile();
 assert.ok((await rows()).every(a=>a.payment_state!=='paid'));
});
test('official cancellation remains cancelled',async()=>{
 await ingest([observation('won'),unread(),observation('failed')]);await officialOrder({cancel:'CANCEL_COMPLETE'});await reconcile();
 assert.equal((await rows())[0].payment_state,'cancelled');
});
test('recovery remains a private helper',async()=>{
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'reconcile_ebay_live_orders_before_current_payment(text)','execute') allowed",[role])).rows[0].allowed,false);
});
