import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../tools/ebay-live-capture/tiktok-worker.js',import.meta.url),'utf8');
const event_id='tiktok-7702243594937125663',url='https://shop.tiktok.com/streamer/live/product/dashboard?session_id=13104336646';
function worker(){let stored={},handler,ack=false,failPrint=false;const deliveries=[],tabs=[];const chrome={runtime:{id:'extension',getManifest:()=>({version:'1.8.0'}),onMessage:{addListener:f=>handler=f}},storage:{local:{get:async()=>structuredClone(stored),set:async d=>Object.assign(stored,structuredClone(d))}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{create:async o=>{const t={id:10+tabs.length,...o};tabs.push(t);return t;},update:async()=>{},sendMessage:async(tab,m)=>{deliveries.push(m);if(m.type==='TIKTOK_LIVE_CONTEXT')return {event_id};if(m.type==='TIKTOK_BAG_BRIDGE'&&failPrint)throw Error('lost print acknowledgement');return m.type==='TIKTOK_LIVE_DELIVER'?{ok:ack,error:'Choose the seller'}:{ok:true};}}};
 vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String,JSON,setTimeout,clearTimeout});
 const send=(m,at=url,tab=1)=>new Promise(resolve=>{const handled=handler(m,{id:'extension',tab:{id:tab,url:at}},resolve);if(!handled)resolve(undefined);});
 return {send,tabs,deliveries,get data(){return stored.tiktokLive;},accept(){ack=true;},losePrint(){failPrint=true;}};
}
test('unacknowledged TikTok sales persist, retries update one identity, and only saved batches leave the outbox',async()=>{
 const w=worker();await w.send({type:'TIKTOK_LIVE_START',event_id,stream:{event_id,url}});const e={key:'16|buyer|20.00',payment_state:'failed',observed_at:'2026-10-30T01:00:00Z'};
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
