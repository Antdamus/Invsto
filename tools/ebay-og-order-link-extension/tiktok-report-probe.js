/* TikTok MAIN-world CSV capture, armed only for the user's selected report download. */
(() => {
 'use strict';
 if(window.__ogTikTokReportProbe)return;window.__ogTikTokReportProbe=true;
 const MAX=10*1024*1024;let active;
 const alive=t=>t&&active===t&&Date.now()<t.until;
 const post=(type,t,payload={})=>{if(alive(t))window.postMessage({type,transferId:t.id,...payload},location.origin);};
 const csv=text=>/^[\uFEFF\s]*"?Order ID"?\s*,/.test(text)&&text.slice(0,12000).includes('SKU ID');
 function report(blob,t){
  if(!alive(t)||!(blob instanceof Blob)||blob.size>MAX)return;
  void blob.text().then(text=>{if(csv(text))post('OG_TIKTOK_REPORT_CAPTURED',t,{text});}).catch(()=>{});
 }
 async function download(u,t){
  const timer=setTimeout(()=>t.controller.abort(),30000);
  try{
   // TikTok's use-disposable link can be consumed once. Read it in the seller
   // session, then save and hand off these same bytes instead of racing a navigation.
   const r=await fetchOriginal.call(window,u.href,{credentials:u.origin===location.origin?'include':'omit',signal:t.controller.signal});
   if(!r.ok||r.status===206)throw Error('TikTok CSV download failed (HTTP '+r.status+'). Try Export all again for a fresh download link.');
   if(Number(r.headers.get('content-length'))>MAX)throw Error('Choose a CSV smaller than 10 MB.');
   const reader=r.body.getReader(),parts=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX){await reader.cancel();throw Error('Choose a CSV smaller than 10 MB.');}parts.push(value);}}finally{reader.releaseLock();}
   const blob=new Blob(parts,{type:'text/csv;charset=utf-8'}),text=await blob.text();
   if(!csv(text))throw Error('TikTok did not return an orders CSV. Try Export all again.');
   if(!alive(t))return;
   const href=create.call(URL,blob),a=document.createElement('a');a.href=href;a.download=t.filename;document.body.appendChild(a);click.call(a);a.remove();setTimeout(()=>URL.revokeObjectURL(href),60000);
   post('OG_TIKTOK_REPORT_CAPTURED',t,{text});
  }catch(e){if(alive(t))post('OG_TIKTOK_REPORT_ERROR',t,{error:e.name==='AbortError'?'TikTok CSV download timed out. Try Export all again.':e.message});}finally{clearTimeout(timer);}
 }
 function url(value,t,fromApi=false){
  if(!alive(t)||typeof value!=='string')return false;
  try{const u=new URL(value,location.href);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))return false;
   const seller=u.origin===location.origin&&/^\/easesafe\/oec_trade_order_export\/object\//.test(u.pathname);
   const cdn=/(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|ibytedtos\.com)$/.test(u.hostname)&&(fromApi||t.urls.has(u.href));
   if(!seller&&!cdn)return false;
   if(!t.urls.has(u.href)){t.urls.add(u.href);void download(u,t);}return true;
  }catch{return false;}
 }
 function links(value,t,depth=0){if(depth>7||!alive(t))return;if(typeof value==='string'&&/^https:\/\//.test(value))url(value,t,true);else if(value&&typeof value==='object')for(const child of Object.values(value).slice(0,100))links(child,t,depth+1);}
 const downloadApi=value=>{try{return new URL(value,location.href).pathname==='/api/fulfillment/na/order/download';}catch{return false;}};
 window.addEventListener('message',e=>{if(e.source!==window||e.origin!==location.origin)return;
  if(e.data?.type==='OG_TIKTOK_REPORT_ARM'&&/^[a-f0-9-]{36}$/i.test(e.data.transferId)){active?.controller.abort();active={id:e.data.transferId,until:Date.now()+60000,urls:new Set(),controller:new AbortController(),filename:/^All order-.*\.csv$/i.test(e.data.filename||'')?e.data.filename:'TikTok-orders.csv'};post('OG_TIKTOK_REPORT_ARMED',active);}
  if(e.data?.type==='OG_TIKTOK_REPORT_DISARM'&&e.data.transferId===active?.id){active.controller.abort();active=null;}
 });
 const fetchOriginal=window.fetch;
 window.fetch=async function(...args){const t=active,r=await fetchOriginal.apply(this,args);if(alive(t)&&r.ok){const copy=r.clone(),request=String(args[0]?.url||args[0]);
  if(downloadApi(request))void copy.json().then(v=>links(v,t)).catch(()=>{});
  else if(/csv|octet-stream/i.test(r.headers.get('content-type')||'')&&Number(r.headers.get('content-length'))<=MAX)void copy.blob().then(b=>report(b,t)).catch(()=>{});
 }return r;};
 const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(method,value,...rest){this.__ogReportUrl=String(value);return open.call(this,method,value,...rest);};
 XMLHttpRequest.prototype.send=function(...args){const t=active;this.addEventListener('load',()=>{if(!alive(t)||this.status<200||this.status>=300)return;try{
  if(this.response instanceof Blob)report(this.response,t);else if(this.response instanceof ArrayBuffer)report(new Blob([this.response]),t);
  else if(downloadApi(this.responseURL||this.__ogReportUrl))links(this.responseType==='json'?this.response:JSON.parse(this.responseText),t);
  else if(typeof this.responseText==='string'&&this.responseText.length<=MAX)report(new Blob([this.responseText]),t);
 }catch{}},{once:true});return send.apply(this,args);};
 const create=URL.createObjectURL;URL.createObjectURL=function(blob){report(blob,active);return create.call(this,blob);};
 const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(...args){if(url(this.href,active))return;return click.apply(this,args);};
 const popup=window.open;window.open=function(value,...args){if(url(value,active))return null;return popup.call(this,value,...args);};
})();
