import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const pending = await readFile(new URL('../pending-orders.js', import.meta.url), 'utf8');
const refunds = await readFile(new URL('../pending-partial-refunds.js', import.meta.url), 'utf8');
async function app() {
  const elements = new Map();
  const context = vm.createContext({console: {...console, error() {}}, URLSearchParams, setTimeout() {}, clearTimeout() {},
    window: {location: {search: ''}, addEventListener() {}},
    document: {addEventListener() {}, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {value: '', textContent: '', disabled: false});
      return elements.get(id);
    }}});
  const run = code => vm.runInContext(code, context);
  run(pending); run(refunds);
  run(`var approvedReview={order_id:'order',order_number:'01-12345-12345',reviewable:true,
      approval:{id:'approval',by:'manager@example.test',at:'2026-10-23T04:58:12Z',reason:'Verified discount'}};
    var calls=[],completionError=null;
    var supabase={rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='get_ebay_partial_refund_reviews')return {data:[approvedReview]};
      if(name==='complete_ebay_order_lines_without_inventory_evidence')return completionError?{error:completionError}:{data:[{updated_lines:1}]};
      throw Error('Unexpected RPC '+name);
    },from(table){return {select(){return this},eq(){return this},async maybeSingle(){return {data:table==='ebay_orders'
      ?{id:'order',raw_payload:structuredClone(state.orders[0].order.raw_payload),label_metadata:{},label_status:null,label_file_path:null}
      :{id:'line',raw_payload:structuredClone(state.orders[0].raw_payload)}}}}}};
    state.orders=[normalizeLine({id:'line',order_id:'order',line_status:'pending',quantity:1,fulfilled_quantity:0,
      raw_payload:{},order:{id:'order',order_number:'01-12345-12345',status:'pending',buyer_username:'buyer',
        raw_payload:{orderPaymentStatus:'PARTIALLY_REFUNDED',orderCancelStatus:'NONE_REQUESTED',
          pending_order_sync_mismatch:{ebayPaymentStatus:'PARTIALLY_REFUNDED',ebayCancelStatus:'NONE_REQUESTED',detectedAt:'old'},
          ebayFinance:{transactions:[{transactionId:'refund',transactionType:'REFUND',transactionStatus:'FUNDS_AVAILABLE',amount:{value:'100',currency:'USD'}}]}}}})];
    state.selectedLine=state.orders[0];
    renderSelectedOrder=renderWorkerNoInventoryCustomerIdentity=()=>{};
    isWorkerNoInventoryModalOpen=()=>true;
    var structuredClone=value=>JSON.parse(JSON.stringify(value));`);
  await run('window.OGPartialRefunds.load(state.orders)');
  return {run, context, elements};
}

test('opening completion hydrates label metadata without discarding a valid refund approval', async () => {
  const {run} = await app();
  assert.equal(run('window.OGPartialRefunds.approved(state.selectedLine)'), true);
  await run("hydrateSelectedOrderDetails('line')");
  assert.equal(run('state.selectedLine.orderDetailsHydrated'), true);
  assert.equal(run('window.OGPartialRefunds.approved(state.selectedLine)'), true);
  assert.equal(run('getLineFulfillmentBlock(state.selectedLine)'), '');
});

test('sync timestamps, photos and payout metadata do not change reviewed refund facts', async () => {
  const {run} = await app();
  run(`const order=state.selectedLine.order;
    order.raw_payload.pending_order_sync_mismatch.detectedAt='new';
    order.raw_payload.pending_order_sync_mismatch.reviewMessage='Updated check';
    order.raw_payload.ebayFinance.checkedAt='new';
    order.label_metadata={completionPhoto:'saved.jpg'};
    state.selectedLine.raw_payload.video_receipt_url='receipt';`);
  assert.equal(run('getLineFulfillmentBlock(state.selectedLine)'), '');
});

for (const [name, change] of [
  ['refund amount', `state.selectedLine.order.raw_payload.ebayFinance.transactions[0].amount.value='200'`],
  ['refund status', `state.selectedLine.order.raw_payload.ebayFinance.transactions[0].transactionStatus='PENDING'`],
  ['full refund on a line', `state.selectedLine.raw_payload.orderPaymentStatus='FULLY_REFUNDED'`],
  ['cancellation on a line', `state.selectedLine.raw_payload.orderCancelStatus='IN_PROGRESS'`],
  ['unpaid order', `state.selectedLine.order.raw_payload.orderPaymentStatus='UNPAID'`],
  ['API cancellation', `state.selectedLine.ebay_api_status={cancel_status:'IN_PROGRESS'}`],
  ['item quantity', `state.selectedLine.quantity=2`],
  ['item identity', `state.selectedLine.item_number='different'`],
  ['closed order', `state.selectedLine.order.status='cancelled'`],
]) test(`${name} changes still invalidate the cached approval`, async () => {
  const {run} = await app();
  run(change);
  assert.equal(run('window.OGPartialRefunds.approved(state.selectedLine)'), false);
  assert.ok(run('getLineFulfillmentBlock(state.selectedLine)'));
});

test('reordered JSON properties do not invalidate the same reviewed refund', async () => {
  const {run} = await app();
  run(`const transaction=state.selectedLine.order.raw_payload.ebayFinance.transactions[0];
    state.selectedLine.order.raw_payload.ebayFinance.transactions[0]=Object.fromEntries(Object.entries(transaction).reverse());`);
  assert.equal(run('getLineFulfillmentBlock(state.selectedLine)'), '');
});

test('a revoked server approval blocks the next refreshed queue', async () => {
  const {run} = await app();
  run('approvedReview.approval=null');
  await run('window.OGPartialRefunds.load(state.orders)');
  assert.match(run('getLineFulfillmentBlock(state.selectedLine)'), /Refund/);
});

for (const rejected of [false, true]) test(`hydrated completion reaches the guarded database RPC${rejected ? ' and preserves server rejection' : ''}`, async () => {
  const {run, elements} = await app();
  await run("hydrateSelectedOrderDetails('line')");
  run(`state.user={email:'manager@example.test'};state.checkoutStoreId='store';
    state.workerNoInventoryCandidates=[state.selectedLine];state.workerNoInventoryLineIds=new Set(['line']);
    state.workerNoInventoryGps={status:'captured'};
    requireCheckoutStore=()=>true;getSelectedNoInventoryEvidencePhotos=()=>[];
    setNoInventoryPhotoStatus=setStatus=clearEbayLaunchFilter=clearSelection=()=>{};
    persistNoInventoryEvidencePhotos=async()=>[];
    var closed=false;closeWorkerNoInventoryModal=()=>{closed=true};
    loadOrders=async()=>{};getNextPackableLine=()=>null;`);
  if (rejected) run(`completionError={message:'Do not ship: refund details changed on server'}`);
  await run('confirmWorkerNoInventoryCompletion()');
  assert.equal(run(`calls.filter(c=>c.name==='complete_ebay_order_lines_without_inventory_evidence').length`), 1);
  assert.equal(run('closed'), !rejected);
  assert.equal(run('state.busy'), false);
  assert.equal(elements.get('confirm-worker-no-inventory').disabled, false);
  if (rejected) assert.match(elements.get('worker-no-inventory-error').textContent, /changed on server/);
});
