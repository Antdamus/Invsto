import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {webcrypto} from 'node:crypto';

const root=new URL('../',import.meta.url);
const pending=await readFile(new URL('pending-orders.js',root),'utf8');
function app(){
  const listeners={};
  const context=vm.createContext({console,setTimeout,clearTimeout,URLSearchParams,Promise,Date,
    window:{addEventListener(){},location:{search:''}},document:{addEventListener:(name,fn)=>listeners[name]=fn}});
  vm.runInContext(pending,context);
  return {context,listeners,run:code=>vm.runInContext(code,context)};
}

test('queue v2 includes original metadata in one request and the older API remains compatible',async()=>{
  const {run}=app();
  run(`var calls=[],hydrations=0,missing=false;
    hydrateFinancePayloadsForLines=async()=>{hydrations++;};
    var supabase={rpc:async(name,args)=>{calls.push(name);
      if(missing&&name.endsWith('_v2'))return {error:{code:'PGRST202',message:'list_pending_ebay_order_queue_v2 not found in schema cache'}};
      return {data:[{id:'line',order_id:'order',sale_date:'2026-10-01T12:00:00Z',
        line_raw_payload:{ebayFinance:{status:'PAID',memo:'saved memo'}},
        order_raw_payload:{date_precision:{sale_date:'day'},first_row:{'Sale Date':'Oct-01-26'}}}]};}};`);
  const rows=await run(`fetchOrderLineQueueViaRpc('pending',false)`);
  assert.equal(rows[0].ebay_orders.raw_payload.date_precision.sale_date,'day');
  assert.equal(rows[0].raw_payload.ebayFinance.memo,'saved memo');
  assert.equal(run('calls.length'),1);assert.equal(run('hydrations'),0);
  run('missing=true;calls=[]');await run(`fetchOrderLineQueueViaRpc('pending',false)`);
  assert.equal(run('calls.join(",")'),'list_pending_ebay_order_queue_v2,list_pending_ebay_order_queue');
  assert.equal(run('hydrations'),1);
  run('calls=[]');await run(`fetchOrderLineQueueViaRpc('pending',false)`);
  assert.equal(run('calls.length'),1,'remember the fallback instead of retrying an unavailable RPC');
});

test('stores and queue start together, and extension readiness waits for both',async()=>{
  const {run,listeners}=app();
  run(`var started=[],releaseStores,releaseOrders,ready=false;
    waitForSupabaseReady=async()=>{};loadCurrentWorker=async()=>true;
    setupEbayLabelReceiver=setupDashboardShell=setupImportVisibility=setupListeners=()=>{};
    clearOrderSearch=clearOrderCreatedDateFilter=()=>{};
    loadCheckoutStores=()=>{started.push('stores');return new Promise(r=>releaseStores=r)};
    loadOrders=()=>{started.push('orders');return new Promise(r=>releaseOrders=r)};
    loadOrderTaskAssignees=loadPackingSellerDirectory=async()=>{};
    getRequestedOrderTaskId=()=>'';openRequestedOrderTask=async()=>false;getRequestedEbayOrderNumbers=()=>[];
    applyRequestedEbayBuyerSelection=()=>{};markEbayTransferReceiverReady=()=>{ready=true};`);
  const boot=listeners.DOMContentLoaded();await new Promise(r=>setImmediate(r));
  assert.equal(run('started.join(",")'),'stores,orders');assert.equal(run('ready'),false);
  run('releaseOrders()');await new Promise(r=>setImmediate(r));assert.equal(run('ready'),false);
  run('releaseStores()');await boot;assert.equal(run('ready'),true);
});

test('finance progress separates slow retries, missing transactions and failures from order processing',()=>{
 const {run}=app();
 let status=run('formatFinanceQueueStatus({queued:8,working:3,retrying:2,checked:10,without_transactions:1})');
 assert.equal(status.remaining,13);assert.match(status.message,/close this page/);assert.match(status.message,/2 will retry automatically/);
 assert.match(status.message,/no transaction data yet/);
 status=run('formatFinanceQueueStatus({checked:10,failed:2})');
 assert.doesNotMatch(status.message,/checks finished/);assert.match(status.message,/Orders can still be processed/);assert.equal(status.failed,2);
 assert.equal(run('formatFinanceQueueStatus({}).message'),'');
});

test('finance status does not block page boot, avoids overlapping polls, and pauses while hidden',async()=>{
 const {run}=app();
 run(`var elements=new Map(),calls=0,releaseStatus,timers=[];
  document.getElementById=id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',addEventListener(){}});return elements.get(id);};
  setTimeout=(fn,delay)=>{timers.push(delay);return timers.length};clearTimeout=()=>{};
  var supabase={rpc:()=>{calls++;return new Promise(r=>releaseStatus=r)}};`);
 run('startFinanceQueueStatus()');assert.equal(run('calls'),1);
 await run('refreshFinanceQueueStatus()');assert.equal(run('calls'),1);
 run('releaseStatus({data:{queued:3}})');await new Promise(r=>setImmediate(r));
 assert.equal(run('elements.get("finance-sync-panel").hidden'),false);assert.equal(run('timers.at(-1)'),15000);
 run('document.hidden=true');await run('refreshFinanceQueueStatus()');assert.equal(run('calls'),1);assert.equal(run('timers.at(-1)'),60000);
 run('document.hidden=false;supabase.rpc=async()=>({error:{message:"offline"}})');await run('refreshFinanceQueueStatus()');
 assert.match(run('elements.get("finance-sync-status").textContent'),/continue processing orders/);
});

test('a failed queue request clears loading indicators and provides a refresh action',async()=>{
  const {run}=app();
  run(`var elements=new Map();
    document.getElementById=id=>{
      if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',value:'',classList:{remove(){}}});
      return elements.get(id);
    };
    isAdminUser=()=>true;
    fetchOrderLineQueue=async()=>{throw {code:'57014',message:'canceling statement due to statement timeout'}};
    console={...console,error(){}};`);
  await run('loadOrders()');
  assert.match(run('elements.get("orders-list").innerHTML'),/Click Refresh to try again/);
  assert.equal(run('elements.get("summary-pending").textContent'),'Unavailable');
  assert.equal(run('elements.get("order-count-pill").textContent'),'Could not load orders');
  assert.equal(run('elements.get("buyer-remaining-count").textContent'),'Count unavailable');
  assert.equal(run('[...elements.values()].some(e=>/Loading|Checking/.test(e.textContent))'),false);
});

test('photo original, preview and thumbnail uploads overlap without publishing a failed original',async()=>{
  const {run}=app();
  run(`var active=0,peak=0,failOriginal=false;
    var stateUser=state.user={email:'staff'};
    getNoInventoryEvidenceFileExtension=()=> 'jpg';
    createEvidenceDerivativeBlob=async()=>({blob:{size:25},mime_type:'image/jpeg',width:100,height:100});
    var supabase={storage:{from:()=>({upload:async(path)=>{active++;peak=Math.max(peak,active);
      await new Promise(r=>setTimeout(r,60));active--;return {error:failOriginal&&!/-preview|-thumb/.test(path)?{message:'Original failed'}:null}}})}};`);
  run('var crypto={randomUUID:()=>"test-photo"}');
  await run(`uploadCompletionPhoto({name:'photo.jpg',type:'image/jpeg',size:100})`);
  assert.equal(run('peak'),3);assert.equal(run('active'),0);
  run('failOriginal=true');await assert.rejects(run(`uploadCompletionPhoto({name:'photo.jpg',type:'image/jpeg',size:100})`),/Original failed/);
  assert.equal(run('active'),0);
});

test('private live channel is shared, reports reconnects, and cleans up only after its last subscriber',async()=>{
  const code=await readFile(new URL('order-live-updates.js',root),'utf8');
  const window={};vm.runInNewContext(code,{window,WeakMap,Set,Promise,console});
  let connect,receive,removed=0,channels=0;
  const client={channel(topic,options){channels++;assert.equal(topic,'pending-orders:updates');assert.equal(options.config.private,true);
    return {on(type,filter,callback){receive=callback;return this},subscribe(callback){connect=callback;return this}}},
    async removeChannel(){removed++}};
  const first=[],second=[];
  const a=window.OGOrderLiveUpdates.subscribe(client,event=>first.push(event.kind));
  const b=window.OGOrderLiveUpdates.subscribe(client,event=>second.push(event.kind));
  assert.equal(channels,1);connect('SUBSCRIBED');assert.equal(a.isConnected(),true);
  receive({payload:{kind:'completion_photo',order_id:'order'}});
  assert.deepEqual(first,['reconnected','completion_photo']);assert.deepEqual(second,first);
  connect('CHANNEL_ERROR');assert.equal(a.isConnected(),false);
  a();assert.equal(removed,0);connect('SUBSCRIBED');assert.equal(second.at(-1),'reconnected');
  b();assert.equal(removed,1);
});

test('extension delivers directly to a ready neutral page, preserves mismatches, and reloads legacy receivers',async()=>{
  const source=await readFile(new URL('tools/ebay-og-order-link-extension/background.js',root),'utf8');
  for(const mode of ['ready','legacy','mismatch']){
    const navigations=[],messages=[];
    const url='https://antdamus.github.io/Invsto/pending-orders.html';let context;
    const ack=id=>context.finishAck(id);
    const chrome={storage:{sync:{get:async()=>({ogPendingOrdersUrl:url})},local:{set:async()=>{}}},
      downloads:{onCreated:{addListener(){}},onChanged:{addListener(){}}},runtime:{onMessage:{addListener(){}}},
      windows:{update:async()=>{}},tabs:{query:async()=>[{id:1,url,windowId:2}],get:async()=>({id:1,windowId:2}),
        update:async(id,options)=>{if(options.url){navigations.push(options.url);ack(new URL(options.url).searchParams.get('labelTransferId'));}return {id,windowId:2}},
        sendMessage:async(id,message)=>{messages.push(message.type);
          if(message.type==='OG_EBAY_GET_LABEL_RECEIVER_STATE')return {ok:true,pageType:'pending-orders',receiverReady:true,
            supportsDirectLabelTransfer:mode!=='legacy',canAutoRoute:mode!=='mismatch',selectedOrderNumber:mode==='mismatch'?'other-order':''};
          if(message.type==='OG_EBAY_LABEL_TRANSFER')ack(message.payload.transferId);
          return {ok:true};}}};
    context=vm.createContext({chrome,URL,URLSearchParams,crypto:webcrypto,console,setTimeout,clearTimeout,Date});
    vm.runInContext(source.replace(/\}\)\(\);\s*$/,`globalThis.relay=relayLabelToApp;globalThis.finishAck=id=>appTransferAcks.get(id)?.resolve({ok:true});})();`),context);
    const result=await context.relay({base64:'test',metadata:{orderId:'order-1',shipmentId:'shipment'}});
    if(mode==='ready'){assert.equal(result.delivered,true);assert.equal(navigations.length,0);assert.ok(messages.includes('OG_EBAY_LABEL_TRANSFER'));}
    if(mode==='legacy'){assert.equal(result.opened,true);assert.equal(navigations.length,1);}
    if(mode==='mismatch'){assert.equal(result.blocked,true);assert.equal(navigations.length,0);}
  }
});
