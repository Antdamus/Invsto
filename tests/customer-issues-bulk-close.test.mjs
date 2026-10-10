import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const sandbox={};
vm.runInNewContext(await readFile(new URL('../customer-issues.js',import.meta.url),'utf8'),sandbox);
const {closeBlock,runCloseBatch}=sandbox.OGCustomerIssues.testing;
const resolved={id:'a',status:'open',ebay_return_id:'123',ebay_status:'CLOSED',open_tasks:1};
test('bulk eligibility rejects provider-open and uninspected returns while permitting resolved cases without assigning work',()=>{
 assert.equal(closeBlock(resolved),'');
 assert.equal(closeBlock({...resolved,ebay_status:'OPEN'}),'Still open on eBay');
 assert.equal(closeBlock({...resolved,ebay_status:null}),'Still open on eBay');
 assert.equal(closeBlock({...resolved,status:'closed',open_tasks:0}),'Already saved in History');
 assert.equal(closeBlock({...resolved,ebay_return_id:null,ebay_status:null}),'');
 const item={received_quantity:1,restocked_quantity:0,disposition:'quarantine'};
 assert.equal(closeBlock(resolved,[item]),'Returned items still need inspection');
 assert.equal(closeBlock(resolved,[{...item,disposition:'received_no_restock'}]),'');
 assert.equal(closeBlock(resolved,[{...item,received_quantity:0}]),'','imported placeholders are not receipts');
});
test('batch skips blocked cases, does not duplicate a case, and continues after a conflict without retrying',async()=>{
 const calls=[],progress=[];
 const entries=[{c:resolved},{c:{...resolved,id:'b'}},{c:{...resolved,id:'c'}},{c:{...resolved,id:'d'},blocked:'Needs inspection'},{c:resolved}];
 const result=await runCloseBatch(entries,async entry=>{
  calls.push(entry.c.id);if(entry.c.id==='b')throw Error('The follow-ups changed');return {closed_tasks:1};
 },(r,n)=>progress.push([r.id,n]));
 assert.deepEqual(calls,['a','b','c']);assert.deepEqual(progress,[['a',1],['b',2],['c',3]]);
 assert.equal(result.length,3);assert.equal(result[0].ok,true);assert.equal(result[1].ok,false);assert.equal(result[1].error,'The follow-ups changed');assert.equal(result[2].ok,true);
});
test('uncertain network result remains unconfirmed; no automatic second request',async()=>{
 let calls=0;const results=await runCloseBatch([{c:resolved}],async()=>{calls++;throw Error('Connection lost');});
 assert.equal(calls,1);assert.equal(results[0].ok,false);assert.equal(results[0].error,'Connection lost');
});
