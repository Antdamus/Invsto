(async function(){
 'use strict';
 if(!location.pathname.endsWith('/pending-tiktok-orders.html'))return;
 const settings=await chrome.storage.sync.get('ogPendingOrdersUrl');let target;
 try{target=new URL('pending-tiktok-orders.html',settings.ogPendingOrdersUrl);}catch{return;}
 if(location.origin!==target.origin||location.pathname!==target.pathname)return;
 const transferId=new URLSearchParams(location.search).get('tiktokReport');
 const post=payload=>window.postMessage({type:'OG_TIKTOK_REPORT_DATA',payload:{...payload,transferId}},location.origin);
 async function deliver(){if(!transferId)return;try{const r=await chrome.runtime.sendMessage({type:'OG_TIKTOK_REPORT_GET',transferId});post(r?.ok?r.payload:{error:r?.error||'Could not receive the TikTok export.'});}catch{post({error:'Reload the extension and this page to receive the export.'});}}
 window.addEventListener('message',async event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  if(event.data?.type==='OG_TIKTOK_REPORT_READY')await deliver();
  if(event.data?.type==='OG_TIKTOK_REPORT_DONE'&&event.data.transferId===transferId)await chrome.runtime.sendMessage({type:'OG_TIKTOK_REPORT_ACK',transferId}).catch(()=>{});
  if(event.data?.type==='OG_EBAY_EXTENSION_VERSION_REQUEST')window.postMessage({type:'OG_EBAY_EXTENSION_VERSION_RESPONSE',requestId:event.data.requestId,version:chrome.runtime.getManifest().version},location.origin);
 });
 // The app may have loaded before the content script. It acknowledges readiness
 // after auth; polling READY avoids losing the transfer without auto-importing it.
 window.postMessage({type:'OG_TIKTOK_BRIDGE_READY'},location.origin);
})();
