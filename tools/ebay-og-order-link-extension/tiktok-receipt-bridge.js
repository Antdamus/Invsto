(async function(){
 'use strict';
 if(window.top!==window||!location.pathname.endsWith('/pending-tiktok-orders.html'))return;
 const s=await chrome.storage.sync.get('ogPendingOrdersUrl');let target;try{target=new URL('pending-tiktok-orders.html',s.ogPendingOrdersUrl);}catch{return;}
 if(location.origin!==target.origin||location.pathname!==target.pathname)return;
 const transferId=new URLSearchParams(location.search).get('tiktokReceipt');if(!transferId)return;
 async function deliver(){try{const r=await chrome.runtime.sendMessage({type:'OG_TIKTOK_RECEIPT_GET',transferId});window.postMessage({type:'OG_TIKTOK_RECEIPT_DATA',payload:{...(r?.ok?r.payload:{error:r?.error||'Could not receive the capture.'}),transferId}},location.origin);}catch{window.postMessage({type:'OG_TIKTOK_RECEIPT_DATA',payload:{transferId,error:'Reload the extension and OG to receive this capture.'}},location.origin);}}
 window.addEventListener('message',async event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  if(event.data?.type==='OG_TIKTOK_RECEIPT_READY')await deliver();
  if(event.data?.type==='OG_TIKTOK_RECEIPT_DONE'&&event.data.transferId===transferId)await chrome.runtime.sendMessage({type:'OG_TIKTOK_RECEIPT_ACK',transferId}).catch(()=>{});
 });
 window.postMessage({type:'OG_TIKTOK_RECEIPT_BRIDGE_READY'},location.origin);
})();
