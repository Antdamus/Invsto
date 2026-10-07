import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

let db;
const event='RETRY017', sid='00000000-0000-4000-8000-000000000001';
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
let day, observed;
const observation=(kind,extra={})=>({key:kind,kind,listing_id:'287633255342',title:'#017 - CHAIN',
 buyer:'buyer17',amount:180,currency:'USD',ordinal:'17',source:kind==='paid'?'listing':'activity',
 time_label:kind==='failed'?'11:55 AM':kind==='won'?'11:57 AM':null,observed_at:observed,...extra});
const ingest=async events=>db.query('select ingest_ebay_live_events($1,$2::jsonb,$3::jsonb)',[event,JSON.stringify(events),JSON.stringify({observed_at:observed,ready:true})]);
const attempts=async()=> (await db.query('select * from ebay_live_attempts where merged_into is null order by created_at,id')).rows;
const reconcile=()=>db.query('select reconcile_ebay_live_paid_retry_internal($1)',[event]);
const permutations=items=>items.length?items.flatMap((item,i)=>permutations(items.filter((_,j)=>i!==j)).map(rest=>[item,...rest])):[[]];

before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select '${sid}'::uuid$$;
 create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;
 create table auth.users(id uuid primary key);
 create table employees(id uuid primary key);
 create table live_sale_sessions(id uuid primary key,status text);
 create table live_sale_lots(id uuid primary key);
 create table ebay_orders(id uuid primary key, buyer_username text,status text,raw_payload jsonb,sale_date timestamptz);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,quantity integer,amount numeric,line_status text,raw_payload jsonb);
 create function ebay_live_order_buyer_matches(o ebay_orders,b text) returns boolean language sql as $$select lower(o.buyer_username)=lower(b)$$;
 create function ebay_live_order_item_amount(l ebay_order_lines) returns numeric language sql as $$select l.amount$$;
 create function ebay_live_seller_at(text,timestamptz) returns uuid language sql as $$select null::uuid$$;
 create function reconcile_ebay_live_orders_internal(text) returns void language plpgsql as $$begin return;end$$;
 create function apply_ebay_live_stream_metadata(text,jsonb) returns void language plpgsql as $$begin return;end$$;
 create function normalize_ebay_live_diagnostics(jsonb) returns jsonb language sql as $$select $1$$;
 create function normalize_ebay_live_recovery(jsonb,timestamptz) returns jsonb language sql as $$select $1$$;`);
 const base=await read('20260928120000_ebay_live_payment_queue.sql');
 await db.exec(base.slice(base.indexOf('create table public.ebay_live_connections'),base.indexOf('alter table public.live_sale_lot_items')));
 await db.exec(`alter table ebay_live_connections add column broadcast_ended_at timestamptz,add column broadcast_end_source text,
 add column review_completed_at timestamptz,add column stream_start_at timestamptz,add column stream_metadata jsonb,add column history_recovery jsonb;
 alter table ebay_live_attempts add column merged_into uuid,add column event_exclusion jsonb,add column sold_at timestamptz,add column sale_time_source text,add column sale_time_precision text;
 alter table ebay_live_observations add column occurred_at timestamptz;`);
 const clock=await read('20260930220000_ebay_live_original_times.sql');
 await db.exec(clock.slice(clock.indexOf('create function public.ebay_live_activity_time'),clock.indexOf('create function public.apply_ebay_live_stream_metadata')));
 await db.exec(await read('20261007170000_ebay_live_paid_retry.sql'));
 day=(await db.query("select to_char(now()-interval '1 day','YYYY-MM-DD') as day")).rows[0].day;
 observed=day+'T11:58:15Z';
});
beforeEach(async()=>{
 await db.exec(`truncate ebay_live_audit,ebay_live_observations,ebay_live_attempts,ebay_live_connections,live_sale_sessions,ebay_order_lines,ebay_orders cascade;
 set test.allowed='yes';insert into live_sale_sessions values('${sid}','active');
 insert into ebay_live_connections(event_id,session_id,stream_start_at,stream_metadata)
 values('${event}','${sid}','${day}T10:00:00Z','{"activity_timezone":"UTC"}');`);
});
after(async()=>db?.close());

for(const sequence of permutations(['paid','failed','won'])) for(const delivery of ['batch','separate']) {
 test(`failed retry reaches paid once: ${sequence.join(' → ')} (${delivery})`,async()=>{
  const events=sequence.map(kind=>observation(kind));
  if(delivery==='batch')await ingest(events);else for(const e of events)await ingest([e]);
  const rows=await attempts();assert.equal(rows.length,1);assert.equal(rows[0].payment_state,'paid');
  assert.equal(rows[0].win_key,'won');assert.equal(rows[0].paid_at.toISOString(),new Date(observed).toISOString());
  assert.equal(rows[0].sold_at.toISOString(),new Date(day+'T11:57:00Z').toISOString());
  assert.equal((await db.query('select count(*)::int n from ebay_live_observations where attempt_id=$1',[rows[0].id])).rows[0].n,3);
  await ingest(events);await reconcile();
  assert.equal((await attempts()).length,1);
  assert.equal((await db.query("select count(*)::int n from ebay_live_audit where action='live_paid_retry_reconciled'")).rows[0].n,1);
  await ingest([observation('failed',{key:'later-failure',time_label:'11:59 AM',observed_at:day+'T12:00:00Z'})]);
  assert.equal((await attempts())[0].payment_state,'failed','a later failure still stops the bag');
  await ingest([observation('paid')]);assert.notEqual((await attempts())[0].payment_state,'paid','replayed Paid must not resurrect it');
 });
}

for(const [name,change] of [
 ['same-minute failure',events=>events[1].time_label='11:57 AM'],
 ['later failure',events=>events[1].time_label='11:59 AM'],
 ['unknown failure time',events=>events[1].time_label='unknown'],
 ['Paid read before the new win',events=>events[0].observed_at=day+'T11:54:00Z'],
 ['Paid read in the ambiguous win minute',events=>events[0].observed_at=day+'T11:57:30Z'],
 ['second genuine win',events=>events.push(observation('won',{key:'previous-win',time_label:'11:54 AM'}))],
 ['cancellation',events=>events.push(observation('cancelled',{key:'cancelled',time_label:'11:58 AM'}))],
 ['unknown payment evidence',events=>events.push(observation('unknown',{key:'unknown'}))],
 ['different paid buyer',events=>events[0].buyer='anotherBuyer'],
 ['different paid amount',events=>events[0].amount=181],
]) test(`${name} stays held`,async()=>{
 const events=['paid','failed','won'].map(kind=>observation(kind));change(events);await ingest(events);
 const rows=await attempts();const win=rows.find(row=>row.win_key==='won');assert.ok(win);assert.notEqual(win.payment_state,'paid');
 assert.equal((await db.query("select count(*)::int n from ebay_live_audit where action='live_paid_retry_reconciled'")).rows[0].n,0);
});

test('ended shows, operator work and imported refunds retain the review path',async()=>{
 await db.exec('update ebay_live_connections set broadcast_ended_at=now()');
 await ingest(['paid','failed','won'].map(kind=>observation(kind)));
 assert.equal((await attempts()).length,2);
 await db.exec("update ebay_live_connections set broadcast_ended_at=null;update ebay_live_attempts set review_note='Operator is checking this bag'");
 await reconcile();assert.equal((await attempts()).length,2);
 await db.exec(`update ebay_live_attempts set review_note=null;
 insert into ebay_orders values('${sid}','buyer17','pending','{"orderPaymentStatus":"FULLY_REFUNDED"}',now());
 insert into ebay_order_lines values('${sid}','${sid}','287633255342',1,180,'pending','{}');`);
 await reconcile();assert.equal((await attempts()).length,2);
 await db.exec('delete from ebay_order_lines;delete from ebay_orders;update ebay_live_attempts set claimed_at=now()');
 await reconcile();assert.equal((await attempts()).length,2);
 await db.exec('update ebay_live_attempts set claimed_at=null');await reconcile();
 assert.equal((await attempts()).length,1);assert.equal((await attempts())[0].payment_state,'paid');
});

test('retry repair remains internal and capture retains its permission check',async()=>{
 assert.equal((await db.query("select has_function_privilege('authenticated','reconcile_ebay_live_paid_retry_internal(text)','execute') allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_function_privilege('anon','reconcile_ebay_live_paid_retry_internal(text)','execute') allowed")).rows[0].allowed,false);
 await db.exec("set test.allowed='no'");await assert.rejects(ingest([observation('paid')]),/Inventory access required/);
});
