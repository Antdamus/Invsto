(function(){
 'use strict';
 if(window.top!==window||location.origin!=='https://www.whatnot.com')return;
 let host,busy=false,openedFor='';
 function context(){
  if(!/^\/dashboard\/orders\/[A-Za-z0-9-]+$/.test(location.pathname))return null;
  const params=new URLSearchParams(location.hash.slice(1)),item=params.get('invsto-receipt'),order=params.get('order');
  if(!/^\d{1,19}$/.test(item||'')||!/^\d{1,19}$/.test(order||''))return null;
  const close=document.querySelector('[aria-label="Close order details"]');
  if(!close||!close.parentElement?.innerText?.match(new RegExp('(?:^|\\s)#'+order+'(?:\\s|$)')))return null;
  // Whatnot's receipt uses an open-shadow HLS-VIDEO custom element.
  const candidates=[...document.querySelectorAll('video'),...[...document.querySelectorAll('hls-video')].map(p=>p.shadowRoot?.querySelector('video')).filter(Boolean)];
  const videos=[...new Set(candidates)].filter(v=>{const r=v.getBoundingClientRect();return r.width>40&&r.height>40&&v.getClientRects().length&&getComputedStyle(v).visibility!=='hidden';});
  return {order,item,video:videos.length===1?videos[0]:null};
 }
 function install(){
  const c=context();if(!c){host?.remove();host=null;return;}
  if(!c.video&&openedFor!==location.href){
   const button=[...document.querySelectorAll('button,[role="button"]')].find(b=>b.textContent.trim()==='View Receipt');
   if(button){openedFor=location.href;button.click();}
  }
  if(!c.video){host?.remove();host=null;return;}
  if(!host?.isConnected){
   host=document.createElement('div');host.id='og-whatnot-capture';host.style.cssText='position:fixed;left:20px;bottom:20px;z-index:2147483647;width:290px';
   const root=host.attachShadow({mode:'open'});root.innerHTML='<style>:host{font:14px system-ui;color:#f5f0df}.panel{background:#172b25;border:1px solid #c7ab70;border-radius:15px;padding:16px;box-shadow:0 8px 32px #0006}button{width:100%;font:700 14px system-ui;padding:12px;background:#ecd291;color:#17231b;border:0;border-radius:9px;cursor:pointer}button:disabled{opacity:.5}p{font-size:12px;line-height:1.5;margin:10px 0 0}</style><div class="panel"><button>Capture item photo → Invsto</button><p id="target"></p><p id="status" role="status">Pause on the item. Keep Invsto’s Whatnot orders page open.</p></div>';
   root.querySelector('button').onclick=capture;document.body.append(host);
  }
  const target=`Order ${c.order} · Item ${c.item}`;if(host.shadowRoot.getElementById('target').textContent!==target)host.shadowRoot.getElementById('target').textContent=target;host.shadowRoot.querySelector('button').disabled=busy;
 }
 async function capture(){
  const c=context();if(!c?.video||busy)return;const status=host.shadowRoot.getElementById('status');busy=true;
  try{
   c.video.pause();host.style.visibility='hidden';await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const r=c.video.getBoundingClientRect();if(c.video.readyState<2||!c.video.videoWidth)throw Error('Wait for the video to load.');
   if(r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight)throw Error('Keep the entire receipt video visible.');
   const result=await chrome.runtime.sendMessage({type:'OG_WHATNOT_RECEIPT_CAPTURE',transferId:crypto.randomUUID(),orderNumber:c.order,itemId:c.item,videoTime:c.video.currentTime,viewport:{width:innerWidth,height:innerHeight},rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
   if(!result?.ok)throw Error(result?.error||'Could not capture this frame.');status.textContent='Sent to Invsto. It will confirm when the photo is saved.';
  }catch(e){status.textContent=e.message||'Reload the extension and try again.';}finally{host.style.visibility='';busy=false;install();}
 }
 let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;install();},250);}).observe(document.documentElement,{childList:true,subtree:true});
 // Shadow-player initialization does not always mutate the light DOM.
 setInterval(()=>{if(!document.hidden)install();},1000);
 window.addEventListener('hashchange',install);install();
})();
