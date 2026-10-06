import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../ebay-order-history.js',import.meta.url),'utf8');
function app() {
  const context=vm.createContext({console,URLSearchParams,setTimeout:()=>0,clearTimeout,
    window:{addEventListener(){},location:{search:''}},document:{addEventListener(){}}});
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  run(`var hidden=true, renders=0, signed=0, writes=0, releaseSign;
    var modal={classList:{contains:()=>hidden,remove:()=>{hidden=false},add:()=>{hidden=true}}};
    var list={set innerHTML(v){renders++;},querySelectorAll:()=>[]};
    var container={set innerHTML(v){writes++;},querySelectorAll:()=>[]};
    document.getElementById=id=>id==='proof-trail-modal'?modal:id==='event-list'?list:null;
    document.body={classList:{add(){},remove(){}}};
    document.querySelector=()=>container;
    getFilteredEvents=()=>[];
    getEventEvidencePhotos=event=>event.photos;
    signEventEvidencePhoto=async()=>{signed++;return 'https://example.test/photo.jpg'};`);
  return {run};
}

test('task lookups preserve visibility, scope, latest updates, and refreshed data', () => {
  const {run}=app();
  run(`state.relatedOrderTasks=[
    {id:'outside',order_line_ids:['other'],title:'Other order'},
    {id:'visible',order_line_ids:['line'],title:'Check packing',status:'open'},
    {id:'whole',order_line_ids:['line','second'],title:'Whole order',metadata:{task_scope:'order'}},
    {id:'hidden',order_line_ids:['line'],metadata:{hidden_from_task_board:true}},
    {id:'receipt',order_line_ids:['line'],title:'Video receipt screenshot captured'},
    {id:'note',order_line_ids:['line'],metadata:{source:'pending_order_line_note'}},
    {id:'cancelled',order_line_ids:['line'],title:'Assignment cancelled'},
    {id:'assigned',order_line_ids:['line'],title:'Assignment cancelled',assigned_to_email:'staff@example.test'}
  ];
  state.relatedOrderTaskEvents=[
    {id:'old',task_id:'visible',order_line_ids:['line'],created_at:'2026-10-05T12:00:00Z',notes:'Old note'},
    {id:'new',task_id:'visible',order_line_ids:['line'],created_at:'2026-10-06T12:00:00Z',notes:'New note'},
    {id:'outside-event',task_id:'outside',order_line_ids:['other'],created_at:'2026-10-06T12:00:00Z'}
  ];`);
  assert.equal(run(`getHistoryOrderTasksForLineIds(['line','second']).map(t=>t.id).join(',')`),'visible,whole,assigned');
  assert.equal(run(`getHistoryOrderTasksForLineIds(['line'],{includeWholeOrderTasks:false}).map(t=>t.id).join(',')`),'visible,assigned');
  assert.equal(run(`getHistoryTaskSummaryForLineIds(['line']).tasks.find(t=>t.id==='visible').latestEvent.notes`),'New note');
  assert.equal(run(`getHistoryTaskEventsForLineIds(['second','line']).map(e=>e.id).join(',')`),'old,new');
  run(`state.relatedOrderTaskEvents=[{id:'refreshed',task_id:'visible',order_line_ids:['line']}];`);
  assert.equal(run(`getHistoryTaskEventsForTaskId('visible')[0].id`),'refreshed');
  run(`state.relatedOrderTaskEvents.unshift({id:'added',task_id:'visible',order_line_ids:['second']});`);
  assert.equal(run(`getHistoryTaskEventsForLineIds(['second'])[0].id`),'added');
});

test('large history lookups index events once and inspect only the matching tasks', () => {
  const {run}=app();
  run(`var taskReads=0,lineReads=0,visibilityChecks=0;
    state.relatedOrderTasks=Array.from({length:1000},(_,i)=>({id:'task-'+i,order_line_ids:['line-'+i]}));
    state.relatedOrderTaskEvents=Array.from({length:4000},(_,i)=>({id:'event-'+i,
      get task_id(){taskReads++;return 'task-'+(i%1000)},
      get order_line_ids(){lineReads++;return ['line-'+(i%1000)]}
    }));
    isHiddenHistoryOrderTask=()=>{visibilityChecks++;return false;};
    for(let i=0;i<1000;i++) {
      if(getHistoryTaskEventsForTaskId('task-'+i).length!==4) throw Error('Lost task events');
      if(getHistoryTaskEventsForLineIds(['line-'+i]).length!==4) throw Error('Lost line events');
      if(getHistoryOrderTasksForLineIds(['line-'+i]).length!==1) throw Error('Lost task');
    }`);
  assert.ok(run('taskReads')<=8000,'task reads must grow with events, not groups multiplied by events');
  assert.ok(run('lineReads')<=8000,'line reads must grow with events, not lines multiplied by events');
  assert.equal(run('visibilityChecks'),1000,'unrelated tasks must not be reclassified for each group');
});

test('related audit events keep category, first matching duplicate, and date ordering', () => {
  const {run}=app();
  run(`state.relatedAdminEvents=[
    {id:'same',order_line_ids:['outside'],notes:'Wrong line'},
    {id:'same',order_line_ids:['line'],notes:'First match',created_at:'2026-10-05T12:00:00Z'}
  ];
  state.adminEvents=[{id:'same',order_line_ids:['line'],notes:'Duplicate',created_at:'2026-10-06T12:00:00Z'}];
  state.relatedLabelEvents=[{id:'same',order_line_ids:['line','second'],created_at:'2026-10-06T12:00:00Z'}];
  state.revertEvents=[{id:'revert',order_line_ids:['line'],action:'old',created_at:'2026-10-07T12:00:00Z'}];`);
  const result=JSON.parse(run(`JSON.stringify(getRelatedEventsForLineIds(['second','line']))`));
  assert.deepEqual(result.map(e=>e.category),['revert','label','admin']);
  assert.equal(result[0].action,'reverted');
  assert.equal(result[2].notes,'First match');
  assert.equal(run(`getRelatedEventsForLineIds([]).length`),0);
  run(`state.labelEvents.unshift({id:'added',order_line_ids:['line'],created_at:'2026-10-08T12:00:00Z'});`);
  assert.equal(run(`getRelatedEventsForLineIds(['line'])[0].id`),'added');
});

test('receipt lookup skips unrelated evidence but keeps shared, explicit item matches and deduplication', () => {
  const {run}=app();
  run(`var inspected=[];
    getEventEvidencePhotos=event=>{inspected.push(event.id);return event.photos;};
    var photo={bucket:'proof',path:'video-receipts/123456789012.png',label:'Video receipt - 123456789012'};
    var receiptEvents=[
      {id:'outside',order_line_ids:['other'],photos:[photo]},
      {id:'line',order_line_ids:['line'],photos:[photo]},
      {id:'shared',order_line_ids:[],photos:[{...photo,path:'video-receipts/shared.png'}]},
      {id:'duplicate',order_line_ids:['line'],photos:[photo]},
      {id:'wrong-item',order_line_ids:['line'],photos:[{...photo,path:'video-receipts/999999999999.png',label:'Video receipt - 999999999999'}]}
    ];
    var receipts=getHistoryLineVideoReceiptPhotos({id:'line',item_number:'123456789012'},receiptEvents);`);
  assert.equal(run(`receipts.map(p=>p.event.id).join(',')`),'line,shared');
  assert.equal(run(`inspected.includes('outside')`),false);
});

test('reused formatters preserve currency, date, and invalid-value presentation', () => {
  const {run}=app();
  for (const amount of [0,12.34,-12.34,123456.78]) {
    assert.equal(run(`formatMoney(${amount})`),amount.toLocaleString(undefined,{style:'currency',currency:'USD'}));
  }
  const date='2026-10-06T13:45:00Z';
  assert.equal(run(`formatDateTime('${date}')`),new Date(date).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}));
  assert.equal(run(`formatDateOnly('${date}')`),new Date(date).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}));
  assert.equal(run(`formatDateTime('invalid')`),'-');
  assert.equal(run(`formatMoney(NaN)`),'$0.00');
});

test('indexed label search preserves exact tokens, first-event precedence, and refreshed labels', () => {
  const {run}=app();
  run(`function referenceLabelSearch(line) {
    const events=new Map();
    [...state.labelEvents,...state.relatedLabelEvents].forEach(event=>{
      const key=event.id||event.label_file_path+':'+event.created_at;
      if(!events.has(key)) events.set(key,event);
    });
    const number=normalizeEbayOrderNumber(line.order?.order_number);
    return buildHistorySearchText([...events.values()].filter(event=>
      (line.id&&(event.order_line_ids||[]).includes(line.id))||
      (number&&(event.order_numbers||[]).map(normalizeEbayOrderNumber).includes(number)))
      .flatMap(event=>[event.action,event.shipment_id,event.label_file_path,event.signed_by_email,
        getLabelMetadataSearchText(event.label_metadata),...(event.order_numbers||[])]).filter(Boolean));
  }
  state.labelEvents=[
    {id:'duplicate',order_line_ids:['outside'],action:'first duplicate'},
    {id:'line',order_line_ids:['line','second'],action:'Label attached',shipment_id:'ship-123456',
      label_metadata:{trackingNumbers:['9400 1234 5678 9000 1234 56'],labelRows:[{provider:'Test shipping',code:'ABC-123456'}]}}
  ];
  state.relatedLabelEvents=[
    {id:'duplicate',order_line_ids:['line'],action:'must be ignored'},
    {id:'order',order_numbers:['11 22222 33333'],action:'replaced',label_file_path:'labels/a.pdf'},
    {label_file_path:'labels/fallback.pdf',created_at:'2026-10-06',order_line_ids:['line'],action:'fallback'},
    {label_file_path:'labels/fallback.pdf',created_at:'2026-10-06',order_line_ids:['line'],action:'ignored'}
  ];
  var searchLines=[{id:'line',order:{order_number:'11-22222-33333'}},{id:'second'},
    {id:'outside'},{order:{order_number:'11-22222-33333'}},{id:'no-match'},{}];`);
  for (let i=0;i<6;i++) assert.equal(run(`getLabelEventSearchTextForLine(searchLines[${i}])`),run(`referenceLabelSearch(searchLines[${i}])`));
  run(`state.labelEvents.unshift({id:'new',order_line_ids:['line'],action:'new label'});`);
  assert.equal(run('getLabelEventSearchTextForLine(searchLines[0])'),run('referenceLabelSearch(searchLines[0])'));
  run(`state.relatedLabelEvents=[{id:'replacement',order_line_ids:['line'],action:'fresh lookup'}];`);
  assert.equal(run('getLabelEventSearchTextForLine(searchLines[0])'),run('referenceLabelSearch(searchLines[0])'));
});

test('shared label metadata is normalized once per dataset rather than once per matching line', () => {
  const {run}=app();
  run(`var metadataReads=0;
    state.labelEvents=Array.from({length:500},(_,i)=>({id:'label-'+i,
      order_line_ids:['line-'+i,'line-'+(i+500)],order_numbers:['11-22222-'+String(10000+i)],
      get label_metadata(){metadataReads++;return {trackingNumbers:['9400111899560000000000']};}
    }));
    for(let i=0;i<1000;i++) {
      if(!getLabelEventSearchTextForLine({id:'line-'+i}).includes('9400111899560000000000')) throw Error('Missing label');
    }`);
  assert.equal(run('metadataReads'),500);
});

test('receipt photos wait for the viewport, bound requests, and cancel detached work', async () => {
  const {run}=app();
  run(`var receiptObserver, observedReceipts=[], finishReceipts=[], receiptStarts=[];
    var IntersectionObserver=class {
      constructor(callback){this.callback=callback;receiptObserver=this;}
      observe(target){observedReceipts.push(target);}
      unobserve(){} disconnect(){}
    };
    var receiptButtons=Array.from({length:100},(_,i)=>({
      dataset:{bucket:'proof',path:i+'.png'},isConnected:true,getClientRects:()=>[{}],
      addEventListener(){},querySelector:()=>null
    }));
    document.querySelectorAll=()=>receiptButtons;
    signEventEvidencePhoto=photo=>{
      receiptStarts.push(photo.path);return new Promise(resolve=>finishReceipts.push(()=>resolve('https://example.test/photo.jpg')));
    };`);
  await run('hydrateHistoryVideoReceiptThumbnails()');
  assert.equal(run('observedReceipts.length'),100);
  assert.equal(run('receiptStarts.length'),0);
  run(`receiptObserver.callback(receiptButtons.slice(0,6).map(target=>({target,isIntersecting:true})),receiptObserver);`);
  assert.equal(run('receiptStarts.length'),8,'at most four photos, two URLs each');
  run('finishReceipts[0]();finishReceipts[1]()');
  await new Promise(r=>setImmediate(r));
  assert.equal(run('receiptStarts.length'),10,'the next visible photo starts when a slot frees');
  run(`receiptButtons.forEach(button=>button.isConnected=false);finishReceipts.forEach(finish=>finish());`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('receiptStarts.length'),10,'detached queued photos must never start');
  assert.equal(run(`receiptButtons.filter(button=>button.dataset.loaded==='true').length`),1,'detached in-flight photos must not update the old DOM');
  run(`receiptButtons=[];hydrateHistoryVideoReceiptThumbnails();`);
  assert.equal(run('historyReceiptPhotoQueue.length'),0);
});

test('task event chunks overlap with at most three reads and preserve result order', async () => {
  const {run}=app();
  run(`var pendingChunks=[],startedChunks=[];
    fetchOverlappingRows=async()=>({data:Array.from({length:600},(_,i)=>({id:'task-'+i,order_line_ids:['line']}))});
    var supabase={from:()=>{
      var ids;
      var query={select:()=>query,in:(_,values)=>{ids=values;return query;},order:()=>query,limit:()=>{
        startedChunks.push(ids[0]);return new Promise(resolve=>pendingChunks.push(()=>resolve({data:[{id:ids[0],task_id:ids[0]}]})));
      }};return query;
    }};`);
  const pending=run(`loadOrderTaskDataForLines(['line'],[])`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('startedChunks.length'),3);
  run('pendingChunks[2]();pendingChunks[0]()');
  await new Promise(r=>setImmediate(r));
  assert.equal(run('startedChunks.length'),3,'the next batch waits for the current batch');
  run('pendingChunks[1]()');
  await new Promise(r=>setImmediate(r));
  assert.equal(run('startedChunks.length'),4);
  run('pendingChunks[3]()');
  const result=await pending;
  assert.equal(result.events.map(e=>e.id).join(','),'task-0,task-150,task-300,task-450');
});

test('failed concurrent task event reads reject the load', async () => {
  const {run}=app();
  run(`fetchOverlappingRows=async()=>({data:Array.from({length:450},(_,i)=>({id:'task-'+i,order_line_ids:['line']}))});
    var supabase={from:()=>{
      var ids;
      var query={select:()=>query,in:(_,values)=>{ids=values;return query;},order:()=>query,
        limit:async()=>ids[0]==='task-150'?{error:new Error('Events unavailable')}:{data:[]}};
      return query;
    }};`);
  await assert.rejects(run(`loadOrderTaskDataForLines(['line'],[])`),/Events unavailable/);
});

test('related dataset reads overlap in pairs, preserve duplicate precedence, and stop on errors', async () => {
  const {run}=app();
  run(`var chunkStarts=[],finishChunks=[];
    var readChunk=ids=>{
      chunkStarts.push(ids);return new Promise(resolve=>finishChunks.push(resolve));
    };`);
  const pending=run(`fetchHistoryRowsInChunks(['a','a',null,'b','c','d','e'],readChunk,1)`);
  assert.equal(run('chunkStarts.length'),2);
  run(`finishChunks[1]({data:[{id:'same',value:'second'}]})`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('chunkStarts.length'),2);
  run(`finishChunks[0]({data:[{id:'same',value:'first'}]})`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('chunkStarts.length'),4);
  run(`finishChunks[2]({data:[{id:'third'}]});finishChunks[3]({data:[{id:'fourth'}]})`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('chunkStarts.length'),5);
  run(`finishChunks[4]({data:[]})`);
  const result=JSON.parse(JSON.stringify(await pending));
  assert.deepEqual(result,{data:[{id:'same',value:'first'},{id:'third'},{id:'fourth'}],error:null});
  run('chunkStarts=[];finishChunks=[]');
  const failed=run(`fetchHistoryRowsInChunks(['a','b','c','d'],readChunk,1)`);
  run(`finishChunks[0]({data:[{id:'good'}]});finishChunks[1]({error:'Unavailable'})`);
  assert.deepEqual(JSON.parse(JSON.stringify(await failed)),{data:[{id:'good'}],error:'Unavailable'});
  assert.equal(run('chunkStarts.length'),2,'do not start additional requests after a failed batch');
  assert.deepEqual(JSON.parse(JSON.stringify(await run('fetchHistoryRowsInChunks([],readChunk)'))),{data:[],error:null});
});

test('closed Proof Trail does no rendering or evidence signing; opening renders current filters',async()=>{
  const {run}=app();
  run('renderEventList()');
  await run('hydrateEventEvidencePhotos([{photos:[{bucket:"proof",path:"one.jpg"}]}])');
  assert.equal(run('renders'),0); assert.equal(run('signed'),0);
  run('openProofTrailModal()'); assert.equal(run('renders'),1);
  run('closeProofTrailModal(); renderEventList()'); assert.equal(run('renders'),1);
  run('openProofTrailModal()'); assert.equal(run('renders'),2);
});

test('open Proof Trail signs and displays evidence',async()=>{
  const {run}=app(); run('openProofTrailModal()');
  await run('hydrateEventEvidencePhotos([{photos:[{bucket:"proof",path:"one.jpg"}]}])');
  assert.equal(run('signed'),2); assert.equal(run('writes'),1);
});

for (const action of ['closeProofTrailModal()','renderEventList()']) {
  test(`stale photo hydration stops after ${action}`,async()=>{
    const {run}=app(); run(`openProofTrailModal();
      signEventEvidencePhoto=()=>{signed++;return signed===1?new Promise(r=>releaseSign=r):Promise.resolve('https://example.test/photo.jpg')};`);
    const pending=run('hydrateEventEvidencePhotos([{photos:[{bucket:"proof",path:"one.jpg"}]},{photos:[{bucket:"proof",path:"two.jpg"}]}])');
    run(`${action}; releaseSign('https://example.test/photo.jpg')`);
    await pending;
    assert.equal(run('writes'),0); assert.equal(run('signed'),2,'do not start the next event');
  });
}

test('line and order task lookups overlap, then preserve deduplication and event context',async()=>{
  const {run}=app();
  run(`var started=[],releaseLines,releaseOrders,eventReads=0;
    fetchOverlappingRows=()=>{started.push('lines');return new Promise(r=>releaseLines=r)};
    var supabase={from:table=>{
      var query={select:()=>query,in:()=>query,order:()=>query,limit:()=>{
        if(table==='ebay_order_tasks'){started.push('orders');return new Promise(r=>releaseOrders=r)}
        eventReads++;return Promise.resolve({data:[{id:'event',task_id:'order-task',signed_by_email:'worker@example.test'}]});
      }};return query;
    }};`);
  const pending=run(`loadOrderTaskDataForLines(['line'],['order'],{lines:[{id:'line',order_id:'order'}]})`);
  assert.equal(run('started.join(",")'),'lines,orders');
  assert.equal(run('eventReads'),0);
  run(`releaseOrders({data:[{id:'shared',order_id:'order',order_line_ids:['line']},{id:'order-task',order_id:'order',order_line_ids:[],title:'Check proof'}]})`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('eventReads'),0,'events must wait for both task scopes');
  run(`releaseLines({data:[{id:'shared',order_id:'order',order_line_ids:['line']}],error:null})`);
  const result=JSON.parse(JSON.stringify(await pending));
  assert.equal(result.tasks.length,2);
  assert.deepEqual(result.tasks[1].order_line_ids,['line']);
  assert.equal(result.events[0].task_title,'Check proof');
  assert.equal(result.events[0].created_by_email,'worker@example.test');
  assert.deepEqual(result.events[0].order_line_ids,['line']);
});

test('a failed task lookup rejects instead of publishing incomplete task evidence',async()=>{
  const {run}=app();
  run(`fetchOverlappingRows=async()=>({data:[],error:new Error('Task lookup failed')});`);
  await assert.rejects(run(`loadOrderTaskDataForLines(['line'],[])`),/Task lookup failed/);
});

test('Proof Trail only loads photos near the viewport and bounds simultaneous events',async()=>{
  const {run}=app();
  run(`var photoObserver, observed=[], unloaded=[], photoStarts=[], finishPhoto=[];
    var IntersectionObserver=class {
      constructor(callback){this.callback=callback;photoObserver=this;}
      observe(target){observed.push(target);}
      unobserve(target){unloaded.push(target);}
      disconnect(){}
    };
    var photoTargets=Array.from({length:100},(_,index)=>({dataset:{eventEvidenceIndex:String(index)}}));
    list.querySelectorAll=()=>photoTargets;
    hydrateEventEvidencePhotos=(events,version,indexes)=>{
      photoStarts.push(indexes[0]);return new Promise(resolve=>finishPhoto.push(resolve));
    };
    openProofTrailModal();
    observeEventEvidencePhotos(Array.from({length:100},()=>({})),proofTrailRenderVersion);`);
  assert.equal(run('observed.length'),100);
  assert.equal(run('photoStarts.length'),0,'offscreen photos must not trigger requests');
  run(`photoObserver.callback(photoTargets.slice(0,3).map(target=>({target,isIntersecting:true})),photoObserver)`);
  assert.equal(run('photoStarts.join(",")'),'0,1');
  run('finishPhoto[0]()'); await new Promise(r=>setImmediate(r));
  assert.equal(run('photoStarts.join(",")'),'0,1,2');
  run(`photoObserver.callback([{target:photoTargets[3],isIntersecting:true}],photoObserver);closeProofTrailModal();finishPhoto[1]();finishPhoto[2]();`);
  await new Promise(r=>setImmediate(r));
  assert.equal(run('photoStarts.join(",")'),'0,1,2','closing cancels queued offscreen work');
});
