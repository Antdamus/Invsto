'use strict';
(()=>{
 const eventId=new URL(location.href).searchParams.get('capture_event');if(!/^tiktok-[0-9]{10,25}$/.test(eventId||'')||new URL(location.href).searchParams.get('capture')!=='1')return;
 const pending=new Map();
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(m.type==='TIKTOK_LIVE_PING'){reply({ok:true});return;}
  if(!['TIKTOK_LIVE_DELIVER','TIKTOK_BAG_BRIDGE'].includes(m.type))return;
  if((m.payload?.event_id||m.command?.event_id)!==eventId){reply({ok:false,error:'Receiver belongs to another show.'});return;}
  const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reply({ok:false,error:'TikTok receiver is not ready. Sign in and choose the seller.'});},m.command?.action==='configure'?180000:30000);
  pending.set(id,result=>{clearTimeout(timer);reply(result);});
  window.postMessage(m.type==='TIKTOK_BAG_BRIDGE'?{type:'INVSTO_BAG_PRINT_REQUEST',id,command:m.command}:{type:'TIKTOK_LIVE_BATCH',id,payload:m.payload},location.origin);return true;
 });
 window.addEventListener('message',e=>{if(e.source!==window||e.origin!==location.origin||!['TIKTOK_LIVE_ACK','INVSTO_BAG_PRINT_RESPONSE'].includes(e.data?.type))return;const reply=pending.get(e.data.id);if(reply){pending.delete(e.data.id);const {type,id,...result}=e.data;reply(result);}});
 const announce=()=>chrome.runtime.sendMessage({type:'TIKTOK_LIVE_RECEIVER',event_id:eventId}).catch(()=>{});announce();setInterval(announce,5000);
})();
