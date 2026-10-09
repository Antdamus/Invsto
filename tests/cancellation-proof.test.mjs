import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {webcrypto} from 'node:crypto';

const root = new URL('../', import.meta.url);
const pendingSource = await readFile(new URL('pending-orders.js', root), 'utf8');
const backgroundSource = await readFile(new URL('tools/ebay-og-order-link-extension/background.js', root), 'utf8');
const appTab = {id:8, windowId:1, url:'https://antdamus.github.io/Invsto/pending-orders.html'};
const ebayTab = {id:9, windowId:1, url:'https://www.ebay.com/cmr/Cancel/Details?cancelId=12345'};
const orderNumber = '11-15257-22041';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8mUAAAAASUVORK5CYII=';
const proof = id => ({transferId:id, metadata:{orderNumber,cancelId:'12345',pageUrl:ebayTab.url},screenshot:{base64:png,mimeType:'image/png'}});

function page() {
  const elements = new Map(), messages = [], uploads = [], rpcCalls = [];
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set(id.endsWith('modal') ? ['hidden'] : []);
      elements.set(id,{value:'',textContent:'',focus(){},classList:{add(...v){v.forEach(x=>classes.add(x));},remove(...v){v.forEach(x=>classes.delete(x));},contains:v=>classes.has(v),toggle(v,on){on?classes.add(v):classes.delete(v);}}});
    }
    return elements.get(id);
  };
  const c = vm.createContext({console:{...console,error(){}},URL,URLSearchParams,Blob,atob,crypto:webcrypto,
    setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},
    document:{getElementById:element,addEventListener(){},querySelectorAll:()=>[]},
    window:{location:{origin:'https://antdamus.github.io',href:appTab.url,search:''},postMessage:m=>messages.push(m),setTimeout(){},addEventListener(){}},
  });
  vm.runInContext(pendingSource,c);
  const state = vm.runInContext('state',c);
  const line = {id:'line-a',order_id:'order-a',item_number:'123456789012',line_status:'pending',quantity:1,fulfilled_quantity:0,order:{order_number:orderNumber,buyer_username:'fixture-buyer'}};
  Object.assign(state,{user:{id:'user',email:'fixture@example.test'},orders:[line],selectedLine:line,ebayTransferReceiverReady:true});
  Object.assign(c,{
    renderWorkerCancelOrderList(){},renderWorkerCancelEvidencePhotos(){},renderOrders(){},
    openModal:id=>element(id).classList.remove('hidden'),closeModal:id=>element(id).classList.add('hidden'),
    returnToOrdersAfterMobileModalClose(){},loadNoInventoryCaptureStations:async()=>{},
    setWorkerCancelPhotoStatus:m=>{element('worker-cancel-photo-status').textContent=m;},
    selectOrderLine:id=>{state.selectedLine=state.orders.find(l=>l.id===id);},
    ensureExtensionOrderLinesLoaded:async()=>{},verifyCurrentUserPassword:async()=>true,
    getNoInventoryEvidenceSourceLabel:()=>orderNumber,createAndUploadEvidenceDerivatives:async()=>({}),
    loadOrders:async()=>{},getNextPackableLine:()=>null,clearSelection(){},setStatus(){},
    supabase:{storage:{from:()=>({upload:async(path,blob)=>{uploads.push({path,blob});return {};}})},
      rpc:async(name,args)=>{rpcCalls.push({name,args});return c.rpcError?{error:{message:'Save unavailable'}}:{data:[{updated_lines:1}]};}},
  });
  return {c,state,element,messages,uploads,rpcCalls};
}

test('multiple screenshots preserve notes, selected lines and earlier photos; closing/reopening recovers each draft once', async()=>{
  const p=page();p.c.openWorkerCancelOrderModal();
  p.element('worker-cancel-order-note').value='Keep this operator note';
  await p.c.handleEbayCancelProofTransfer(proof('one'));
  await p.c.handleEbayCancelProofTransfer(proof('two'));
  await p.c.handleEbayCancelProofTransfer(proof('two'));
  assert.equal(p.state.workerCancelEvidencePhotos.length,2);
  assert.equal(p.element('worker-cancel-order-note').value,'Keep this operator note');
  assert.deepEqual([...p.state.workerCancelLineIds],['line-a']);
  assert.equal(p.messages.filter(m=>m.payload?.phase==='attached').length,2);
  p.c.closeWorkerCancelOrderModal();p.c.openWorkerCancelOrderModal();
  assert.ok(p.messages.some(m=>m.type==='OG_EBAY_REQUEST_CANCEL_PROOFS'&&m.orderNumber===orderNumber));
  await p.c.handleEbayCancelProofTransfer({...proof('one'),restoreOnly:true});
  assert.equal(p.state.workerCancelEvidencePhotos.length,1);
});

test('failed imports can retry; missing identity, closed orders and a different open form never receive proof', async()=>{
  const p=page();const bad=proof('retry');bad.screenshot={};
  await p.c.handleEbayCancelProofTransfer(bad);
  assert.equal(p.state.handledEbayCancelProofTransferIds.has('retry'),false);
  await p.c.handleEbayCancelProofTransfer(proof('retry'));
  assert.equal(p.state.workerCancelEvidencePhotos.length,1);
  await assert.rejects(p.c.attachEbayCancelProofToWorkerModal({...proof('missing'),metadata:{itemNumber:'123456789012'}}),/exact eBay order/);
  p.state.orders[0].line_status='cancelled';
  await assert.rejects(p.c.attachEbayCancelProofToWorkerModal(proof('closed')),/already closed/);
  p.state.orders[0].line_status='pending';p.state.workerCancelMode='refunded';
  await assert.rejects(p.c.attachEbayCancelProofToWorkerModal(proof('other')),/Another cancellation or refund/);
  assert.equal(p.state.workerCancelEvidencePhotos.length,1);
});

test('original PNG and capture metadata reach signed audit; failed save retains proof and retry reuses upload', async()=>{
  const p=page();await p.c.handleEbayCancelProofTransfer(proof('save'));
  p.element('worker-cancel-order-password').value='fixture signature';p.c.rpcError=true;
  await p.c.confirmWorkerCancelOrder();
  assert.equal(p.uploads.length,1);
  assert.equal(Buffer.from(await p.uploads[0].blob.arrayBuffer()).toString('base64'),png);
  assert.equal(p.messages.some(m=>m.payload?.phase==='saved'),false);
  assert.equal(p.state.workerCancelEvidencePhotos.length,1);
  const evidence=p.rpcCalls[0].args._evidence_photos[0];
  assert.equal(evidence.bucket,'order-evidence-photos');
  assert.equal(evidence.metadata.orderNumber,orderNumber);
  assert.equal(evidence.metadata.transferId,'save');
  p.c.rpcError=false;await p.c.confirmWorkerCancelOrder();
  assert.equal(p.uploads.length,1,'retry must not create duplicate proof files');
  assert.ok(p.messages.some(m=>m.payload?.phase==='saved'&&m.payload.transferId==='save'));
  assert.ok(p.messages.some(m=>m.type==='OG_EBAY_PENDING_QUEUE_UPDATED'));
  assert.equal(p.messages.some(m=>m.type==='OG_EBAY_PENDING_QUEUE_CHANGED'),false,'old extensions must not navigate after cancellation');
  const afterSave=p.state.workerCancelEvidencePhotos.length;
  await p.c.handleEbayCancelProofTransfer(proof('save'));
  assert.equal(p.state.workerCancelEvidencePhotos.length,afterSave,'late legacy retransmissions must not reopen the canceled form');
});

test('existing cancellations open their details rather than restarting eBay cancellation',()=>{
  const p=page(),opened=[];p.c.window.open=url=>opened.push(url);
  p.c.openWorkerCancelOrderModal();
  p.c.getEbayCancellationDetailsUrl=()=>ebayTab.url;
  p.c.openEbayCancelFlowForWorkerModal();assert.equal(opened.pop(),ebayTab.url);
  p.c.getEbayCancellationDetailsUrl=()=>'';p.c.getLineCancellationSignal=()=>({cancelStatus:'CANCEL_CLOSED_WITH_REFUND'});
  p.c.openEbayCancelFlowForWorkerModal();assert.match(opened.pop(),/mesh\/ord\/details\?orderid=11-15257-22041$/);
});

function worker(t,{hasAwaiting=true,active=true,switchDuringCapture=false}={}) {
  let listener, delivered;const delivery=new Promise(r=>{delivered=r;});
  const stored={},focused=[],created=[],timers=new Set(),sent=[];
  const awaiting={id:10,windowId:1,url:'https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT',status:'complete'};
  let captureCount=0;
  t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  const tabs=[appTab,ebayTab,...(hasAwaiting?[awaiting]:[])];
  const chrome={runtime:{onMessage:{addListener:fn=>{listener=fn;}}},storage:{sync:{get:async()=>({ogPendingOrdersUrl:appTab.url})},local:{get:async key=>key?{[key]:stored[key]}:stored,set:async v=>Object.assign(stored,v),remove:async key=>{delete stored[key];}}},windows:{update:async()=>{}},tabs:{
    query:async q=>q?.active?(active?[ebayTab]:[appTab]):tabs,get:async id=>tabs.find(x=>x.id===id),
    update:async(id,options)=>{focused.push({id,...options});return tabs.find(x=>x.id===id);},create:async options=>{created.push(options);return appTab;},reload:async()=>{},
    captureVisibleTab:async()=>{captureCount++;if(switchDuringCapture)active=false;return 'data:image/png;base64,'+png;},
    sendMessage:async(id,message)=>{
      sent.push({id,message});
      if(message.type==='OG_EBAY_GET_LABEL_RECEIVER_STATE')return {ok:true,pageType:'pending-orders',selectedOrderNumber:orderNumber};
      if(message.type==='OG_EBAY_CANCEL_PROOF_TRANSFER'){delivered(message.payload);return {ok:true};}
      return {ok:true};
    },
  }};
  vm.runInNewContext(backgroundSource,{chrome,URL,console,setTimeout(fn,ms){const t=setTimeout(fn,ms);timers.add(t);return t;},clearTimeout,fetch(){throw new Error('Unexpected network');}});
  return {stored,focused,created,delivery,sent,get captureCount(){return captureCount;},send(type,payload,tab=appTab,extra={}){return new Promise(resolve=>assert.equal(listener({type,payload,...extra},{tab},resolve),true));}};
}

for(const hasAwaiting of [true,false])test(`cancellation queue update never changes focus or opens eBay (existing queue: ${hasAwaiting})`,async t=>{
  const w=worker(t,{hasAwaiting});await w.send('OG_EBAY_PENDING_QUEUE_CHANGED',{action:'worker_cancelled_order'});
  assert.equal(w.focused.length,0);assert.equal(w.created.length,0);
});

test('export remains recoverable after draft attachment and only clears after signed save',async t=>{
  const w=worker(t);const response=w.send('OG_EBAY_CAPTURE_CANCEL_CONFIRMATION',{metadata:proof('x').metadata},ebayTab);
  const payload=await w.delivery,key='ogPendingCancelProof:'+payload.transferId;
  assert.equal(payload.screenshot.base64,png);assert.equal(payload.screenshot.dataUrl,undefined);
  await w.send('OG_EBAY_CANCEL_PROOF_TRANSFER_STATUS',{transferId:payload.transferId,ok:true,phase:'attached'});
  assert.equal((await response).ok,true);assert.ok(w.stored[key]);assert.equal(w.focused.length,1);
  const restored=await w.send('OG_EBAY_GET_PENDING_CANCEL_PROOFS_FOR_ORDER',{},appTab,{orderNumber});
  assert.equal(restored.payloads.length,1);
  const unrelated=await w.send('OG_EBAY_GET_PENDING_CANCEL_PROOFS_FOR_ORDER',{},appTab,{orderNumber:'22-33333-44444'});
  assert.equal(unrelated.payloads.length,0);
  await w.send('OG_EBAY_CANCEL_PROOF_TRANSFER_STATUS',{transferId:payload.transferId,ok:true,phase:'saved'});
  assert.equal(w.stored[key],undefined);assert.equal(w.focused.length,1);
});

for(const options of [{active:false},{switchDuringCapture:true}])test(`wrong-tab screenshots are rejected: ${JSON.stringify(options)}`,async t=>{
  const w=worker(t,options);const result=await w.send('OG_EBAY_CAPTURE_CANCEL_CONFIRMATION',{metadata:proof('x').metadata},ebayTab);
  assert.equal(result.ok,false);assert.equal(Object.keys(w.stored).length,0);assert.equal(w.focused.length,0);
});
