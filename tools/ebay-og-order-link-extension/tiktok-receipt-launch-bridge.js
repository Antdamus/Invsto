(async function(){
 'use strict';
 if(window.top!==window||!location.pathname.endsWith('/tiktok-receipt-launch.html'))return;
 const stored=await chrome.storage.sync.get('ogPendingOrdersUrl');let target;
 try{target=new URL('tiktok-receipt-launch.html',stored.ogPendingOrdersUrl);}catch{return;}
 if(location.origin!==target.origin||location.pathname!==target.pathname)return;
 const announce=()=>window.postMessage({type:'OG_TIKTOK_LAUNCH_BRIDGE_READY'},location.origin);
 let busy=false;
 window.addEventListener('message',async event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  if(event.data?.type==='OG_TIKTOK_LAUNCH_READY'){announce();return;}
  const m=event.data;if(m?.type!=='OG_TIKTOK_OPEN_RECEIPT'||busy||!/^[a-f0-9-]{36}$/i.test(m.requestId||''))return;
  busy=true;
  try{
   const result=await chrome.runtime.sendMessage({type:'OG_TIKTOK_OPEN_RECEIPT',requestId:m.requestId,orderNumber:m.orderNumber,skuId:m.skuId});
   window.postMessage({type:'OG_TIKTOK_OPEN_RECEIPT_RESULT',requestId:m.requestId,ok:Boolean(result?.ok),error:result?.error},location.origin);
  }catch{window.postMessage({type:'OG_TIKTOK_OPEN_RECEIPT_RESULT',requestId:m.requestId,ok:false,error:'Reload the OG extension and try again.'},location.origin);}
  finally{busy=false;}
 });
 announce();
})();
