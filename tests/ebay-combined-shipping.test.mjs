import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {assess}=require('../tools/ebay-og-order-link-extension/shipping-combine-policy.js');
const a='11-22222-33333',b='11-22222-44444',c='22-33333-55555';
const group=(numbers)=>({orderNumbers:numbers,lines:numbers.map(orderNumber=>({orderNumber,shippingEligible:true,shippingBlockReason:''}))});
const base={ready:true,priorities:[group([a,b]),group([c])]};
const row=(...orderNumbers)=>({orderNumbers});

test('separate same-buyer shipments block review and final purchase even when eBay offers no combine button',()=>{
  const r=assess({...base,shipments:[row(a),row(b)]});
  assert.equal(r.blocked,true);assert.equal(r.action,'combine');
});
test('a verified combined shipment permits purchase with a different buyer in its own package',()=>{
  assert.equal(assess({...base,shipments:[row(a,b),row(c)]}).blocked,false);
});
test('single-order entry cannot miss another pending order for that buyer',()=>{
  const r=assess({...base,single:true,shipments:[row(a)]});
  assert.equal(r.blocked,true);assert.equal(r.action,'load');assert.deepEqual(r.orderNumbers,[a,b]);
});
test('removing a sibling from bulk shipping does not bypass one-package rule',()=>{
  const r=assess({...base,shipments:[row(a),row(c)]});
  assert.equal(r.blocked,true);assert.equal(r.action,'load');assert.deepEqual(new Set(r.orderNumbers),new Set([a,b,c]));
});
test('Undo combine immediately changes the decision back to blocked',()=>{
  assert.equal(assess({...base,shipments:[row(a,b)]}).blocked,false);
  assert.equal(assess({...base,shipments:[row(a),row(b)]}).blocked,true);
});
test('multiple lines under one eBay order still use just one shipping label',()=>{
  const priorities=[group([a])];priorities[0].lines.push({...priorities[0].lines[0]});
  assert.equal(assess({ready:true,priorities,single:true,shipments:[row(a)]}).blocked,false);
});
test('eBay combine signal blocks when its rows have not updated yet',()=>{
  assert.equal(assess({...base,shipments:[row(a,b)],nativeCanCombine:true}).blocked,true);
});
test('unavailable, loading, or outdated Invsto cannot authorize a purchase',()=>{
  assert.equal(assess({...base,shipments:[row(a,b)],ready:false}).blocked,true);
  assert.equal(assess({...base,shipments:[]}).blocked,true);
  assert.equal(assess({...base,priorities:[{orderNumbers:[a,b],lines:[{orderNumber:a}]}],shipments:[row(a,b)]}).blocked,true);
});
test('unknown eBay order does not silently qualify as a single-item shipment',()=>{
  const r=assess({...base,shipments:[row('99-99999-99999')]});assert.equal(r.blocked,true);assert.match(r.reason,/not in the current Invsto/);
});
test('refunded sibling orders are excluded; trying to ship the refunded order stays blocked',()=>{
  const priorities=[group([a,b])];Object.assign(priorities[0].lines[1],{shippingEligible:false,shippingBlockReason:'Refund reported'});
  assert.equal(assess({ready:true,priorities,single:true,shipments:[row(a)]}).blocked,false);
  const r=assess({ready:true,priorities,shipments:[row(a,b)]});assert.equal(r.blocked,true);assert.match(r.reason,/Refund reported/);
});
test('missing order identity cannot silently drop an eligible item from the package',()=>{
  const priorities=[group([a])];priorities[0].lines.push({orderNumber:'',shippingEligible:true});
  assert.equal(assess({ready:true,priorities,single:true,shipments:[row(a)]}).blocked,true);
});
test('published manifest loads the guard before eBay purchase handlers with no new permissions',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../tools/ebay-og-order-link-extension/manifest.json',import.meta.url),'utf8'));
  const script=manifest.content_scripts.find(entry=>entry.js.includes('shipping-combine-guard.js'));
  assert.equal(script.run_at,'document_start');assert.deepEqual(script.js,['shipping-combine-policy.js','shipping-combine-guard.js']);
  assert.deepEqual(manifest.permissions,['storage','activeTab','tabs','downloads','clipboardWrite','unlimitedStorage']);
});

test('shipping safety reads a ready second Invsto tab instead of an old or disconnected first tab',async()=>{
  const source=await readFile(new URL('../tools/ebay-og-order-link-extension/background.js',import.meta.url),'utf8');
  for(const firstResponse of [{ok:true,priorities:[]},new Error('Tab disconnected')]) {
    let listener;const calls=[];
    const url='https://antdamus.github.io/Invsto/pending-orders.html';
    const expected={ok:true,shippingCheckReady:true,priorities:base.priorities};
    const chrome={storage:{sync:{get:async()=>({ogPendingOrdersUrl:url})}},runtime:{onMessage:{addListener(fn){listener=fn;}}},
      tabs:{query:async()=>[{id:1,url},{id:2,url}],sendMessage:async(id,message)=>{
        calls.push({id,message});if(id===2)return expected;if(firstResponse instanceof Error)throw firstResponse;return firstResponse;
      }}};
    vm.runInNewContext(source,{chrome,URL,console,setTimeout,clearTimeout});
    const response=await new Promise(resolve=>listener({type:'OG_EBAY_GET_PENDING_PRIORITIES',payload:{useCache:false,shippingSafetyCheck:true}},{},resolve));
    assert.equal(response,expected);assert.deepEqual(calls.map(call=>call.id),[1,2]);
  }
});
