/* A local, reviewable evidence archive. No submission to eBay or other services. */
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const safe=v=>{try{const u=new URL(v);return /^https?:$/.test(u.protocol)?u.href:'';}catch{return '';}};
 const date=v=>{const d=new Date(v);return v&&!Number.isNaN(d.getTime())?d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'';};
 const textBytes=v=>new TextEncoder().encode(v);
 const groups={item:'Item screenshots',completion:'Completion photos',packaging:'Packaging photos / videos',certificate:'Certificates',returned:'Returned-item evidence'};
 const limit=80*1024*1024;
 async function originalFile(file,sign,remaining){
  const url=await sign(file,{thumbnail:false});if(!url)throw Error('Original file unavailable');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
  try{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw Error('Original file unavailable');
   if(Number(response.headers.get('Content-Length'))>remaining)throw Error('Archive size limit; download this file separately');
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>remaining){controller.abort();throw Error('Archive size limit; download this file separately');}chunks.push(value);}}
   finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }finally{clearTimeout(timeout);}
 }
 // The same normalized conversation powers the case view and evidence export.
 function conversation(data={}){
  const history=(Array.isArray(data.case_history)?data.case_history:[]).map((e,index)=>{
   const actor=String(e.actor||'UNKNOWN').toUpperCase(),body=typeof e.description==='string'?e.description.trim():'',action=typeof e.action==='string'?e.action.trim():'';
   return {id:`case-history-${index}`,direction:actor==='SELLER'?'outbound':actor==='BUYER'?'inbound':'system',
    sender_username:actor==='SELLER'?'Our reply':actor==='BUYER'?(data.case?.buyer_username||'Buyer'):actor==='CSR'?'eBay support':actor==='SYSTEM'?'eBay system':'eBay · unknown author',
    message_body:body||action,sent_at:typeof e.date==='string'?e.date:e.date?.value,channel:'eBay case history',message_status:'imported',entry_type:body?'message':'event',event_action:action,provider_actor:actor};
  }).filter(e=>e.message_body);
  const all=[...history,...(data.case_messages||[]).map(m=>({...m,channel:'eBay case'})),...(data.buyer_messages||[]).map(m=>({...m,channel:'Buyer chat',sent_at:m.created_at_ebay}))]
   .filter(m=>m.direction!=='internal'&&(!m.message_status||['sent','imported'].includes(m.message_status)));
  const seen=new Map();
  return all.filter(m=>{
   // Only merge copies across sources; repeated real messages retain their dates.
   const body=String(m.message_body||'').trim().replace(/\s+/g,' '),time=Date.parse(m.sent_at),key=JSON.stringify([m.direction,body,Number.isNaN(time)?m.sent_at||null:time]);
   const prior=seen.get(key);if(prior&&prior!==m.channel)return false;seen.set(key,m.channel);return true;
  }).sort((a,b)=>(Date.parse(b.sent_at)||0)-(Date.parse(a.sent_at)||0));
 }
 function providerContext(c={}){
  const d=c.raw_payload?.ebayDetail||{},field=c.source_lane==='inquiry'?'inquiryHistoryDetails':c.source_lane==='case'?'caseHistoryDetails':null;
  const id=c.source_lane==='inquiry'?d.inquiryId:d.caseId;
  if(!field||String(id||'')!==String(c.ebay_return_id||'')||!id)return {};
  const history=d[field]||{},amount=d.claimAmount,value=amount?.value;
  let requestAmount='';
  if(value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&/^[A-Z]{3}$/.test(amount.currency||'')){
   try{requestAmount=new Intl.NumberFormat(undefined,{style:'currency',currency:amount.currency}).format(Number(value));}catch{}
  }
  return {buyerComment:typeof history.additionalInfo==='string'?history.additionalInfo.trim():'',requestAmount};
 }
 function collect(data,receipts=[],returnEvents=[]){
  const files=[],seen=new Set();
  const add=(rows,group)=>{for(const p of rows||[]){const bucket=p.bucket||p.storage_bucket,path=p.path||p.storage_path;
   if(!bucket||!path||seen.has(`${bucket}:${path}`))continue;seen.add(`${bucket}:${path}`);
   files.push({bucket,path,group,label:p.label||groups[group],mime_type:p.mime_type||p.content_type||'',created_at:p.created_at||p.captured_at||p.event?.created_at,video:/video|\.(mp4|mov|webm|m4v)$/i.test(p.mime_type||path)});
  }};
  add(receipts,'item');add(data.bag_photos,'item');
  for(const e of data.completion_events||[])add(e.photo_attachments,'completion');
  // Item receipts are supplied by the shared line-scoping helper. Generic task
  // photos are not silently treated as item evidence or exported as staff notes.
  add(data.packaging_photos,'packaging');
  for(const c of data.certificates||[])add(c.attachments,'certificate');
  add(data.return_photos,'returned');
  for(const e of returnEvents)add(e.evidence_photos||e.photo_attachments,'returned');
  return files;
 }
 const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
 function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
 // ZIP store mode preserves the original evidence bytes; no third-party CDN.
 function zip(entries){
  const chunks=[],central=[];let offset=0,size=0;
  for(const e of entries){const name=textBytes(e.name),bytes=e.bytes,checksum=crc(bytes),h=new Uint8Array(30+name.length),v=new DataView(h.buffer);
   v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,checksum,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,name.length,true);h.set(name,30);
   const c=new Uint8Array(46+name.length),w=new DataView(c.buffer);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint32(16,checksum,true);w.setUint32(20,bytes.length,true);w.setUint32(24,bytes.length,true);w.setUint16(28,name.length,true);w.setUint32(42,offset,true);c.set(name,46);
   chunks.push(h,bytes);central.push(c);offset+=h.length+bytes.length;size+=c.length;
  }
  const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
  return new Blob([...chunks,...central,end],{type:'application/zip'});
 }
 function report(data,files,messages,missing){
  const c=data.case||{};
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"><title>Case ${esc(c.ebay_return_id)} evidence</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:30px auto;padding:0 20px;color:#19251f}h1,h2{line-height:1.2}article{border:1px solid #ccc;padding:15px;margin:12px 0;break-inside:avoid}img{max-width:100%;max-height:500px}small{color:#555}pre{white-space:pre-wrap;font:inherit}.missing{color:#9a391f}@media print{a{color:inherit}}</style>
  <h1>Case ${esc(c.ebay_return_id)} · ${esc(c.buyer_username)}</h1><p>Order ${esc(c.order_number)} · ${esc(c.source_lane)} · ${esc(c.ebay_status)}</p><p>Generated ${esc(new Date().toISOString())}<br>Last case sync ${esc(c.synced_at)}<br>eBay response deadline ${esc(c.ebay_due_at||'Not provided')}</p>
  <p>Working evidence copy. Review the selected material before submitting it. Internal staff notes are excluded. Dates below retain their stored time zone.</p>
  ${missing.length?`<h2 class="missing">Incomplete download</h2><ul>${missing.map(m=>`<li>${esc(m)}</li>`).join('')}</ul>`:''}
  <h2>Items</h2>${(data.lines||[]).map(l=>`<article>${esc(l.item_title)}<br>Item ${esc(l.item_number)} · Quantity ${esc(l.quantity)}</article>`).join('')||'<p>No exact order lines linked.</p>'}
  <h2>Tracking</h2>${[...(data.orders||[]).map(o=>({code:o.tracking_number,status:'Order tracking'})),...(data.packages||[]).map(p=>({code:p.tracking_code,status:p.status}))].filter(p=>p.code).map(p=>`<p>${esc(p.code)} · ${esc(p.status)}</p>`).join('')||'<p>No saved tracking.</p>'}
  <h2>Certificates</h2>${(data.certificates||[]).map(c=>`<p>Report ${esc(c.report_number)} · Serial ${esc(c.watch_serial)}${safe(c.certificate_url)?` · <a href="${esc(safe(c.certificate_url))}">Certificate link</a>`:''}</p>`).join('')||'<p>No saved certificates.</p>'}
  <h2>Selected files</h2>${files.map(f=>`<article><b>${esc(groups[f.group])}</b> · ${esc(f.label)}<br><small>${esc(f.created_at||'Capture date unavailable')}</small><p><a href="${esc(f.filename)}">Open original file</a></p>${/\.(png|jpe?g|webp|gif)$/i.test(f.filename)?`<img src="${esc(f.filename)}" alt="${esc(f.label)}">`:''}</article>`).join('')||'<p>No files selected.</p>'}
  <h2>Selected messages</h2>${messages.map(m=>`<article><small>${esc(date(m.sent_at||m.created_at_ebay))} · ${esc(m.sender_username||(m.direction==='outbound'?'Our reply':m.direction==='inbound'?'Buyer':m.direction))}</small><pre>${esc(m.message_body||'')}</pre></article>`).join('')||'<p>No messages selected.</p>'}</html>`;
 }
 async function open({db,caseId,target,sign,receipts=[],returnEvents=[],data:loadedData}){
  if(target.dataset.loading==='true')return;target.dataset.loading='true';target.innerHTML='<p role="status">Gathering saved evidence…</p>';
  try{
   const result=loadedData?{data:loadedData}:await db.rpc('customer_issue_evidence',{_case_id:caseId});if(result.error)throw result.error;if(!target.isConnected)return;
   const data=result.data,files=collect(data,receipts,returnEvents),messages=conversation(data);
   const truncated=(data.case_messages||[]).length>500||(data.buyer_messages||[]).length>500||(data.case_history||[]).length>500;
   target.innerHTML=`<p class="issue-subtitle">Choose the files and messages to include. The ZIP contains original files and a printable report.</p>${Object.entries(groups).map(([key,label])=>{const matches=files.map((f,i)=>({...f,i})).filter(f=>f.group===key);return `<section class="issue-evidence-group"><h3>${label} <small>${matches.length}</small></h3>${matches.length?matches.map(f=>`<label class="issue-evidence-option"><input type="checkbox" data-evidence-file="${f.i}" ${f.video?'':'checked'}><span>${esc(f.label)}${f.video?' · Video':''}<small>${esc(date(f.created_at))}</small></span><button type="button" class="secondary-btn" data-evidence-preview="${f.i}">View</button></label>`).join(''):'<p class="issue-subtitle">Not saved for this case.</p>'}</section>`;}).join('')}
    <details class="issue-evidence-group"><summary>Conversation &amp; case activity · ${messages.length} available</summary><p class="issue-subtitle">Only messages linked to this case or its exact order/item are listed. Select the relevant messages.</p>${truncated?'<p class="issue-form-error">Showing a limited message history. Use Buyer chat for older messages.</p>':''}${messages.map((m,i)=>`<label class="issue-evidence-message"><input type="checkbox" data-evidence-message="${i}"><span><small>${esc(date(m.sent_at||m.created_at_ebay))} · ${esc(m.sender_username||(m.direction==='outbound'?'Our reply':m.direction==='inbound'?'Buyer':m.direction))}</small><span>${esc(m.message_body||'')}</span></span></label>`).join('')}</details>
    <p class="issue-subtitle">Tracking and saved certificate links are included in the report. Internal staff notes are excluded.</p><div class="issue-actions"><button type="button" class="primary-btn" data-evidence-download>Download evidence ZIP</button></div><p role="status" data-evidence-status></p><div data-evidence-preview-panel></div>`;
   target.dataset.ready='true';
   target.onclick=async event=>{
    const preview=event.target.closest('[data-evidence-preview]');
    if(preview){const f=files[Number(preview.dataset.evidencePreview)],panel=target.querySelector('[data-evidence-preview-panel]');panel.textContent='Opening original file…';
     try{const url=await sign(f,{thumbnail:false});if(!url)throw Error('Could not load the file.');panel.innerHTML=`<a class="secondary-btn" href="${esc(url)}" target="_blank" rel="noopener">Open original ${f.video?'video':'file'} ↗</a>${f.video?`<video src="${esc(url)}" controls playsinline preload="metadata"></video>`:/pdf/i.test(f.mime_type||f.path)?'':`<img src="${esc(url)}" alt="${esc(f.label)}">`}`;panel.scrollIntoView({block:'nearest'});}catch(e){panel.textContent=e.message;}return;}
    const button=event.target.closest('[data-evidence-download]');if(!button||button.disabled)return;
    button.disabled=true;const status=target.querySelector('[data-evidence-status]');
    const selected=[...target.querySelectorAll('[data-evidence-file]:checked')].map(el=>files[Number(el.dataset.evidenceFile)]),chosen=[...target.querySelectorAll('[data-evidence-message]:checked')].map(el=>messages[Number(el.dataset.evidenceMessage)]);
    const entries=[],included=[],missing=[];let total=0;
    try{
     for(const [i,f] of selected.entries()){
      status.textContent=`Preparing file ${i+1} of ${selected.length}…`;
      if(i>=100||total>=limit){missing.push(`${f.label}: archive limit reached; download separately.`);continue;}
      try{const bytes=await originalFile(f,sign,limit-total);
       const filename=`files/${String(i+1).padStart(3,'0')}-${f.group}-${f.path.split('/').pop().replace(/[^a-zA-Z0-9._-]/g,'_')}`;
       entries.push({name:filename,bytes});included.push({...f,filename});total+=bytes.length;
      }catch(e){missing.push(`${f.label}: ${e.message||'File unavailable'}`);}
     }
     if(truncated)missing.push('Message history is limited; review older messages in Buyer chat.');
     entries.push({name:'report.html',bytes:textBytes(report(data,included,chosen,missing))},{name:'manifest.json',bytes:textBytes(JSON.stringify({case:data.case,generated_at:new Date().toISOString(),complete:!missing.length,missing,files:included.map(({bucket,path,...f})=>f)},null,2))});
     const blob=zip(entries),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`case-${String(data.case.ebay_return_id||caseId).replace(/[^\w-]/g,'_')}-evidence${missing.length?'-incomplete':''}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
     status.textContent=missing.length?`Downloaded with ${missing.length} missing item(s). The report lists what to download separately.`:`Downloaded ${included.length} files and ${chosen.length} messages. Open report.html after extracting the ZIP.`;
    }catch(e){status.textContent=e.message||'Could not prepare the download. Please retry.';}finally{button.disabled=false;}
   };
  }catch(error){target.innerHTML=`<p class="issue-form-error">${esc(error.message||'Could not gather evidence. Retry Prepare evidence.')}</p>`;}
  finally{delete target.dataset.loading;}
 }
 root.OGIssueEvidence={open,collect,conversation,providerContext,testing:{collect,zip,report,crc,conversation,providerContext}};
})(globalThis);
