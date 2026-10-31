/* Whatnot-only frame capture and expiring delivery. No eBay receipt handlers or storage keys. */
(function(){
 'use strict';
 const PREFIX='ogWhatnotReceipt:',TTL=3600000,inflight=new Map();
 const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
 async function target(){const s=await chrome.storage.sync.get('ogPendingOrdersUrl'),url=new URL(s.ogPendingOrdersUrl||'');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw Error('Set an HTTPS OG Pending Orders URL in extension settings.');return new URL('pending-whatnot-orders.html',url);}
 async function assertActive(sender,source){
  const tab=await chrome.tabs.get(sender.tab.id),active=await chrome.tabs.query({active:true,windowId:tab.windowId});
  if(active.length!==1||active[0].id!==tab.id||tab.url!==source.href)throw Error('Keep this Whatnot receipt tab active while capturing.');
  return tab;
 }
 async function receiver(destination,sourceTab){
  const candidates=(await chrome.tabs.query({})).filter(tab=>{try{const u=new URL(tab.url);return u.origin===destination.origin&&u.pathname===destination.pathname;}catch{return false;}});
  candidates.sort((a,b)=>Number(b.id===sourceTab.openerTabId)-Number(a.id===sourceTab.openerTabId)||Number(b.windowId===sourceTab.windowId)-Number(a.windowId===sourceTab.windowId)||(b.lastAccessed||0)-(a.lastAccessed||0));
  for(const tab of candidates){try{const state=await chrome.tabs.sendMessage(tab.id,{type:'OG_WHATNOT_RECEIPT_PING'});if(state?.ready&&!state.busy)return tab;}catch{}}
  throw Error(candidates.length?'Refresh your open OG Whatnot orders tab and finish any capture already saving, then try again.':'Open your OG Whatnot orders tab first, then capture again.');
 }
 async function crop(dataUrl,rect,viewport){
  const bitmap=await createImageBitmap(await (await fetch(dataUrl)).blob());
  try{
   const sx=bitmap.width/viewport.width,sy=bitmap.height/viewport.height;
   if(Math.abs(sx/sy-1)>.03)throw Error('The window changed size. Capture again.');
   const x=Math.round(rect.x*sx),y=Math.round(rect.y*sy),w=Math.round(rect.width*sx),h=Math.round(rect.height*sy);
   if(w<40||h<40||x+w>bitmap.width||y+h>bitmap.height)throw Error('Keep the whole video visible.');
   const scale=Math.min(1,1600/Math.max(w,h)),canvas=new OffscreenCanvas(Math.round(w*scale),Math.round(h*scale));
   canvas.getContext('2d').drawImage(bitmap,x,y,w,h,0,0,canvas.width,canvas.height);
   const blob=await canvas.convertToBlob({type:'image/jpeg',quality:.9}),bytes=new Uint8Array(await blob.arrayBuffer());
   if(bytes.length>5*1024*1024)throw Error('The capture is too large. Reduce the video size and retry.');
   let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   return 'data:image/jpeg;base64,'+btoa(binary);
  }finally{bitmap.close();}
 }
 async function handle(m,sender){
  if(sender.frameId!==0||!sender.tab?.id)throw Error('Use the main Whatnot or OG tab.');
  const source=new URL(sender.url||'about:blank'),destination=await target(),id=m.transferId;
  if(!validId(id))throw Error('Invalid receipt transfer.');const key=PREFIX+id;
  if(m.type==='OG_WHATNOT_RECEIPT_CAPTURE'){
   if(new URLSearchParams(source.hash.slice(1)).get('order')!==m.orderNumber||new URLSearchParams(source.hash.slice(1)).get('invsto-receipt')!==m.itemId||source.origin!=='https://www.whatnot.com'||!/^\/dashboard\/orders\/[A-Za-z0-9-]+$/.test(source.pathname)||!/^\d{1,19}$/.test(m.orderNumber||'')||!/^\d{1,19}$/.test(m.itemId||''))throw Error('Open the matching Whatnot order receipt first.');
   const r=m.rect,v=m.viewport;
   if(!r||!v||![r.x,r.y,r.width,r.height,v.width,v.height,m.videoTime].every(Number.isFinite)||r.x<0||r.y<0||r.width<40||r.height<40||v.width>16000||v.height>16000||r.x+r.width>v.width||r.y+r.height>v.height||m.videoTime<0||m.videoTime>604800)throw Error('Invalid video capture area.');
   const tab=await assertActive(sender,source),og=await receiver(destination,tab);
   await assertActive(sender,source);
   const shot=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
   await assertActive(sender,source);
   const image=await crop(shot,r,v),all=await chrome.storage.local.get(null);
   const expired=Object.keys(all).filter(k=>k.startsWith(PREFIX)&&Date.now()-all[k].createdAt>TTL);if(expired.length)await chrome.storage.local.remove(expired);
   await chrome.storage.local.set({[key]:{transferId:id,orderNumber:m.orderNumber,itemId:m.itemId,videoTime:m.videoTime,sourceUrl:source.origin+source.pathname,image,createdAt:Date.now(),target:destination.href,receiverTabId:og.id}});
   const accepted=await chrome.tabs.sendMessage(og.id,{type:'OG_WHATNOT_RECEIPT_AVAILABLE',transferId:id});
   if(!accepted?.ok)throw Error('Refresh your open OG Whatnot orders tab, then capture again.');
   return {ok:true,transferId:id};
  }
  if(source.origin!==destination.origin||source.pathname!==destination.pathname)throw Error('Open the configured Whatnot workspace to receive this capture.');
  const record=(await chrome.storage.local.get(key))[key];
  if(!record||record.target!==destination.href||Date.now()-record.createdAt>TTL){if(record)await chrome.storage.local.remove(key);throw Error('This capture expired. Capture the Whatnot frame again.');}
  if(record.receiverTabId?record.receiverTabId!==sender.tab.id:source.searchParams.get('whatnotReceipt')!==id)throw Error('Use the OG tab receiving this capture.');
  if(m.type==='OG_WHATNOT_RECEIPT_GET')return {ok:true,payload:record};
  if(m.type==='OG_WHATNOT_RECEIPT_ACK'){
   await chrome.storage.local.set({[key]:{transferId:id,orderNumber:record.orderNumber,itemId:record.itemId,target:record.target,createdAt:record.createdAt,receiverTabId:record.receiverTabId,completed:true}});
   if(!record.completed){const tab=await chrome.tabs.update(sender.tab.id,{active:true});if(tab.windowId)await chrome.windows.update(tab.windowId,{focused:true});}
   return {ok:true};
  }
  throw Error('Unsupported Whatnot receipt transfer.');
 }
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(!['OG_WHATNOT_RECEIPT_CAPTURE','OG_WHATNOT_RECEIPT_GET','OG_WHATNOT_RECEIPT_ACK'].includes(m?.type))return;
  const key=m.type+':'+sender.tab?.id+':'+m.transferId;
  if(!inflight.has(key))inflight.set(key,handle(m,sender).finally(()=>inflight.delete(key)));
  inflight.get(key).then(reply,e=>reply({ok:false,error:e.message}));return true;
 });
})();
