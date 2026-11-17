(function(){
 'use strict';
 if(window.top!==window||location.origin!=='https://seller-us.tiktok.com')return;
 let host,selected=null,capturing=false,preview;
 const orderNumber=()=>location.pathname==='/order/detail'?new URLSearchParams(location.search).get('order_no'):null;
 const skuIds=element=>[...new Set([...String(element?.innerText||'').matchAll(/SKU\s*ID\s*:\s*(\d{10,24})(?!\d)/gi)].map(m=>m[1]))];
 function receiptSku(element){
  for(let node=element;node&&node!==document.body;node=node.parentElement){const ids=skuIds(node);if(ids.length===1)return ids[0];if(ids.length>1)return null;}
  return null;
 }
 // Record the SKU belonging to the receipt actually clicked, not the first item on the order.
 document.addEventListener('click',event=>{
  const node=event.target.closest('button,span,div');
  if(node&&node.textContent.trim()==='Video receipt'){selected={order:orderNumber(),sku:receiptSku(node)};install();}
 },true);
 function current(){
  const order=orderNumber();if(!/^\d{10,24}$/.test(order||''))return null;
  const videos=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>40&&r.height>40&&v.getClientRects().length&&getComputedStyle(v).visibility!=='hidden';});
  if(videos.length!==1)return null;
  const video=videos[0],player=video.closest('[id^="auction-video-receipt-"]');
  if(!player||player.id!=='auction-video-receipt-'+order)return null;
  const ids=skuIds(document.body),sku=selected?.order===order?selected.sku:ids.length===1?ids[0]:null;
  return {order,sku,video};
 }
 function install(){
  const c=current();if(!c){host?.remove();host=null;return;}
  if(!host?.isConnected){
   host=document.createElement('div');host.id='og-tiktok-receipt-capture';host.style.cssText='position:fixed;right:24px;top:100px;z-index:2147483647;max-width:310px';
   const root=host.attachShadow({mode:'open'});
   root.innerHTML='<style>:host{font:14px system-ui;color:#f7f0df}.panel{background:#172b25;border:1px solid #c7ab70;border-radius:12px;padding:15px;box-shadow:0 8px 32px #0006}button{font:700 14px system-ui;padding:12px 16px;background:#e3bd77;color:#211b12;border:0;border-radius:8px;cursor:pointer;width:100%}button:disabled{opacity:.6;cursor:wait}p{font-size:12px;line-height:1.5;margin:9px 0 0;overflow-wrap:anywhere}</style><div class="panel"><button type="button">Capture item photo → OG</button><p id="target"></p><p id="status" role="status">Pause on the item you want to save.</p></div>';
   root.querySelector('button').onclick=()=>capture(false);
   const fallback=document.createElement('button');fallback.type='button';fallback.textContent='Capture from window';fallback.style.cssText='margin-top:10px;background:transparent;border:1px solid #c7ab70;color:#f7f0df';fallback.onclick=()=>capture(true);root.querySelector('.panel').append(fallback);
   document.body.append(host);
  }
  host.shadowRoot.querySelectorAll('button').forEach(button=>button.disabled=capturing||!c.sku);
  host.shadowRoot.getElementById('target').textContent=c.sku?`Order ${c.order} · SKU ${c.sku}`:'Close this video and reopen the correct item’s Video receipt to identify its SKU.';
 }
 function review(image,c){
  return new Promise(resolve=>{
   preview?.remove();preview=document.createElement('div');preview.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#000b;display:grid;place-items:center;padding:20px';
   const root=preview.attachShadow({mode:'open'});
   root.innerHTML='<style>:host{font:15px system-ui;color:#f7f0df}.card{background:#172b25;border:1px solid #c7ab70;border-radius:16px;padding:20px;max-width:520px;max-height:85vh;overflow:auto}h2{margin:0 0 8px;font-size:20px}p{line-height:1.5;font-size:13px;overflow-wrap:anywhere}img{display:block;max-width:100%;max-height:52vh;margin:12px auto;border-radius:8px}.actions{display:flex;gap:10px}button{font:600 14px system-ui;border:1px solid #c7ab70;border-radius:8px;padding:12px;cursor:pointer;flex:1;background:#e3bd77;color:#211b12}button:last-child{background:transparent;color:#f7f0df}</style><div class="card" role="dialog" aria-modal="true" aria-label="Review receipt photo"><h2>Review item photo</h2><p>Only this cropped photo will be saved. Window sharing has stopped.</p><img alt="Captured receipt item"><p id="identity"></p><div class="actions"><button type="button">Save photo to OG</button><button type="button">Cancel</button></div></div>';
   root.querySelector('img').src=image;root.getElementById('identity').textContent=`Order ${c.order} · SKU ${c.sku}`;
   const finish=value=>{preview?.remove();preview=null;resolve(value);};
   root.querySelectorAll('button')[0].onclick=()=>finish(true);root.querySelectorAll('button')[1].onclick=()=>finish(false);
   root.addEventListener('keydown',e=>{if(e.key==='Escape')finish(false);});document.documentElement.append(preview);root.querySelector('button').focus();
  });
 }
 async function capture(fromWindow){
  const c=current(),status=host?.shadowRoot.getElementById('status');if(!c?.sku||capturing)return;
  const overlays=[host,document.getElementById('og-tiktok-order-tools')].filter(Boolean),visibility=overlays.map(el=>el.style.visibility);
  capturing=true;install();
  try{
   c.video.pause();const time=c.video.currentTime;
   const valid=()=>{const now=current();return now?.video===c.video&&now.order===c.order&&now.sku===c.sku&&c.video.paused&&Math.abs(c.video.currentTime-time)<.1;};
   let image;
   if(fromWindow){
    status.textContent='Choose the Firefox window showing this receipt. You’ll review the cropped photo before saving.';
    image=await ogTikTokWindowCapture({video:c.video,valid,overlays});
    if(!await review(image,c)){status.textContent='Capture canceled. No photo was saved.';return;}
    if(!valid())throw Error('The receipt changed. Capture the current item again.');
   }
   overlays.forEach(el=>el.style.visibility='hidden');
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const r=c.video.getBoundingClientRect();
   if(!c.video.videoWidth||c.video.readyState<2)throw Error('Wait for the receipt video to load before capturing.');
   if(r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)throw Error('Keep the whole video visible, then capture again.');
   status.textContent='Capturing this frame for its OG order line…';
   const result=await chrome.runtime.sendMessage({type:'OG_TIKTOK_RECEIPT_CAPTURE',transferId:crypto.randomUUID(),orderNumber:c.order,skuId:c.sku,videoTime:time,viewport:{width:innerWidth,height:innerHeight},rect:{x:r.x,y:r.y,width:r.width,height:r.height},...(fromWindow?{captureMode:'window',image}:{})});
   if(!result?.ok)throw Error(result?.error||'Could not send the capture.');
   status.textContent='Sent to OG. You’ll return to the matching order line when the photo is saved.';
  }catch(e){status.textContent=e.message||'Reload the extension and TikTok, then try again.';}
  finally{overlays.forEach((el,i)=>el.style.visibility=visibility[i]);capturing=false;install();}
 }
 let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;install();},250);}).observe(document.documentElement,{childList:true,subtree:true});
 if(document.body)install();else document.addEventListener('DOMContentLoaded',install,{once:true});
})();
