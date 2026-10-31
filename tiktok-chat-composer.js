(function(){
 'use strict';
 const drafts=new Map();let user='';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key=id=>'invsto:tiktok-reply:'+user+':'+id;
 function get(id){if(!drafts.has(id)){let saved;try{saved=JSON.parse(sessionStorage.getItem(key(id))||'null');}catch{}drafts.set(id,{type:'TEXT',text:'',orderNumber:'',...saved,busy:false,file:null,preview:null});}return drafts.get(id);}
 function save(id,d){try{sessionStorage.setItem(key(id),JSON.stringify({type:d.type,text:d.text,orderNumber:d.orderNumber,requestId:d.requestId,attemptStatus:d.attemptStatus,attemptId:d.attemptId}));}catch{}}
 const timestamp=value=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York',timeZoneName:'short'}).format(new Date(value));
 function mount({container,api,rpc,chat,orders,sends=[],enabled=false,onSent,onRefresh}){
  const id=chat.id,d=get(id),q=selector=>container.querySelector(selector);
  const pending=()=>d.busy||['sending','unknown','checking'].includes(d.attemptStatus);
  container.innerHTML=`<section class="tm-composer" aria-label="Reply to buyer"><div class="tm-title-row"><div><span class="tm-eyebrow">REPLY ON TIKTOK</span><h3>To ${escape(chat.buyer_name||'this buyer')}</h3></div><span class="tm-badge">Buyer can see this</span></div><p class="tm-help">Replies are sent to this buyer’s TikTok chat. Internal team notes stay below.</p><form data-reply-form><label>Message type<select data-kind aria-label="Reply type"><option value="TEXT">Text reply</option><option value="IMAGE">Photo</option><option value="ORDER_CARD">Order card</option></select></label><div data-text-wrap><label for="tm-reply-text">Your reply</label><textarea id="tm-reply-text" data-text maxlength="2000" placeholder="Write to the buyer…"></textarea><div class="tm-reply-count" data-count></div></div><div data-photo-wrap hidden><label for="tm-reply-photo">Photo · JPG, PNG, GIF or WebP · up to 10 MB</label><input id="tm-reply-photo" data-photo type="file" accept="image/jpeg,image/png,image/gif,image/webp"><div data-preview class="tm-reply-preview"></div></div><div data-order-wrap hidden><label>Order to share<select data-order aria-label="Order to share"><option value="">Choose this buyer’s order…</option>${orders.map(o=>`<option value="${escape(o.order_number)}">${escape(o.order_number)} · ${escape((o.lines||[])[0]?.title||o.marketplace_status||'Order')}</option>`).join('')}</select></label><p class="tm-help">The buyer receives an order card inside TikTok.</p></div><div class="tm-reply-actions"><button class="tm-button tm-send" data-send type="submit">Send reply</button><button class="tm-button" data-check type="button" hidden>Check send status</button><button class="tm-button" data-reopen type="button">Reopen chat</button><button class="tm-button" data-read type="button">Mark read in TikTok</button></div><p data-status class="tm-reply-status" role="status" aria-live="polite"></p></form><div data-receipts></div></section>`;
  const tell=(message,error=false)=>{d.notice=message;d.noticeError=error;if(container.isConnected){q('[data-status]').textContent=message;q('[data-status]').classList.toggle('is-error',error);}};
  function controls(){if(!container.isConnected)return;const lock=pending()||!enabled,editLock=lock||d.attemptStatus==='retry_same';
   q('[data-kind]').value=d.type;q('[data-kind]').disabled=editLock;q('[data-text]').value=d.text;q('[data-text]').disabled=editLock;q('[data-order]').value=d.orderNumber;q('[data-order]').disabled=editLock;q('[data-photo]').disabled=lock||editLock&&Boolean(d.file);
   q('[data-text-wrap]').hidden=d.type!=='TEXT';q('[data-photo-wrap]').hidden=d.type!=='IMAGE';q('[data-order-wrap]').hidden=d.type!=='ORDER_CARD';q('[data-count]').textContent=`${d.text.length.toLocaleString()} / 2,000`;
   q('[data-send]').disabled=lock||(d.type==='TEXT'?!d.text.trim():d.type==='IMAGE'?!d.file:!d.orderNumber);
   q('[data-send]').textContent=d.busy?'Sending…':d.attemptStatus==='failed'?'Retry reply':d.type==='IMAGE'?'Send photo':d.type==='ORDER_CARD'?'Send order card':'Send reply';
   q('[data-check]').hidden=!d.requestId;q('[data-check]').disabled=d.busy;q('[data-reopen]').disabled=d.busy||!enabled;q('[data-read]').disabled=d.busy||!enabled;
   q('[data-preview]').innerHTML=d.preview?`<img src="${escape(d.preview)}" alt="Photo ready to send"><span>${escape(d.file?.name||'Photo')}</span>`:d.type==='IMAGE'&&d.requestId?'<p class="tm-help">Check the send status before selecting this photo again.</p>':'';
   if(!enabled)tell('Replies are temporarily unavailable. Refresh the page shortly.',true);else if(d.notice)tell(d.notice,d.noticeError);
  }
  function receiptList(){if(!container.isConnected)return;const problems=sends.filter(s=>['sending','unknown','failed'].includes(s.status)),recent=sends.filter(s=>!problems.includes(s));
   function row(s){const labels={sent:'Accepted by TikTok',sending:'Sending · confirmation pending',unknown:'Send not confirmed',failed:'Not sent',not_sent:'Reviewed by staff · not sent'};const content=s.type==='TEXT'?s.content.content:s.type==='IMAGE'?'Photo':`Order ${s.content.order_id}`;
    return `<article class="tm-send-receipt ${escape(s.status)}"><strong>${escape(labels[s.status]||s.status)}</strong><p>${escape(content||'Reply')}</p><small>${escape(s.author_name)} · ${escape(timestamp(s.created_at))}${s.provider_message_id?` · Message ${escape(s.provider_message_id)}`:''}</small>${s.error?`<p>${escape(s.error)}</p>`:''}${s.status==='unknown'?`<p>Check the conversation in TikTok before sending again.</p><label class="tm-review-check"><input type="checkbox" data-reviewed="${escape(s.id)}"> I checked TikTok and this reply was not sent.</label><button type="button" class="tm-button" data-release="${escape(s.id)}" disabled>Record review · allow a new attempt</button>`:''}</article>`;
   }
   q('[data-receipts]').innerHTML=problems.map(row).join('')+(recent.length?`<details class="tm-receipt-history"><summary>Invsto send history · ${recent.length}</summary>${recent.map(row).join('')}</details>`:'');
   q('[data-receipts]').querySelectorAll('[data-reviewed]').forEach(input=>{input.onchange=()=>{q(`[data-release="${input.dataset.reviewed}"]`).disabled=!input.checked;};});
   q('[data-receipts]').querySelectorAll('[data-release]').forEach(button=>{button.onclick=async()=>{button.disabled=true;try{const s=await rpc('review_tiktok_chat_send',{_id:button.dataset.release});sends=sends.map(x=>x.id===s.id?s:x);if(d.requestId===s.id||d.attemptId===s.id){d.requestId=null;d.attemptId=null;d.attemptStatus=null;save(id,d);}tell('Review recorded. You can send a new reply.');receiptList();controls();}catch(e){tell(e.message,true);button.disabled=false;}};});
  }
  function accept(result){const s=result.attempt;if(!s){d.attemptStatus='retry_same';tell('No receipt is saved yet. Retry uses the same request to prevent duplicate sends.',true);save(id,d);controls();return;}
   sends=[s,...sends.filter(x=>x.id!==s.id)];d.attemptId=s.id;d.attemptStatus=s.status;
   if(s.status==='sent'){
    d.text='';d.orderNumber='';d.requestId=null;d.attemptId=null;d.attemptStatus=null;if(d.preview)URL.revokeObjectURL(d.preview);d.preview=null;d.file=null;
    tell(result.warning||'Accepted by TikTok. Your reply was sent successfully.');onSent?.(s);
   }else if(s.status==='failed')tell(s.error||'TikTok did not accept this reply. Your draft is preserved.',true);
   else if(s.status==='not_sent'){d.requestId=null;d.attemptStatus=null;tell('Review recorded. You can send a new reply.');}
   else tell(s.status==='sending'?'Waiting for TikTok confirmation. Check status; do not resend.':'Sending could not be confirmed. Check TikTok before starting another attempt.',true);
   save(id,d);controls();receiptList();
  }
  q('[data-kind]').onchange=e=>{d.type=e.target.value;d.requestId=null;d.attemptId=null;d.attemptStatus=null;save(id,d);tell('Choose your message, then click Send.');controls();};
  q('[data-text]').oninput=e=>{d.text=e.target.value;d.requestId=null;d.attemptId=null;d.attemptStatus=null;save(id,d);tell(d.text.trim()?'Draft · not sent':'');q('[data-count]').textContent=`${d.text.length.toLocaleString()} / 2,000`;q('[data-send]').disabled=!d.text.trim();};
  q('[data-order]').onchange=e=>{d.orderNumber=e.target.value;d.requestId=null;d.attemptId=null;d.attemptStatus=null;save(id,d);controls();};
  q('[data-photo]').onchange=e=>{const file=e.target.files?.[0];if(!file)return;if(!['image/jpeg','image/png','image/gif','image/webp'].includes(file.type)||!file.size||file.size>10*1024*1024){e.target.value='';tell('Choose a JPG, PNG, GIF or WebP photo no larger than 10 MB.',true);return;}if(d.preview)URL.revokeObjectURL(d.preview);d.file=file;d.preview=URL.createObjectURL(file);if(d.attemptStatus!=='retry_same'){d.requestId=null;d.attemptStatus=null;}save(id,d);controls();tell('Photo ready. Click Send photo to share it with the buyer.');};
  q('[data-reply-form]').onsubmit=async event=>{event.preventDefault();if(pending()||!enabled||q('[data-send]').disabled)return;
   if(!d.requestId||d.attemptStatus==='failed')d.requestId=crypto.randomUUID();d.busy=true;d.attemptStatus='sending';save(id,d);controls();tell('Sending to TikTok…');
   const metadata={action:'send',id,requestId:d.requestId,type:d.type,...(d.type==='TEXT'?{text:d.text}:d.type==='ORDER_CARD'?{orderNumber:d.orderNumber}:{})};let body=metadata;
   if(d.type==='IMAGE'){body=new FormData();body.append('metadata',JSON.stringify(metadata));body.append('photo',d.file);}
   try{const result=await api(body);d.busy=false;accept(result);}catch(e){d.busy=false;d.attemptStatus=e.notSent?'failed':'checking';save(id,d);tell(e.notSent?e.message:`${e.message} Check send status before trying again.`,true);controls();}
  };
  q('[data-check]').onclick=async()=>{if(!d.requestId||d.busy)return;d.busy=true;controls();try{const result=await api({action:'send_status',id,requestId:d.attemptId||d.requestId});d.busy=false;accept(result);}catch(e){d.busy=false;tell(e.message,true);controls();}};
  q('[data-reopen]').onclick=async()=>{if(d.busy)return;d.busy=true;controls();try{await api({action:'open_chat',id});tell('Chat reopened in TikTok. You can send your reply.');}catch(e){tell(e.message,true);}finally{d.busy=false;controls();}};
  q('[data-read]').onclick=async()=>{if(d.busy)return;d.busy=true;controls();try{await api({action:'mark_read',id});tell('Buyer messages marked read in TikTok.');onRefresh?.();}catch(e){tell(e.message,true);}finally{d.busy=false;controls();}};
  // Recover a saved request after navigation or a reload without sending it again.
  const existing=sends.find(s=>s.id===d.requestId||s.id===d.attemptId);if(existing)accept({attempt:existing});else{controls();receiptList();}
 }
 window.TikTokChatComposer={mount,setUser(id){user=id||'';},isBusy(id){return Boolean(drafts.get(id)?.busy);},hasDraft(id){const d=drafts.get(id);return Boolean(d&&(d.text||d.file||d.orderNumber||d.requestId));},clear(){for(const [id,d] of drafts){if(d.preview)URL.revokeObjectURL(d.preview);try{sessionStorage.removeItem(key(id));}catch{}}drafts.clear();user='';}};
})();
