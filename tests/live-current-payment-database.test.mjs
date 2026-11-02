import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db,day;
const sid='00000000-0000-4000-8000-000000000001', event='PAID123';
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const obs=(kind,extra={})=>({key:kind,kind,source:kind==='won'||kind==='failed'?'activity':'listing',listing_id:'287636925068',title:'#001 - UPGRADE',buyer:'winner',amount:3000,currency:'USD',ordinal:'1',time_label:kind==='won'?'04:39 AM':'04:38 AM',observed_at:day+'T12:00:00Z',...extra});
const ingest=events=>db.query('select ingest_ebay_live_events($1,$2::jsonb,$3::jsonb)',[event,JSON.stringify(events),JSON.stringify({observed_at:day+'T12:30:00Z'})]);
const rows=async()=> (await db.query('select * from ebay_live_attempts where merged_into is null order by id')).rows;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select '${sid}'::uuid$$;
 create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;
 create table auth.users(id uuid primary key);create table employees(id uuid primary key);
 create table live_sale_sessions(id uuid primary key,status text);create table live_sale_lots(id uuid primary key);
 create table ebay_orders(id uuid primary key,buyer_username text,status text,raw_payload jsonb,sale_date timestamptz);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,quantity integer,amount numeric,line_status text,raw_payload jsonb);
 create function ebay_live_order_buyer_matches(o ebay_orders,b text) returns boolean language sql as $$select lower(o.buyer_username)=lower(b)$$;
 create function ebay_live_order_item_amount(l ebay_order_lines) returns numeric language sql as $$select l.amount$$;
 create function ebay_live_seller_at(text,timestamptz) returns uuid language sql as $$select null::uuid$$;
 create function reconcile_ebay_live_orders_internal(text) returns void language plpgsql as $$begin return;end$$;
 create function apply_ebay_live_stream_metadata(text,jsonb) returns void language plpgsql as $$begin return;end$$;
 create function normalize_ebay_live_diagnostics(jsonb) returns jsonb language sql as $$select $1$$;
 create function normalize_ebay_live_recovery(jsonb,timestamptz) returns jsonb language sql as $$select $1$$;
 create function ebay_live_recovery_status(text) returns jsonb language sql as $$select '{"phase":"needs_review","reason":"live_sales","captured_total":20649.99,"listing_passes":2,"activity_passes":2,"sold_seen":40,"sold_expected":40,"saved_listings":40}'::jsonb$$;`);
 const base=await read('20260928120000_ebay_live_payment_queue.sql');await db.exec(base.slice(base.indexOf('create table public.ebay_live_connections'),base.indexOf('alter table public.live_sale_lot_items')));
 await db.exec(`alter table ebay_live_connections add column broadcast_ended_at timestamptz,add column broadcast_end_source text,add column review_completed_at timestamptz,add column stream_start_at timestamptz,add column stream_metadata jsonb,add column history_recovery jsonb;
 alter table ebay_live_attempts add column merged_into uuid,add column event_exclusion jsonb,add column sold_at timestamptz,add column sale_time_source text,add column sale_time_precision text;
 alter table ebay_live_observations add column occurred_at timestamptz;`);
 const clock=await read('20260930220000_ebay_live_original_times.sql');await db.exec(clock.slice(clock.indexOf('create function public.ebay_live_activity_time'),clock.indexOf('create function public.apply_ebay_live_stream_metadata')));
 await db.exec(await read('20261007170000_ebay_live_paid_retry.sql'));
 await db.exec(await read('20261007173000_ebay_live_paid_retry_badges.sql'));
 await db.exec(await read('20261009030000_ebay_live_current_payment.sql'));
 await db.exec(await read('20261029223000_live_unknown_payment_preserves_evidence.sql'));
 const clocks=await read('20261008150000_batch_live_order_sync_reconciliation.sql');
 await db.exec(clocks.slice(clocks.indexOf('create or replace function public.ebay_live_activity_time'),clocks.indexOf('create function public.ebay_live_order_lines_changed_statement')));
 await db.exec('drop function apply_ebay_live_stream_metadata(text,jsonb); alter table live_sale_sessions add column started_at timestamptz');
 await db.exec(await read('20261102220000_live_capture_show_clock.sql'));
 day=(await db.query("select to_char(now()-interval '1 day','YYYY-MM-DD') as day")).rows[0].day;
});
beforeEach(async()=>{await db.exec(`truncate ebay_live_listing_payments,ebay_live_audit,ebay_live_observations,ebay_live_attempts,ebay_live_connections,live_sale_sessions,live_sale_lots,ebay_order_lines,ebay_orders cascade;
 set test.allowed='yes';insert into live_sale_sessions values('${sid}','active');insert into ebay_live_connections(event_id,session_id,stream_start_at,stream_metadata,broadcast_ended_at) values('${event}','${sid}','${day}T01:00:00Z','{"activity_timezone":"UTC"}',now());`);});
after(async()=>db?.close());
const perms=a=>a.length?a.flatMap((v,i)=>perms(a.filter((_,j)=>j!==i)).map(p=>[v,...p])):[[]];
test('unmatched Activity recovers when a later readable card supplies its listing ID without duplicating the sale',async()=>{
 await ingest([obs('won',{listing_id:undefined})]);assert.equal((await rows()).length,0);
 await ingest([obs('paid'),obs('won')]);const first=await rows();assert.equal(first.length,1);assert.equal(first[0].payment_state,'paid');
 await ingest([obs('paid'),obs('won')]);const again=await rows();assert.equal(again.length,1);assert.equal(again[0].id,first[0].id);
 const observations=(await db.query('select listing_id,disposition from ebay_live_observations')).rows;
 assert.equal(observations.length,2);assert.ok(observations.every(o=>o.listing_id==='287636925068'&&o.disposition==='matched'));
});
for(const seq of perms(['failed','won','paid']))test(`ended show Paid wins over historical failure: ${seq.join(' → ')}`,async()=>{
 for(const k of seq)await ingest([obs(k)]);
 let a=await rows();assert.equal(a.length,1);assert.equal(a[0].payment_state,'paid');assert.equal(a[0].win_key,'won');
 const id=a[0].id;await ingest(seq.map(k=>obs(k)));await db.query('select reconcile_ebay_live_orders_internal($1)',[event]);
 a=await rows();assert.equal(a.length,1);assert.equal(a[0].id,id);assert.equal(a[0].payment_state,'paid');
 assert.equal((await db.query('select count(*)::int n from ebay_live_observations')).rows[0].n,3);
 const total=(await db.query('select ebay_live_recovery_status($1) r',[event])).rows[0].r;
 assert.equal(total.paid_total,3000);assert.equal(total.paid_auctions,1);assert.equal(total.phase,'read');assert.equal(total.requires_manual_note,false);
});
test('Paid → failed → Paid uses the current snapshot, and delayed old evidence cannot revert it',async()=>{
 await ingest([obs('paid')]);const id=(await rows())[0].id;
 await ingest([obs('failed',{source:'listing',key:'listing-failed',observed_at:day+'T12:01:00Z'})]);assert.equal((await rows())[0].payment_state,'failed');
 await ingest([obs('paid',{observed_at:day+'T12:02:00Z'})]);assert.equal((await rows())[0].payment_state,'paid');
 await ingest([obs('failed',{source:'listing',key:'old-failed',observed_at:day+'T12:00:30Z'})]);assert.equal((await rows())[0].payment_state,'paid');
 assert.equal((await rows())[0].id,id);
 await ingest([obs('unknown',{source:'listing',key:'no-paid',payment_snapshot:true,evidence:'AUC',observed_at:day+'T12:03:00Z'})]);assert.equal((await rows())[0].payment_state,'paid');
 assert.equal((await db.query('select ebay_live_recovery_status($1) r',[event])).rows[0].r.paid_total,3000);
});
test('an existing bag is preserved when a later win is merged; no inventory or extra bag is created',async()=>{
 await ingest([obs('failed')]);const a=(await rows())[0];
 await db.exec(`insert into live_sale_lots values('${sid}');update ebay_live_attempts set lot_id='${sid}' where id='${a.id}'`);
 await ingest([obs('won'),obs('paid')]);const after=await rows();assert.equal(after.length,1);assert.equal(after[0].id,a.id);assert.equal(after[0].lot_id,sid);assert.equal(after[0].win_key,'won');
 assert.equal((await db.query('select count(*)::int n from live_sale_lots')).rows[0].n,1);
});

test('unread cards do not erase paid evidence needed to reject delayed historical failures',async()=>{
 await ingest([obs('paid',{observed_at:day+'T13:00:00Z'})]);
 await ingest([obs('unknown',{source:'listing',key:'unread',payment_snapshot:true,observed_at:day+'T14:00:00Z'})]);
 await ingest([obs('failed',{observed_at:day+'T12:00:00Z'})]);
 assert.equal((await rows())[0].payment_state,'paid');
 assert.equal((await db.query('select kind from ebay_live_listing_payments')).rows[0].kind,'paid');
 // A genuinely newer explicit failed badge still supersedes the payment.
 await ingest([obs('failed',{source:'listing',key:'new-failure',observed_at:day+'T15:00:00Z'})]);
 assert.equal((await rows())[0].payment_state,'failed');
});

test('an unread listing badge preserves every explicit payment state and operator decision',async()=>{
 await ingest([obs('won')]);const id=(await rows())[0].id;
 for(const state of ['paid','failed','cancelled','review','waiting']){
  await db.query("update ebay_live_attempts set payment_state=$1,payment_source='order_import',review_note='Retain evidence' where id=$2",[state,id]);
  await ingest([obs('unknown',{source:'listing',key:'unread-'+state,payment_snapshot:true,evidence:'',observed_at:day+'T14:00:00Z'})]);
  const a=(await rows())[0];assert.equal(a.payment_state,state);assert.equal(a.payment_source,'order_import');assert.equal(a.review_note,'Retain evidence');
 }
 assert.equal((await db.query("select count(*)::int n from ebay_live_observations where kind='unknown' and disposition<>'matched'")).rows[0].n,0);
});

test('reconciliation can restore an imported paid order without an unread card reverting it',async()=>{
 await ingest([obs('won'),obs('unknown',{source:'listing',key:'unread',payment_snapshot:true,evidence:''})]);
 assert.equal((await rows())[0].payment_state,'waiting');
 await db.exec("create or replace function reconcile_ebay_live_orders_before_current_payment(text) returns void language plpgsql as $$begin update public.ebay_live_attempts set payment_state='paid',payment_source='order_import' where event_id=$1;end$$");
 try{
  await db.query('select reconcile_ebay_live_orders_internal($1)',[event]);
  assert.equal((await rows())[0].payment_state,'paid');
  await ingest([obs('unknown',{source:'listing',key:'unread-later',payment_snapshot:true,evidence:'AUC',observed_at:day+'T14:00:00Z'})]);
  assert.equal((await rows())[0].payment_state,'paid');
  assert.equal((await rows()).length,1);
 }finally{
  await db.exec('create or replace function reconcile_ebay_live_orders_before_current_payment(text) returns void language plpgsql as $$begin return;end$$');
 }
});
test('different buyers do not merge and a cancelled card removes the prior winner from paid totals',async()=>{
 await ingest([obs('failed'),obs('won'),obs('paid',{buyer:'another-buyer'})]);let a=await rows();
 assert.equal(a.filter(x=>x.payment_state==='paid').length,1);assert.equal(a.find(x=>x.payment_state==='paid').buyer,'another-buyer');
 await ingest([obs('cancelled',{key:'current-cancelled',source:'listing',buyer:'another-buyer',observed_at:day+'T12:10:00Z'})]);a=await rows();assert.equal(a.filter(x=>x.payment_state==='paid').length,0);
});
test('distinct wins cannot be silently merged',async()=>{
 await ingest([obs('won'),obs('won',{key:'other-win',time_label:'04:50 AM'}),obs('paid')]);assert.equal((await rows()).length,2);
 assert.equal((await rows()).filter(a=>a.payment_state==='paid').length,0);
});
test('private helpers and the legacy ingress cannot bypass inventory permissions',async()=>{
 for(const fn of ['apply_ebay_live_listing_payments_internal(text)','ingest_ebay_live_events_before_current_payment(text,jsonb,jsonb)'])assert.equal((await db.query("select has_function_privilege('authenticated',$1,'execute') allowed",[fn])).rows[0].allowed,false);
 await db.exec("set test.allowed='no'");await assert.rejects(ingest([obs('paid')]),/Inventory access required/);
});


test('newer official refunds and deliberate operator cancellations stay blocked',async()=>{
 await ingest([obs('failed'),obs('won')]);let a=(await rows()).find(a=>a.win_key);
 await db.exec(`insert into ebay_orders(id,status,raw_payload) values('${sid}','open','{"orderPaymentStatus":"FULLY_REFUNDED","ebay_order_evidence":{"source":"ebay_fulfillment_api","checked_at":"${day}T13:00:00Z"}}');
 insert into ebay_order_lines(id,order_id) values('${sid}','${sid}');update ebay_live_attempts set order_line_id='${sid}' where id='${a.id}';`);
 await ingest([obs('paid')]);assert.equal((await rows()).filter(a=>a.payment_state==='paid').length,0);
 await db.exec(`update ebay_orders set raw_payload='{}';insert into ebay_live_audit(event_id,attempt_id,action) values('${event}','${a.id}','cancel_release');`);
 await ingest([obs('paid',{observed_at:day+'T14:00:00Z'})]);assert.equal((await rows()).filter(a=>a.payment_state==='paid').length,0);
});


test('a reused listing does not revoke another buyer confirmed payment',async()=>{
 await ingest([obs('won'),obs('paid')]);
 await ingest([obs('won',{buyer:'next-buyer',key:'next-win',time_label:'05:00 AM'}),obs('failed',{source:'listing',buyer:'next-buyer',key:'next-failed',observed_at:day+'T12:01:00Z'})]);
 let a=await rows();assert.equal(a.find(a=>a.buyer==='winner').payment_state,'paid');assert.equal(a.find(a=>a.buyer==='next-buyer').payment_state,'failed');
 await ingest([obs('paid',{buyer:'next-buyer',key:'next-paid',observed_at:day+'T12:02:00Z'})]);
 a=await rows();assert.equal(a.filter(a=>a.payment_state==='paid').length,2);
});

test('browser clock changes replay the original auction across zones and midnight',async()=>{
 const stream={source:'ebay_event_information',start_local:'2026-10-30T22:30',timezone_label:'America/New_York',activity_timezone:'America/New_York'};
 const source='America/Denver';
 await db.query('update ebay_live_connections set stream_metadata=null,stream_start_at=null');
 const push=(events,zone)=>db.query('select ingest_ebay_live_events($1,$2::jsonb,$3::jsonb)',[event,JSON.stringify(events),JSON.stringify({stream:{...stream,activity_timezone:zone}})]);
 const activity=(clock,zone)=>obs('won',{time_label:clock,activity_timezone:zone,key:['activity','winner','#001 - UPGRADE',3000,clock,'Won the auction'].map(encodeURIComponent).join('|')});
 await push([],stream.activity_timezone);
 await push([activity('Oct 31, 12:15 AM')],stream.activity_timezone);
 await push([activity('10:15 PM')],source); // Older helper sends the zone in batch metadata.
 await push([activity('Oct 30, 10:15 PM',source)],stream.activity_timezone); // Queued on another computer.
 await push([],source);
 assert.equal((await rows()).length,1);
 const result=await db.query('select source_key,time_label,occurred_at from ebay_live_observations');
 assert.equal(result.rows.length,1);
 assert.equal(result.rows[0].time_label,'12:15 AM');
 assert.equal(new Date(result.rows[0].occurred_at).toISOString(),'2026-10-31T04:15:00.000Z');
 assert.equal((await db.query('select stream_metadata from ebay_live_connections')).rows[0].stream_metadata.activity_timezone,stream.activity_timezone);
 await db.query('select apply_ebay_live_stream_metadata($1,$2::jsonb)',[event,JSON.stringify({...stream,activity_timezone:source})]);
 assert.equal((await db.query('select stream_metadata from ebay_live_connections')).rows[0].stream_metadata.activity_timezone,stream.activity_timezone);
});
test('an ambiguous foreign DST minute stays in the review queue on retries',async()=>{
 const stream={source:'ebay_event_information',start_local:'2026-11-01T04:00',timezone_label:'UTC',activity_timezone:'UTC'};
 await db.query('select apply_ebay_live_stream_metadata($1,$2::jsonb)',[event,JSON.stringify(stream)]);
 const a=obs('won',{key:'activity|winner|title|3000|1%3A30%20AM|Won',time_label:'1:30 AM',activity_timezone:'America/New_York'});
 await ingest([a]);await ingest([a]);
 assert.equal((await rows()).length,0);
 const result=await db.query('select disposition,kind,evidence,occurred_at from ebay_live_observations');
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].disposition,'unmatched');assert.equal(result.rows[0].kind,'unknown');
 assert.match(result.rows[0].evidence,/1:30 AM.*America\/New_York/);assert.equal(result.rows[0].occurred_at,null);
});
test('a replay from a different zone matches a dated observation stored before the change',async()=>{
 const stream={source:'ebay_event_information',start_local:'2026-10-30T22:30',timezone_label:'America/New_York',activity_timezone:'America/New_York'};
 await db.query('update ebay_live_connections set stream_metadata=null');
 await db.query('select apply_ebay_live_stream_metadata($1,$2::jsonb)',[event,JSON.stringify(stream)]);
 const originalKey='activity|winner|title|3000|Oct%2031%2C%2012%3A15%20AM|Won';
 const existing=obs('won',{key:originalKey,time_label:'Oct 31, 12:15 AM'});
 await db.query('select ingest_ebay_live_events_before_current_payment($1,$2::jsonb,$3::jsonb)',[event,JSON.stringify([existing]),'{}']);
 const previous=(await rows())[0];
 await ingest([{...existing,key:'activity|winner|title|3000|10%3A15%20PM|Won',time_label:'10:15 PM',activity_timezone:'America/Denver'}]);
 const current=await rows();assert.equal(current.length,1);assert.equal(current[0].id,previous.id);
 assert.equal(current[0].win_key,originalKey);assert.deepEqual(current[0].sold_at,previous.sold_at);
 assert.equal((await db.query('select count(*)::int n from ebay_live_observations')).rows[0].n,1);
});
