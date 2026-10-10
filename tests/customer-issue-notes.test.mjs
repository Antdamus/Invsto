import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../customer-issue-notes.js',import.meta.url),'utf8');
function setup(rpc){
 const context={document:{getElementById:()=>({addEventListener(){}})}};
 vm.runInNewContext(source,context);
 const notes=context.OGCaseNotes;notes.init({db:{rpc},people:[{user_id:'staff',display_name:'Sandra'}]});return notes;
}
test('scrolling cards show the latest authored note and count with untrusted text escaped',async()=>{
 const notes=setup(async()=>({data:[{case_id:'case',note_count:4,notes:[{notes:'Checked <img src=x onerror=alert(1)>\nWaiting for eBay.',signed_by:'staff',created_at:'2026-10-10T12:00:00Z'}]}]}));
 await notes.load(['case']);const html=notes.card({id:'case',buyer_username:'buyer" onmouseover="bad'});
 assert.ok(html.includes('Notes (4)'));assert.ok(html.includes('Sandra'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(html.includes('buyer&quot;'));
 assert.ok(notes.section({id:'case'}).includes('View / add notes'));
});
test('failed reads are shown explicitly instead of claiming that no notes exist',async()=>{
 const notes=setup(async()=>({error:{message:'Offline'}}));await notes.load(['case']);
 assert.ok(notes.card({id:'case'}).includes('Notes unavailable'));assert.ok(notes.section({id:'case'}).includes('could not be loaded'));
});
test('preview reads batch only requested cases and an empty page makes no request',async()=>{
 const calls=[],notes=setup(async(name,args)=>{calls.push({name,args});return {data:[]};});
 await notes.load([]);assert.equal(calls.length,0);await notes.load(['first','second']);
 assert.equal(calls.length,1);assert.equal(calls[0].args._limit,1);assert.equal(calls[0].args._offset,0);assert.deepEqual(calls[0].args._case_ids,['first','second']);
});
