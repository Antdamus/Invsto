'use strict';
// No eBay cookies or Supabase credentials cross this bridge.
const discoverListings=()=>chrome.runtime.sendMessage({type:'INVSTO_LISTING_DISCOVER'}).then(result=>{
  if(result?.ok)window.postMessage({type:'INVSTO_LISTING_EVENTS',events:result.events},location.origin);
}).catch(()=>{});
window.addEventListener('message',event=>{if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_LISTING_DISCOVER')discoverListings();});
window.addEventListener('message',event=>{
  if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_CAPTURE_FINISHED')chrome.runtime.sendMessage({type:'INVSTO_CAPTURE_FINISHED',event_id:event.data.event_id}).catch(()=>{});
  if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_CAPTURE_CONNECTED'){
    const requested=new URL(location.href).searchParams.get('capture_event');
    if(requested===event.data.event_id&&/^[A-Za-z0-9_-]{6,100}$/.test(requested||''))chrome.runtime.sendMessage({type:'INVSTO_CAPTURE_CONNECTED',event_id:requested}).catch(()=>{});
  }
});
discoverListings();setInterval(discoverListings,5000);
if (new URL(location.href).searchParams.get('capture') === '1') {
  const pending = new Map();
  const captureChecks = new Map();
  const listingPending = new Map();
  const bagPending = new Map();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if(sender.id===chrome.runtime.id&&message?.type==='INVSTO_BAG_LABEL_BRIDGE'){
      const id=crypto.randomUUID();
      const timer=setTimeout(()=>{bagPending.delete(id);reply({ok:false,error:'The receiver did not confirm the request. Retry to check the same label send.'});},message.command?.action==='configure'?180000:30000);
      bagPending.set(id,result=>{clearTimeout(timer);reply(result);});
      window.postMessage({type:'INVSTO_BAG_PRINT_REQUEST',id,command:message.command},location.origin);return true;
    }
    if(sender.id===chrome.runtime.id&&message?.type==='INVSTO_CHECK_CAPTURE'){
      if(!/^[A-Za-z0-9_-]{6,100}$/.test(message.event_id||'')){reply({ok:false});return;}
      const id=crypto.randomUUID();const timer=setTimeout(()=>{captureChecks.delete(id);reply({ok:false,state:'unavailable'});},8000);
      captureChecks.set(id,result=>{clearTimeout(timer);reply(result);});
      window.postMessage({type:'INVSTO_CAPTURE_CHECK',id,event_id:message.event_id},location.origin);return true;
    }
    if(sender.id===chrome.runtime.id&&message?.type==='INVSTO_OPEN_CAPTURE_SETUP'){
      if(!/^[A-Za-z0-9_-]{6,100}$/.test(message.event_id||'')){reply({ok:false});return;}
      const url=new URL(location.href);url.searchParams.set('capture_event',message.event_id);
      if(message.stream)url.searchParams.set('stream',JSON.stringify(message.stream));else url.searchParams.delete('stream');
      history.replaceState(null,'',url.href);
      window.postMessage({type:'INVSTO_CAPTURE_SETUP',event_id:message.event_id,stream:message.stream},location.origin);
      reply({ok:true});return;
    }
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
    if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_BAG_PRINT_RESPONSE'){
      const respond=bagPending.get(event.data.id);if(respond){bagPending.delete(event.data.id);const {type,id,...result}=event.data;respond(result);}return;
    }
    if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_CAPTURE_CHECK_RESULT'){
      const respond=captureChecks.get(event.data.id);if(respond){captureChecks.delete(event.data.id);respond({ok:true,state:event.data.state});}return;
    }
    if(event.source===window&&event.origin===location.origin&&event.data?.type==='INVSTO_LISTING_RESPONSE'){
      const respond=listingPending.get(event.data.id);if(respond){listingPending.delete(event.data.id);respond({ok:event.data.ok===true,error:event.data.error,job:event.data.job});}return;
    }
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'INVSTO_LIVE_ACK') return;
    const reply = pending.get(event.data.id);
    if (reply) {pending.delete(event.data.id);reply({ok:event.data.ok===true,error:String(event.data.error||'').slice(0,250),state:event.data.state});}
  });
  const announce = () => chrome.runtime.sendMessage({type:'INVSTO_RECEIVER'}).catch(()=>{});
  announce(); setInterval(announce,5000);
}
