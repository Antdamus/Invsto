(async function(){
 'use strict';
 const id=new URLSearchParams(location.search).get('tiktokLabels');if(!id||!location.pathname.endsWith('/pending-tiktok-orders.html'))return;
 const settings=await chrome.storage.sync.get('ogPendingOrdersUrl');let target;try{target=new URL('pending-tiktok-orders.html',settings.ogPendingOrdersUrl);}catch{return;}
 if(location.origin!==target.origin||location.pathname!==target.pathname)return;
 window.addEventListener('message',async e=>{
  if(e.source!==window||e.origin!==location.origin)return;
  if(e.data?.type==='OG_TIKTOK_LABELS_READY'){try{const r=await chrome.runtime.sendMessage({type:'OG_ONLINE_PRINT_GET',transferId:id});window.postMessage({type:'OG_TIKTOK_LABELS_DATA',payload:r?.ok?r.payload:{error:r?.error||'Could not receive the TikTok labels.'}},location.origin);}catch{window.postMessage({type:'OG_TIKTOK_LABELS_DATA',payload:{error:'Reload the updated extension and this page.'}},location.origin);}}
  if(e.data?.type==='OG_TIKTOK_LABELS_DONE'&&e.data.transferId===id)await chrome.runtime.sendMessage({type:'OG_ONLINE_PRINT_DONE',transferId:id,result:'Shipping labels saved to TikTok orders.'}).catch(()=>{});
 });
 window.postMessage({type:'OG_TIKTOK_LABELS_BRIDGE_READY'},location.origin);
})();
