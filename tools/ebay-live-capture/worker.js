'use strict';
let serial = Promise.resolve();
const enqueue = fn => { const task = serial.then(fn); serial = task.catch(()=>{}); return task; };
async function read() { return (await chrome.storage.local.get('capture')).capture || {events:{},health:{},receivers:{},status:'Waiting for Invsto receiver'}; }
async function save(data) { await chrome.storage.local.set({capture:data}); }
async function deliver(data) {
  const receivers = Object.entries(data.receivers).filter(([,time])=>Date.now()-time<20000).sort((a,b)=>b[1]-a[1]);
  if (!receivers.length) {data.status='Open signed-in Invsto Live Sales with capture=1 in this browser.';return;}
  const eventIds = Object.keys(data.health);
  for (const event_id of eventIds) {
    const batch = Object.values(data.events).filter(e=>e.event_id===event_id).slice(0,80);
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
      data.health[event_id]={...message.health,pending:Object.keys(data.events).length,version:'1.0.1'};
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
