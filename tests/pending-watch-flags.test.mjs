import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import vm from 'node:vm';

const lineId='10000000-0000-0000-0000-000000000001';
const userId='20000000-0000-0000-0000-000000000001';
let db;
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;
  create schema auth;create schema realtime;
  create table auth.users(id uuid primary key,email text);
  insert into auth.users values('${userId}','worker@example.test');
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
  create function public.can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.staff',true)='yes'$$;
  create function realtime.send(jsonb,text,text,boolean) returns void language sql as $$select$$;
  create table public.ebay_order_lines(id uuid primary key,line_status text,quantity integer,fulfilled_quantity integer,raw_payload jsonb);
  insert into public.ebay_order_lines values('${lineId}','pending',2,0,'{"payment":"PAID"}');
  set test.staff='yes';set test.uid='${userId}';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010203000_order_line_watch_flags.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261103170000_pending_watch_brands.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
const save=async(value,revision=0)=>(await db.query('select * from public.set_order_line_watch($1,$2,$3)',[lineId,value,revision])).rows[0];

test('watch classification is shared, audited, reversible and idempotent without touching fulfillment',async()=>{
 const before=(await db.query('select * from ebay_order_lines')).rows;
 const marked=await save(true);
 assert.equal(marked.is_watch,true);assert.equal(marked.revision,1);assert.equal(marked.updated_by,userId);
 assert.equal((await save(true)).revision,1);
 const removed=await save(false,1);assert.equal(removed.revision,2);assert.equal(removed.is_watch,false);
 assert.equal((await db.query('select count(*)::int n from order_line_watch_events')).rows[0].n,2);
 assert.deepEqual((await db.query('select * from ebay_order_lines')).rows,before);
 await assert.rejects(save(true,1),/Another teammate/);
 assert.equal((await save(true,2)).revision,3);
});
test('eBay refresh and fulfillment do not clear a saved watch; completed items cannot be changed',async()=>{
 await db.exec(`update ebay_order_lines set raw_payload='{"freshImport":true}',line_status='fulfilled',fulfilled_quantity=2;`);
 assert.equal((await db.query('select is_watch from order_line_watch_flags')).rows[0].is_watch,true);
 await assert.rejects(save(false,3),/no longer pending/);
 await db.exec(`update ebay_order_lines set line_status='pending',fulfilled_quantity=0;`);
});
test('only authenticated staff can read or change markers, with no direct write privileges',async()=>{
 await db.exec("set test.staff='no'");await assert.rejects(save(false,3),/Staff access/);
 await db.exec('set role authenticated');
 assert.equal((await db.query('select * from order_line_watch_flags')).rows.length,0);
 await assert.rejects(db.exec('update order_line_watch_flags set is_watch=false'),/permission denied/);
 await db.exec("reset role;set test.staff='yes';set test.uid=''");
 await assert.rejects(save(false,3),/Staff access/);
 await db.exec(`set test.uid='${userId}';set role authenticated`);
 assert.equal((await db.query('select * from order_line_watch_flags')).rows.length,1);
 await db.exec('reset role;set role anon');await assert.rejects(save(false,3),/permission denied/);
 await db.exec('reset role');
});

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
test('brand changes use the signed marker revision and old clients can remove branded watches',async()=>{
 const assign=async(key,rev)=>(await db.query('select * from set_order_line_watch_brand($1,true,$2,$3)',[lineId,rev,key])).rows[0];
 assert.equal((await assign('cartier',3)).revision,4);
 assert.equal((await save(true,0)).brand,'cartier');
 await assert.rejects(assign('rolex',3),/Another teammate/);
 await assert.rejects(assign('unknown',4),/Invalid Watch/);
 assert.equal((await assign('rolex',4)).brand,'rolex');
 assert.equal((await save(false,5)).brand,null);
 assert.equal((await db.query('select count(*) n from order_line_watch_events')).rows[0].n,4);
});
async function client(){
 const listeners={},requests=[],reads=[],messages=[],row={id:lineId,line_status:'pending'};
 const dialog={querySelector:()=>({}),querySelectorAll:()=>[],showModal(){this.open=true;},close(){this.open=false;}};
 const context={state:{orders:[row],filteredOrders:[row]},console:{warn(){}},
  escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;'),isOpenOrderLine:r=>r.line_status==='pending',getBuyerKey:()=> 'buyer',
  setStatus:(...args)=>messages.push(args),document:{getElementById:id=>id==='watch-brand-picker'?dialog:null,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners[name]=fn,visibilityState:'visible'},
  supabase:{from:()=>({select:()=>({in:()=>{const d=deferred();reads.push(d);return d.promise;}})}),rpc:(name,args)=>{const d=deferred();requests.push({name,args,...d});return d.promise;}},
  window:{setInterval(){},addEventListener(){},OGOrderLiveUpdates:{subscribe(){}}}};
 vm.runInNewContext(await readFile(new URL('../pending-watch-flags.js',import.meta.url),'utf8'),context);
 const api=context.window.OGOrderWatches;api.start();
 const click=()=>listeners.click({target:{closest:()=>({dataset:{watchToggle:lineId}})},preventDefault(){},stopPropagation(){}});
 const flush=()=>new Promise(r=>setImmediate(r));
 const choose=key=>dialog.onclick({target:{closest:()=>({dataset:{watchChoice:key}})}});
 return{api,click,choose,reads,requests,row,messages,flush};
}
test('a late read cannot erase a saved marker and double-clicks make one request',async()=>{
 const c=await client();const first=c.api.load();c.reads[0].resolve({data:[]});await first;
 const late=c.api.load();c.click();assert.equal(c.requests.length,0);c.choose('cartier');c.choose('cartier');assert.equal(c.requests.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(c.requests[0].args)),{_order_line_id:lineId,_is_watch:true,_expected_revision:0,_brand:'cartier'});
 c.requests[0].resolve({data:{order_line_id:lineId,is_watch:true,brand:'cartier',revision:1}});await c.flush();
 c.reads[1].resolve({data:[]});await late;
 assert.match(c.api.line(c.row),/aria-pressed="true"/);assert.match(c.api.summary([c.row]),/Extra processing/);
});
test('failed saves keep the previous marker and show a local error; read failure never assumes unmarked',async()=>{
 const c=await client();const first=c.api.load();c.reads[0].resolve({error:{message:'offline'}});await first;
 c.click();assert.equal(c.requests.length,0);assert.match(c.api.line(c.row),/disabled/);assert.match(c.api.line(c.row),/Retry/);
 const read=c.api.load();c.reads[1].resolve({data:[{order_line_id:lineId,is_watch:true,revision:4}]});await read;
 c.click();c.choose('ap');c.requests[0].resolve({error:{message:'Could not save'}});await c.flush();
 assert.match(c.api.line(c.row),/aria-pressed="true"/);assert.match(c.api.line(c.row),/Could not save/);
});
test('counts distinct pending order IDs overall and within each brand',async()=>{
 const c=await client();
 const rows=['cartier','cartier','rolex','ap','other','cartier'].map((brand,i)=>({id:String(i),order_id:['A','A','A','B','C','D'][i],line_status:i===5?'fulfilled':'pending',brand}));
 const run=c.api.load(rows);c.reads[0].resolve({data:rows.map(r=>({order_line_id:r.id,is_watch:true,brand:r.brand,revision:1}))});await run;
 assert.deepEqual({...c.api.orderCounts(rows).counts},{all:3,cartier:1,rolex:1,ap:1,other:1});
 assert.deepEqual(rows.filter(r=>c.api.matches(r,'cartier')).map(r=>r.id),['0','1']);
});
