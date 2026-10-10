import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../customer-issue-notes.js',import.meta.url),'utf8');
const workflow=await readFile(new URL('../task-workflow.js',import.meta.url),'utf8');
function setup(rpc,mobile=false,taskRpc=async()=>({data:[]})){
 const context={crypto:{randomUUID:()=> 'request-1'},matchMedia:()=>({matches:mobile}),document:{getElementById:()=>({addEventListener(){},querySelectorAll:()=>[]})}};
 vm.runInNewContext(workflow,context);vm.runInNewContext(source,context);
 const notes=context.OGCaseNotes;notes.init({db:{rpc:(name,args)=>name==='customer_issue_task_notes'?taskRpc(name,args):rpc(name,args)},people:[{user_id:'staff',display_name:'Sandra',active:true},{user_id:'admin',display_name:'Jose',role:'admin',active:true}]});return notes;
}
test('scrolling cards show the latest authored note and count with untrusted text escaped',async()=>{
 const notes=setup(async()=>({data:[{case_id:'case',note_count:4,notes:[{notes:'Checked <img src=x onerror=alert(1)>\nWaiting for eBay.',signed_by:'staff',created_at:'2026-10-10T12:00:00Z'}]}]}));
 await notes.load(['case']);const html=notes.card({id:'case'});
 assert.ok(html.includes('Notes (4)'));assert.ok(html.includes('Sandra'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img>'));
 assert.ok(html.includes('data-note-toggle aria-expanded="false"'));assert.ok(!html.includes('dialog'));
});
test('failed reads are shown explicitly instead of claiming that no notes exist',async()=>{
 const notes=setup(async()=>({error:{message:'Offline'}}));await notes.load(['case']);
 assert.ok(notes.card({id:'case'}).includes('Notes unavailable'));assert.ok(notes.section({id:'case'}).includes('Retry loading notes'));
});

test('phones show notes expanded, without truncating their content, using bounded batch reads',async()=>{
 const calls=[],notes=setup(async(name,args)=>{calls.push(args);return {data:[{case_id:'case',note_count:2,notes:[{id:'n',notes:'Full note',created_at:'2026-10-10',signed_by:'staff'}]}]};},true);
 await notes.load(['case']);const html=notes.card({id:'case'});
 assert.equal(calls[0]._limit,3);assert.ok(html.includes('aria-expanded="true"'));assert.ok(html.includes('Show older notes (1)'));assert.ok(!html.includes('issue-note-preview-button'));
});

test('expanded history and drafts survive refreshes without mixing cases',async()=>{
 const notes=setup(async()=>({data:[{case_id:'case',note_count:2,notes:[{id:'new',notes:'Latest',created_at:'2026-10-10'}]}]}));
 const s=notes.testing.state('case');s.notes=[{id:'new',notes:'Latest'},{id:'old',notes:'Older'}];s.count=2;s.expanded=true;
 await notes.load(['case']);assert.equal(s.notes.length,2);assert.equal(s.expanded,true);
 s.editing=true;s.draft='Unfinished update';await notes.load(['case']);assert.equal(s.draft,'Unfinished update');assert.equal(notes.isEditing,true);
 assert.ok(notes.card({id:'case'}).includes('Unfinished update'));assert.ok(!notes.card({id:'other'}).includes('Unfinished update'));
});

test('failed inline saves retain the draft and retry with the same request ID',async()=>{
 const requests=[],notes=setup(async(name,args)=>{requests.push(args);return requests.length===1?{error:{message:'Network failure'}}:{data:{id:'saved',notes:args._note,created_at:'2026-10-10',note_count:1}};});
 const s=notes.testing.state('case');s.editing=true;s.draft='Checked delivery';await notes.testing.save('case');
 assert.equal(s.draft,'Checked delivery');assert.equal(s.editing,true);assert.equal(s.error,'Network failure');
 await notes.testing.save('case');assert.equal(requests[0]._request_id,requests[1]._request_id);assert.equal(s.notes.length,1);assert.equal(s.draft,'');assert.equal(s.expanded,true);assert.equal(s.editing,false);
});
test('preview reads batch only requested cases and an empty page makes no request',async()=>{
 const calls=[],notes=setup(async(name,args)=>{calls.push({name,args});return {data:[]};});
 await notes.load([]);assert.equal(calls.length,0);await notes.load(['first','second']);
 assert.equal(calls.length,1);assert.equal(calls[0].args._limit,1);assert.equal(calls[0].args._offset,0);assert.deepEqual(calls[0].args._case_ids,['first','second']);
});

test('case task appears compactly beside notes, with current responsibility, date and evidence link',async()=>{
 const task={id:'task/1',question:'Check <img src=x> before refund',latest_note:'Receipt saved',created_at:'2026-10-10T12:00:00Z',status:'assigned',assigned_to_user_id:'staff',created_by:'admin',attachment_count:2};
 const tasks=async()=>({data:[{case_id:'case',task_count:1,tasks:[task]}]});
 for(const mobile of [false,true]){
  const notes=setup(async()=>({data:[{case_id:'case',note_count:0,notes:[]}]}),mobile,tasks);await notes.load(['case']);
  const html=notes.card({id:'case'});assert.match(html,/Notes & tasks \(1\)/);assert.match(html,/Task · Next: Sandra/);
  assert.match(html,/Check &lt;img src=x&gt;/);assert.match(html,/Update:<\/b> Receipt saved/);assert.match(html,/Created Oct 10, 2026/);
  assert.match(html,/2 files · Open task/);assert.match(html,/taskId=task%2F1/);assert.equal(html.includes('is-compact'),!mobile);
  assert.ok(!notes.card({id:'other'}).includes('Receipt saved'));
 }
});

test('task updates replace old summaries, route review to the reviewer and preserve manual drafts',async()=>{
 let task={id:'task',question:'Inspect',status:'assigned',assigned_to_user_id:'staff',assigned_by:'admin',created_at:'2026-10-10'};
 const notes=setup(async()=>({data:[]}),true,async()=>({data:[{case_id:'case',task_count:1,tasks:[task]}]}));
 await notes.load(['case']);const s=notes.testing.state('case');s.editing=true;s.draft='Keep this manual note';
 task={...task,status:'completed_by_employee',latest_note:'Inspection finished',attachment_count:1};await notes.load(['case']);
 assert.equal(s.tasks.length,1);assert.equal(s.draft,'Keep this manual note');assert.match(notes.card({id:'case'}),/Task · Review: Jose/);
 task={...task,status:'resolved'};await notes.load(['case']);assert.match(notes.card({id:'case'}),/Task · Finished/);assert.match(notes.card({id:'case'}),/Inspection finished/);
});

test('task pagination is independent of manual notes and a changed count restarts its offsets',async()=>{
 let tasks=Array.from({length:14},(_,i)=>({id:'t'+i,created_at:'2026-10-10',question:'Task '+i,status:'assigned'}));
 const calls=[],notes=setup(async()=>({data:[{case_id:'case',note_count:1,notes:[{id:'n',notes:'Manual note'}]}]}),true,async(name,args)=>{
  calls.push(args);return {data:[{case_id:'case',task_count:tasks.length,tasks:tasks.slice(args._offset,args._offset+args._limit)}]};
 });
 await notes.load(['case']);assert.equal(notes.testing.state('case').tasks.length,3);
 await notes.testing.readTasks('case',true);assert.equal(notes.testing.state('case').tasks.length,13);
 assert.equal(notes.testing.state('case').notes.length,1);assert.match(notes.card({id:'case'}),/Show older tasks \(1\)/);
 tasks=[{id:'new',question:'Newly created',created_at:'2026-10-11'},...tasks];await notes.testing.readTasks('case',true);
 assert.equal(calls.at(-1)._offset,0);assert.equal(notes.testing.state('case').tasks[0].id,'new');
 await notes.testing.readTasks('case',true);assert.equal(notes.testing.state('case').tasks.length,15);
});

test('task loading errors do not hide manual notes or pretend that no tasks exist',async()=>{
 const notes=setup(async()=>({data:[{case_id:'case',note_count:1,notes:[{id:'n',notes:'Checked delivery'}]}]}),true,async()=>({error:{message:'Unavailable'}}));
 await notes.load(['case']);const html=notes.card({id:'case'});assert.match(html,/Checked delivery/);assert.match(html,/Tasks unavailable/);assert.match(html,/Retry loading tasks/);
});
