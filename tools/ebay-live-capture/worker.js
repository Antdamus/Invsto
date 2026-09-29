'use strict';
let serial = Promise.resolve();
const enqueue = fn => { const task = serial.then(fn); serial = task.catch(()=>{}); return task; };
async function read() { return (await chrome.storage.local.get('capture')).capture || {events:{},health:{},receivers:{},status:'Waiting for Invsto receiver'}; }
async function save(data) { await chrome.storage.local.set({capture:data}); }
function receiverEntries(data){
  // A background receiver's timer can be throttled. Let message delivery prove
  // whether it is still available instead of dropping it after twenty seconds.
  return Object.entries(data.receivers).sort((a,b)=>b[1]-a[1]);
}
function selectCaptureHealth(data,event_id){
  const all=Object.values(data.sources?.[event_id]||{});
  if(!all.length)return;
  const current=all.filter(s=>Date.now()-s.receivedAt<20000);
  const automatic=current.filter(s=>s.health.running!==false&&s.health.mode!=='working');
  const sort=(a,b)=>Number(!!b.health.ready)-Number(!!a.health.ready)||b.receivedAt-a.receivedAt;
  const source=automatic.sort(sort)[0]||current.sort((a,b)=>b.receivedAt-a.receivedAt)[0]||all.sort((a,b)=>b.receivedAt-a.receivedAt)[0];
  const ended=!!(data.health[event_id]?.broadcast_ended||all.some(s=>s.health.broadcast_ended));
  data.health[event_id]={...source.health,ready:!ended&&current.includes(source)&&source.health.mode!=='working'&&source.health.running!==false&&!!source.health.ready&&Object.keys(data.events).length<=10000,broadcast_ended:ended,pending:Object.values(data.events).filter(e=>e.event_id===event_id).length,version:'1.1.2'};
}
async function deliver(data) {
  const receivers = receiverEntries(data);
  if (!receivers.length) {data.status='Open the Invsto receiver in this browser and keep it signed in.';return;}
  const eventIds = Object.keys(data.health);
  for (const event_id of eventIds) {
    selectCaptureHealth(data,event_id);
    const batch = Object.values(data.events).filter(e=>e.event_id===event_id).slice(0,80);
    data.health[event_id].pending=Object.values(data.events).filter(e=>e.event_id===event_id).length;
    let accepted = false;
    for (const [tab] of receivers) {
      try {
        const reply = await chrome.tabs.sendMessage(Number(tab),{type:'INVSTO_DELIVER',payload:{event_id,events:batch.map(e=>e.event),health:data.health[event_id]}});
        if (reply?.ok) {accepted=true;break;}
        data.status=reply?.error||'Invsto has not accepted the data yet';
      } catch {delete data.receivers[tab];}
    }
    if (accepted) {
      for (const entry of batch) delete data.events[entry.id];
      data.status=`Connected · ${Object.keys(data.events).length} pending`;
      data.lastDelivered=Date.now();
    }
  }
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  const url = sender.tab?.url || sender.url || '';
  if (sender.id !== chrome.runtime.id) return;
  if(message.type==='INVSTO_LISTING_COMMAND'){
    if(!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url))return;
    const event_id=new URL(url).pathname.split('/')[4];
    if(message.command?.event_id!==event_id)return;
    // Photo preparation must not block the separate payment-capture outbox.
    (async()=>{
      const data=await read();
      const receivers=receiverEntries(data);
      for(const [tab] of receivers){
        try{return await chrome.tabs.sendMessage(Number(tab),{type:'INVSTO_LISTING_BRIDGE',command:message.command});}catch{}
      }
      return {ok:false,error:'Open the signed-in Invsto capture receiver in this browser.'};
    })().then(reply,error=>reply({ok:false,error:error.message}));
    return true;
  }
  enqueue(async()=>{
    const data = await read();
    if (message.type==='INVSTO_RECEIVER' && /^https:\/\/antdamus\.github\.io\/Invsto\/live-sales\.html(?:\?|$)/.test(url)) {
      data.receivers[sender.tab.id]=Date.now();
    } else if (message.type==='INVSTO_CAPTURE' && /^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url)) {
      const event_id=new URL(url).pathname.split('/')[4];
      if (event_id!==message.event_id || !/^[\w-]{6,100}$/.test(event_id)) throw Error('Event mismatch');
      for (const event of (message.events||[]).slice(0,100)) {
        if (typeof event.key !== 'string' || event.key.length>2000) continue;
        const id=event_id+'|'+event.key;
        data.events[id]={id,event_id,event};
      }
      data.sources ||= {};data.sources[event_id] ||= {};
      data.sources[event_id][sender.tab.id]={health:{...message.health},receivedAt:Date.now()};
      for(const [id,source] of Object.entries(data.sources[event_id]))if(Date.now()-source.receivedAt>120000)delete data.sources[event_id][id];
      selectCaptureHealth(data,event_id);
      if (Object.keys(data.events).length>10000) {data.health[event_id].ready=false;data.status='Capture backlog is full. Reconnect Invsto before continuing.';}
    } else return {ok:false};
    // Persist first: a browser crash or network outage must not drop a payment failure.
    await save(data); await deliver(data); await save(data);
    return {ok:true,status:data.status,lastDelivered:data.lastDelivered};
  }).then(reply,error=>reply({ok:false,error:error.message}));
  return true;
});
chrome.alarms.create('retry-live',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>enqueue(async()=>{const d=await read();await deliver(d);await save(d);}));
