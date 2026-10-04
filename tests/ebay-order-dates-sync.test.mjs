import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';

const plain=value=>JSON.parse(JSON.stringify(value));
function backend(){
  const ctx={Deno:{env:{get:()=>''},serve(handler){ctx.handler=handler;}},console,URL,URLSearchParams,Response,Request,AbortSignal};
  vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/ebay-order-sync/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'')),ctx);
  return ctx;
}
const raw={orderId:'23-15215-33555',creationDate:'2026-10-01T20:17:45Z',
  buyer:{username:'test-buyer'},paymentSummary:{payments:[{paymentDate:'2026-10-01T20:20:00Z'}]},
  lineItems:[{lineItemId:'txn-a',legacyItemId:'item-a',title:'Ring',quantity:1,lineItemFulfillmentInstructions:{shipByDate:'2026-10-06T06:59:00Z'}}]};
const existing={id:'order-a',order_number:raw.orderId,status:'pending',
  raw_payload:{source:'ebay_orders_report_csv',first_row:{'Sale Date':'Oct-01-26'},date_precision:{sale_date:'day',shipped_on_date:'day'},
    ebayFinance:{status:'paid'},cancellation_review:{keep_pending:true}}};

test('routine sync replaces CSV date placeholders even without finance data, preserving unrelated records',async()=>{
  const ctx=backend(),prepared=ctx.prepareOrder(raw,new Map()),writes=[];
  const client={from(table){assert.equal(table,'ebay_orders');return {update(patch){return {async eq(key,id){writes.push({key,id,patch:plain(patch)});return {};}};}};}};
  await ctx.updateExistingOrderDetails(client,[prepared],new Map([[raw.orderId,existing]]));
  assert.equal(writes.length,1);const update=writes[0].patch;
  assert.equal(update.sale_date,'2026-10-01T20:17:45.000Z');assert.equal(update.paid_on_date,'2026-10-01T20:20:00.000Z');
  assert.equal(update.ship_by_date,'2026-10-06T06:59:00.000Z');assert.equal(update.status,undefined);
  assert.equal(update.label_file_path,undefined);assert.equal(update.raw_payload.source,'ebay_orders_report_csv');
  assert.deepEqual(update.raw_payload.first_row,existing.raw_payload.first_row);
  assert.deepEqual(update.raw_payload.ebayFinance,existing.raw_payload.ebayFinance);
  assert.deepEqual(update.raw_payload.cancellation_review,existing.raw_payload.cancellation_review);
  assert.deepEqual(update.raw_payload.date_precision,{sale_date:'timestamp',paid_on_date:'timestamp',ship_by_date:'timestamp',shipped_on_date:'day'});
});

test('missing API dates never erase known dates or promote their precision',()=>{
  const ctx=backend();
  assert.equal(ctx.existingOrderDetailsUpdate({order:{sale_date:null,paid_on_date:null,ship_by_date:'bad',raw_payload:{}}},existing,'now'),null);
  const patch=plain(ctx.existingOrderDetailsUpdate({order:{sale_date:'2026-10-01T20:17:45Z',raw_payload:{ebayFinance:{status:'available'}}}},existing,'now'));
  assert.equal(patch.ship_by_date,undefined);assert.equal(patch.paid_on_date,undefined);
  assert.equal(patch.raw_payload.date_precision.shipped_on_date,'day');assert.equal(patch.raw_payload.date_precision.paid_on_date,undefined);
  assert.equal(patch.raw_payload.ebayFinance.status,'available');
});

test('timestamp repair dry run is read-only for orders; apply updates dates without imports, reservations or closeout',async()=>{
  const ctx=backend(),writes=[];
  ctx.getEbayAccessToken=async()=> 'fixture-token';ctx.fetchOrders=async()=>[raw];
  ctx.loadExistingOrders=async()=>new Map([[raw.orderId,existing]]);
  ctx.createClient=()=>({from(table){return {
    insert(){assert.equal(table,'ebay_order_sync_runs');return {select(){return {single:async()=>({data:{id:'run-a'}})};}};},
    update(patch){return {eq:async()=>{writes.push({table,patch:plain(patch)});return {};}};},
  };}});
  for(const dryRun of [true,false]){
    writes.length=0;
    const response=await ctx.handler(new Request('https://example.invalid/sync',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({datesOnly:true,dryRun,orderIds:[raw.orderId]})}));
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.ordersUpdated,dryRun?0:1);assert.equal(result.preview[0].saleDate,'2026-10-01T20:17:45.000Z');
    assert.equal(writes.filter(w=>w.table==='ebay_orders').length,dryRun?0:1);
    assert.ok(writes.every(w=>['ebay_orders','ebay_order_sync_runs'].includes(w.table)));
    assert.ok(writes.filter(w=>w.table==='ebay_orders').every(w=>w.patch.status===undefined&&w.patch.fulfilled_quantity===undefined));
  }
});

test('routine sync refreshes official payment evidence and preserves old buyer names for the same order',()=>{
 const ctx=backend();
 const prior={...existing,buyer_username:'old-name',raw_payload:{...existing.raw_payload,orderPaymentStatus:'PAID'}};
 const prepared=ctx.prepareOrder({...raw,buyer:{username:'new-name'},orderPaymentStatus:'FULLY_REFUNDED',cancelStatus:{cancelState:'CANCEL_COMPLETE'}},new Map());
 const patch=plain(ctx.existingOrderDetailsUpdate(prepared,prior,'checked'));
 assert.equal(patch.buyer_username,'new-name');assert.equal(patch.raw_payload.orderPaymentStatus,'FULLY_REFUNDED');
 assert.equal(patch.raw_payload.orderCancelStatus,'CANCEL_COMPLETE');assert.equal(patch.status,undefined);
 assert.deepEqual(patch.raw_payload.ebay_buyer_identity,{source:'ebay_fulfillment_api',order_number:raw.orderId,current_username:'new-name',aliases:['old-name','new-name'],checked_at:'checked'});
 assert.deepEqual(patch.raw_payload.cancellation_review,existing.raw_payload.cancellation_review);
 const again=plain(ctx.existingOrderDetailsUpdate(prepared,{...prior,...patch},'again'));
 assert.deepEqual(again.raw_payload.ebay_buyer_identity.aliases,['old-name','new-name']);
 const dates=plain(ctx.existingOrderDetailsUpdate(prepared,prior,'checked',false));
 assert.equal(dates.buyer_username,undefined);assert.equal(dates.raw_payload.orderPaymentStatus,'PAID');assert.equal(dates.raw_payload.ebay_buyer_identity,undefined);
});

test('targeted order-detail refresh updates evidence without importing lines or reserving stock',async()=>{
 const ctx=backend(),writes=[];
 ctx.getEbayAccessToken=async()=> 'fixture-token';ctx.fetchOrders=async()=>[{...raw,orderPaymentStatus:'FULLY_REFUNDED',buyer:{username:'new-name'}}];
 ctx.loadExistingOrders=async()=>new Map([[raw.orderId,{...existing,buyer_username:'old-name'}]]);
 ctx.createClient=()=>({from(table){return {
  insert(){assert.equal(table,'ebay_order_sync_runs');return {select(){return {single:async()=>({data:{id:'run-a'}})};}};},
  update(patch){return {eq:async()=>{writes.push({table,patch:plain(patch)});return {};}};},
 };}});
 for(const dryRun of [true,false]){
  writes.length=0;const response=await ctx.handler(new Request('https://example.invalid/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({detailsOnly:true,dryRun,orderIds:[raw.orderId]})}));
  const result=await response.json();assert.equal(response.status,200);assert.equal(result.preview[0].buyer,'new-name');assert.equal(result.preview[0].payment,'FULLY_REFUNDED');
  assert.equal(writes.filter(w=>w.table==='ebay_orders').length,dryRun?0:1);assert.ok(writes.every(w=>['ebay_orders','ebay_order_sync_runs'].includes(w.table)));
  if(!dryRun){const patch=writes.find(w=>w.table==='ebay_orders').patch;assert.equal(patch.buyer_username,'new-name');assert.equal(patch.status,undefined);assert.equal(patch.raw_payload.orderPaymentStatus,'FULLY_REFUNDED');}
 }
});

test('routine sync refreshes closed-order evidence without reopening or importing its lines',async()=>{
 const ctx=backend(),writes=[];
 ctx.getEbayAccessToken=async()=> 'fixture-token';
 ctx.fetchOrders=async()=>[{...raw,orderPaymentStatus:'FULLY_REFUNDED',orderFulfillmentStatus:'FULFILLED',buyer:{username:'new-name'}}];
 ctx.hydrateCancellationOrderDetails=async(_token,orders)=>({orders,warnings:[],checked:0});
 ctx.loadExistingOrders=async(_client,numbers)=>{assert.deepEqual(plain(numbers),[raw.orderId]);return new Map([[raw.orderId,{...existing,status:'fulfilled',buyer_username:'old-name'}]]);};
 ctx.updateOrderSyncMismatchFlags=async()=>{};ctx.loadItemMapBySku=async()=>new Map();
 ctx.loadFinanceTransactionsByOrder=async()=>({byOrder:new Map(),warnings:[],stats:{}});
 ctx.updateLocalOrderFinancePayloads=async()=>{};ctx.loadExistingLines=async(_client,ids)=>{assert.deepEqual(plain(ids),[]);return [];};
 ctx.createClient=()=>({from(table){return {
  insert(){assert.equal(table,'ebay_order_sync_runs');return {select(){return {single:async()=>({data:{id:'run-a'}})};}};},
  update(patch){return {eq:async()=>{writes.push({table,patch:plain(patch)});return {};}};},
 };}});
 const response=await ctx.handler(new Request('https://example.invalid/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dryRun:false,orderIds:[raw.orderId],checkLocalMismatches:false,syncFinance:false})}));
 const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
 assert.equal(result.ordersImported,0);assert.equal(result.linesImported,0);assert.equal(result.linesReserved,0);
 const patch=writes.find(w=>w.table==='ebay_orders')?.patch;assert.ok(patch);
 assert.equal(patch.status,undefined);assert.equal(patch.buyer_username,'new-name');assert.equal(patch.raw_payload.orderPaymentStatus,'FULLY_REFUNDED');
});

test('automatic capture check authenticates and uses only server-scoped order IDs',async()=>{
 const ctx=backend(),calls=[],writes=[];
 const client={auth:{getUser:async token=>({data:{user:token==='signed-in'?{id:'worker'}:null}})},rpc:async(name,args)=>{calls.push({name,args});return {data:{state:'complete'}};},from(table){assert.equal(table,'ebay_orders');return {update(patch){return {eq:async()=>{writes.push(plain(patch));return {};}};}};}};
 ctx.createClient=(_url,_key,options)=>{assert.equal(options.global.headers.Authorization,'Bearer signed-in');return {rpc:async(name,args)=>{calls.push({name,args});return {data:{orders:[raw.orderId],token:'lease',state:'checking'}};}};};
 ctx.getEbayAccessToken=async()=> 'api-token';ctx.fetchOrders=async(_token,body)=>{assert.deepEqual(plain(body),{orderIds:[raw.orderId]});return [{...raw,orderPaymentStatus:'PAID'}];};
 ctx.loadExistingOrders=async()=>new Map([[raw.orderId,existing]]);
 const unsigned=await ctx.refreshCapturedShowOrders(client,new Request('https://example.invalid'),'EVENT123');assert.equal(unsigned.status,401);assert.equal(calls.length,0);
 const result=await ctx.refreshCapturedShowOrders(client,new Request('https://example.invalid',{headers:{Authorization:'Bearer signed-in'}}),'EVENT123');
 assert.equal(result.status,200);assert.equal(writes.length,1);assert.equal(writes[0].status,undefined);
 assert.deepEqual(calls.map(c=>c.name),['claim_ebay_live_order_check','finish_ebay_live_order_check']);assert.equal(calls[1].args._ok,true);
 ctx.fetchOrders=async()=>[];writes.length=0;calls.length=0;
 await assert.rejects(()=>ctx.refreshCapturedShowOrders(client,new Request('https://example.invalid',{headers:{Authorization:'Bearer signed-in'}}),'EVENT123'),/Incomplete order response/);
 assert.equal(writes.length,0);assert.equal(calls.at(-1).args._ok,false);
});

test('automatic capture check does not call eBay when another receiver owns the batch',async()=>{
 const ctx=backend();ctx.createClient=()=>({rpc:async()=>({data:{orders:[],state:'checking'}})});
 ctx.getEbayAccessToken=async()=>{throw Error('Should not fetch eBay');};
 const client={auth:{getUser:async()=>({data:{user:{id:'worker'}}})}};
 const result=await ctx.refreshCapturedShowOrders(client,new Request('https://example.invalid',{headers:{Authorization:'Bearer signed-in'}}),'EVENT123');
 assert.equal(result.status,200);assert.equal((await result.json()).orderCheck.state,'checking');
});
