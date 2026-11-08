/* Shared customer-care composer. Saves internal records; never sends a buyer message. */
(function(root) {
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={call:'Call customer',call_followup:'Follow up on a call',manual_return:'Manual return'};
 const stages={awaiting_shipment:'Awaiting shipment',in_transit:'In transit',received:'Received',resolved:'Resolved'};
 const checked=r=>{if(r.error)throw r.error;return r.data;};
 const localTime=iso=>{if(!iso)return '';const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 const displayTime=value=>{if(!value)return 'Not set';const d=new Date(value);return Number.isNaN(+d)?String(value):new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(d)+' ET';};
 const orderTime=o=>{
  if(!o?.purchased_at)return 'Not provided';
  if(o.purchase_precision==='local')return o.purchased_at+' (saved order time)';
  if(o.purchase_precision==='day'||/^\d{4}-\d{2}-\d{2}$/.test(o.purchased_at)){const d=new Date(o.purchased_at.slice(0,10)+'T12:00:00Z');return Number.isNaN(+d)?'Time not provided':new Intl.DateTimeFormat('en-US',{timeZone:'UTC',dateStyle:'medium'}).format(d)+' � time not provided';}
  return displayTime(o.purchased_at);
 };
 const timezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
 const dueValue=value=>value?new Date(value).toISOString():null;
 const contactFields=c=>`<div class="cf-fields"><label>Customer / contact name<input name="contact_name" maxlength="1000" value="${escape(c?.name)}"></label><label>Phone<input name="contact_phone" type="tel" maxlength="1000" value="${escape(c?.phone)}"></label><label>Email<input name="contact_email" type="email" maxlength="1000" value="${escape(c?.email)}"></label><label>Address<textarea name="contact_address" rows="2" maxlength="1000">${escape(c?.address)}</textarea></label></div>`;
 const contactValues=f=>Object.fromEntries(['name','phone','email','address'].map(k=>[k,f.elements.namedItem('contact_'+k).value.trim()]));
 const dueFields=(r={})=>`<div class="cf-fields"><label>Next follow-up (${escape(timezone())})<input name="due_at" type="datetime-local" value="${localTime(r.due_at)}"></label><label>Priority<select name="priority">${['normal','high','urgent','low'].map(p=>`<option ${r.priority===p?'selected':''}>${p}</option>`).join('')}</select></label></div>`;
 const photoFields=()=>'<label>Add photos<input name="photos" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif" multiple></label><small>Up to 10 photos per update, 20 MB each.</small><div class="cf-photo-picker"></div>';
 let dialog=null;
 function buttons(context={}) {
  const data=escape(JSON.stringify(context));
  return `<button type="button" class="secondary-btn cf-launch" data-cf-kind="call" data-cf-context="${data}">Remind me to call</button><button type="button" class="secondary-btn cf-launch" data-cf-kind="manual_return" data-cf-context="${data}">Add manual return</button><a class="secondary-btn" href="customer-followups.html${context.buyer?'?buyer='+encodeURIComponent(context.buyer)+'&channel='+encodeURIComponent(context.channel||'ebay'):''}">Customer follow-ups</a>`;
 }
 function makeDialog(title,body,saveLabel) {
  if(dialog)return null;
  const opener=document.activeElement,element=document.createElement('dialog');dialog=element;
  element.className='cf-dialog';element.setAttribute('aria-labelledby','cf-dialog-title');
  element.innerHTML=`<form><header><div><span class="cf-eyebrow">CUSTOMER CARE</span><h2 id="cf-dialog-title">${escape(title)}</h2></div><button type="button" data-cf-close aria-label="Close">×</button></header>${body}<p class="cf-error" role="status"></p><footer><button type="button" data-cf-close>Cancel</button><button type="submit" class="cf-primary">${escape(saveLabel)}</button></footer></form>`;
  document.body.append(element);element.showModal();
  const form=element.querySelector('form');let busy=false;const cleanup=[];
  function close(){if(busy)return;cleanup.forEach(fn=>fn());element.close();element.remove();dialog=null;opener?.isConnected&&opener.focus();}
  element.addEventListener('cancel',e=>{e.preventDefault();close();});
  element.addEventListener('click',e=>{if(e.target.closest('[data-cf-close]'))close();});
  return {element,form,close,cleanup,error:message=>{form.querySelector('.cf-error').textContent=message;},busy:value=>{busy=value;form.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=value);}};
 }
 function photoPicker(modal,user,request) {
  const photos=[],form=modal.form,input=form.elements.photos,container=form.querySelector('.cf-photo-picker');
  const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',heic:'image/heic',heif:'image/heif'};
  const render=()=>{container.innerHTML=photos.map((p,i)=>`<div><img src="${escape(p.preview)}" alt="${escape(p.file.name)}"><span>${escape(p.file.name)}</span><button type="button" data-cf-remove="${i}">Remove</button></div>`).join('');};
  input.addEventListener('change',()=>{
   const files=[...input.files];input.value='';
   if(photos.length+files.length>10){modal.error('Choose up to 10 photos per update.');return;}
   const mapped=files.map(file=>({file,ext:file.name.split('.').pop().toLowerCase()}));
   if(mapped.some(p=>!types[p.ext]||!p.file.size||p.file.size>20*1024*1024)){modal.error('Use JPG, PNG, WebP, GIF, HEIC or HEIF photos up to 20 MB each.');return;}
   for(const p of mapped)photos.push({...p,type:types[p.ext],preview:URL.createObjectURL(p.file),path:`${user}/${request}/${root.crypto.randomUUID()}.${p.ext}`});
   modal.error('');render();
  });
  container.addEventListener('click',e=>{const b=e.target.closest('[data-cf-remove]');if(b){URL.revokeObjectURL(photos.splice(Number(b.dataset.cfRemove),1)[0].preview);render();}});
  modal.cleanup.push(()=>photos.forEach(p=>URL.revokeObjectURL(p.preview)));
  return async db=>{
   const result=[];
   for(const p of photos){
    if(!p.uploaded){const {error}=await db.storage.from('customer-followup-photos').upload(p.path,p.file,{contentType:p.type,upsert:false});if(error&&String(error.statusCode)!=='409'&&error.error!=='Duplicate')throw error;p.uploaded=true;}
    result.push({bucket:'customer-followup-photos',path:p.path,label:p.file.name,mime_type:p.type,size_bytes:p.file.size});
   }
   return result;
  };
 }
 async function connection(){const db=root.supabase;if(!db?.auth)throw Error('Connection is not ready. Refresh and try again.');const session=checked(await db.auth.getSession()).session;if(!session)throw Error('Sign in to save a follow-up.');return {db,user:session.user.id};}
 async function people(form,db,user,optional=true){
  const rows=checked(await db.rpc('list_team_task_assignees'))||[];
  form.elements.owner.innerHTML=(optional?'<option value="">No task yet</option>':'<option value="">Choose a person</option>')+rows.filter(p=>p.user_id).map(p=>`<option value="${escape(p.user_id)}">${escape(p.display_name||p.email)}${p.user_id===user?' (you)':''}</option>`).join('');
 }
 function saved(modal,record){modal.busy(false);modal.close();root.dispatchEvent(new CustomEvent('customer-followup-saved',{detail:record}));}
 async function open(kind='call',context={}) {
  if(dialog)return;
  let db,user;try{({db,user}=await connection());}catch(e){root.alert(e.message);return;}
  const request=root.crypto.randomUUID(),taskRequest=root.crypto.randomUUID();let selected=null,searchGeneration=0,record=null,pendingDetails=null;
  const modal=makeDialog(labels[kind]||labels.call,`
   <label>Type<select name="kind">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${k===kind?'selected':''}>${v}</option>`).join('')}</select></label>
   <div class="cf-fields"><label>Marketplace<select name="channel"><option value="ebay">eBay</option><option value="tiktok">TikTok</option><option value="other">Other / personal contact</option></select></label><label>Customer username / buyer ID<input name="buyer" value="${escape(context.buyer||'')}" maxlength="200"></label></div>
   ${context.conversationId?'<p class="cf-help">The original chat will be linked to this record.</p>':''}
   <section class="cf-order-picker"><h3>Link a purchased item <span data-cf-order-required></span></h3><div class="cf-search"><label>Search order history<input name="order_query" placeholder="Order number, customer name, username or item" maxlength="200"></label><button type="button" data-cf-search>Search orders</button></div><p class="cf-help" data-cf-search-status></p><div class="cf-order-results"></div><div class="cf-selected-order"></div></section>
   <h3>Customer details</h3>${contactFields({name:context.name||''})}<small>Saved order details fill these fields. You can add missing contact information.</small>
   <label>Title<input name="title" required maxlength="200" placeholder="${kind==='manual_return'?'Return for damaged clasp':'Call about complaint'}"></label>
   <label>Message / notes<textarea name="note" required rows="4" maxlength="10000" placeholder="What happened, what was agreed, and the next step"></textarea></label>
   <div data-cf-return-fields class="cf-fields"><label>Return quantity<input name="return_quantity" type="number" min="1" step="1" value="1" required></label><label>Return tracking number<input name="tracking_number" maxlength="150" placeholder="Tracking number provided to the customer"></label><label>Carrier<input name="carrier" maxlength="80" placeholder="USPS, UPS, FedEx…"></label></div>
   ${dueFields()}${photoFields()}<label>Assign a follow-up task (optional)<select name="owner"><option value="">Loading people…</option></select></label>
   <p class="cf-help">Saved to the shared Customer follow-ups page. Manual returns record arrangements made outside the marketplace return process.</p>`, 'Save follow-up');
  if(!modal)return;const f=modal.form,results=f.querySelector('.cf-order-results'),status=f.querySelector('[data-cf-search-status]');
  f.elements.channel.value=context.channel|| (context.buyer||context.lineId?'ebay':'other');
  if(context.conversationId){f.elements.channel.disabled=true;f.elements.buyer.readOnly=true;}
  const upload=photoPicker(modal,user,request);
  const syncKind=()=>{const ret=f.elements.kind.value==='manual_return';f.querySelector('[data-cf-return-fields]').hidden=!ret;f.querySelector('[data-cf-order-required]').textContent=ret?'· required':'· optional';if(ret&&f.elements.channel.value==='other')f.elements.channel.value='ebay';};
  f.elements.kind.addEventListener('change',syncKind);syncKind();
  function choose(item){selected=item;f.elements.return_quantity.max=item.quantity;f.elements.return_quantity.value=1;f.querySelector('.cf-selected-order').innerHTML=`<strong>${escape(item.order_number)} · ${escape(item.title)}</strong><p>${escape(item.contact.name||item.buyer_username)} · ${escape(item.buyer_username)} · Qty ${Number(item.quantity)}</p><button type="button" data-cf-clear>Change item</button>`;f.elements.buyer.value=item.buyer_username;for(const key of ['name','phone','email','address'])f.elements.namedItem('contact_'+key).value=item.contact[key]||'';results.innerHTML='';status.textContent='Exact order item selected.';}
  async function search(lineId=null){const generation=++searchGeneration;status.textContent='Searching saved orders…';results.innerHTML='';try{
   const channel=f.elements.channel.value;if(channel==='other')throw Error('Choose eBay or TikTok to search purchased items.');
   const items=checked(await db.rpc('search_customer_followup_orders',{_query:lineId?'':f.elements.order_query.value.trim(),_channel:channel,_buyer:f.elements.buyer.value.trim(),_line_id:lineId}));
   if(!modal.element.isConnected||generation!==searchGeneration)return;
   if(lineId&&items.length===1){choose(items[0]);return;}
   status.textContent=items.length>40?'Showing 40 matches. Narrow the search to find the exact item.':items.length?`${items.length} matching items. Select the item below.`:'No matching orders. Try the exact order number or customer username.';
   results.innerHTML=items.slice(0,40).map((item,i)=>`<button type="button" data-cf-pick="${i}"><strong>${escape(item.order_number)} · ${escape(item.title)}</strong><span>${escape(item.contact.name||item.buyer_username)} · ${escape(item.buyer_username)} · Item ${escape(item.item_number)} · Qty ${Number(item.quantity)}</span><small>${escape(orderTime(item))}</small></button>`).join('');
   results.querySelectorAll('[data-cf-pick]').forEach(b=>b.onclick=()=>choose(items[Number(b.dataset.cfPick)]));
   if(kind!=='manual_return'&&context.buyer&&items.length){for(const key of ['name','phone','email','address']){const el=f.elements.namedItem('contact_'+key);if(!el.value)el.value=items[0].contact[key]||'';}}
  }catch(e){if(generation===searchGeneration)status.textContent=e.message||'Could not search orders.';}}
  const clear=()=>{if(selected){for(const key of ['name','phone','email','address'])f.elements.namedItem('contact_'+key).value='';}selected=null;searchGeneration++;results.innerHTML='';f.querySelector('.cf-selected-order').innerHTML='';status.textContent='';};
  f.elements.channel.addEventListener('change',clear);f.elements.buyer.addEventListener('input',clear);
  f.querySelector('[data-cf-search]').onclick=()=>search();
  f.elements.order_query.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
  f.addEventListener('click',e=>{if(e.target.closest('[data-cf-clear]')){clear();search();}});
  f.addEventListener('submit',async e=>{
   e.preventDefault();if(!f.reportValidity())return;
   if(f.elements.kind.value==='manual_return'&&!selected){modal.error('Select the exact purchased item before saving a return.');return;}
   modal.error('');const owner=f.elements.owner.value;
   if(!pendingDetails)pendingDetails={kind:f.elements.kind.value,channel:f.elements.channel.value,buyer_username:f.elements.buyer.value.trim(),
    line_id:selected?.line_id||null,contact:contactValues(f),title:f.elements.title.value.trim(),note:f.elements.note.value.trim(),
    return_quantity:Number(f.elements.return_quantity.value),tracking_number:f.elements.tracking_number.value.trim(),carrier:f.elements.carrier.value.trim(),due_at:dueValue(f.elements.due_at.value),priority:f.elements.priority.value,
    conversation_id:context.conversationId||null,message_id:context.messageId||null};
   modal.busy(true);
   try{
    if(!record){pendingDetails.photos=await upload(db);record=checked(await db.rpc('create_customer_followup',{_request_id:request,_details:pendingDetails}));}
    if(owner)await createTask(db,record.id,taskRequest,{owner,title:pendingDetails.title,instructions:pendingDetails.note,due_at:pendingDetails.due_at,priority:pendingDetails.priority});
    saved(modal,record);
    if(!document.getElementById('cf-page')){const a=document.createElement('a');a.href=`customer-followups.html?id=${encodeURIComponent(record.id)}`;a.className='cf-saved-toast';a.textContent='Follow-up saved — open record';document.body.append(a);setTimeout(()=>a.remove(),15000);}
   }catch(err){modal.busy(false);if(context.conversationId)f.elements.channel.disabled=true;
    modal.error(record?'The record is saved, but its task could not be created. Retry, or cancel and open it in Customer follow-ups. '+err.message:(err.message||'Save could not be confirmed. Retry the same save.'));
    if(err.code)pendingDetails=null;
   }
  });
  try{await people(f,db,user);if(kind!=='manual_return')f.elements.owner.value=user;}catch(e){modal.error('People could not load. You can save the record and assign a task later.');f.elements.owner.innerHTML='<option value="">Assign later</option>';}
  if(context.lineId)await search(context.lineId);else if(context.buyer&&f.elements.channel.value!=='other')await search();
 }
 async function createTask(db,id,request,details){return checked(await db.rpc('create_customer_followup_task',{_id:id,_request_id:request,_details:details}));}
 async function task(record){
  if(dialog)return;const {db,user}=await connection(),request=root.crypto.randomUUID();
  const modal=makeDialog('Assign follow-up task',`<p>${escape(record.title)}</p><label>Task title<input name="title" required maxlength="200" value="${escape(record.title)}"></label><label>Instructions<textarea name="instructions" required maxlength="10000" rows="4"></textarea></label><label>Responsible person<select name="owner" required><option value="">Loading…</option></select></label>${dueFields(record)}`,'Create task');
  try{await people(modal.form,db,user,false);}catch(e){modal.error(e.message);return;}
  modal.form.addEventListener('submit',async e=>{e.preventDefault();const f=modal.form;if(!f.reportValidity())return;
   const details={owner:f.elements.owner.value,title:f.elements.title.value.trim(),instructions:f.elements.instructions.value.trim(),due_at:dueValue(f.elements.due_at.value),priority:f.elements.priority.value};modal.busy(true);
   try{await createTask(db,record.id,request,details);saved(modal,record);}catch(err){modal.busy(false);modal.error(err.message);}
  });
 }
 async function update(record){
  if(dialog)return;const {db,user}=await connection(),request=root.crypto.randomUUID();
  const modal=makeDialog('Update follow-up',`<label>Title<input name="title" required maxlength="200" value="${escape(record.title)}"></label>${contactFields(record.contact)}
   <div class="cf-fields"><label>Status<select name="status">${['open','waiting','closed','cancelled'].map(s=>`<option ${s===record.status?'selected':''}>${s}</option>`).join('')}</select></label>${record.kind==='manual_return'?`<label>Return quantity<input name="return_quantity" type="number" min="1" max="${Number(record.order_snapshot.quantity)}" step="1" value="${Number(record.return_quantity||1)}" required></label><label>Return progress<select name="return_stage">${Object.entries(stages).map(([k,v])=>`<option value="${k}" ${record.return_stage===k?'selected':''}>${v}</option>`).join('')}</select></label><label>Return tracking number<input name="tracking_number" maxlength="150" value="${escape(record.tracking_number)}"></label><label>Carrier<input name="carrier" maxlength="80" value="${escape(record.carrier)}"></label>`:''}</div>
   ${dueFields(record)}<label>Note / call outcome<textarea name="note" rows="4" maxlength="10000" placeholder="What happened and what should happen next?"></textarea></label>${photoFields()}`,'Save update');
  const upload=photoPicker(modal,user,request);
  modal.form.addEventListener('submit',async e=>{e.preventDefault();const f=modal.form;if(!f.reportValidity())return;
   const details={title:f.elements.title.value.trim(),contact:contactValues(f),status:f.elements.status.value,due_at:dueValue(f.elements.due_at.value),priority:f.elements.priority.value,note:f.elements.note.value.trim(),
    ...(record.kind==='manual_return'?{return_quantity:Number(f.elements.return_quantity.value),return_stage:f.elements.return_stage.value,tracking_number:f.elements.tracking_number.value.trim(),carrier:f.elements.carrier.value.trim()}:{})};modal.busy(true);
   try{details.photos=await upload(db);const result=checked(await db.rpc('update_customer_followup',{_id:record.id,_revision:record.revision,_request_id:request,_details:details}));saved(modal,result);}catch(err){modal.busy(false);modal.error(err.message);}
  });
 }
 document.addEventListener('click',e=>{const b=e.target.closest('[data-cf-kind]');if(!b||b.disabled)return;e.preventDefault();e.stopPropagation();let context={};try{context=JSON.parse(b.dataset.cfContext||'{}');}catch{}void open(b.dataset.cfKind,context);},true);
 root.OGCustomerFollowups={open,buttons,task,update,escape,labels,stages,displayTime,orderTime,checked};
})(window);
