'use strict';
(() => {
  const event_id=location.pathname.split('/')[4];
  if (!/^[\w-]{6,100}$/.test(event_id||'')) return;
  const tab = name => [...document.querySelectorAll('[role="tab"]')].find(el=>new RegExp('^'+name+'(?:\\s|\\(|$)','i').test(el.textContent.trim()));
  const disabled = el => !!el && (el.disabled || el.getAttribute('aria-disabled')==='true');
  const choose = el => {if(el && !disabled(el) && el.getAttribute('aria-selected')!=='true') el.click();};
  async function readStream() {
    for(let attempt=0;attempt<54 && (!tab('Event information')||!tab('Stream manager'));attempt++)await new Promise(resolve=>setTimeout(resolve,150));
    const info=tab('Event information'), manager=tab('Stream manager');
    if(!info || !manager) throw Error('Open the eBay event dashboard so capture can read its original date');
    // Do not navigate away from an open listing editor or unsaved event fields.
    if([...document.querySelectorAll('[role="dialog"],dialog[open]')].some(el=>el.getClientRects().length&&el.getAttribute('aria-hidden')!=='true') || document.querySelector('#invsto-listing-helper[open]') || window.InvstoListingPreparing) throw Error('Finish editing this event before starting capture');
    let result=InvstoLiveParser.streamMetadata(document);
    if(!result) {
      choose(info);
      for(let attempt=0;attempt<54 && !(result=InvstoLiveParser.streamMetadata(document));attempt++) await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!result) throw Error('The saved date and timezone could not be read. Open Event information and try capture again');
    return result;
  }
  const metadataTask=new URL(location.href).searchParams.get('invsto_metadata');
  if(metadataTask){
    // Read in a temporary background tab; never navigate the broadcasting tab.
    void readStream().then(stream=>chrome.runtime.sendMessage({type:'INVSTO_STREAM_METADATA',event_id,task:metadataTask,stream}),error=>chrome.runtime.sendMessage({type:'INVSTO_STREAM_METADATA',event_id,task:metadataTask,error:error.message}));
    return;
  }
  const box=document.createElement('div');box.id='invsto-capture-helper';
  box.style.cssText='position:fixed;bottom:12px;left:12px;z-index:2147483647;background:#18251f;color:white;border:1px solid #98ba8b;border-radius:12px;padding:12px;max-width:330px;font:14px/1.4 system-ui;box-shadow:0 3px 15px #0008';
  const button=document.createElement('button');button.textContent='Start Invsto capture';button.style.cssText='font:inherit;padding:8px 14px;border-radius:8px;cursor:pointer';
  const movement=document.createElement('button');movement.textContent='Keep page still';movement.style.cssText=button.style.cssText;
  const receiver=document.createElement('a');receiver.textContent='Open Invsto receiver';receiver.href='https://antdamus.github.io/Invsto/live-sales.html?capture=1&v=1.4.4';receiver.target='_blank';receiver.rel='noopener';receiver.style.cssText='display:block;color:#efd69b;margin-top:8px';
  const note=document.createElement('div');note.textContent='Automatic capture checks Activity and Sold. Use a separate tab for uninterrupted capture while editing.';
  box.append(button,movement,note,receiver);document.body.append(box);
  receiver.href+='&capture_event='+encodeURIComponent(event_id);
  let holdMovement=false,lastInteraction=0,eventInfoDirty=false;
  document.addEventListener('input',e=>{if(e.isTrusted && e.target.matches('input#startDate,input#timezone,input#title'))eventInfoDirty=true;},true);
  const usingPage=()=>{
    const focused=document.activeElement;
    return holdMovement||window.InvstoListingPreparing||document.querySelector('#invsto-listing-helper[open]')||
      [...document.querySelectorAll('[role="dialog"],dialog')].some(el=>el.getClientRects().length&&el.getAttribute('aria-hidden')!=='true')||
      (focused&&!box.contains(focused)&&focused.matches('input,textarea,select,[contenteditable=true],iframe'))||Date.now()-lastInteraction<15000;
  };
  for(const type of ['pointerdown','keydown','wheel','touchstart'])document.addEventListener(type,e=>{if(e.isTrusted&&!box.contains(e.target))lastInteraction=Date.now();},{capture:true,passive:true});
  movement.onclick=()=>{holdMovement=!holdMovement;lastInteraction=0;movement.textContent=holdMovement?'Resume automatic capture':'Keep page still';tick();};
  let active=false,busy=false,cache={},sent=new Map(),pageAt=0,stopping=false,latestNext=true,endReported=false,stream=null,readingStream=false,history=null,resumePending=true,checkingResume=false;
  chrome.runtime.onMessage?.addListener((message,sender,reply)=>{
    if(sender.id===chrome.runtime.id&&message?.type==='INVSTO_CAPTURE_STATUS')reply({ok:message.event_id===event_id&&active});
    if(sender.id===chrome.runtime.id&&message?.type==='INVSTO_STOP_CAPTURE'&&message.event_id===event_id){active=false;resumePending=false;stopping=false;endReported=true;button.textContent='Start Invsto capture';note.textContent='This Invsto show is closed. Capture will not restart it.';reply({ok:true});}
  });
  const sweepPositions=new WeakMap();
  let diagnostics=null,diagnosticsAt=0;
  let lastClock=null,clockChangedAt=0,clockWasAdvancing=false;
  const stopKey='invsto-capture-stopped:'+event_id;
  const stoppedHere=()=>{try{return sessionStorage.getItem(stopKey)==='1';}catch{return false;}};
  function activate(metadata){
    try{sessionStorage.removeItem(stopKey);}catch{}
    stream=metadata;history=InvstoLiveParser.createHistoryTracker(crypto.randomUUID());
    const url=new URL(receiver.href);url.searchParams.set('stream',JSON.stringify(stream));receiver.href=url.href;
    active=true;resumePending=false;sent.clear();stopping=false;button.textContent='Stop Invsto capture';tick();
  }
  async function restoreCapture(){
    if(!resumePending||active||readingStream||checkingResume)return;checkingResume=true;
    try{
      if(stoppedHere()){resumePending=false;await chrome.runtime.sendMessage({type:'INVSTO_STOP_CAPTURE',event_id});return;}
      const result=await chrome.runtime.sendMessage({type:'INVSTO_RESUME_CAPTURE',event_id});
      if(!resumePending||active||readingStream)return;
      if(result?.resume&&result.stream){activate(result.stream);note.textContent='Capture resumed for the same show. Sellers are unchanged.';}
      else if(result?.retry){note.textContent=result.error||'Reconnecting saved capture. Keep the Invsto receiver signed in.';}
      else{resumePending=false;if(result?.closed)note.textContent='This Invsto show is closed. Capture will not restart it.';else if(result?.error)note.textContent=result.error;}
    }catch{note.textContent='Reconnecting saved capture…';}
    finally{checkingResume=false;}
  }
  button.onclick=async()=>{
    if(readingStream)return;
    resumePending=false;
    if(!active){
      readingStream=true;button.disabled=true;note.textContent='Reading the original show date from eBay…';
      try {
        if(eventInfoDirty)throw Error('Save your Event information changes and reload eBay before starting capture');
        if([...document.querySelectorAll('[role="dialog"],dialog[open]')].some(el=>el.getClientRects().length&&el.getAttribute('aria-hidden')!=='true') || document.querySelector('#invsto-listing-helper[open]') || window.InvstoListingPreparing)throw Error('Finish editing this event before starting capture');
        const result=await chrome.runtime.sendMessage({type:'INVSTO_READ_STREAM',event_id});
        if(!result?.ok || !result.stream)throw Error(result?.error||'Could not read the saved event date. Try capture again');
        stream=result.stream;
        const url=new URL(receiver.href);url.searchParams.set('stream',JSON.stringify(stream));receiver.href=url.href;
      }catch(error){note.textContent=error.message;return;}
      finally{readingStream=false;button.disabled=false;}
    }
    if(!active){
      activate(stream);
      try{const result=await chrome.runtime.sendMessage({type:'INVSTO_START_CAPTURE',event_id,stream});if(result?.closed){active=false;stopping=false;endReported=true;button.textContent='Start Invsto capture';note.textContent=result.error;return;}if(!result?.ok)throw Error(result?.error||'Could not open Invsto');}
      catch(error){note.textContent=error.message+'. Use Open Invsto receiver below to choose sellers.';}
    }else{
      try{sessionStorage.setItem(stopKey,'1');}catch{}
      active=false;stopping=true;button.textContent='Start Invsto capture';
      try{await chrome.runtime.sendMessage({type:'INVSTO_STOP_CAPTURE',event_id});}catch(error){note.textContent='Could not save Stop. Try again before refreshing: '+error.message;}
      tick();
    }
  };
  async function tick() {
    if(busy || readingStream || (!active&&!stopping&&(endReported||!InvstoLiveParser.hasEnded(document)))) return;busy=true;
    try {
      const working=!!usingPage();
      if (active && !working) {
        choose(tab('Activity'));choose(disabled(tab('Sold'))?tab('All'):tab('Sold'));
        const all=[...document.querySelectorAll('#activity-panel [aria-label="Filter activity"] button')].find(b=>b.textContent.trim()==='All');
        if(all && all.getAttribute('aria-pressed')!=='true') all.click();
      }
      const parsed=InvstoLiveParser.parse(document,cache);cache=parsed.cache;
      const activitySelected=tab('Activity')?.getAttribute('aria-selected')==='true';
      const soldSelected=tab('Sold')?.getAttribute('aria-selected')==='true';
      // eBay disables Sold before the first sale. Watch Activity and the All
      // listings in that state, then select Sold as soon as it becomes available.
      const waitingForSales=disabled(tab('Sold')) && tab('All')?.getAttribute('aria-selected')==='true';
      const listingsReady=soldSelected || waitingForSales;
      if(parsed.elapsed!==null && parsed.elapsed!==lastClock){clockWasAdvancing=lastClock!==null;lastClock=parsed.elapsed;clockChangedAt=Date.now();}
      const advancing=clockWasAdvancing && Date.now()-clockChangedAt<20000;
      const clockReady=document.visibilityState==='visible' || advancing;
      const ready=active && !working && !parsed.broadcastEnded && parsed.supported && parsed.panelPresent && activitySelected && listingsReady && navigator.onLine && clockReady;
      const filtered=[...document.querySelectorAll('#activity-panel [aria-label="Filter activity"] button')].some(b=>b.textContent.trim()==='All'&&b.getAttribute('aria-pressed')==='true');
      const canRead=active&&!working&&navigator.onLine&&parsed.supported&&parsed.panelPresent&&activitySelected&&listingsReady&&filtered&&!document.querySelector('[aria-busy="true"],[role="progressbar"]');
      const recovery=history?.observe(document,parsed,{canRead,reason:!active?'stopped':working?'working':!navigator.onLine?'offline':'waiting'});
      if(parsed.broadcastEnded&&(!diagnostics||Date.now()-diagnosticsAt>=15000)){
        try{diagnostics={...InvstoLiveParser.captureDiagnostics(document),observed_at:new Date().toISOString()};}catch{diagnostics=null;}
        diagnosticsAt=Date.now();
      }
      const recoveryText=recovery?.phase==='read'?'Available history read. Compare the recovered sales with eBay.':recovery?.phase==='needs_review'?'History needs review. Check the recovery details in Invsto.':recovery?.phase==='paused'?'History reading paused. Resume capture to finish.':'Reading finished-show history…';
      const reason=parsed.broadcastEnded?recoveryText:!active?'Capture stopped':working?'Page stays still while you work. Close open panels and leave fields to resume full capture, or use a separate capture tab.':!navigator.onLine?'Capture computer is offline':!parsed.supported?'Stream Manager layout is not recognized; verify payment manually':!activitySelected||!parsed.panelPresent?'Waiting for the Activity panel to load':!listingsReady?'Waiting for the Sold or All listings panel':!clockReady?'Bring Stream Manager forward; its clock must keep updating':waitingForSales?'Watching Activity; waiting for the first sale':'Reading Activity and Sold items';
      const events=[];
      if(active) for(const event of parsed.events) {
        const signature=JSON.stringify([event.listing_id,event.kind,event.buyer,event.amount]);
        if(sent.get(event.key)!==signature) {if(events.length<100)events.push(event);}
      }
      const result=await chrome.runtime.sendMessage({type:'INVSTO_CAPTURE',event_id,events,health:{observed_at:new Date().toISOString(),ready,running:active,mode:working?'working':'automatic',broadcast_ended:parsed.broadcastEnded,message:reason,...(stream?{stream}:{}),...(recovery?{recovery}:{}),...(diagnostics?{diagnostics}:{})}});
      if(result?.closed){active=false;resumePending=false;stopping=false;endReported=true;button.textContent='Start Invsto capture';note.textContent='This Invsto show is closed. Capture stopped.';return;}
      if(result?.ok&&parsed.broadcastEnded)endReported=true;
      if(!active&&result?.ok)stopping=false;
      if(result?.ok) for(const e of events) sent.set(e.key,JSON.stringify([e.listing_id,e.kind,e.buyer,e.amount]));
      const statusText=reason+' · '+(result?.status||result?.error||'Waiting for receiver');
      if(note.textContent!==statusText)note.textContent=statusText;
      // The Activity feed is virtualized. Sweep it so failures below the fold are read too.
      if(active && !parsed.broadcastEnded && !working && parsed.supported && parsed.panelPresent && activitySelected && listingsReady && Date.now()-pageAt>1500) {
        const scrollers=new Set(Object.values(InvstoLiveParser.historyContainers(document)));
        for(const scroller of scrollers) if(scroller && scroller.scrollHeight>scroller.clientHeight) {
          const bottom=scroller.scrollHeight-scroller.clientHeight;
          if(latestNext)scroller.scrollTop=bottom;
          else {const at=sweepPositions.get(scroller)||0;scroller.scrollTop=Math.min(at,bottom);sweepPositions.set(scroller,at>=bottom?0:at+scroller.clientHeight*0.75);}
        }
        latestNext=!latestNext;pageAt=Date.now();
      }
    } catch(error) {note.textContent='Not connected: '+error.message;}
    finally {busy=false;}
  }
  setInterval(tick,1200);
  void restoreCapture();setInterval(restoreCapture,10000);
  let timer;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>active&&tick(),250);}).observe(document.querySelector('#activity-panel')||document.body,{childList:true,subtree:true,characterData:true});
})();
