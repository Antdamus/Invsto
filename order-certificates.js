/* A permanent, item-scoped certificate record shared by fulfillment and history. */
(() => {
 'use strict';
 const BUCKET='order-evidence-photos', MAX=10*1024*1024;
 const $=id=>document.getElementById(id), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
 const client=()=>window.supabase;
 let dialog, lineId, trigger, requestId, userId, admin=false, busy=false, loading=true, readingFiles=false, files=[], records=[], generation=0;
 const counts=new Map(),pending=new Set();let countTimer;
 const status=(text,error=false)=>{const el=$('certificate-status');el.textContent=text;el.classList.toggle('is-error',error);};
 function link(value){
  value=String(value||'').trim();if(!value)return null;
  if(/^www\./i.test(value))value='https://'+value;
  if(!/^https?:\/\//i.test(value))return null;
  try{const url=new URL(value);if(url.username||url.password||url.port||/[\x00-\x20\x7f]/.test(value))return null;
   if(url.protocol==='http:')url.protocol='https:';return url.href;
  }catch{return null;}
 }
 function fileType(bytes){
  const text=(a,b)=>new TextDecoder().decode(bytes.slice(a,b));
  if(text(0,5)==='%PDF-')return {mime:'application/pdf',extension:'pdf'};
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',extension:'jpg'};
  if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return {mime:'image/png',extension:'png'};
  if(text(0,4)==='RIFF'&&text(8,12)==='WEBP')return {mime:'image/webp',extension:'webp'};
  return null;
 }
 function refreshControls(){$('certificate-fields').disabled=busy||loading||readingFiles;$('certificate-close').disabled=busy;
  $('certificate-save').disabled=busy||loading||readingFiles;$('certificate-save').textContent=busy?'Saving certificate…':readingFiles?'Reading files…':'Save certificate';}
 function setBusy(value){busy=value;refreshControls();}
 function create(){
  if(dialog)return;
  dialog=document.createElement('dialog');dialog.id='order-certificate-dialog';dialog.className='certificate-dialog';dialog.setAttribute('aria-labelledby','certificate-title');
  dialog.innerHTML=`<header class="certificate-head"><div><span class="certificate-eyebrow">WATCH DOCUMENTS</span><h2 id="certificate-title">CGL certificates</h2></div><button id="certificate-close" type="button" aria-label="Close certificates">×</button></header>
   <p id="certificate-context" class="certificate-context"></p><section id="certificate-saved" aria-label="Saved certificates"></section>
   <form id="certificate-form"><fieldset id="certificate-fields"><legend>Add a certificate</legend>
   <label for="certificate-qr">Certificate link or QR contents</label><div class="certificate-scan-row"><input id="certificate-qr" type="text" maxlength="2048" inputmode="url" autocomplete="off" placeholder="Scan the QR or paste its link"><button type="button" data-scan-target="certificate-qr" data-scan-mode="certificate" data-scan-hint="Check this certificate belongs to the selected watch, then save it.">Scan QR</button></div>
   <a id="certificate-preview-link" target="_blank" rel="noopener noreferrer" hidden>Open certificate website ↗</a>
   <p class="certificate-hint">CGL links save a PDF copy automatically when available. You can also attach the certificate yourself.</p>
   <div class="certificate-upload-actions"><label class="certificate-button">Add PDF / photos<input id="certificate-files" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple></label><label class="certificate-button">Take photo<input id="certificate-camera" type="file" accept="image/*" capture="environment"></label></div>
   <ul id="certificate-file-list"></ul><p class="certificate-hint">Up to 6 files, 10 MB each.</p>
   <details class="certificate-identifiers"><summary>Report number / watch serial (optional)</summary><label for="certificate-report">Report number</label><input id="certificate-report" maxlength="120" autocomplete="off"><label for="certificate-serial">Watch serial</label><input id="certificate-serial" maxlength="120" autocomplete="off"></details>
   </fieldset><p id="certificate-status" role="status" aria-live="polite"></p><footer class="certificate-footer"><small>Saved with this item in Pending Orders, Packaging, and Order History.</small><button id="certificate-save" type="submit">Save certificate</button></footer></form>`;
  document.body.append(dialog);
  $('certificate-close').onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.addEventListener('close',()=>{generation++;files=[];trigger?.focus();});
  dialog.addEventListener('keydown',e=>e.stopPropagation());
  dialog.addEventListener('click',e=>{if(!e.target.closest('[data-scan-target]'))e.stopPropagation();});
  $('certificate-qr').addEventListener('input',()=>{const url=link($('certificate-qr').value),a=$('certificate-preview-link');a.hidden=!url;if(url)a.href=url;else a.removeAttribute('href');});
  for(const id of ['certificate-files','certificate-camera'])$(id).addEventListener('change',async e=>{
   const selected=[...e.target.files];e.target.value='';if(files.length+selected.length>6){status('Choose up to 6 certificate files.',true);return;}
   const run=generation;readingFiles=true;refreshControls();
   try{for(const file of selected){if(!file.size||file.size>MAX)throw Error('Each certificate copy must be between 1 byte and 10 MB.');
     const bytes=new Uint8Array(await file.arrayBuffer()),type=fileType(bytes);if(!type)throw Error('Use a PDF, JPG, PNG, or WebP certificate copy.');
     if(run!==generation)return;
     const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
     if(run!==generation)return;
     if(!files.some(f=>f.sha256===sha256))files.push({file,bytes,...type,sha256});}
    status('');
   }catch(error){if(run===generation)status(error.message,true);}finally{if(run===generation){readingFiles=false;refreshControls();renderFiles();}}
  });
  $('certificate-file-list').onclick=e=>{const b=e.target.closest('[data-remove-certificate-file]');if(b&&!busy){files.splice(Number(b.dataset.removeCertificateFile),1);renderFiles();}};
  $('certificate-form').onsubmit=save;
  $('certificate-saved').onclick=async e=>{
   const b=e.target.closest('[data-certificate-copy]');if(b){const record=records.find(r=>r.id===b.dataset.certificateCopy),file=record?.attachments[Number(b.dataset.fileIndex)];if(!file)return;
    b.disabled=true;try{const {data,error}=await client().storage.from(file.bucket).createSignedUrl(file.path,600);if(error)throw error;
     const a=document.createElement('a');a.href=data.signedUrl;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open saved copy ↗';a.className='certificate-button';b.replaceWith(a);a.click();
    }catch{b.disabled=false;status('Could not open the saved copy. Try again.',true);}return;}
   const correct=e.target.closest('[data-certificate-incorrect]');if(!correct||busy)return;
   const row=correct.closest('.certificate-record'),reason=row.querySelector('textarea').value.trim();if(!reason){status('Enter why this certificate is incorrect.',true);return;}
   setBusy(true);try{const {error}=await client().rpc('void_order_line_certificate',{_id:correct.dataset.certificateIncorrect,_reason:reason});if(error)throw error;await loadRecords();status('Marked incorrect. The original copy remains in the history.');}
   catch(error){status(error.message||'Could not save the correction.',true);}finally{setBusy(false);}
  };
 }
 function renderFiles(){$('certificate-file-list').innerHTML=files.map((f,i)=>`<li><span>${esc(f.file.name)}</span><button type="button" data-remove-certificate-file="${i}" aria-label="Remove ${esc(f.file.name)}">×</button></li>`).join('');}
 function renderRecords(){
  $('certificate-saved').innerHTML=records.length?records.map(r=>`<article class="certificate-record ${r.voided_at?'is-incorrect':''}"><div class="certificate-record-head"><strong>${esc(r.report_number?'CGL · '+r.report_number:'CGL certificate')}</strong><span>${r.voided_at?'Marked incorrect':'Copy saved'}</span></div>
   ${r.watch_serial?`<p>Watch serial: ${esc(r.watch_serial)}</p>`:''}<small>Saved ${esc(date(r.created_at))}${r.created_by_email?' · '+esc(r.created_by_email):''}</small>
   ${r.voided_at?`<p class="certificate-correction">${esc(r.void_reason)} · ${esc(date(r.voided_at))}</p>`:''}
   <div class="certificate-record-actions">${r.attachments.map((f,i)=>`<button type="button" data-certificate-copy="${esc(r.id)}" data-file-index="${i}">${r.attachments.length>1?`Copy ${i+1}`:'Open saved copy'} · ${f.mime_type==='application/pdf'?'PDF':'Photo'}</button>`).join('')}
   ${link(r.certificate_url)?`<a class="certificate-button" href="${esc(link(r.certificate_url))}" target="_blank" rel="noopener noreferrer">CGL website ↗</a>`:''}</div>
   ${!r.voided_at&&(r.created_by===userId||admin)?`<details class="certificate-correction"><summary>Wrong certificate?</summary><p>Mark it incorrect and add the right certificate. The original stays in the audit history.</p><textarea maxlength="1000" aria-label="Correction reason" placeholder="Reason for correction"></textarea><button type="button" data-certificate-incorrect="${esc(r.id)}">Mark incorrect</button></details>`:''}</article>`).join(''):'<p class="certificate-empty">No certificate saved for this item yet.</p>';
 }
 function updateCounts(id,count){counts.set(id,count);document.querySelectorAll('[data-certificate-line]').forEach(b=>{if(b.dataset.certificateLine===id){b.textContent=count?`CGL certificate · ${count}`:'CGL certificate';b.classList.toggle('has-certificate',count>0);}});}
 async function loadRecords(){const run=generation,id=lineId;let rows=[];
  for(let offset=0;;offset+=100){const {data,error}=await client().from('ebay_order_line_certificates').select('*').eq('order_line_id',id).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+99);if(error)throw error;rows.push(...data);if(data.length<100)break;}
  if(run!==generation)return;records=rows;renderRecords();updateCounts(id,rows.filter(r=>!r.voided_at).length);
 }
 async function open(button){
  if(busy)return;create();trigger=button;lineId=button.dataset.certificateLine;generation++;requestId=crypto.randomUUID();files=[];records=[];loading=true;readingFiles=false;refreshControls();
  $('certificate-form').reset();$('certificate-preview-link').hidden=true;renderFiles();status('');$('certificate-context').textContent=button.dataset.certificateTitle||'Selected order item';
  $('certificate-saved').textContent='Loading saved certificates…';window.OGTaskNotifications?.dismiss();dialog.showModal();$('certificate-close').focus();
  const run=generation;
  try{const [auth,role]=await Promise.all([client().auth.getUser(),client().rpc('is_admin')]);if(run!==generation)return;if(auth.error||!auth.data?.user)throw Error('Sign in again');userId=auth.data.user.id;admin=role.data===true;await loadRecords();if(run===generation){loading=false;refreshControls();}}
  catch{if(run===generation){$('certificate-saved').textContent='Could not load saved certificates.';status('Close and reopen to retry before adding another certificate.',true);}}
 }
 async function save(event){
  event.preventDefault();if(busy||loading||readingFiles)return;
  const raw=$('certificate-qr').value.trim(),url=link(raw),report=$('certificate-report').value.trim(),serial=$('certificate-serial').value.trim();
  if(raw.length>2048||/[\x00-\x1f\x7f]/.test(raw)){status('Paste the QR contents on one line, up to 2,048 characters.',true);return;}
  if(raw&&/^(?:[a-z][a-z\d+.-]*:|www\.)/i.test(raw)&&!url){status('Use a normal certificate website link, or its report number.',true);return;}
  if(!files.length&&!url){status('Scan a certificate link, or add a PDF/photo copy.',true);return;}
  setBusy(true);status(files.length?'Saving certificate copies…':'Getting the certificate PDF from CGL…');
  try{
   const args={_id:requestId,_line_id:lineId,_qr_text:raw||null,_url:url,_report_number:report||null,_watch_serial:serial||null};
   let result;
   if(files.length){const attachments=[];
    for(const f of files){const path=`certificates/${lineId}/${requestId}/${f.sha256}.${f.extension}`;
     const {error}=await client().storage.from(BUCKET).upload(path,f.bytes,{contentType:f.mime,upsert:false});
     if(error&&String(error.statusCode)!=='409'&&!/already exists|duplicate/i.test(error.message))throw error;
     attachments.push({bucket:BUCKET,path,mime_type:f.mime,size:f.bytes.length,label:f.file.name,sha256:f.sha256});}
    const {data,error}=await client().rpc('save_order_line_certificate',{...args,_attachments:attachments});if(error)throw error;result=data;
   }else{
    if(!['cgl-labs.com','www.cgl-labs.com','miami.cgl-labs.com'].includes(new URL(url).hostname))throw Error('Add a PDF or photo copy for this certificate website. The link will be saved with it.');
    const {data,error}=await client().functions.invoke('archive-order-certificate',{body:{id:requestId,line_id:lineId,url,qr_text:raw,report_number:report,watch_serial:serial}});
    if(error){let message='Could not download the certificate. Add a PDF or photo copy and retry.';try{message=(await error.context.json()).error||message;}catch{}throw Error(message);}
    if(data?.error)throw Error(data.error);result=data?.certificate;
   }
   if(!result?.id)throw Error('No saved certificate was confirmed. Retry to check the same request.');
   files=[];requestId=crypto.randomUUID();$('certificate-form').reset();$('certificate-preview-link').hidden=true;renderFiles();
   records=[result,...records.filter(r=>r.id!==result.id)];renderRecords();updateCounts(lineId,records.filter(r=>!r.voided_at).length);
   status('Certificate copy saved with this item. It stays available after shipping.');
  }catch(error){status(error.message||'Could not save. Your certificate details are still here; retry.',true);}
  finally{setBusy(false);}
 }
 document.addEventListener('click',event=>{const b=event.target.closest('[data-certificate-line]');if(b){event.preventDefault();event.stopPropagation();void open(b);}});
 async function flushCounts(){countTimer=null;const ids=[...pending];pending.clear();
  if(!client()?.from)return;
  for(let start=0;start<ids.length;start+=75){const batch=ids.slice(start,start+75),totals=new Map(batch.map(id=>[id,0]));
   try{for(let offset=0;;offset+=500){const {data,error}=await client().from('ebay_order_line_certificates').select('order_line_id').in('order_line_id',batch).is('voided_at',null).range(offset,offset+499);if(error)throw error;
     for(const r of data||[])totals.set(r.order_line_id,(totals.get(r.order_line_id)||0)+1);if(!data||data.length<500)break;}
    for(const [id,count]of totals)updateCounts(id,count);
   }catch{/* Opening the certificate panel provides an explicit load/retry error. */}
  }
 }
 const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){observer.unobserve(e.target);const id=e.target.dataset.certificateLine;if(counts.has(id))updateCounts(id,counts.get(id));else pending.add(id);}if(pending.size&&!countTimer)countTimer=setTimeout(flushCounts,30);},{rootMargin:'200px'});
 function observe(root){if(root.nodeType!==1)return;const buttons=[...(root.matches('[data-certificate-line]')?[root]:[]),...root.querySelectorAll('[data-certificate-line]')];for(const b of buttons)observer.observe(b);}
 new MutationObserver(changes=>{for(const c of changes)for(const n of c.addedNodes)observe(n);}).observe(document.body,{childList:true,subtree:true});observe(document.body);
})();
