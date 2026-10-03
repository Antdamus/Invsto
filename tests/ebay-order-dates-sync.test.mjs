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
