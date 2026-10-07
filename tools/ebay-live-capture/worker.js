'use strict';
let serial = Promise.resolve();
// A receiver's own timer stops when Edge suspends that page. Keep the deadline
// in the worker so one unanswered message cannot hold the persisted outbox lock.
async function sendToTab(tab,message,timeout=8000){
  let timer;
  try{return await Promise.race([
    chrome.tabs.sendMessage(tab,message),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The Invsto receiver is not responding. Capture is saved; bring the receiver forward.')),timeout);})
  ]);}finally{clearTimeout(timer);}
}
const streamReaders=new Map();
async function readStreamInBackground(url,event_id){
  const task=crypto.randomUUID();let tab;
  const result=new Promise(resolve=>{
    const timer=setTimeout(()=>{streamReaders.delete(task);resolve({ok:false,error:'Could not read Event information. Keep eBay signed in and try capture again.'});},20000);
    streamReaders.set(task,{event_id,resolve:value=>{clearTimeout(timer);streamReaders.delete(task);resolve(value);}});
  });
  try{
    const target=new URL(url);target.searchParams.set('tab','information');target.searchParams.set('invsto_metadata',task);
    tab=await chrome.tabs.create({url:target.href,active:false});
    const reader=streamReaders.get(task);if(reader)reader.tab=tab.id;
    return await result;
  }catch(error){streamReaders.get(task)?.resolve({ok:false,error:error.message});return await result;}
  finally{if(tab?.id!==undefined)try{await chrome.tabs.remove(tab.id);}catch{}}
}

const enqueue = fn => { const task = serial.then(fn); serial = task.catch(()=>{}); return task; };
async function read() { return (await chrome.storage.local.get('capture')).capture || {events:{},health:{},receivers:{},status:'Waiting for Invsto receiver'}; }
async function save(data) { await chrome.storage.local.set({capture:data}); }
async function finishCapture(event_id){
  const tabs=await enqueue(async()=>{
    const data=await read();data.closedEvents||={};data.closedEvents[event_id]=true;
    const ids=[];for(const [id,run] of Object.entries(data.captureRuns||{}))if(run.event_id===event_id){run.enabled=false;ids.push(Number(id));}
    await save(data);return ids;
  });
  await Promise.allSettled(tabs.map(id=>sendToTab(id,{type:'INVSTO_STOP_CAPTURE',event_id})));
}
async function resumeCapture(event_id,tabId){
  const data=await enqueue(()=>read()),run=data.captureRuns?.[tabId];
  if(!run?.enabled||run.event_id!==event_id||!run.stream||data.closedEvents?.[event_id])return {ok:true,resume:false,closed:!!data.closedEvents?.[event_id]};
  let reachable=false;
  const ids=[...new Set([...receiverEntries(data).map(([id])=>Number(id)),data.setupTabs?.[event_id]].filter(id=>id!==undefined))];
  for(const id of ids){
    try{
      const response=await sendToTab(id,{type:'INVSTO_CHECK_CAPTURE',event_id});reachable=true;
      if(response?.state==='closed'){await finishCapture(event_id);return {ok:true,resume:false,closed:true};}
      if(response?.state==='active')return enqueue(async()=>{
        const latest=await read(),saved=latest.captureRuns?.[tabId];
        return {ok:true,resume:!!saved?.enabled&&saved.event_id===event_id&&!latest.closedEvents?.[event_id],stream:saved?.stream};
      });
      if(response?.state==='unlinked')return {ok:true,resume:false,error:'Finish choosing sellers in Invsto, then start capture.'};
    }catch{await enqueue(async()=>{const latest=await read();delete latest.receivers[id];await save(latest);});}
  }
  if(!reachable)await enqueue(async()=>{
    const latest=await read();if(!latest.captureRuns?.[tabId]?.enabled)return;
    latest.resumeOpenedAt||={};if(Date.now()-(latest.resumeOpenedAt[event_id]||0)<30000)return;
    const tab=await chrome.tabs.create({url:'https://antdamus.github.io/Invsto/live-sales.html?capture=1&resume_event='+encodeURIComponent(event_id)+'&v=1.7.1',active:false});
    latest.setupTabs||={};latest.setupTabs[event_id]=tab.id;latest.resumeOpenedAt[event_id]=Date.now();await save(latest);
  });
  return {ok:true,retry:true,error:'Reconnecting saved capture. Keep the Invsto receiver signed in; sellers will stay unchanged.'};
}
async function openCaptureSetup(event_id, sourceTab, stream) {
  const data = await read(); data.setupTabs ||= {};
  if(data.closedEvents?.[event_id])return {ok:false,closed:true,error:'This Invsto show is already closed.'};
  data.captureRuns||={};data.captureRuns[sourceTab]={event_id,stream,enabled:true};
  data.captureTabs ||= {}; data.captureTabs[event_id] = sourceTab;
  await save(data);
  const previous = data.setupTabs[event_id];
  if (previous !== undefined) {
    try {
      const response = await sendToTab(previous,{type:'INVSTO_OPEN_CAPTURE_SETUP',event_id,stream});
      if (response?.ok) { await chrome.tabs.update(previous,{active:true}); return {ok:true,status:'Choose your sellers in Invsto.'}; }
    } catch {}
  }
  const tab = await chrome.tabs.create({url:'https://antdamus.github.io/Invsto/live-sales.html?capture=1&capture_event='+encodeURIComponent(event_id)+'&v=1.7.1'+(stream?'&stream='+encodeURIComponent(JSON.stringify(stream)):''),active:true});
  data.setupTabs[event_id] = tab.id; await save(data);
  return {ok:true,status:'Choose your sellers in Invsto.'};
}
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
  const rank=s=>s.health.recovery?.phase==='read'?2:s.health.recovery?.phase==='needs_review'?1:0;
  const sort=(a,b)=>Number(!!b.health.ready)-Number(!!a.health.ready)||rank(b)-rank(a)||b.receivedAt-a.receivedAt;
  const source=automatic.sort(sort)[0]||current.sort((a,b)=>b.receivedAt-a.receivedAt)[0]||all.sort((a,b)=>b.receivedAt-a.receivedAt)[0];
  const ended=!!(data.health[event_id]?.broadcast_ended||all.some(s=>s.health.broadcast_ended));
  data.health[event_id]={...source.health,ready:!ended&&current.includes(source)&&source.health.mode!=='working'&&source.health.running!==false&&!!source.health.ready&&Object.keys(data.events).length<=10000,broadcast_ended:ended,pending:Object.values(data.events).filter(e=>e.event_id===event_id).length,version:'1.7.1'};
}
async function deliver(data) {
  const receivers = receiverEntries(data);
  if (!receivers.length) {data.status='Open the Invsto receiver in this browser and keep it signed in.';return;}
  const eventIds = Object.keys(data.health);
  for (const event_id of eventIds) {
    if(data.closedEvents?.[event_id])continue;
    selectCaptureHealth(data,event_id);
    const batch = Object.values(data.events).filter(e=>e.event_id===event_id).slice(0,80);
    data.health[event_id].pending=Object.values(data.events).filter(e=>e.event_id===event_id).length;
    let accepted = false;
    for (const [tab] of receivers) {
      try {
        const reply = await sendToTab(Number(tab),{type:'INVSTO_DELIVER',payload:{event_id,events:batch.map(e=>e.event),health:data.health[event_id]}});
        if (reply?.ok) {accepted=true;break;}
        if(reply?.state==='closed'){
          data.closedEvents||={};data.closedEvents[event_id]=true;
          for(const run of Object.values(data.captureRuns||{}))if(run.event_id===event_id)run.enabled=false;
          data.status='Show closed. Unsent notifications are retained for review.';break;
        }
        data.status=reply?.error||'Invsto has not accepted the data yet';
      } catch(error) {delete data.receivers[tab];data.status=error.message;}
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
  if(message.type==='INVSTO_STREAM_FRAME'){
    if(!/^https:\/\/ir\.ebaystatic\.com\/cr\/ebaylivepubweb\/liveassets\/shoplive\/[^/]+\/player\.html(?:\?|$)/.test(sender.url||'')||!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url)||!sender.frameId)return;
    enqueue(async()=>{const data=await read();data.streamFrames||={};data.streamFrames[sender.tab.id]={frameId:sender.frameId,documentId:sender.documentId,eventId:new URL(url).pathname.split('/')[4],seen:Date.now()};await save(data);return {ok:true};}).then(reply);return true;
  }
  if(message.type==='INVSTO_BAG_LABEL_COMMAND'){
    if(!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url))return;
    const eventId=new URL(url).pathname.split('/')[4],command=message.command;
    if(!/^[A-Za-z0-9_-]{6,100}$/.test(eventId)||command?.event_id!==eventId||!['status','auto','print','configure','capture','photo'].includes(command.action)||new URL(url).searchParams.has('invsto_metadata')){reply({ok:false,error:'Invalid bag-label request.'});return;}
    (async()=>{
      const data=await enqueue(()=>read()),receivers=receiverEntries(data);
      if(command.action==='capture'){
        const frame=data.streamFrames?.[sender.tab.id];
        if(!frame||frame.eventId!==eventId||Date.now()-frame.seen>60000)return {ok:false,error:'Open the live video preview and let it play, then try the camera. Refresh eBay after updating the extension.'};
        try{return await chrome.tabs.sendMessage(sender.tab.id,{type:'INVSTO_CAPTURE_STREAM_PHOTO'},{frameId:frame.frameId,...(frame.documentId?{documentId:frame.documentId}:{})});}
        catch{return {ok:false,error:'The video preview reconnected. Wait a moment and try the camera again.'};}
      }
      if(!receivers.length)return {ok:false,error:'Open the Invsto receiver in this browser and keep it signed in.'};
      for(const [tab] of receivers){
        try{
          if(command.action==='configure')await chrome.tabs.update(Number(tab),{active:true});
          const result=await sendToTab(Number(tab),{type:'INVSTO_BAG_LABEL_BRIDGE',command},command.action==='configure'?185000:32000);
          if(command.action==='configure')await chrome.tabs.update(sender.tab.id,{active:true});
          if(result)return result;
        }catch(error){
          // Printing may already have reached the queue. Do not repeat a print
          // automatically on another receiver after losing its acknowledgement.
          if(command.action!=='status')return {ok:false,error:command.action==='photo'?'The receiver disconnected. Reopen it and click the camera to retry this same photo.':'The receiver disconnected. Reopen it and retry the same label send.'};
        }
      }
      return {ok:false,error:'Refresh the Invsto receiver to enable bag-label printing.'};
    })().then(reply,error=>reply({ok:false,error:error.message}));return true;
  }
  if(message.type==='INVSTO_RESUME_CAPTURE'||message.type==='INVSTO_STOP_CAPTURE'){
    if(!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url))return;
    const event_id=new URL(url).pathname.split('/')[4];
    if(event_id!==message.event_id||!/^[A-Za-z0-9_-]{6,100}$/.test(event_id)||new URL(url).searchParams.has('invsto_metadata')){reply({ok:false});return;}
    if(message.type==='INVSTO_RESUME_CAPTURE'){resumeCapture(event_id,sender.tab.id).then(reply,error=>reply({ok:false,retry:true,error:error.message}));return true;}
    enqueue(async()=>{const data=await read(),run=data.captureRuns?.[sender.tab.id];if(run?.event_id===event_id)run.enabled=false;await save(data);return {ok:true};}).then(reply,error=>reply({ok:false,error:error.message}));return true;
  }
  if(message.type==='INVSTO_CAPTURE_FINISHED'){
    if(!/^https:\/\/antdamus\.github\.io\/Invsto\/live-sales\.html(?:\?|$)/.test(url)||!/^[A-Za-z0-9_-]{6,100}$/.test(message.event_id||''))return;
    finishCapture(message.event_id).then(()=>reply({ok:true}),error=>reply({ok:false,error:error.message}));return true;
  }
  if(message.type==='INVSTO_READ_STREAM'||message.type==='INVSTO_STREAM_METADATA'){
    if(!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url))return;
    const event_id=new URL(url).pathname.split('/')[4];
    if(event_id!==message.event_id || !/^[A-Za-z0-9_-]{6,100}$/.test(event_id)){reply({ok:false,error:'Event mismatch'});return;}
    if(message.type==='INVSTO_READ_STREAM'){
      // Independent from the serialized outbox: loading metadata must not delay payments.
      readStreamInBackground(url,event_id).then(reply,error=>reply({ok:false,error:error.message}));return true;
    }
    const reader=streamReaders.get(message.task);
    if(!reader || reader.event_id!==event_id || (reader.tab!==undefined && reader.tab!==sender.tab.id)){reply({ok:false});return;}
    reader.resolve(message.error?{ok:false,error:message.error}:{ok:true,stream:message.stream});reply({ok:true});return;
  }
  if (message.type==='INVSTO_START_CAPTURE') {
    if (!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url)) return;
    const event_id=new URL(url).pathname.split('/')[4];
    if (event_id!==message.event_id || !/^[A-Za-z0-9_-]{6,100}$/.test(event_id)) {reply({ok:false,error:'Event mismatch'});return;}
    enqueue(()=>openCaptureSetup(event_id,sender.tab.id,message.stream)).then(reply,error=>reply({ok:false,error:error.message}));
    return true;
  }
  if (message.type==='INVSTO_CAPTURE_CONNECTED') {
    if (!/^https:\/\/antdamus\.github\.io\/Invsto\/live-sales\.html(?:\?|$)/.test(url) || new URL(url).searchParams.get('capture_event')!==message.event_id) return;
    enqueue(async()=>{
      const data=await read(),tab=data.captureTabs?.[message.event_id];
      if(tab!==undefined){
        try{const result=await sendToTab(tab,{type:'INVSTO_CAPTURE_STATUS',event_id:message.event_id});if(result?.ok)await chrome.tabs.update(tab,{active:true});}catch{}
      }
      return {ok:true};
    }).then(reply,error=>reply({ok:false,error:error.message}));return true;
  }
  if(message.type==='INVSTO_LISTING_HELLO'||message.type==='INVSTO_LISTING_DISCOVER'){
    const listingPage=/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url);
    const invstoPage=/^https:\/\/antdamus\.github\.io\/Invsto\/live-sales\.html(?:\?|$)/.test(url);
    if(message.type==='INVSTO_LISTING_HELLO'?!listingPage:!invstoPage)return;
    enqueue(async()=>{
      const data=await read();data.listingSources||={};
      for(const [tab,source] of Object.entries(data.listingSources))if(Date.now()-source.seen>120000)delete data.listingSources[tab];
      if(listingPage){
        const event_id=new URL(url).pathname.split('/')[4];
        if(!/^[A-Za-z0-9_-]{6,100}$/.test(event_id))return {ok:false};
        for(const [event,owner] of Object.entries(data.listingOwners||{}))if(owner===sender.tab.id&&event!==event_id)delete data.listingOwners[event];
        data.listingSources[sender.tab.id]={event_id,seen:Date.now()};
      }
      await save(data);return {ok:true,events:[...new Set(Object.values(data.listingSources).map(source=>source.event_id))]};
    }).then(reply,error=>reply({ok:false,error:error.message}));return true;
  }
  if(message.type==='INVSTO_LISTING_COMMAND'){
    if(!/^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url))return;
    const event_id=new URL(url).pathname.split('/')[4];
    if(message.command?.event_id!==event_id)return;
    // Photo preparation must not block the separate payment-capture outbox.
    (async()=>{
      const receivers=await enqueue(async()=>{
        const data=await read();data.listingOwners||={};
        const owner=data.listingOwners[event_id];
        if(owner!==undefined&&owner!==sender.tab.id)throw Error('This event is being prepared in another eBay tab. Finish there or close that tab first.');
        data.listingOwners[event_id]=sender.tab.id;await save(data);return receiverEntries(data);
      });
      let result;
      for(const [tab] of receivers){
        try{result=await chrome.tabs.sendMessage(Number(tab),{type:'INVSTO_LISTING_BRIDGE',command:message.command});break;}catch{}
      }
      if(!result||result.ok&&(message.command.action==='next'&&!result.job||['created','failed'].includes(message.command.action))){
        await enqueue(async()=>{const data=await read();if(data.listingOwners?.[event_id]===sender.tab.id){delete data.listingOwners[event_id];await save(data);}});
      }
      return result||{ok:false,error:'Open the signed-in Invsto capture receiver in this browser.'};
    })().then(reply,error=>reply({ok:false,error:error.message}));
    return true;
  }
  enqueue(async()=>{
    const data = await read();
    if (message.type==='INVSTO_RECEIVER' && /^https:\/\/antdamus\.github\.io\/Invsto\/live-sales\.html(?:\?|$)/.test(url)) {
      data.receivers[sender.tab.id]=Date.now();
      const requested=new URL(url).searchParams.get('capture_event')||new URL(url).searchParams.get('resume_event');
      if (/^[A-Za-z0-9_-]{6,100}$/.test(requested||'')) {data.setupTabs||={};data.setupTabs[requested]=sender.tab.id;}
    } else if (message.type==='INVSTO_CAPTURE' && /^https:\/\/www\.ebay\.com\/ebaylive\/host\/events\//.test(url)) {
      const event_id=new URL(url).pathname.split('/')[4];
      if (event_id!==message.event_id || !/^[\w-]{6,100}$/.test(event_id)) throw Error('Event mismatch');
      if(data.closedEvents?.[event_id])return {ok:true,closed:true,status:'This show is closed'};
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
    return {ok:true,status:data.status,lastDelivered:data.lastDelivered,closed:!!data.closedEvents?.[message.event_id]};
  }).then(reply,error=>reply({ok:false,error:error.message}));
  return true;
});
chrome.alarms.create('retry-live',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>enqueue(async()=>{const d=await read();await deliver(d);await save(d);}));
chrome.tabs.onRemoved?.addListener(tab=>enqueue(async()=>{
  const data=await read();if(data.listingSources)delete data.listingSources[tab];
  if(data.streamFrames)delete data.streamFrames[tab];
  if(data.captureRuns)delete data.captureRuns[tab];
  for(const [event,id] of Object.entries(data.setupTabs||{}))if(id===tab)delete data.setupTabs[event];
  for(const [event,id] of Object.entries(data.captureTabs||{}))if(id===tab)delete data.captureTabs[event];
  for(const [event,owner] of Object.entries(data.listingOwners||{}))if(owner===tab)delete data.listingOwners[event];
  await save(data);
}));
chrome.runtime.onStartup?.addListener(()=>enqueue(async()=>{const data=await read();data.listingSources={};data.listingOwners={};data.captureRuns={};await save(data);}));
