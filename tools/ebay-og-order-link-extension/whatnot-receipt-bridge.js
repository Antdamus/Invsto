(async function(){
 'use strict';
 if(window.top!==window||!location.pathname.endsWith('/pending-whatnot-orders.html'))return;
 const s=await chrome.storage.sync.get('ogPendingOrdersUrl');let target;try{target=new URL('pending-whatnot-orders.html',s.ogPendingOrdersUrl);}catch{return;}
 if(location.origin!==target.origin||location.pathname!==target.pathname)return;
 const transfers=new Set(),delivering=new Set(),initial=new URLSearchParams(location.search).get('whatnotReceipt');if(initial)transfers.add(initial);
 const available=id=>window.postMessage({type:'OG_WHATNOT_RECEIPT_AVAILABLE',transferId:id},location.origin);
 const ready=()=>document.documentElement.dataset.wnReceiptReceiver==='2';
 chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message?.type==='OG_WHATNOT_RECEIPT_PING'){reply({ready:ready(),busy:document.documentElement.dataset.wnReceiptSaving==='true'});return;}
  if(message?.type!=='OG_WHATNOT_RECEIPT_AVAILABLE')return;
  if(!ready()||!/^[a-f0-9-]{36}$/i.test(message.transferId||'')){reply({ok:false});return;}
  transfers.add(message.transferId);available(message.transferId);reply({ok:true});
 });
 async function deliver(transferId){
  if(delivering.has(transferId))return;delivering.add(transferId);
  try{const r=await chrome.runtime.sendMessage({type:'OG_WHATNOT_RECEIPT_GET',transferId});window.postMessage({type:'OG_WHATNOT_RECEIPT_DATA',payload:{...(r?.ok?r.payload:{error:r?.error||'Could not receive the capture.'}),transferId}},location.origin);}catch{window.postMessage({type:'OG_WHATNOT_RECEIPT_DATA',payload:{transferId,error:'Reload the extension and OG to receive this capture.'}},location.origin);}finally{delivering.delete(transferId);}
 }
 window.addEventListener('message',async event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  if(event.data?.type==='OG_WHATNOT_RECEIPT_READY'){
   if(transfers.has(event.data.transferId))await deliver(event.data.transferId);
   else if(!event.data.transferId)for(const id of transfers)available(id);
  }
  if(event.data?.type==='OG_WHATNOT_RECEIPT_DONE'&&transfers.has(event.data.transferId)){
   const transferId=event.data.transferId,result=await chrome.runtime.sendMessage({type:'OG_WHATNOT_RECEIPT_ACK',transferId}).catch(()=>null);if(result?.ok)transfers.delete(transferId);
  }
 });
 window.postMessage({type:'OG_WHATNOT_RECEIPT_BRIDGE_READY'},location.origin);
})();
