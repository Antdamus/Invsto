'use strict';
(()=>{
 if(window.top!==window)return;
 let context=null,running=false,busy=false,held=false,historyRead=false,sweep=0,lastSweep=0,lastInput=0,panel=null,box=null,latest='Capture stopped',seen=new Map();
 const parser=window.InvstoTikTokParser;
 const send=(type,extra={})=>chrome.runtime.sendMessage({type,event_id:context?.event_id,...extra});
 function captureFrame(){
  const videos=[...document.querySelectorAll('#live-stream-video-container video, .live-stream-video-container video,video')].filter(v=>v.readyState>=2&&v.videoWidth>=160&&v.videoHeight>=160&&v.getClientRects().length&&!v.ended);
  const v=videos.sort((a,b)=>b.videoWidth*b.videoHeight-a.videoWidth*a.videoHeight)[0];if(!v)throw Error('Play the TikTok live video preview, then try Screenshot again.');
  const scale=Math.min(1,1600/Math.max(v.videoWidth,v.videoHeight)),canvas=document.createElement('canvas');canvas.width=Math.round(v.videoWidth*scale);canvas.height=Math.round(v.videoHeight*scale);canvas.getContext('2d').drawImage(v,0,0,canvas.width,canvas.height);
  const dataUrl=canvas.toDataURL('image/jpeg',.9);if(dataUrl.length>4000000)throw Error('Frame is too large; try again.');
  return {dataUrl,width:canvas.width,height:canvas.height,capturedAt:new Date().toISOString()};
 }
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(m.type==='TIKTOK_LIVE_CONTEXT'){reply({event_id:parser.metadata(document,location.href)?.event_id});return;}
  if(m.type==='TIKTOK_CAPTURE_FRAME'){try{reply({ok:true,image:captureFrame()});}catch(e){reply({ok:false,error:e.name==='SecurityError'?'TikTok has not made this video frame available. Restart the preview and retry.':e.message});}return;}
 });
 function status(message,error=false){latest=message;if(box){box.querySelector('[data-tt-status]').textContent=message;panel.setCaptureStatus?.({state:error?'attention':running?'active':'waiting',label:running?'TikTok capture on':'TikTok capture stopped',detail:message});}}
 function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;return b;}
 function mount(){
  if(box)return;box=document.createElement('div');box.id='invsto-capture-helper';document.body.append(box);panel=window.InvstoBagLabelPanel.mount(box,{eventId:context.event_id});
  const start=button('Start TikTok capture',async()=>{start.disabled=true;try{const r=await send('TIKTOK_LIVE_START',{stream:context});if(!r?.ok)throw Error(r?.error||'Could not start capture.');running=true;seen.clear();historyRead=false;status('Choose the seller in Invsto. Captured sales will wait safely.');start.textContent='Capture running';}catch(e){status(e.message,true);}finally{start.disabled=false;}});
  const stop=button('Stop capture',async()=>{const r=await send('TIKTOK_LIVE_STOP');if(r?.ok){running=false;start.textContent='Start TikTok capture';status('Capture stopped. Saved bags remain available.');}});
  const still=button('Keep page still',()=>{held=!held;still.textContent=held?'Resume history reading':'Keep page still';status(held?'Reading visible sales only. History scrolling paused.':'Automatic history reading resumed.');});
  const open=button('Open TikTok receiver',async()=>{const r=await send('TIKTOK_LIVE_OPEN');if(!r?.ok)status(r?.error||'Start capture first.',true);});
  const p=document.createElement('p');p.dataset.ttStatus='';p.setAttribute('role','status');p.style.cssText='font-size:11px;white-space:normal';
  panel.settings.append(start,stop,still,open,p);status(latest);
  send('TIKTOK_LIVE_RESUME').then(r=>{if(r?.resume){running=true;start.textContent='Capture running';status('TikTok capture resumed.');}}).catch(()=>{});
 }
 for(const type of ['pointerdown','wheel','keydown'])document.addEventListener(type,e=>{if(e.isTrusted&&!e.target.closest?.('#invsto-capture-helper'))lastInput=Date.now();},{capture:true,passive:true});
 async function tick(){
  if(busy)return;busy=true;
  try{
   const current=parser.metadata(document,location.href);
   if(!current){if(box)status('Waiting for TikTok’s current LIVE room identity.',true);return;}
   if(context&&current.event_id!==context.event_id){running=false;status('TikTok changed shows. Refresh this tab before capturing the new show.',true);return;}
   context=current;mount();if(!running)return;
   const canMove=!held&&Date.now()-lastInput>15000&&!document.querySelector('[role="dialog"]')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
   let result=parser.parse(document);
   if(!result.list&&canMove){
    const auction=[...document.querySelectorAll('[role="tab"]')].find(e=>/^(Auction|LIVE auctions)/.test(e.textContent.trim()));
    if(auction&&auction.getAttribute('aria-selected')!=='true')auction.click();
    else [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Sold items')?.click();
    status('Opening TikTok sold auctions…');return;
   }
   const events=[];
   for(const e of result.events){const signature=JSON.stringify([e.key,e.title,e.payment_state,e.payment_label]);const previous=seen.get(e.key);if(!previous||previous.signature!==signature){events.push(e);seen.set(e.key,{signature,event:e});}}
   const health={ready:result.supported,observed_at:new Date().toISOString(),history_read:historyRead,rows_seen:seen.size,message:result.errors[0]||(historyRead?'Current sold history read; watching new sales':'Reading available sold history')};
   const delivered=await send('TIKTOK_LIVE_OBSERVE',{events,health});
   if(!delivered?.ok){for(const e of events)seen.delete(e.key);throw Error(delivered?.error||'Capture could not be saved.');}
   status((delivered.pending?`${delivered.pending} observations waiting · `:'')+(delivered.status||health.message)+(result.errors.length?' · '+result.errors[0]:''),!result.supported||delivered.pending>0);
   const list=result.list;if(list&&canMove){
    if(!historyRead||Date.now()-lastSweep>60000){
     if(list.scrollTop+list.clientHeight>=list.scrollHeight-3){sweep++;list.scrollTop=0;if(sweep>=2){historyRead=true;sweep=0;lastSweep=Date.now();}}
     else list.scrollTop=Math.min(list.scrollHeight,list.scrollTop+Math.max(140,list.clientHeight*.75));
    }else if(list.scrollTop>0)list.scrollTop=0;
   }
  }catch(e){status(e.message,true);}finally{busy=false;}
 }
 void tick();setInterval(tick,2000);
})();
