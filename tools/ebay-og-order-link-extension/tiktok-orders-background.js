/* Dedicated, expiring TikTok export handoff. Does not use eBay import messages. */
(function(){
 'use strict';
 const PREFIX='ogTikTokOrders:',TTL=3600000,MAX=10*1024*1024,inflight=new Map();
 async function target(){const s=await chrome.storage.sync.get('ogPendingOrdersUrl');const u=new URL(s.ogPendingOrdersUrl||'');if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Set an HTTPS OG Pending Orders URL in extension settings.');return new URL('pending-tiktok-orders.html',u);}
 const valid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
 async function handle(m,sender){
  const source=new URL(sender.url||'about:blank'),destination=await target();
  if(sender.frameId>0)throw Error('Use the main TikTok or OG tab.');
  const id=m.transferId;if(!valid(id))throw Error('Invalid TikTok transfer.');const key=PREFIX+id;
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
  if(!['OG_TIKTOK_REPORT_SEND','OG_TIKTOK_REPORT_GET','OG_TIKTOK_REPORT_ACK'].includes(m?.type))return;
  const key=m.type+':'+(sender.tab?.id||'')+':'+m.transferId;
  if(!inflight.has(key))inflight.set(key,handle(m,sender).finally(()=>inflight.delete(key)));
  inflight.get(key).then(reply,e=>reply({ok:false,error:e.message}));return true;
 });
})();
