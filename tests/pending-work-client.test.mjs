import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../pending-work-queue.js',import.meta.url),'utf8');
function fixture(){
 const rows=[{id:'a',key:'buyer'},{id:'b',key:'buyer'},{id:'c',key:'other'}];
 const elements={'order-search':{value:''},'order-status-filter':{value:'pending'}}, listeners={},reads=[];
 const context={state:{orders:rows},escapeHtml:s=>s.replaceAll('<','&lt;'),formatDate:s=>s,
 isOpenOrderLine:r=>r.line_status!=='fulfilled',getBuyerKey:r=>r.key,
 groupLinesByBuyer:rs=>[...new Set(rs.map(r=>r.key))].map(key=>({key,lines:rs.filter(r=>r.key===key)})),
 applyOrderFilters(){context.state.filteredOrders=context.window.OGPendingWork.filter(rows);},clearOrderSearch(){},requestAnimationFrame(){},setTimeout(){},clearTimeout(){},
 console:{warn(){}},supabase:{rpc:()=>({range:()=>new Promise(resolve=>reads.push(resolve))})},
 document:{getElementById:id=>elements[id],querySelectorAll:()=>[],addEventListener:(event,fn)=>listeners[event]=fn},
 window:{OGOrderWatches:{marked:()=>true},scrollBy(){},addEventListener(){},setInterval(){}}};
 vm.runInNewContext(source,context);const api=context.window.OGPendingWork;api.start();
 const click=(dataset,id)=>listeners.click({target:{closest:()=>({dataset,id,hasAttribute:()=>false})},preventDefault(){},stopPropagation(){}});
 const load=async(data=[])=>{const promise=api.load(rows,{paint:false});reads.at(-1)({data});await promise;};
 return{api,load,reads,rows,click,elements,state:context.state};
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

test('missing watch filter keeps the buyer together, counts lines, and is independent from CGL',async()=>{
 const f=fixture();
 const counter={textContent:''};f.elements['pending-work-missing']={setAttribute(){},querySelector:()=>counter};
 await f.load([blocker({id:'missing',kind:'watch_missing',line_ids:['a'],task_id:null}),blocker({id:'cgl',kind:'cgl',line_ids:['a'],task_id:null})]);
 assert.match(f.api.line(f.rows[0]),/Watch missing · Mark found/);
 assert.match(f.api.line(f.rows[0]),/data-work-cgl-manage/);
 assert.match(f.api.line(f.rows[1]),/data-work-missing-add/);
 assert.match(f.api.summary({key:'buyer'}),/Watch missing · 1 item/);
 f.click({},'pending-work-missing');assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['a','b']);assert.equal(counter.textContent,'1');
 await f.load([blocker({id:'cgl',kind:'cgl',line_ids:['a'],task_id:null})]);
 assert.equal(f.api.filter(f.rows).length,0);assert.match(f.api.emptyMessage(),/No watches are marked missing/);
 f.click({},'pending-work-cgl');assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['a','b']);
 f.click({workView:'ready'});assert.deepEqual(Array.from(f.api.filter(f.rows),r=>r.id),['c']);
});

test('item not found includes ready and waiting buyers, excludes unmarked and completed lines, and follows found updates',async()=>{
 const f=fixture(),counter={textContent:''};
 f.elements['pending-work-not-found']={setAttribute(){},querySelector:()=>counter};
 f.rows[0].item_search={is_missing:true};f.rows[2].item_search={is_missing:true};
 await f.load([blocker()]);
 f.click({},'pending-work-not-found');
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','b','c']);assert.equal(counter.textContent,'2');
 // One buyer is waiting and the other is ready; both must be visible.
 f.rows[0].item_search={is_missing:false};f.api.itemSearchChanged();
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['c']);assert.equal(counter.textContent,'1');
 f.rows[2].line_status='fulfilled';f.api.itemSearchChanged();
 assert.equal(f.state.filteredOrders.length,0);assert.equal(counter.textContent,'0');
 assert.match(f.api.emptyMessage(),/No pending items are marked not found/);
 f.rows[1].item_search={is_missing:true};f.api.itemSearchChanged();
 assert.deepEqual(Array.from(f.state.filteredOrders,r=>r.id),['a','b']);
 f.elements['order-search'].value='buyer';assert.equal(f.api.filter(f.rows).length,3);
});

test('item not found counts honor the date-filtered input and are independent of hold loading',()=>{
 const f=fixture(),counter={textContent:''};
 f.elements['pending-work-not-found']={setAttribute(){},querySelector:()=>counter};
 f.rows[0].item_search={is_missing:true};f.rows[2].item_search={is_missing:true};
 f.click({},'pending-work-not-found');
 assert.deepEqual(Array.from(f.api.filter(f.rows.slice(0,2)),r=>r.id),['a','b']);assert.equal(counter.textContent,'1');
});
