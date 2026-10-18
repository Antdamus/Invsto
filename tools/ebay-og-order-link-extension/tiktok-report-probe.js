/* TikTok MAIN-world CSV capture, armed only for the user's selected report download. */
(() => {
 'use strict';
 if(window.__ogTikTokReportProbe)return;window.__ogTikTokReportProbe=true;
 const MAX=10*1024*1024;let active;
 const alive=t=>t&&active===t&&Date.now()<t.until;
 const post=(type,t,payload={})=>{if(alive(t))window.postMessage({type,transferId:t.id,...payload},location.origin);};
 function report(blob,t){
  if(!alive(t)||!(blob instanceof Blob)||blob.size>MAX)return;
  void blob.text().then(text=>{if(alive(t)&&/^[\uFEFF\s]*"?Order ID"?\s*,/.test(text)&&text.slice(0,12000).includes('SKU ID'))post('OG_TIKTOK_REPORT_CAPTURED',t,{text});}).catch(()=>{});
 }
 function url(value,t){
  if(!alive(t)||typeof value!=='string')return;
  try{const u=new URL(value,location.href);if(u.protocol!=='https:'||t.urls.has(u.href))return;
   if(u.origin!==location.origin&&!/(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|ibytedtos\.com)$/.test(u.hostname))return;
   t.urls.add(u.href);post('OG_TIKTOK_REPORT_URL',t,{url:u.href});
  }catch{}
 }
 function links(value,t,depth=0){if(depth>7||!alive(t))return;if(typeof value==='string'&&/^https:\/\//.test(value))url(value,t);else if(value&&typeof value==='object')for(const child of Object.values(value).slice(0,100))links(child,t,depth+1);}
 const downloadApi=value=>{try{return new URL(value,location.href).pathname==='/api/fulfillment/na/order/download';}catch{return false;}};
 window.addEventListener('message',e=>{if(e.source!==window||e.origin!==location.origin)return;
  if(e.data?.type==='OG_TIKTOK_REPORT_ARM'&&/^[a-f0-9-]{36}$/i.test(e.data.transferId)){active={id:e.data.transferId,until:Date.now()+60000,urls:new Set()};post('OG_TIKTOK_REPORT_ARMED',active);}
  if(e.data?.type==='OG_TIKTOK_REPORT_DISARM'&&e.data.transferId===active?.id)active=null;
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
 const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(...args){if(alive(active)&&!this.href.startsWith('blob:'))url(this.href,active);return click.apply(this,args);};
 const popup=window.open;window.open=function(value,...args){url(value,active);return popup.call(this,value,...args);};
})();
