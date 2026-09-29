'use strict';
// No eBay cookies or Supabase credentials cross this bridge.
if (new URL(location.href).searchParams.get('capture') === '1') {
  const pending = new Map();
  const listingPending = new Map();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if(sender.id===chrome.runtime.id&&message?.type==='INVSTO_LISTING_BRIDGE'){
      const id=crypto.randomUUID();
      const timer=setTimeout(()=>{listingPending.delete(id);reply({ok:false,error:'Preparation timed out. Check the receiver and the saved request before retrying.'});},180000);
      listingPending.set(id,result=>{clearTimeout(timer);reply(result);});
      window.postMessage({type:'INVSTO_LISTING_REQUEST',id,command:message.command},location.origin);return true;
    }
    if (sender.id !== chrome.runtime.id || message?.type !== 'INVSTO_DELIVER') return;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reply({ok:false,error:'Invsto is not ready. Sign in and link this show.'}); }, 12000);
    pending.set(id, result => {clearTimeout(timer); reply(result);});
    window.postMessage({type:'INVSTO_LIVE_BATCH',id,payload:message.payload}, location.origin);
    return true;
  });
  window.addEventListener('message', event => {
    if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_LISTING_RESPONSE'){
      const respond=listingPending.get(event.data.id);if(respond){listingPending.delete(event.data.id);respond({ok:event.data.ok===true,error:event.data.error,job:event.data.job});}return;
    }
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'INVSTO_LIVE_ACK') return;
    const reply = pending.get(event.data.id);
    if (reply) {pending.delete(event.data.id);reply({ok:event.data.ok===true,error:String(event.data.error||'').slice(0,250)});}
  });
  const announce = () => chrome.runtime.sendMessage({type:'INVSTO_RECEIVER'}).catch(()=>{});
  announce(); setInterval(announce,5000);
}
