import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../tools/ebay-live-capture/tiktok-worker.js',import.meta.url),'utf8');
const sharedSource=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');
const event_id='tiktok-7702243594937125663',url='https://shop.tiktok.com/streamer/live/product/dashboard?session_id=13104336646';
function worker(initial={}){let stored=structuredClone(initial),ack=false,failPrint=false,asleep=false;const hooks={};const handlers=[],deliveries=[],tabs=[];const chrome={runtime:{id:'extension',getManifest:()=>({version:'1.8.1'}),onMessage:{addListener:f=>handlers.push(f)},onStartup:{addListener:f=>{(hooks.startup??=[]).push(f)}}},storage:{local:{get:async()=>structuredClone(stored),set:async d=>Object.assign(stored,structuredClone(d))}},alarms:{create(){},onAlarm:{addListener:f=>{(hooks.alarm??=[]).push(f)}}},tabs:{onRemoved:{addListener:f=>{(hooks.removed??=[]).push(f)}},get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('No tab');return t;},create:async o=>{await new Promise(setImmediate);const t={id:10+tabs.length,...o};tabs.push(t);return t;},update:async()=>{},sendMessage:async(tab,m)=>{deliveries.push(m);if(m.type==='TIKTOK_LIVE_CONTEXT')return {event_id,running:true};if(asleep)throw Error('Receiver sleeping');if(m.type==='TIKTOK_BAG_BRIDGE'&&failPrint)throw Error('lost print acknowledgement');return m.type==='TIKTOK_LIVE_DELIVER'?{ok:ack,error:'Choose the seller'}:{ok:true};}}};
 vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String,JSON,setTimeout,clearTimeout});
 vm.runInNewContext(sharedSource,{chrome,URL,Date,Promise,Error,Object,Number,String,JSON,setTimeout,clearTimeout});
 const send=(m,at=url,tab=1)=>new Promise(resolve=>{let handled=false;for(const handler of handlers)handled=handler(m,{id:'extension',tab:{id:tab,url:at}},resolve)||handled;if(!handled)resolve(undefined);});
 return {send,tabs,deliveries,trigger:async(key,value)=>{await Promise.all(hooks[key].map(f=>f(value)));await send({type:'TIKTOK_LIVE_STATUS',event_id});},sleepReceiver(){asleep=true;},get data(){return stored.tiktokLive;},accept(){ack=true;},losePrint(){failPrint=true;}};
}
test('unacknowledged TikTok sales persist, retries update one identity, and only saved batches leave the outbox',async()=>{
 const w=worker();assert.equal((await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}})).ok,true,'eBay handler must not race TikTok startup');const e={key:'16|buyer|20.00',payment_state:'failed',observed_at:'2026-10-30T01:00:00Z'};
 await w.send({type:'TIKTOK_LIVE_OBSERVE',event_id,events:[e],health:{ready:true}});assert.equal(Object.keys(w.data.events).length,1);
 await w.send({type:'TIKTOK_LIVE_OBSERVE',event_id,events:[{...e,payment_state:'paid',observed_at:'2026-10-30T01:01:00Z'}],health:{ready:true}});assert.equal(Object.values(w.data.events)[0].event.payment_state,'paid');
 w.accept();await w.send({type:'TIKTOK_LIVE_OBSERVE',event_id,events:[],health:{ready:true}});assert.equal(Object.keys(w.data.events).length,0);assert.equal(w.tabs.length,1);
});
test('capture resumes in the same tab, explicit stop stays stopped, and unrelated pages cannot send TikTok evidence',async()=>{
 const w=worker();await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}});assert.equal((await w.send({type:'TIKTOK_LIVE_RESUME',event_id})).resume,true);
 assert.equal((await w.send({type:'TIKTOK_LIVE_RESUME',event_id},url,2)).resume,false);await w.send({type:'TIKTOK_LIVE_STOP',event_id});assert.equal((await w.send({type:'TIKTOK_LIVE_RESUME',event_id})).resume,false);
 assert.equal(await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}},'https://example.invalid'),undefined);assert.equal((await w.send({type:'TIKTOK_LIVE_OBSERVE',event_id,events:[],health:{}})).ok,false);
});
test('lost print acknowledgement is returned without trying another receiver or queueing twice',async()=>{
 const w=worker();await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}});await w.send({type:'TIKTOK_LIVE_RECEIVER',event_id},'https://antdamus.github.io/Invsto/tiktok-live-sales.html?capture=1&capture_event='+event_id,11);w.losePrint();
 const r=await w.send({type:'INVSTO_BAG_LABEL_COMMAND',command:{event_id,action:'print'}});assert.equal(r.ok,false);assert.equal(w.deliveries.filter(m=>m.type==='TIKTOK_BAG_BRIDGE').length,1);
});
test('the retry alarm cannot reopen a legacy run with a two-day-old source heartbeat',async()=>{
 const show={stream:{event_id,url},health:{observed_at:new Date(Date.now()-2*86400000).toISOString()},lastDelivered:Date.now()};
 const w=worker({tiktokLive:{shows:{[event_id]:show},runs:{1:{event_id,enabled:true}},events:{},receivers:{}}});
 await w.trigger('alarm',{name:'tiktok-live-delivery'});assert.equal(w.tabs.length,0);
 assert.equal((await w.send({type:'TIKTOK_LIVE_RESUME',event_id})).resume,false);
});
test('dismissal preserves queued sales, a sleeping receiver is reused, and startup clears old tab IDs',async()=>{
 const w=worker();await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}});
 w.sleepReceiver();await w.trigger('alarm',{name:'tiktok-live-delivery'});assert.equal(w.tabs.length,1);
 await w.trigger('removed',10);await w.send({type:'TIKTOK_LIVE_OBSERVE',event_id,events:[{key:'unsaved'}],health:{ready:true}});
 assert.equal(Object.keys(w.data.events).length,1);assert.equal(w.tabs.length,1);
 await w.trigger('startup');await w.trigger('alarm',{name:'tiktok-live-delivery'});
 assert.equal(Object.keys(w.data.runs).length,0);assert.equal(Object.keys(w.data.events).length,1);assert.equal(w.tabs.length,1);
});
test('ended state is bound to the receiver room and does not prevent starting the next show',async()=>{
 const w=worker();await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}});
 const u='https://antdamus.github.io/Invsto/tiktok-live-sales.html?capture=1&capture_event='+event_id;
 await w.send({type:'TIKTOK_LIVE_RECEIVER_ENDED',event_id:'tiktok-1234567890123'},u,10);assert.equal(w.data.shows[event_id].ended,undefined);
 await w.send({type:'TIKTOK_LIVE_RECEIVER_ENDED',event_id},u,10);await w.trigger('removed',10);await w.trigger('alarm',{name:'tiktok-live-delivery'});
 assert.equal(w.tabs.length,1);assert.equal((await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}})).ended,true);
 const next='tiktok-1234567890123';assert.equal((await w.send({type:'TIKTOK_LIVE_START',event_id:next,stream:{event_id:next,url}})).ok,true);assert.equal(w.tabs.length,2);
});
