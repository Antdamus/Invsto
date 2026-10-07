import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(setImmediate);};
function worker(){
  let stored={capture:{events:{},health:{},receivers:{9:Date.now()}}},handler,respond,blocked=true;
  const timers=new Map(),deliveries=[];
  const chrome={
    storage:{local:{get:async()=>structuredClone(stored),set:async value=>{stored=structuredClone(value);}}},
    runtime:{id:'extension',onMessage:{addListener:fn=>{handler=fn;}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    tabs:{sendMessage:async(tab,message)=>{deliveries.push(message);if(blocked)return new Promise(resolve=>{respond=resolve;});return {ok:true};}}
  };
  vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String,
    setTimeout:(fn,ms)=>{const key={};timers.set(key,{fn,ms});return key;},clearTimeout:key=>timers.delete(key)});
  const send=(message,id=1,url='https://www.ebay.com/ebaylive/host/events/EVENT123')=>new Promise(resolve=>handler(message,{id:'extension',tab:{id,url}},resolve));
  return {send,timers,deliveries,get data(){return stored.capture;},recover(){blocked=false;},lateAck(){respond?.({ok:true});}};
}
test('a frozen receiver times out in the worker and cannot trap later capture messages',async()=>{
  const w=worker(),event={key:'paid-007',kind:'paid',buyer:'winner'};
  const first=w.send({type:'INVSTO_CAPTURE',event_id:'EVENT123',events:[event],health:{ready:true,running:true,mode:'automatic'}});
  await settle();
  assert.equal(Object.keys(w.data.events).length,1,'save the sale before contacting the receiver');
  assert.equal(w.timers.size,1,'the deadline must run in the worker, not the suspended receiver');
  const deadline=[...w.timers.values()][0];assert.ok(deadline.ms<=10000);deadline.fn();
  const result=await first;assert.equal(result.ok,true);assert.match(result.status,/receiver.*respond/i);
  const second=await w.send({type:'INVSTO_CAPTURE',event_id:'EVENT123',events:[{...event,key:'paid-008'}],health:{ready:true}});
  assert.equal(second.ok,true);assert.equal(Object.keys(w.data.events).length,2,'later captures remain safely buffered');
  w.lateAck();await settle();assert.equal(Object.keys(w.data.events).length,2,'a late reply cannot erase unconfirmed data');
  w.recover();
  await w.send({type:'INVSTO_RECEIVER'},9,'https://antdamus.github.io/Invsto/live-sales.html?capture=1');
  assert.equal(Object.keys(w.data.events).length,0);
  assert.deepEqual(w.deliveries.at(-1).payload.events.map(e=>e.key),['paid-007','paid-008']);
});

test('receiver heartbeats do not accumulate while delivery is stalled',async()=>{
  const receiverSource=await readFile(new URL('../tools/ebay-live-capture/receiver.js',import.meta.url),'utf8');
  const timers=[],messages=[];let release;
  const chrome={runtime:{id:'extension',onMessage:{addListener(){}},sendMessage:message=>{
    messages.push(message.type);return message.type==='INVSTO_RECEIVER'?new Promise(resolve=>{release=resolve;}):Promise.resolve({ok:true,events:[]});
  }}};
  vm.runInNewContext(receiverSource,{chrome,URL,location:{href:'https://antdamus.github.io/Invsto/live-sales.html?capture=1',origin:'https://antdamus.github.io'},window:{addEventListener(){},postMessage(){}},setInterval:fn=>timers.push(fn)});
  const announce=timers.at(-1);announce();announce();await settle();
  assert.equal(messages.filter(m=>m==='INVSTO_RECEIVER').length,1);
  release({ok:true});await settle();announce();assert.equal(messages.filter(m=>m==='INVSTO_RECEIVER').length,2);
});

test('a timed-out label send is not repeated on another receiver',async()=>{
  const w=worker();w.data.receivers[8]=Date.now()-10000;
  const pending=w.send({type:'INVSTO_BAG_LABEL_COMMAND',command:{action:'print',event_id:'EVENT123',attemptId:'bag-007',requestId:'same-label-send'}});
  await settle();
  const deadline=[...w.timers.values()][0];assert.equal(deadline.ms,32000);deadline.fn();
  const result=await pending;assert.equal(result.ok,false);assert.match(result.error,/retry the same label send/i);
  assert.equal(w.deliveries.length,1,'never route an uncertain manual print to a second receiver');
  assert.equal(w.deliveries[0].command.requestId,'same-label-send');
  w.lateAck();await settle();assert.equal(w.deliveries.length,1);
});
