// Seller Hub creates a download in response to a report link. Only listen for
// the explicitly requested month, return only validated Claim rows, then disarm.
(()=>{
 if(location.origin!=='https://www.ebay.com'||location.pathname!=='/mes/transaction-reports')return;
 let active=null;
 const live=()=>active&&Date.now()<active.until?active:null;
 window.addEventListener('message',e=>{
  if(e.origin!==location.origin||e.source!==window||e.data?.type!=='INVSTO_ARM_CLAIM_REPORT'||!/^\d{4}-\d{2}$/.test(e.data.month))return;
  active={month:e.data.month,nonce:e.data.nonce,until:Date.now()+25000};
 });
 async function read(blob,t){
  if(!t||active!==t||!(blob instanceof Blob)||!blob.size||blob.size>25*1024*1024)return;
  try{
   const head=await blob.slice(0,5000).text();if(!/Transaction creation date|Start date/i.test(head))return;
   const entries=window.WeeklyEbayClaims.parseExport(await blob.text(),t.month,true);
   if(active!==t||!live())return;
   active=null;window.postMessage({type:'INVSTO_CLAIM_ROWS',nonce:t.nonce,month:t.month,entries},location.origin);
  }catch{/* Wrong seller, date range or transaction type: never accept a partial result. */}
 }
 const create=URL.createObjectURL;
 URL.createObjectURL=function(blob){const u=create.call(this,blob);const t=live();if(t)read(blob,t);return u;};
 const original=window.fetch;
 window.fetch=async function(...args){
  const r=await original.apply(this,args);const t=live();
  if(t&&/csv|octet-stream/i.test(r.headers.get('content-type')||''))r.clone().blob().then(b=>read(b,t)).catch(()=>{});
  return r;
 };
 const click=HTMLAnchorElement.prototype.click;
 function fileURL(value){
  if(typeof value!=='string')return false;
  try{const u=new URL(value,location.href);return u.protocol==='https:'&&(u.hostname==='ebay.com'||u.hostname.endsWith('.ebay.com'))&&/download|\.csv(?:[?#]|$)/i.test(u.pathname+u.search);}catch{return false;}
 }
 HTMLAnchorElement.prototype.click=function(...args){
  const t=live();if(t&&this.href.startsWith('blob:'+location.origin+'/')){original(this.href).then(r=>r.blob()).then(b=>read(b,t)).catch(()=>{});return;}
  if(t&&fileURL(this.href)){original(this.href,{credentials:'include'}).then(r=>r.ok?r.blob():null).then(b=>read(b,t)).catch(()=>{});return;}
  return click.apply(this,args);
 };
 const open=window.open;window.open=function(value,...args){const t=live();if(t&&fileURL(value)){original(value,{credentials:'include'}).then(r=>r.ok?r.blob():null).then(b=>read(b,t)).catch(()=>{});return null;}return open.call(this,value,...args);};
})();
