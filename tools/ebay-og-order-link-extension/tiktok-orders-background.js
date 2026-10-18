/* Dedicated, expiring TikTok export handoff. Does not use eBay import messages. */
(function(){
 'use strict';
 const AUTO='ogTikTokExport:',PREFIX='ogTikTokOrders:',TTL=3600000,MAX=10*1024*1024,inflight=new Map();
 async function target(){const s=await chrome.storage.sync.get('ogPendingOrdersUrl');const u=new URL(s.ogPendingOrdersUrl||'');if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Set an HTTPS OG Pending Orders URL in extension settings.');return new URL('pending-tiktok-orders.html',u);}
 const valid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
 function reportUrl(value){
  const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||(u.hostname!=='seller-us.tiktok.com'&&!/(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|ibytedtos\.com)$/.test(u.hostname)))throw Error('TikTok returned an unsupported download address. Download the CSV and use Send downloaded CSV.');return u;
 }
 async function readReport(value){
  const u=reportUrl(value),r=await fetch(u.href,{credentials:u.origin==='https://seller-us.tiktok.com'?'include':'omit',signal:AbortSignal.timeout(30000)});
  if(!r.ok||r.status===206)throw Error('TikTok CSV download failed (HTTP '+r.status+').');if(r.url)reportUrl(r.url);
  if(Number(r.headers.get('content-length'))>MAX)throw Error('Choose a CSV smaller than 10 MB.');
  if(!r.body?.getReader){const text=await r.text();if(new TextEncoder().encode(text).length>MAX)throw Error('Choose a CSV smaller than 10 MB.');return text;}
  const reader=r.body.getReader(),decoder=new TextDecoder();let size=0,text='';try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX){await reader.cancel();throw Error('Choose a CSV smaller than 10 MB.');}text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}
 }
 async function handle(m,sender){
  const source=new URL(sender.url||'about:blank'),destination=await target();
  if(sender.frameId>0)throw Error('Use the main TikTok or OG tab.');
  const id=m.transferId;if(!valid(id))throw Error('Invalid TikTok transfer.');const key=PREFIX+id;
  if(['OG_TIKTOK_REPORT_BEGIN','OG_TIKTOK_REPORT_CANCEL','OG_TIKTOK_REPORT_FETCH','OG_TIKTOK_REPORT_CAPTURE'].includes(m.type)){
   if(source.origin!=='https://seller-us.tiktok.com'||source.pathname!=='/order'||!Number.isInteger(sender.tab?.id))throw Error('Start Export all from TikTok Manage orders.');
   const autoKey=AUTO+id;
   if(m.type==='OG_TIKTOK_REPORT_BEGIN'){
    if(!/^All order-.*\.csv$/i.test(String(m.filename||'')))throw Error('Choose the new All-orders CSV.');
    const records=await chrome.storage.local.get(null),expired=Object.keys(records).filter(k=>k.startsWith(AUTO)&&Date.now()>records[k].until);if(expired.length)await chrome.storage.local.remove(expired);
    await chrome.storage.local.set({[autoKey]:{tabId:sender.tab.id,until:Date.now()+90000,filename:m.filename,modifiedAt:m.modifiedAt,deadlines:m.deadlines}});return {ok:true};
   }
   const pending=(await chrome.storage.local.get(autoKey))[autoKey];
   if(!pending||pending.tabId!==sender.tab.id||pending.until<Date.now())throw Error('This export was cancelled or expired. Try Export all again.');
   if(m.type==='OG_TIKTOK_REPORT_CANCEL'){await chrome.storage.local.remove(autoKey);return {ok:true};}
   const deliveryKey='deliver:'+id;
   if(!inflight.has(deliveryKey))inflight.set(deliveryKey,(async()=>{
    const text=m.type==='OG_TIKTOK_REPORT_FETCH'?await readReport(m.url):m.text;
    const live=(await chrome.storage.local.get(autoKey))[autoKey];if(!live||live.tabId!==sender.tab.id||live.until<Date.now())throw Error('Export cancelled. No orders were imported.');
    const result=await handle({type:'OG_TIKTOK_REPORT_SEND',transferId:id,text,filename:pending.filename,modifiedAt:pending.modifiedAt,deadlines:pending.deadlines},sender);
    await chrome.storage.local.remove(autoKey);return result;
   })().finally(()=>inflight.delete(deliveryKey)));
   return inflight.get(deliveryKey);
  }
  if(m.type==='OG_TIKTOK_REPORT_SEND'){
   if(source.origin!=='https://seller-us.tiktok.com'||!/^\/order(?:\/|$)/.test(source.pathname))throw Error('Send orders from TikTok Seller Center.');
   if(typeof m.text!=='string'||new TextEncoder().encode(m.text).length>MAX||!m.text.slice(0,10000).includes('Order ID')||!m.text.slice(0,10000).includes('SKU ID'))throw Error('Choose an original TikTok CSV smaller than 10 MB.');
   const all=await chrome.storage.local.get(null),expired=Object.keys(all).filter(k=>k.startsWith(PREFIX)&&Date.now()-all[k].createdAt>TTL);if(expired.length)await chrome.storage.local.remove(expired);
   if(all[key]&&Date.now()-all[key].createdAt<TTL)return {ok:true,transferId:id};
   const deadlines={};for(const [order,date] of Object.entries(m.deadlines||{}).slice(0,200)){if(/^\d{10,24}$/.test(order)&&/^\d{4}-\d{2}-\d{2}$/.test(String(date)))deadlines[order]=date;}
   await chrome.storage.local.set({[key]:{transferId:id,text:m.text,filename:String(m.filename||'TikTok-orders.csv').slice(0,240),modifiedAt:Number(m.modifiedAt)||Date.now(),deadlines,createdAt:Date.now(),target:destination.href}});
   destination.searchParams.set('tiktokReport',id);
   try{await chrome.tabs.create({url:destination.href,active:true});}catch(e){await chrome.storage.local.remove(key);throw e;}
   return {ok:true,transferId:id};
  }
  if(source.origin!==destination.origin||source.pathname!==destination.pathname||source.searchParams.get('tiktokReport')!==id)throw Error('Open the configured TikTok orders page to receive this report.');
  const record=(await chrome.storage.local.get(key))[key];
  if(!record||record.target!==destination.href||Date.now()-record.createdAt>TTL){if(record)await chrome.storage.local.remove(key);throw Error('This export handoff expired. Send the CSV from TikTok again.');}
  if(m.type==='OG_TIKTOK_REPORT_GET')return {ok:true,payload:record};
  if(m.type==='OG_TIKTOK_REPORT_ACK'){await chrome.storage.local.set({[key]:{transferId:id,target:record.target,createdAt:record.createdAt,completed:true}});return {ok:true};}
  throw Error('Unsupported TikTok handoff.');
 }
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(!['OG_TIKTOK_REPORT_SEND','OG_TIKTOK_REPORT_GET','OG_TIKTOK_REPORT_ACK','OG_TIKTOK_REPORT_BEGIN','OG_TIKTOK_REPORT_CANCEL','OG_TIKTOK_REPORT_FETCH','OG_TIKTOK_REPORT_CAPTURE'].includes(m?.type))return;
  const key=m.type+':'+(sender.tab?.id||'')+':'+m.transferId;
  if(!inflight.has(key))inflight.set(key,handle(m,sender).finally(()=>inflight.delete(key)));
  inflight.get(key).then(reply,e=>reply({ok:false,error:e.message}));return true;
 });
})();
