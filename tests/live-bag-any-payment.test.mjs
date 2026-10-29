import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const source=await readFile(new URL('../live-bag-print-bridge.js',import.meta.url),'utf8');
const migration=await readFile(new URL('../supabase/migrations/20261029180000_live_capture_any_payment.sql',import.meta.url),'utf8');
const event='EVENT123',actor='00000000-0000-4000-8000-000000000010';
const sale=(state='waiting',overrides={})=>({id:randomUUID(),event_id:event,buyer:'winner',listing_title:'#101 Ring',payment_state:state,sold_at:new Date().toISOString(),...overrides});
function bridge(rows){
 const storage=new Map(),responses=new Map(),jobs=[],uploads=[],photos=[],lots=new Map();let listener,failAck=false,ended=false;
 const data=()=>({connection:{event_id:event,broadcast_ended_at:ended?'2026-10-29':null},server_time:new Date().toISOString(),attempts:rows});
 const win={liveBagLabel:{identity:()=>({auctionNumber:'101'})},printStations:{},
  addEventListener:(name,fn)=>{if(name==='message')listener=fn;},dispatchEvent(){},
  postMessage:message=>{responses.get(message.id)?.(message);},
  supabase:{auth:{getSession:async()=>({data:{session:{user:{id:actor}}}})},from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{session_id:'show',event_id:event}})};return q;},
   storage:{from:()=>({upload:async(path)=>{uploads.push(path);return {data:{path}};}})},
   rpc:async(name,args)=>{
    if(name==='get_ebay_live_dashboard')return {data:data()};
    if(name==='get_ebay_live_bag_print_status')return {data:[]};
    if(name==='list_print_stations')return {data:[{id:'station',paired:true,printer_name:'DYMO 450',name:'Show printer'}]};
    if(name==='prepare_ebay_live_bag_label'){let lot=lots.get(args._attempt_id);if(!lot){lot={id:args._attempt_id,lot_code:'LIVE-'+args._attempt_id};lots.set(args._attempt_id,lot);}return {data:lot};}
    if(name==='attach_ebay_live_bag_photo'){let p=photos.find(p=>p.id===args._photo_id);if(!p){p={id:args._photo_id,args};photos.push(p);}return {data:p};}
    throw Error('Unexpected RPC '+name);
   }}
 };
 storage.set('invsto.print.destination.v1','station');
 const context={window:win,location:{href:'https://example.test/live-sales.html?capture=1',origin:'https://example.test'},navigator:{locks:{request:async(name,options,fn)=>fn({})}},
 localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},URL,Date,Promise,Error,Object,Number,String,Map,JSON,Blob,Uint8Array,atob,CustomEvent:class{},createImageBitmap:async()=>({width:720,height:1280,close(){}})};
 vm.runInNewContext(source,context);
 win.liveBagPrintBridge.install({printBag:async(id,options)=>{let job=jobs.find(j=>j.options.requestId===options.requestId);if(!job){job={id,options};jobs.push(job);}if(failAck){failAck=false;throw Error('Acknowledgement lost');}return {mode:'remote-queue',status:'queued',jobId:options.requestId};}},rows=>[...rows].sort((a,b)=>Date.parse(b.sold_at)-Date.parse(a.sold_at)));
 const send=command=>new Promise(resolve=>{const id=randomUUID();responses.set(id,resolve);listener({source:win,origin:context.location.origin,data:{type:'INVSTO_BAG_PRINT_REQUEST',id,command:{event_id:event,...command}}});});
 return {send,storage,jobs,uploads,photos,lots,failAck:()=>{failAck=true;},end:()=>{ended=true;}};
}
test('every payment state stays selectable and permits photo and manual label requests',async()=>{
 const rows=['paid','waiting','failed','review','cancelled','unknown'].map(state=>sale(state,{payment_hold:true,resolved_at:'2026-10-28'})),b=bridge(rows);
 const status=await b.send({action:'status'});assert.equal(status.sales.length,6);assert.equal(status.sales[0].payment_hold,true);
 for(const row of rows){
  const before=structuredClone(row);
  assert.equal((await b.send({action:'print',attemptId:row.id,requestId:randomUUID()})).ok,true);
  assert.equal((await b.send({action:'photo',attemptId:row.id,requestId:randomUUID(),image:{dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:720,height:1280,capturedAt:new Date().toISOString()}})).ok,true);
  assert.deepEqual(row,before);
 }
 assert.equal(b.jobs.length,6);assert.equal(b.photos.length,6);
});
test('new unpaid auctions auto print once and payment changes never reprint them',async()=>{
 const rows=[sale('waiting')],b=bridge(rows);await b.send({action:'auto'});assert.equal(b.jobs.length,0);
 for(const state of ['waiting','failed','review','cancelled']){const row=sale(state);rows.push(row);await b.send({action:'auto'});const n=b.jobs.length;row.payment_state='paid';await b.send({action:'auto'});row.payment_state='failed';await b.send({action:'auto'});assert.equal(b.jobs.length,n);}
 assert.equal(b.jobs.length,4);
});
test('upgrade keeps pending sends, prevents unpaid backlog and retains lost-ack retry identity',async()=>{
 const rows=[sale('waiting'),sale('paid')],b=bridge(rows),key=`invsto.live.bagPrinter.v1.${actor}.auto.${event}`;
 b.storage.set(key,JSON.stringify({enabled:true,since:Date.now()-60000,seen:{[rows[0].id]:false,[rows[1].id]:true},done:{},pending:[{id:rows[1].id,number:'101'}],last:null,error:''}));
 b.failAck();const first=await b.send({action:'auto'});assert.match(first.automatic.error,/Acknowledgement lost/);
 rows[1].payment_state='failed';await b.send({action:'auto'});await b.send({action:'auto'});
 assert.equal(b.jobs.length,1);assert.equal(b.jobs[0].options.requestId,rows[1].id);
 assert.equal(JSON.parse(b.storage.get(key)).done[rows[0].id],'earlier');
});
test('pause, historical timestamps, finished shows and missing buyer identities stay bounded',async()=>{
 const rows=[sale()],b=bridge(rows);await b.send({action:'auto'});
 rows.push(sale('failed',{sold_at:'2020-01-01T00:00:00Z'}));await b.send({action:'auto'});assert.equal(b.jobs.length,0);
 await b.send({action:'auto',enabled:false});rows.push(sale('failed'));await b.send({action:'auto',enabled:true});assert.equal(b.jobs.length,0);
 b.end();rows.push(sale('waiting'));await b.send({action:'auto'});assert.equal(b.jobs.length,0);
 const merged=sale('paid',{merged_into:randomUUID()}),noBuyer=sale('failed',{buyer:''});rows.push(merged,noBuyer);
 for(const row of [merged,noBuyer])assert.equal((await b.send({action:'print',attemptId:row.id,requestId:randomUUID()})).ok,false);
 assert.equal((await b.send({action:'print',event_id:'OTHER123',attemptId:rows[0].id,requestId:randomUUID()})).ok,false);
});
test('database prepares unpaid identification bags without claiming inventory, clearing holds or reopening released bags',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create schema auth;create table auth.users(id uuid,email text);insert into auth.users values('${actor}','staff@example.test');
 create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;
 create function can_manage_inventory() returns boolean language sql as $$select true$$;
 create table live_sale_sessions(id uuid,status text);insert into live_sale_sessions values('${actor}','active');
 create table ebay_live_connections(event_id text,session_id uuid,review_completed_at timestamptz);insert into ebay_live_connections values('EVENT123','${actor}',null);
 create table live_sale_lots(id uuid default gen_random_uuid(),lot_code text,status text,owner_employee_id uuid);
 create table ebay_live_attempts(id uuid default gen_random_uuid(),event_id text,listing_id text,listing_title text,buyer text,seller_id uuid,payment_state text,resolved_at timestamptz,merged_into uuid,closed_at timestamptz,lot_id uuid,updated_at timestamptz,claimed_by uuid,claimed_at timestamptz,hold boolean);
 create table ebay_live_audit(event_id text,attempt_id uuid,action text,details jsonb);
 create function create_live_sale_lot(uuid,text,text,text,uuid) returns live_sale_lots language sql as $$insert into public.live_sale_lots(lot_code,status,owner_employee_id) values('LIVE-'||gen_random_uuid(),'open',$5) returning *$$;`);
 const start=migration.indexOf('create or replace function public.prepare_ebay_live_bag_label');await db.exec(migration.slice(start,migration.indexOf('end $$;',start)+7));
 for(const state of ['paid','waiting','failed','review','cancelled']){
  const id=(await db.query("insert into ebay_live_attempts(event_id,listing_id,listing_title,buyer,seller_id,payment_state,hold) values('EVENT123','123','#001 Ring','buyer',$1,$2,true) returning id",[actor,state])).rows[0].id;
  const lot=(await db.query('select to_jsonb(prepare_ebay_live_bag_label($1)) bag',[id])).rows[0].bag;
  const attempt=(await db.query('select * from ebay_live_attempts where id=$1',[id])).rows[0];
  assert.equal(attempt.payment_state,state);assert.equal(attempt.hold,true);assert.equal(attempt.claimed_by,null);assert.equal(attempt.closed_at,null);assert.equal(lot.owner_employee_id,actor);
  await db.query("update live_sale_lots set status='released' where id=$1",[lot.id]);
  const again=(await db.query('select to_jsonb(prepare_ebay_live_bag_label($1)) bag',[id])).rows[0].bag;assert.equal(again.id,lot.id);assert.equal(again.status,'released');
 }
 assert.equal((await db.query('select count(*)::int n from live_sale_lots')).rows[0].n,5);
});
