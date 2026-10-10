/* eBay's submitted response is separate from our internal notes and buyer chat. */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const nice=v=>String(v||'').toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
 const date=v=>v&&!Number.isNaN(Date.parse(v))?new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'';
 function badge(c){
  if(c?.source_lane!=='payment_dispute'||['closed','cancelled'].includes(c.status))return null;
  const d=c.raw_payload?.ebayDetail,valid=d?.paymentDisputeId&&String(d.paymentDisputeId)===String(c.ebay_return_id);
  const status=String(c.ebay_status||(valid?d.paymentDisputeStatus:'')||'').toUpperCase();
  // A new eBay action always supersedes a previously submitted response.
  if(status==='ACTION_NEEDED')return {kind:'action',label:'Response required'};
  if(status==='OPEN'&&(c.seller_response||(valid?d.sellerResponse:''))==='SELLER_CONTEST')return {kind:'waiting',label:'Response submitted · awaiting outcome'};
  return null;
 }
 function response(c){
  const d=c?.raw_payload?.ebayDetail;
  if(c?.source_lane!=='payment_dispute'||!d?.paymentDisputeId||String(d.paymentDisputeId)!==String(c.ebay_return_id))return null;
  const files=[],tracking=[],seen=new Set();
  for(const e of Array.isArray(d.evidence)?d.evidence:[]){
   for(const f of Array.isArray(e.files)?e.files:[]){const key=JSON.stringify([e.evidenceId,f.fileId]);if(!e.evidenceId||!f.fileId||seen.has(key))continue;seen.add(key);files.push({...f,evidenceId:e.evidenceId,evidenceType:e.evidenceType,providedDate:e.providedDate});}
   for(const t of Array.isArray(e.shipmentTracking)?e.shipmentTracking:[])tracking.push(t);
  }
  const decision=typeof d.sellerResponse==='string'?d.sellerResponse:'',contested=decision==='SELLER_CONTEST';
  return {decision,contested,waiting:badge(c)?.kind==='waiting',note:typeof d.note==='string'?d.note:'',files,tracking};
 }
 function section(c){
  const r=response(c);if(!r)return '';
  return `<section class="issue-dispute-response" id="issue-dispute-response"><div class="issue-response-heading"><div><small>EBAY PAYMENT DISPUTE</small><h3>${r.decision?'Submitted response':'Response & supporting documents'}</h3></div>${r.decision?`<span class="issue-tag">${esc(r.contested?'Challenged on eBay':nice(r.decision))}</span>`:''}</div>
   ${r.waiting?'<p class="issue-response-state">Response submitted · awaiting outcome</p>':r.decision?'<p class="issue-subtitle">Your response is recorded on eBay. The current case status is shown above.</p>':'<p class="issue-subtitle">eBay has not returned a submitted response. Saved evidence alone does not confirm submission.</p>'}
   ${r.note?`<div class="issue-response-note"><small>${r.contested?'Why you challenged this dispute':'Your response to eBay'}</small><p>${esc(r.note)}</p></div>`:r.decision?'<p class="issue-subtitle">eBay did not include the response text.</p>':''}
   <h4>Supporting documents <span>${r.files.length}</span></h4>${r.files.length?`<div class="issue-response-files">${r.files.map((f,i)=>`<article class="issue-response-file"><div data-dispute-preview="${i}" class="issue-dispute-preview"><span role="status">Loading document…</span></div><div class="issue-response-caption"><strong>${esc(f.name||'Supporting document')}</strong><span>${esc(nice(f.evidenceType))}</span>${date(f.uploadedDate||f.providedDate)?`<small>Uploaded ${esc(date(f.uploadedDate||f.providedDate))}</small>`:''}</div></article>`).join('')}</div><p class="issue-subtitle issue-response-private">Documents are retrieved from eBay and saved privately in Invsto.</p>`:'<p class="issue-subtitle">No supporting documents were included in eBay’s latest response.</p>'}
   ${r.tracking.length?`<h4>Submitted tracking</h4>${r.tracking.map(t=>`<p class="issue-subtitle">${esc(t.shippingCarrierCode)} · ${esc(t.trackingNumber)}</p>`).join('')}`:''}</section>`;
 }
 async function hydrate({c,db,target}){
  const r=response(c);if(!r||!target)return;
  async function load(index){
   const f=r.files[index],panel=target.querySelector(`[data-dispute-preview="${index}"]`);if(!panel||panel.dataset.busy==='true')return;panel.dataset.busy='true';panel.innerHTML='<span role="status">Loading document…</span>';
   try{
    const result=await db.functions.invoke('ebay-return-sync',{body:{action:'dispute_evidence',caseId:c.id,evidenceId:f.evidenceId,fileId:f.fileId}});
    if(result.error||result.data?.error){let message=result.data?.error;try{message||=(await result.error?.context?.clone().json())?.error;}catch{}throw Error(message||'Document could not load. Retry or open this case on eBay.');}
    const {url,mime_type}=result.data||{};if(!url||new URL(url,location.href).protocol!=='https:')throw Error('Document link is unavailable. Please retry.');
    if(!target.isConnected)return;
    panel.innerHTML=`<a href="${esc(url)}" target="_blank" rel="noopener" aria-label="Open ${esc(f.name||'supporting document')}">${/^image\/(jpeg|png|gif|webp)$/.test(mime_type)?`<img src="${esc(url)}" alt="${esc(f.name||'Submitted supporting document')}" loading="lazy" />`:'<span class="issue-response-pdf">PDF document</span>'}<span>Open full document ↗</span></a>`;
    const img=panel.querySelector('img');if(img)img.onerror=()=>{if(panel.isConnected){img.remove();panel.querySelector('a').insertAdjacentHTML('afterbegin','<span>Preview unavailable · open the saved document</span>');}};
   }catch(error){if(target.isConnected)panel.innerHTML=`<p class="issue-form-error">${esc(error.message)}</p><button type="button" class="secondary-btn" data-dispute-retry="${index}">Retry document</button>`;}
   finally{panel.dataset.busy='false';}
  }
  target.addEventListener('click',e=>{const b=e.target.closest('[data-dispute-retry]');if(b)load(Number(b.dataset.disputeRetry));});
  // Bounded parallelism keeps a case with many files from flooding the server.
  for(let i=0;i<r.files.length;i+=2){if(!target.isConnected)return;await Promise.all(r.files.slice(i,i+2).map((_,j)=>load(i+j)));}
 }
 root.OGDisputeResponse={response,badge,section,hydrate};
})(globalThis);
