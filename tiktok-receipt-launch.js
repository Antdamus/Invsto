(function(){
 'use strict';
 const params=new URLSearchParams(location.search),order=params.get('order'),sku=params.get('sku')||'',status=document.getElementById('receipt-launch-status'),retry=document.getElementById('receipt-launch-retry');
 if(!/^\d{10,24}$/.test(order||'')||(sku&&!/^\d{10,24}$/.test(sku))){status.textContent='This receipt link has no valid order or item. Open it again from Invsto.';return;}
 let active=null,completed=false,ready=false,timer;
 function open(){
  if(active||completed)return;
  if(!ready){status.textContent='The OG extension is not responding. Install or enable its Firefox version, refresh this page, then try again.';retry.hidden=false;return;}
  active=crypto.randomUUID();retry.hidden=true;status.textContent='Preparing Invsto and opening your TikTok receipt…';
  window.postMessage({type:'OG_TIKTOK_OPEN_RECEIPT',requestId:active,orderNumber:order,skuId:sku},location.origin);
  timer=setTimeout(()=>{active=null;status.textContent='Still waiting. Check the Invsto tab for sign-in, then try again.';retry.hidden=false;},45000);
 }
 window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  if(event.data?.type==='OG_TIKTOK_LAUNCH_BRIDGE_READY'){ready=true;open();}
  if(event.data?.type==='OG_TIKTOK_OPEN_RECEIPT_RESULT'&&event.data.requestId===active){clearTimeout(timer);active=null;completed=Boolean(event.data.ok);status.textContent=completed?'Receipt opened. Pause on the item, then choose “Capture item photo → OG.”':event.data.error||'Could not open the receipt. Try again.';retry.hidden=completed;}
 });
 retry.onclick=()=>{if(!ready)location.reload();else open();};
 window.postMessage({type:'OG_TIKTOK_LAUNCH_READY'},location.origin);
 setTimeout(()=>{if(!ready)open();},4000);
})();
