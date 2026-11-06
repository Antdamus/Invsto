import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncRecentOrders} from '../supabase/functions/whatnot-order-sync/recent.mjs';

const now=Date.parse('2026-11-06T15:00:00Z');
const order=(id,created_at='2026-11-05T18:00:00Z')=>({id:String(id),created_at});
function fixture(pages){
 const connection={connected_at:'2026-10-31T16:00:00Z',full_in_progress:true,page_cursor:'historical-page',orders_processed:150000,recent_page_cursor:null,recent_synced_at:null};
 const saved=[],calls=[];let fail=null,ownsLease=true;
 const db={from(table){assert.equal(table,'whatnot_api_connection');return {update(changes){const filters={};const q={eq(k,v){filters[k]=v;return q;},async select(){assert.deepEqual(filters,{singleton:true,dispatch_token:'lease'});if(!ownsLease)return {data:[]};Object.assign(connection,changes);return {data:[{singleton:true}]};}};return q;}};}};
 const api={async page(path,cursor,limit){calls.push({path,cursor,limit});const p=pages.shift();if(p instanceof Error)throw p;return p;}};
 return {connection,saved,calls,setFail:id=>{fail=String(id);},loseLease:()=>{ownsLease=false;},run:(time=now)=>syncRecentOrders(db,{...connection},'lease',api,async o=>{if(o.id===fail)throw Error('Import failed');saved.push(o.id);},time)};
}

test('recent catch-up paginates past the newest five without changing historical progress',async()=>{
 const f=fixture([{data:Array.from({length:30},(_,i)=>order(100-i)),next_cursor:'recent-two'},{data:[order(70),order(69),order(68,'2026-10-30T00:00:00Z')],next_cursor:'older'}]);
 assert.deepEqual(await f.run(),{more:true,read:30});
 assert.equal(f.connection.recent_synced_at,null);assert.equal(f.connection.recent_page_cursor,'recent-two');
 assert.deepEqual(await f.run(now+60000),{more:false,read:2});
 assert.equal(f.saved.length,32);assert.equal(f.connection.recent_synced_at,new Date(now).toISOString());
 assert.equal(f.connection.recent_page_cursor,null);assert.equal(f.connection.page_cursor,'historical-page');assert.equal(f.connection.orders_processed,150000);
 assert.equal(f.calls[1].cursor,'recent-two');
});

test('failed imports keep the recent page checkpoint, so replay cannot skip a sale',async()=>{
 const f=fixture([{data:[order(10),order(9)],next_cursor:'two'},{data:[order(10),order(9)],next_cursor:'two'}]);
 const before=structuredClone(f.connection);f.setFail(9);
 await assert.rejects(f.run(),/Import failed/);assert.deepEqual(f.connection,before);
 f.setFail('none');await f.run();assert.deepEqual(f.saved,['10','10','9']);assert.equal(f.connection.recent_page_cursor,'two');
});

test('a completed catch-up uses its start time and overlaps the next window for arrivals during paging',async()=>{
 const f=fixture([{data:[order(10)],next_cursor:'two'},{data:[order(9)],next_cursor:null},{data:[order(11,'2026-11-06T15:00:30Z'),order(8,'2026-11-06T14:54:00Z')],next_cursor:'older'}]);
 await f.run();await f.run(now+60000);
 assert.equal(f.connection.recent_synced_at,new Date(now).toISOString());
 assert.deepEqual(await f.run(now+120000),{more:false,read:0});assert.equal(f.calls.length,2);
 assert.deepEqual(await f.run(now+300000),{more:false,read:1});assert.ok(f.saved.includes('11'));assert.ok(!f.saved.includes('8'));
});

test('empty final pages succeed; malformed pages, invalid dates and expired leases cannot advance',async()=>{
 const empty=fixture([{data:[],next_cursor:null}]);assert.deepEqual(await empty.run(),{more:false,read:0});assert.ok(empty.connection.recent_synced_at);
 for(const page of [{data:[],next_cursor:'more'},{data:[{id:'10',created_at:'invalid'}],next_cursor:null},new Error('API unavailable')]){
  const f=fixture([page]),before=structuredClone(f.connection);await assert.rejects(f.run());assert.deepEqual(f.connection,before);
 }
 const f=fixture([{data:[order(10)],next_cursor:null}]);f.loseLease();await assert.rejects(f.run(),/checkpoint/);assert.equal(f.connection.recent_synced_at,null);
});
