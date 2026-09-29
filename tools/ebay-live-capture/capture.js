'use strict';
(() => {
  const event_id=location.pathname.split('/')[4];
  if (!/^[\w-]{6,100}$/.test(event_id||'')) return;
  const box=document.createElement('div');box.id='invsto-capture-helper';
  box.style.cssText='position:fixed;bottom:12px;left:12px;z-index:2147483647;background:#18251f;color:white;border:1px solid #98ba8b;border-radius:12px;padding:12px;max-width:330px;font:14px/1.4 system-ui;box-shadow:0 3px 15px #0008';
  const button=document.createElement('button');button.textContent='Start Invsto capture';button.style.cssText='font:inherit;padding:8px 14px;border-radius:8px;cursor:pointer';
  const movement=document.createElement('button');movement.textContent='Keep page still';movement.style.cssText=button.style.cssText;
  const receiver=document.createElement('a');receiver.textContent='Open Invsto receiver';receiver.href='https://antdamus.github.io/Invsto/live-sales.html?capture=1&v=1.1.2';receiver.target='_blank';receiver.rel='noopener';receiver.style.cssText='display:block;color:#efd69b;margin-top:8px';
  const note=document.createElement('div');note.textContent='Automatic capture checks Activity and Sold. Use a separate tab for uninterrupted capture while editing.';
  box.append(button,movement,note,receiver);document.body.append(box);
  receiver.href+='&listing_event='+encodeURIComponent(event_id);
  let holdMovement=false,lastInteraction=0;
  const usingPage=()=>{
    const focused=document.activeElement;
    return holdMovement||window.InvstoListingPreparing||document.querySelector('#invsto-listing-helper[open]')||
      [...document.querySelectorAll('[role="dialog"],dialog')].some(el=>el.getClientRects().length&&el.getAttribute('aria-hidden')!=='true')||
      (focused&&!box.contains(focused)&&focused.matches('input,textarea,select,[contenteditable=true],iframe'))||Date.now()-lastInteraction<15000;
  };
  for(const type of ['pointerdown','keydown','wheel','touchstart'])document.addEventListener(type,e=>{if(e.isTrusted&&!box.contains(e.target))lastInteraction=Date.now();},{capture:true,passive:true});
  movement.onclick=()=>{holdMovement=!holdMovement;lastInteraction=0;movement.textContent=holdMovement?'Resume automatic capture':'Keep page still';tick();};
  let active=false,busy=false,cache={},sent=new Map(),pageAt=0,stopping=false,latestNext=true,endReported=false;
  const sweepPositions=new WeakMap();
  let lastClock=null,clockChangedAt=0,clockWasAdvancing=false;
  const tab = name => [...document.querySelectorAll('[role="tab"]')].find(el=>new RegExp('^'+name+'(?:\\s|\\(|$)','i').test(el.textContent.trim()));
  const disabled = el => !!el && (el.disabled || el.getAttribute('aria-disabled')==='true');
  const choose = el => {if(el && !disabled(el) && el.getAttribute('aria-selected')!=='true') el.click();};
  button.onclick=()=>{active=!active;button.textContent=active?'Stop Invsto capture':'Start Invsto capture';sent.clear();stopping=!active;tick();};
  async function tick() {
    if(busy || (!active&&!stopping&&(endReported||!InvstoLiveParser.hasEnded(document)))) return;busy=true;
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
      const reason=parsed.broadcastEnded?'Broadcast ended. Finish the bag review in Invsto.':!active?'Capture stopped':working?'Page stays still while you work. Close open panels and leave fields to resume full capture, or use a separate capture tab.':!navigator.onLine?'Capture computer is offline':!parsed.supported?'Stream Manager layout is not recognized; verify payment manually':!activitySelected||!parsed.panelPresent?'Waiting for the Activity panel to load':!listingsReady?'Waiting for the Sold or All listings panel':!clockReady?'Bring Stream Manager forward; its clock must keep updating':waitingForSales?'Watching Activity; waiting for the first sale':'Reading Activity and Sold items';
      const events=[];
      if(active) for(const event of parsed.events) {
        const signature=JSON.stringify([event.listing_id,event.kind,event.buyer,event.amount]);
        if(sent.get(event.key)!==signature) {if(events.length<100)events.push(event);}
      }
      const result=await chrome.runtime.sendMessage({type:'INVSTO_CAPTURE',event_id,events,health:{observed_at:new Date().toISOString(),ready,running:active,mode:working?'working':'automatic',broadcast_ended:parsed.broadcastEnded,message:reason}});
      if(result?.ok&&parsed.broadcastEnded)endReported=true;
      if(!active&&result?.ok)stopping=false;
      if(result?.ok) for(const e of events) sent.set(e.key,JSON.stringify([e.listing_id,e.kind,e.buyer,e.amount]));
      const statusText=reason+' · '+(result?.status||result?.error||'Waiting for receiver');
      if(note.textContent!==statusText)note.textContent=statusText;
      // The Activity feed is virtualized. Sweep it so failures below the fold are read too.
      if(active && !working && parsed.supported && parsed.panelPresent && activitySelected && listingsReady && Date.now()-pageAt>1500) {
        const scrollers=new Set([document.querySelector('#activity-panel [class*="_list_"]')]);
        let parent=document.querySelector('[data-testid="listing-tile"]')?.parentElement;
        while(parent && parent!==document.body) { if(parent.className?.includes('_list_') && parent.scrollHeight>parent.clientHeight){scrollers.add(parent);break;}parent=parent.parentElement; }
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
  let timer;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>active&&tick(),250);}).observe(document.querySelector('#activity-panel')||document.body,{childList:true,subtree:true,characterData:true});
})();
