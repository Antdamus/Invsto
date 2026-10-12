import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=(await readFile(new URL('../pending-work-queue.js',import.meta.url),'utf8'))
 .replace('window.OGPendingWork={','window.undoTest={showNotice,undoLast,addLineHold,clearCancellation,load};window.OGPendingWork={');
function fixture(){
 const buttons=[{},{ }],paragraph={},calls=[],rows=[{id:'line',key:'buyer'}];let readRows=[];
 const notice={hidden:false,classList:{toggle(){}},setAttribute(){},querySelector:s=>s==='p'?paragraph:s==='[data-work-undo]'?buttons[0]:buttons[1],querySelectorAll:()=>buttons};
 const pending=[];
 const context={state:{orders:rows},escapeHtml:String,formatDate:String,isOpenOrderLine:()=>true,getBuyerKey:r=>r.key,getBuyerLabel:()=> 'Customer',crypto:{randomUUID:()=> 'new-hold'},setStatus(){},
 groupLinesByBuyer:rs=>[{key:'buyer',lines:rs}],applyOrderFilters(){},requestAnimationFrame(){},console,
 document:{createElement:()=>notice,body:{append(){}},querySelectorAll:()=>[],getElementById:()=>null},
 window:{scrollBy(){}},supabase:{rpc(name,args){calls.push({name,args});
 if(name==='list_pending_order_work')return{range:async()=>({data:readRows})};
 return new Promise(resolve=>pending.push(resolve));}}};
 vm.runInNewContext(source,context);
 return{api:context.window.undoTest,notice,paragraph,buttons,calls,pending,setRows:data=>readRows=data};
}
const entry={id:'new-hold',kind:'task',revision:1,key:'buyer',buyer:'Customer'};
test('Undo targets only its original hold, suppresses double clicks, and reports remaining blockers',async()=>{
 const f=fixture();f.setRows([{id:'other-hold',buyer_key:'buyer',kind:'cgl',active:true,line_ids:['line']}]);
 f.api.showNotice('Moved to Waiting',entry);const first=f.api.undoLast();await f.api.undoLast();
 assert.equal(f.calls.length,1);assert.equal(f.buttons[0].disabled,true);
 assert.equal(f.calls[0].name,'release_pending_order_work');
 assert.equal(f.calls[0].args._id,'new-hold');assert.equal(f.calls[0].args._expected_revision,1);
 assert.match(f.calls[0].args._reason,/mistake/);
 f.pending[0]({data:null});await first;
 assert.match(f.paragraph.textContent,/still Waiting on 1 other requirement/);
 assert.equal(f.buttons[0].hidden,true);assert.equal(f.buttons[1].disabled,false);
});
test('CGL Undo is a revision-checked correction and refuses a newer certificate change',async()=>{
 const f=fixture();f.api.showNotice('Pending CGL saved',{...entry,kind:'cgl'});
 const promise=f.api.undoLast();assert.equal(f.calls[0].name,'confirm_pending_cgl');
 assert.equal(f.calls[0].args._expected_revision,1);assert.equal(f.calls[0].args._certificate_id,undefined);
 assert.match(f.calls[0].args._correction_reason,/mistake/);
 f.pending[0]({error:{code:'40001',message:'Changed'}});await promise;
 assert.match(f.paragraph.textContent,/Open Manage waiting/);assert.equal(f.buttons[0].hidden,true);
 assert.equal(f.calls.length,1);
});
test('a failed undo remains retryable and a successful final release reports Ready',async()=>{
 const f=fixture();f.api.showNotice('Moved to Waiting',entry);
 const failed=f.api.undoLast();f.pending[0]({error:{message:'Offline'}});await failed;
 assert.equal(f.buttons[0].hidden,false);assert.equal(f.buttons[0].disabled,false);
 const retry=f.api.undoLast();f.pending[1]({data:null});await retry;
 assert.match(f.paragraph.textContent,/back in Ready to work/);assert.equal(f.buttons[0].hidden,true);
});

test('pending cancel saves only the selected line, supports Undo, and suppresses duplicate clicks',async()=>{
 const f=fixture(),button={disabled:false};
 const save=f.api.addLineHold('line',button,'pending_cancel');await f.api.addLineHold('line',button,'pending_cancel');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'create_pending_order_work');
 assert.equal(f.calls[0].args._kind,'pending_cancel');assert.deepEqual(Array.from(f.calls[0].args._line_ids),['line']);
 assert.equal(f.calls[0].args._task_id,undefined);assert.match(f.calls[0].args._reason,/not yet completed/);
 f.pending[0]({data:'new-hold'});await save;assert.equal(f.buttons[0].hidden,false);
 const undo=f.api.undoLast();assert.equal(f.calls.at(-1).name,'release_pending_order_work');
 f.pending[1]({data:null});await undo;assert.match(f.paragraph.textContent,/Ready to work/);
});

test('clear uses the current marker revision, preserves other holds and reports failed updates without hiding them',async()=>{
 const f=fixture(),cancel={...entry,buyer_key:'buyer',kind:'pending_cancel',line_ids:['line'],active:true,revision:7};
 f.setRows([cancel]);await f.api.load();
 const button={disabled:false},fail=f.api.clearCancellation('line',button);
 assert.equal(f.calls.at(-1).args._expected_revision,7);
 f.pending[0]({error:{code:'40001',message:'changed'}});await fail;
 assert.match(f.paragraph.textContent,/marker changed/);assert.equal(button.disabled,false);
 const clear=f.api.clearCancellation('line',button);await f.api.clearCancellation('line',button);
 assert.equal(f.pending.length,2);
 f.setRows([{id:'another',buyer_key:'buyer',kind:'manual',line_ids:['line'],active:true}]);
 f.pending[1]({data:null});await clear;
 assert.match(f.paragraph.textContent,/still Waiting on 1 other requirement/);
});
