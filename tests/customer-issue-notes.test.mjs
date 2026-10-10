import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../customer-issue-notes.js',import.meta.url),'utf8');
function setup(rpc,mobile=false){
 const context={crypto:{randomUUID:()=> 'request-1'},matchMedia:()=>({matches:mobile}),document:{getElementById:()=>({addEventListener(){},querySelectorAll:()=>[]})}};
 vm.runInNewContext(source,context);
 const notes=context.OGCaseNotes;notes.init({db:{rpc},people:[{user_id:'staff',display_name:'Sandra'}]});return notes;
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
