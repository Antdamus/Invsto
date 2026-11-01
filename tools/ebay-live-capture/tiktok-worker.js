'use strict';
// Separate storage and receiver routing prevent TikTok/eBay identities crossing.
(()=>{
 let serial=Promise.resolve();const lock=fn=>{const p=serial.then(fn);serial=p.catch(()=>{});return p;};
 const source=url=>{try{const u=new URL(url);return u.origin==='https://shop.tiktok.com'&&u.pathname==='/streamer/live/product/dashboard';}catch{return false;}};
 const receiver=url=>{try{const u=new URL(url);return u.origin==='https://antdamus.github.io'&&u.pathname==='/Invsto/tiktok-live-sales.html';}catch{return false;}};
 const valid=id=>/^tiktok-[0-9]{10,25}$/.test(id||'');
 const read=async()=> (await chrome.storage.local.get('tiktokLive')).tiktokLive||{events:{},shows:{},receivers:{},runs:{}};
 const write=data=>chrome.storage.local.set({tiktokLive:data});
 const freshRun=(run,show)=>{const age=Date.now()-(run.lastSeen||Date.parse(show?.health?.observed_at));return age>=-30000&&age<120000;};
 function endShow(data,id){
  const show=data.shows[id];show.ended=true;show.status='Show ended · saved report available';
  for(const run of Object.values(data.runs))if(run.event_id===id)run.enabled=false;
 }
 async function hasSource(data,eventId){
  for(const [tab,run] of Object.entries(data.runs)){
   if(run.event_id!==eventId||!run.enabled||!freshRun(run,data.shows[eventId]))continue;
   try{const context=await send(tab,{type:'TIKTOK_LIVE_CONTEXT'},3000);if(context?.event_id===eventId&&context.running===true&&!context.ended)return true;}catch{}
  }
  return false;
 }
 async function receiverPresent(tab,eventId){
  try{const t=await chrome.tabs.get(Number(tab));
   return !t.url||(receiver(t.url)&&new URL(t.url).searchParams.get('capture_event')===eventId);
  }catch{return false;}
 }
 function forgetReceiver(data,tab){
  const id=data.receivers[tab];delete data.receivers[tab];
  if(id&&data.shows[id]&&!Object.values(data.receivers).includes(id)){
   const show=data.shows[id];show.dismissed=true;
   if(!show.ended)show.status='Receiver closed · use Open TikTok receiver to deliver queued sales.';
  }
 }
 async function send(tab,message,timeout=15000){let timer;try{return await Promise.race([chrome.tabs.sendMessage(Number(tab),message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Invsto did not respond. Keep the receiver open and signed in.')),timeout);})]);}finally{clearTimeout(timer);}}
 async function openReceiver(data,eventId,stream,active){
  for(const [tab,id] of Object.entries(data.receivers))if(id===eventId){
   let present=true;try{await send(tab,{type:'TIKTOK_LIVE_PING'},4000);}catch{present=await receiverPresent(tab,eventId);}
   if(present){if(active)await chrome.tabs.update(Number(tab),{active:true});return;}delete data.receivers[tab];
  }
  const url='https://antdamus.github.io/Invsto/tiktok-live-sales.html?capture=1&capture_event='+encodeURIComponent(eventId)+'&stream='+encodeURIComponent(JSON.stringify(stream));
  const tab=await chrome.tabs.create({url,active});data.receivers[tab.id]=eventId;
 }
 async function flush(data){
  for(const [eventId,show] of Object.entries(data.shows)){
   const batch=Object.entries(data.events).filter(([,e])=>e.event_id===eventId).slice(0,80);
   const active=!show.ended&&Object.values(data.runs).some(r=>r.enabled&&r.event_id===eventId&&freshRun(r,show));
   if(!batch.length&&!active&&!show.endPending)continue;
   let accepted=false;
   for(const [tab,id] of Object.entries(data.receivers))if(id===eventId){
    try{const r=await send(tab,{type:'TIKTOK_LIVE_DELIVER',payload:{event_id:eventId,events:batch.map(([,e])=>e.event),health:{...show.health,pending:batch.length,version:chrome.runtime.getManifest().version}}});
     if(r?.ended){endShow(data,eventId);show.endPending=false;}
     if(r?.ok){accepted=true;if(!show.ended)show.status='Connected · sales saved';show.lastDelivered=Date.now();break;}show.status=r?.error||'Choose the seller in Invsto.';
    }catch(error){show.status=error.message;if(!await receiverPresent(tab,eventId))forgetReceiver(data,tab);}
   }
   if(accepted)for(const [key] of batch)delete data.events[key];
   if(active&&!show.ended&&!show.dismissed&&!Object.values(data.receivers).includes(eventId)&&Date.now()-(show.lastOpened||0)>30000&&await hasSource(data,eventId)){show.lastOpened=Date.now();await openReceiver(data,eventId,show.stream,false);}
  }
 }
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;const url=sender.tab?.url||sender.url||'';
  if(['TIKTOK_LIVE_RECEIVER','TIKTOK_LIVE_RECEIVER_ENDED'].includes(m.type)&&receiver(url)&&valid(m.event_id)){
   const actual=new URL(url).searchParams.get('capture_event');if(actual!==m.event_id)return;
   lock(async()=>{const d=await read();d.receivers[sender.tab.id]=m.event_id;if(m.type==='TIKTOK_LIVE_RECEIVER_ENDED'&&d.shows[m.event_id])endShow(d,m.event_id);await write(d);return {ok:true};}).then(reply);return true;
  }
  if(!source(url))return;
  if(m.type==='INVSTO_BAG_LABEL_COMMAND'){
   const c=m.command;if(!valid(c?.event_id)||!['status','auto','configure','print','capture','photo'].includes(c.action))return;
   (async()=>{
    const d=await lock(()=>read());if(!d.shows[c.event_id])throw Error('Start TikTok capture in Settings first.');
    // Bind every request to the exact room currently visible in its source tab.
    const context=await send(sender.tab.id,{type:'TIKTOK_LIVE_CONTEXT'},4000);if(context?.event_id!==c.event_id)throw Error('The TikTok show changed. Refresh this console.');
    if(c.action==='capture')return send(sender.tab.id,{type:'TIKTOK_CAPTURE_FRAME'},12000);
    for(const [tab,id] of Object.entries(d.receivers))if(id===c.event_id){
     if(c.action==='configure')await chrome.tabs.update(Number(tab),{active:true});
     try{return await send(tab,{type:'TIKTOK_BAG_BRIDGE',command:c},c.action==='configure'?185000:35000);}
     finally{if(c.action==='configure')await chrome.tabs.update(sender.tab.id,{active:true});}
    }
    throw Error('Open the TikTok receiver and keep it signed in.');
   })().then(reply,e=>reply({ok:false,error:e.message}));return true;
  }
  if(!/^TIKTOK_LIVE_(START|STOP|RESUME|OBSERVE|STATUS|OPEN)$/.test(m.type)||!valid(m.event_id))return;
  lock(async()=>{
   const d=await read(),id=m.event_id,tab=sender.tab.id;
   if(m.type==='TIKTOK_LIVE_START'){
    if(d.shows[id]?.ended)return {ok:false,ended:true,error:'This TikTok show has ended.'};
    if(!m.stream||m.stream.event_id!==id||m.stream.url!==url)throw Error('The show identity changed. Refresh TikTok.');
    d.shows[id]||={stream:m.stream,health:{},status:'Choose the seller in Invsto.'};d.shows[id].dismissed=false;d.runs[tab]={event_id:id,enabled:true,lastSeen:Date.now()};await openReceiver(d,id,m.stream,true);
   }else if(m.type==='TIKTOK_LIVE_STOP'){d.runs[tab]={event_id:id,enabled:false};}
   else if(m.type==='TIKTOK_LIVE_RESUME'){const run=d.runs[tab];return {ok:true,resume:!!(run?.enabled&&run.event_id===id&&!d.shows[id]?.ended&&freshRun(run,d.shows[id]))};}
   else if(m.type==='TIKTOK_LIVE_OPEN'){if(!d.shows[id])throw Error('Start TikTok capture first.');d.shows[id].dismissed=false;await openReceiver(d,id,d.shows[id].stream,true);}
   else if(m.type==='TIKTOK_LIVE_OBSERVE'){
    if(d.shows[id]?.ended)return {ok:false,ended:true,error:'This TikTok show has ended.'};
    if(!d.runs[tab]?.enabled||d.runs[tab].event_id!==id)throw Error('Capture is stopped.');
    if(!Array.isArray(m.events)||m.events.length>100||JSON.stringify(m.events).length>600000)throw Error('Invalid capture batch.');
    const show=d.shows[id];show.health=m.health;d.runs[tab].lastSeen=Date.now();
    for(const e of m.events){if(typeof e.key!=='string'||e.key.length>1000)continue;const key=id+':'+e.key;const prev=d.events[key];if(!prev||e.observed_at>=prev.event.observed_at)d.events[key]={event_id:id,event:e};}
    if(Object.keys(d.events).length>10000)throw Error('Capture queue is full; reconnect Invsto.');
    // Save before network delivery so a suspended receiver cannot lose a sale.
    if(m.health?.broadcast_ended){endShow(d,id);show.endPending=true;}
    await write(d);await flush(d);
   }
   await write(d);return {ok:true,ended:!!d.shows[id]?.ended,status:d.shows[id]?.status,pending:Object.values(d.events).filter(e=>e.event_id===id).length,lastDelivered:d.shows[id]?.lastDelivered};
  }).then(reply,e=>reply({ok:false,error:e.message}));return true;
 });
 chrome.alarms.create('tiktok-live-delivery',{periodInMinutes:0.5});
 chrome.alarms.onAlarm.addListener(a=>{if(a.name==='tiktok-live-delivery')lock(async()=>{const d=await read();await flush(d);await write(d);}).catch(()=>{});});
 chrome.tabs.onRemoved?.addListener(tab=>lock(async()=>{
  const d=await read();delete d.runs[tab];forgetReceiver(d,tab);
  await write(d);
 }).catch(()=>{}));
 chrome.runtime.onStartup?.addListener(()=>lock(async()=>{const d=await read();d.runs={};d.receivers={};await write(d);}).catch(()=>{}));
})();
