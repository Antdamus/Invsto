import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderPage, syncOrderPage, syncInProgress} from '../supabase/functions/tiktok-order-sync/sync.ts';

const order=()=>({id:'577637745070936130',user_id:'7021436810468230477',status:'AWAITING_SHIPMENT',payment:{currency:'USD',total_amount:'12.30'},create_time:1792950000,update_time:1792950050,line_items:[{id:'577637745070936131',sku_id:'1732789145515889437',product_id:'1732789133450515229',product_name:'Test item',display_status:'AWAITING_SHIPMENT',sale_price:'12.30',currency:'USD'}]});
const now=Date.parse('2026-10-31T16:00:00Z');
function fixture(pages){
 const state={shop_cipher:'test-shop',shop_id:'123456789012345',window_from:'2026-10-25T19:28:23Z',window_to:'2026-10-25T19:40:51Z',cursor_at:'2026-10-25T19:33:23Z',page_token:null,dispatch_token:'lease',enabled:true,last_error:'Old error'};
 const imports=[],requests=[],updates=[];
 const db={
  from(table){
   if(table==='tiktok_orders')return {select:()=>({in:async()=>({data:[{order_number:order().id,api_buyer_id:order().user_id,buyer_username:'saved.handle'}]})})};
   assert.equal(table,'tiktok_api_connection');
   return {update(values){const filters={};const query={eq(k,v){filters[k]=v;return query;},async select(){assert.deepEqual(filters,{singleton:true,dispatch_token:'lease'});if(state.dispatch_token!=='lease')return {data:[]};updates.push(values);Object.assign(state,values);return {data:[{singleton:true}]};}};return query;}};
  },
  async rpc(name,args){assert.equal(name,'import_tiktok_api_order');assert.equal(args._token,'lease');imports.push(args._rows);return {data:{ok:true}};}
 };
 const api={async read(path,token,query,body){requests.push({path,query,body});assert.equal(token,'test-access');const value=pages.shift();if(value instanceof Error)throw value;return value;}};
 return {state,imports,requests,updates,db,api,run:()=>syncOrderPage(db,{...state},'lease',api,'test-access',now)};
}
test('a confirmed empty response may omit or null its orders; ambiguous pages never advance',()=>{
 for(const data of [{total_count:0},{total_count:0,orders:null,next_page_token:''},{orders:[],total_count:0}])assert.deepEqual(orderPage(data).orders,[]);
 for(const data of [null,[],{}, {total_count:1}, {orders:null}, {total_count:'0'}, {orders:{},total_count:0}, {total_count:0,next_page_token:'next'}, {orders:[],next_page_token:'next'}, {orders:[],next_page_token:12}, {orders:[order()],total_count:0}])assert.throws(()=>orderPage(data));
 assert.throws(()=>orderPage({orders:[order()],next_page_token:'same'},'same'),/repeated/);
});
test('an empty window completes, then the next window imports new sales with overlap and preserved buyer names',async()=>{
 const f=fixture([{total_count:0},{orders:[order()],total_count:1}]);
 const end=f.state.window_to;
 assert.deepEqual(await f.run(),{ok:true,orders_read:0,more:false,empty_result:true});
 assert.equal(f.state.cursor_at,end);assert.equal(f.state.last_error,null);assert.equal(f.state.window_from,null);assert.equal(f.imports.length,0);
 // The database claims the next window using a five-minute overlap.
 Object.assign(f.state,{dispatch_token:'lease',window_from:new Date(Date.parse(f.state.cursor_at)-300000).toISOString(),window_to:new Date(now-10000).toISOString()});
 assert.equal((await f.run()).orders_read,1);
 assert.equal(f.requests[1].body.update_time_ge,Date.parse(end)/1000-300);
 assert.equal(f.imports[0][0].buyer_username,'saved.handle');assert.equal(f.imports[0][0].order_number,order().id);
 assert.equal(f.state.cursor_at,new Date(now-10000).toISOString());assert.equal(f.state.last_synced_at,new Date(now).toISOString());
});
test('pages resume in the same window until the final page succeeds',async()=>{
 const f=fixture([{orders:[order()],next_page_token:'page-two',total_count:2},{orders:[order()],total_count:2}]);
 const windowEnd=f.state.window_to,oldCursor=f.state.cursor_at;
 assert.equal((await f.run()).more,true);assert.equal(f.state.page_token,'page-two');assert.equal(f.state.cursor_at,oldCursor);assert.equal(f.state.window_to,windowEnd);
 f.state.dispatch_token='lease';assert.equal((await f.run()).more,false);
 assert.equal(f.requests[1].query.page_token,'page-two');assert.deepEqual(f.requests[1].body,f.requests[0].body);assert.equal(f.state.cursor_at,windowEnd);
});
test('invalid pages, unreadable orders, API failures and import failures preserve the checkpoint',async()=>{
 for(const page of [{total_count:10},new Error('API temporarily unavailable'),{orders:[order(),{...order(),status:'UNKNOWN'}]}]){
  const f=fixture([page]);const before={...f.state};await assert.rejects(f.run());assert.deepEqual(f.state,before);assert.equal(f.imports.length,0);assert.equal(f.updates.length,0);
 }
 const f=fixture([{orders:[order()]}]);const before={...f.state};f.db.rpc=async()=>({error:{message:'temporary'}});
 await assert.rejects(f.run(),/save/);assert.deepEqual(f.state,before);
});
test('a lost lease cannot report a successfully completed window',async()=>{
 const f=fixture([{total_count:0}]);f.state.dispatch_token='different-lease';await assert.rejects(f.run(),/lease expired/);assert.equal(f.updates.length,0);
});
test('failed or paused pagination does not lock the retry button as perpetually syncing',()=>{
 assert.equal(syncInProgress({enabled:true,page_token:'next',last_error:'failed'},now),false);
 assert.equal(syncInProgress({enabled:false,page_token:'next'},now),false);
 assert.equal(syncInProgress({enabled:true,page_token:'next'},now),true);
 assert.equal(syncInProgress({enabled:true,last_error:'failed',lease_until:new Date(now+1000).toISOString()},now),true);
 assert.equal(syncInProgress({enabled:true,lease_until:new Date(now-1000).toISOString()},now),false);
});
