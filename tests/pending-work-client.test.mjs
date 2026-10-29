import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../pending-work-queue.js',import.meta.url),'utf8');
function fixture({watch=true}={}){
 const rows=[{id:'a',key:'buyer'},{id:'b',key:'buyer'},{id:'c',key:'other'}];
 const elements={'order-search':{value:''},'order-status-filter':{value:'pending'},'order-created-date-filter':{value:''}}, listeners={},reads=[];
 const workButtons=['ready','waiting','all'].map(workView=>({dataset:{workView},counter:{textContent:''},setAttribute(){},querySelector(){return this.counter;}}));
 const context={state:{orders:rows},escapeHtml:s=>s.replaceAll('<','&lt;'),formatDate:s=>s,
 isOpenOrderLine:r=>r.line_status!=='fulfilled',getBuyerKey:r=>r.key,
 groupLinesByBuyer:rs=>[...new Set(rs.map(r=>r.key))].map(key=>({key,lines:rs.filter(r=>r.key===key)})),
 applyOrderFilters(){context.state.filteredOrders=context.window.OGPendingWork.filter(rows);},
 clearOrderSearch(){elements['order-search'].value='';},clearOrderCreatedDateFilter(){elements['order-created-date-filter'].value='';},
 clearEbayLaunchFilter(){context.state.ebayLaunchBuyerKeys=new Set();context.state.ebayLaunchOrderNumbers=new Set();},
 clearLiveLotSelection(){context.state.selectedLiveLot=null;},renderLiveLotPanel(){},loadOrders:async()=>{context.state.reloads=(context.state.reloads||0)+1;},
 getOrderUrgency:()=>null,requestAnimationFrame(){},setTimeout(){},clearTimeout(){},
 console:{warn(){}},supabase:{rpc:()=>({range:()=>new Promise(resolve=>reads.push(resolve))})},
 document:{getElementById:id=>elements[id],querySelector:()=>null,querySelectorAll:selector=>selector==='[data-work-view]'?workButtons:[],addEventListener:(event,fn)=>listeners[event]=fn},
 window:{OGOrderWatches:{marked:()=>watch},scrollBy(){},addEventListener(){},setInterval(){}}};
 vm.runInNewContext(source,context);const api=context.window.OGPendingWork;api.start();
 const click=(dataset,id)=>listeners.click({target:{closest:()=>({dataset,id,hasAttribute:()=>false})},preventDefault(){},stopPropagation(){}});
 const load=async(data=[])=>{const promise=api.load(rows,{paint:false});reads.at(-1)({data});await promise;};
 return{api,load,reads,rows,click,elements,state:context.state,counts:()=>Object.fromEntries(workButtons.map(b=>[b.dataset.workView,b.counter.textContent]))};
}
const blocker=(override={})=>({id:'hold',buyer_key:'buyer',kind:'task',task_id:'task',task_source:'team',active:true,line_ids:['a','b'],reason:'Waiting for clasp',assignee:'Otello',created_at:'2026-10-10',...override});
test('ready and waiting partition whole buyers; counts cannot imply unknown orders are ready; search bypasses hiding',async()=>{
 const f=fixture();assert.equal(f.api.filter(f.rows).length,0);
 await f.load([blocker()]);assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['c']);
 f.click({workView:'waiting'});assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['a','b']);
 f.elements['order-search'].value='buyer';assert.equal(f.api.filter(f.rows).length,3);
 f.elements['order-search'].value='';await f.load([blocker({active:false})]);assert.equal(f.api.filter(f.rows).length,0);
 f.click({workView:'ready'});assert.equal(f.api.filter(f.rows).length,3);
});
test('CGL is line-specific, HTML is escaped, ordinary customer tasks do not manufacture blockers',async()=>{
 const f=fixture();await f.load();assert.match(f.api.line(f.rows[0]),/Set Pending CGL/);
 assert.equal(f.api.summary({key:'buyer'}),'');
 await f.load([blocker({kind:'cgl',line_ids:['a'],task_id:null})]);
 assert.match(f.api.line(f.rows[0]),/Pending CGL/);assert.match(f.api.line(f.rows[1]),/Set Pending CGL/);
 assert.match(f.api.summary({key:'buyer'}),/Pending CGL · 1 item/);
 await f.load([blocker({reason:'<script>bad</script>'})]);assert.ok(!f.api.summary({key:'buyer'}).includes('<script>'));
});
test('a failed read does not classify orders as ready and a late read cannot erase a newer hold',async()=>{
 const f=fixture();await f.load();
 const earlier=f.api.load(f.rows,{paint:false});const later=f.api.load(f.rows,{paint:false});
 f.reads[2]({data:[blocker()]});await later;f.reads[1]({data:[]});await earlier;
 assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['c']);
 const failed=f.api.load(f.rows,{paint:false});f.reads[3]({error:Error('offline')});await failed;
 assert.equal(f.api.filter(f.rows).length,0);assert.match(f.api.control({key:'buyer',lines:f.rows}),/disabled/);
});

test('missing watch filter shows missing lines and is independent from CGL',async()=>{
 const f=fixture();
 const counter={textContent:''};f.elements['pending-work-missing']={setAttribute(){},querySelector:()=>counter};
 await f.load([blocker({id:'missing',kind:'watch_missing',line_ids:['a'],task_id:null}),blocker({id:'cgl',kind:'cgl',line_ids:['a'],task_id:null})]);
 assert.match(f.api.line(f.rows[0]),/Watch missing · Mark found/);
 assert.match(f.api.line(f.rows[0]),/data-work-cgl-manage/);
 assert.match(f.api.line(f.rows[1]),/data-work-missing-add/);
 assert.match(f.api.summary({key:'buyer'}),/Watch missing · 1 item/);
 f.click({},'pending-work-missing');assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['a']);assert.equal(counter.textContent,'1');
 f.click({},'pending-work-show-all');assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','b']);
 await f.load([blocker({id:'cgl',kind:'cgl',line_ids:['a'],task_id:null})]);
 assert.equal(f.api.filter(f.rows).length,0);assert.match(f.api.emptyMessage(),/No watches are marked missing/);
 f.click({},'pending-work-cgl');assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['a','b']);
 f.click({},'pending-work-cgl');
 f.click({workView:'ready'});assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['c']);
});

test('item not found includes ready and waiting buyers, excludes unmarked and completed lines, and follows found updates',async()=>{
 const f=fixture(),counter={textContent:''};
 f.elements['pending-work-not-found']={setAttribute(){},querySelector:()=>counter};
 f.rows[0].item_search={is_missing:true};f.rows[2].item_search={is_missing:true};
 await f.load([blocker()]);
 f.click({},'pending-work-not-found');
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','c']);assert.equal(counter.textContent,'2');
 // One buyer is waiting and the other is ready; both must be visible.
 f.rows[0].item_search={is_missing:false};f.api.itemSearchChanged();
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['c']);assert.equal(counter.textContent,'1');
 f.rows[2].line_status='fulfilled';f.api.itemSearchChanged();
 assert.equal(f.state.filteredOrders.length,0);assert.equal(counter.textContent,'0');
 assert.match(f.api.emptyMessage(),/No pending items are marked not found/);
 f.rows[1].item_search={is_missing:true};f.api.itemSearchChanged();
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['b']);
 f.elements['order-search'].value='buyer';assert.equal(f.api.filter(f.rows).length,3);
});

test('item not found counts honor the date-filtered input and are independent of hold loading',()=>{
 const f=fixture(),counter={textContent:''};
 f.elements['pending-work-not-found']={setAttribute(){},querySelector:()=>counter};
 f.rows[0].item_search={is_missing:true};f.rows[2].item_search={is_missing:true};
 f.click({},'pending-work-not-found');
 assert.deepEqual(Array.from(f.api.filter(f.rows.slice(0,2)),r=>r.id),['a']);assert.equal(counter.textContent,'1');
 assert.deepEqual(f.counts(),{ready:'…',waiting:'…',all:'1'});
});

test('counts and missing-line results stay aligned while switching work status, outer filters and full-buyer context',async()=>{
 const f=fixture(),counter={textContent:''},toggle={hidden:true,setAttribute(){}};
 f.elements['pending-work-not-found']={setAttribute(){},querySelector:()=>counter};
 f.elements['pending-work-show-all']=toggle;
 f.rows.push({id:'d',key:'unmarked'});
 f.rows[0].item_search={is_missing:true};f.rows[2].item_search={is_missing:true};
 await f.load([blocker()]);f.api.filter(f.rows);
 assert.deepEqual(f.counts(),{ready:'2',waiting:'1',all:'3'});assert.equal(toggle.hidden,true);
 f.click({},'pending-work-not-found');
 assert.deepEqual(f.counts(),{ready:'1',waiting:'1',all:'2'});assert.equal(counter.textContent,'2');
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','c']);assert.equal(toggle.hidden,false);
 f.click({},'pending-work-show-all');
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','b','c']);assert.equal(counter.textContent,'2');
 assert.match(toggle.textContent,/Show only missing/);
 f.click({},'pending-work-show-all');
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','c']);assert.match(toggle.textContent,/Show all buyer/);
 f.click({workView:'ready'});
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['c']);assert.equal(counter.textContent,'1');
 assert.deepEqual(f.counts(),{ready:'1',waiting:'1',all:'2'});
 f.click({workView:'waiting'});
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a']);assert.equal(counter.textContent,'1');
 f.click({workView:'all'});
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','c']);assert.equal(counter.textContent,'2');
 f.api.filter(f.rows.slice(2));assert.deepEqual(f.counts(),{ready:'1',waiting:'0',all:'1'});assert.equal(counter.textContent,'1');
 f.rows[0].item_search={is_missing:false};f.api.itemSearchChanged();
 assert.deepEqual(f.counts(),{ready:'1',waiting:'0',all:'1'});assert.equal(counter.textContent,'1');
 f.rows[2].item_search={is_missing:false};f.api.itemSearchChanged();
 assert.deepEqual(f.counts(),{ready:'0',waiting:'0',all:'0'});assert.equal(counter.textContent,'0');
 f.click({},'pending-work-not-found');
 assert.deepEqual(f.counts(),{ready:'2',waiting:'1',all:'3'});assert.equal(f.state.filteredOrders.length,4);assert.equal(toggle.hidden,true);
});

test('CGL, missing-watch and cancellation counters match the work status that will be shown',async()=>{
 for(const [filter,kind] of [['cgl','cgl'],['missing','watch_missing'],['cancel','pending_cancel']]){
  const f=fixture(),counter={textContent:''};
  f.elements[`pending-work-${filter}`]={setAttribute(){},querySelector:()=>counter};
  await f.load([blocker({kind,line_ids:['a'],task_id:null})]);
  f.click({},`pending-work-${filter}`);
  assert.deepEqual(f.counts(),{ready:'0',waiting:'1',all:'1'});assert.equal(counter.textContent,'1');
  f.click({workView:'ready'});assert.equal(f.state.filteredOrders.length,0);assert.equal(counter.textContent,'0');
  assert.deepEqual(f.counts(),{ready:'0',waiting:'1',all:'1'});
  f.click({workView:'all'});assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),filter==='missing'?['a']:['a','b']);assert.equal(counter.textContent,'1');
  await f.load();f.api.filter(f.rows);assert.deepEqual(f.counts(),{ready:'0',waiting:'0',all:'0'});
 }
});

test('not-found summary opens all marked pending buyers and keeps its total current outside the active filters',async()=>{
 for(const buttonId of ['summary-not-found-button','phone-summary-not-found-button']){
  const f=fixture(),pressed={};
  f.elements[buttonId]={setAttribute:(name,value)=>pressed[name]=value};
  for(const id of ['summary-not-found','phone-summary-not-found'])f.elements[id]={textContent:''};
  for(const id of ['buyer-refund-filter','buyer-refund-timing'])f.elements[id]={value:'restricted'};
  f.rows[0].item_search={is_missing:true};f.rows[2].item_search={is_missing:true};
  f.api.summaryCounts();assert.equal(f.elements['summary-not-found'].textContent,'2','count needs no waiting-status request');
  await f.load([blocker()]);
  f.elements['order-search'].value='unrelated';f.elements['order-created-date-filter'].value='2026-10-12';
  f.state.orderDueFilter='tomorrow';f.state.selectedLiveLot={id:'bag'};f.state.ebayLaunchBuyerKeys=new Set(['other']);
  f.click({},buttonId);
  assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','c'],'includes only missing lines from ready and waiting buyers');
  assert.equal(pressed['aria-pressed'],'true');assert.equal(f.state.orderDueFilter,'all');
  assert.equal(f.elements['order-search'].value,'');assert.equal(f.elements['order-created-date-filter'].value,'');
  assert.equal(f.state.selectedLiveLot,null);assert.equal(f.state.ebayLaunchBuyerKeys.size,0);
  for(const id of ['buyer-refund-filter','buyer-refund-timing'])assert.equal(f.elements[id].value,'all');
  f.rows[0].item_search={is_missing:false};f.api.itemSearchChanged();
  assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['c']);
  f.click({workView:'ready'});assert.equal(pressed['aria-pressed'],'true');
  f.rows[2].line_status='fulfilled';f.api.itemSearchChanged();
  for(const id of ['summary-not-found','phone-summary-not-found'])assert.equal(f.elements[id].textContent,'0');
  f.rows[1].item_search={is_missing:true};f.api.filter(f.rows.slice(2));f.api.itemSearchChanged();
  assert.equal(f.elements['summary-not-found'].textContent,'1','summary is the full pending queue, not the narrowed work view');
  f.elements['order-status-filter'].value='fulfilled';f.api.summaryCounts();
  assert.equal(f.elements['summary-not-found'].textContent,'—');
  f.click({},buttonId);assert.equal(f.state.reloads,1);assert.equal(f.elements['order-status-filter'].value,'pending');
 }
});

test('pending cancellation is available on ordinary lines, counted per line and keeps the buyer together',async()=>{
 const f=fixture({watch:false}),counter={textContent:''};
 f.elements['pending-work-cancel']={setAttribute(){},querySelector:()=>counter};
 assert.match(f.api.line(f.rows[0]),/data-work-cancel-add=.*disabled/);
 await f.load();assert.match(f.api.line(f.rows[0]),/data-work-cancel-add/);
 assert.doesNotMatch(f.api.line(f.rows[0]),/data-work-cgl|disabled/);
 await f.load([blocker({kind:'pending_cancel',line_ids:['a'],task_id:null})]);
 assert.match(f.api.line(f.rows[0]),/data-work-cancel-clear="a" aria-pressed="true"/);
 assert.match(f.api.line(f.rows[1]),/data-work-cancel-add="b"/);
 assert.match(f.api.summary({key:'buyer'}),/Pending to cancel · 1 item/);
 assert.doesNotMatch(f.api.summary({key:'buyer'}),/1 blocker/);
 f.click({},'pending-work-cancel');assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','b']);
 assert.equal(counter.textContent,'1');
 await f.load();assert.equal(f.api.filter(f.rows).length,0);
 assert.match(f.api.emptyMessage(),/No order lines are pending to cancel/);
 f.click({},'pending-work-cancel');
 f.click({workView:'ready'});assert.equal(f.api.filter(f.rows).length,3);
 f.rows[0].line_status='fulfilled';assert.equal(f.api.line(f.rows[0]),'');
});

test('desktop and phone summary counters count marked lines, and their shortcuts open the complete cancellation queue',async()=>{
 for(const buttonId of ['summary-cancel-button','phone-summary-cancel-button']){
  const f=fixture();
  f.elements['summary-pending-cancel']={textContent:''};f.elements['phone-summary-pending-cancel']={textContent:''};
  f.api.summaryCounts();assert.equal(f.elements['summary-pending-cancel'].textContent,'…');
  await f.load([blocker({id:'cancel-a',kind:'pending_cancel',line_ids:['a'],task_id:null}),blocker({id:'cancel-b',kind:'pending_cancel',line_ids:['b'],task_id:null})]);
  f.api.summaryCounts();assert.equal(f.elements['summary-pending-cancel'].textContent,'2');assert.equal(f.elements['phone-summary-pending-cancel'].textContent,'2');
  f.elements['order-search'].value='different buyer';f.elements['order-created-date-filter'].value='2026-10-12';f.elements['order-status-filter'].value='cancellations';
  f.state.orderDueFilter='today';f.state.selectedLiveLot={id:'bag'};f.state.ebayLaunchBuyerKeys=new Set(['other']);
  f.click({},buttonId);
  assert.equal(f.elements['order-search'].value,'');assert.equal(f.elements['order-created-date-filter'].value,'');
  assert.equal(f.elements['order-status-filter'].value,'pending');assert.equal(f.state.orderDueFilter,'all');
  assert.equal(f.state.selectedLiveLot,null);assert.equal(f.state.ebayLaunchBuyerKeys.size,0);
  assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','b']);
  await f.load();f.api.summaryCounts();assert.equal(f.elements['summary-pending-cancel'].textContent,'0');
  assert.equal(f.api.filter(f.rows).length,0);assert.match(f.api.emptyMessage(),/No order lines are pending to cancel/);
 }
});

test('the cancellation summary returns from History by reloading pending orders',async()=>{
 const f=fixture();await f.load();f.elements['order-status-filter'].value='fulfilled';
 f.elements['summary-pending-cancel']={textContent:''};f.api.summaryCounts();assert.equal(f.elements['summary-pending-cancel'].textContent,'—');
 f.click({},'summary-cancel-button');assert.equal(f.state.reloads,1);assert.equal(f.elements['order-status-filter'].value,'pending');
});

test('only selected missing-watch lines block partial completion; other holds and failed reads still block',async()=>{
 const f=fixture(),missing=blocker({kind:'watch_missing',line_ids:['a'],task_id:null});
 const check=async(rows,data,error)=>{const attempt=f.api.assertReady(rows);f.reads.at(-1)({data,error});return attempt;};
 await check([f.rows[1]],[missing]);
 await assert.rejects(check([f.rows[0],f.rows[1]],[missing]),/Watch missing.*unselected/);
 assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['c'],'buyer stays in Waiting');
 for(const kind of ['manual','task','cgl','pending_cancel'])
  await assert.rejects(check([f.rows[1]],[blocker({kind,line_ids:['a']})]),/Package is waiting/);
 await assert.rejects(check([f.rows[1]],null,Error('Offline')),/could not be checked/);
});
