(() => {
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const time=s=>new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const key=r=>r.kind+':'+r.ref, labels={sale:'Original sale credit',return:'Return',dispute:'Payment dispute',retro:'Sale funds held again',other:'Other eBay hold'};
 const canReview=k=>['return','dispute','retro'].includes(k);
 const get=(el,r)=>el.wh.reviews?.[key(r)]||{};
 const marked=(el,r)=>!!get(el,r).mark?.inspected;
 function identity(r){
  const c=r.item_context;if(!c)return '';
  const username=c.user?'@'+c.user.replace(/^@/,''):'',items=c.items||[],isReturn=r.kind==='return';
  const label=isReturn?(c.source==='case'?'Item on eBay return':'Returned order line'):'Order item';
  const item=i=>'<b>'+esc(i.title||'Title unavailable')+'</b>'+(i.number?'<span>Item #'+esc(i.number)+'</span>':'');
  return '<section class="whr-identity"><div><small>Customer</small><b>'+esc(c.name||username||'Name unavailable')+'</b>'+
   (c.name&&username&&c.name.toLowerCase()!==c.user.toLowerCase()?'<span>'+esc(username)+'</span>':'')+
   (!c.name&&c.ship_name?'<span>Ship to: '+esc(c.ship_name)+'</span>':'')+'</div><div><small>'+label+'</small>'+(items.length?item(items[0]):'<b>'+(isReturn?'Order line not matched':'Title unavailable')+'</b>')+
   (c.source==='case'?'<span>Order line not matched</span>':'')+
   (items.length>1?'<details><summary>Show '+(items.length-1)+' more '+(items.length===2?'item':'items')+'</summary><ul>'+items.slice(1).map(i=>'<li>'+item(i)+'</li>').join('')+'</ul></details>':'')+
   (c.case_id?'<a href="ebay-returns.html?caseId='+encodeURIComponent(c.case_id)+'" target="_blank" rel="noopener">View return ↗</a>':'')+'</div></section>';
 }
 const controls='<section class="whr-filters" hidden aria-label="Inspection filters"><strong>Inspections</strong><div class="whr-modes"></div></section><p class="whr-notice" role="status" aria-live="polite"></p>';
 function filter(el,rows,kind){
  const box=el.querySelector('.whr-filters');
  box.hidden=!canReview(kind)||!el.wh.reviews;
  if(box.hidden)return rows;
  const modes=[['all',kind==='return'?'All returns':kind==='dispute'?'All disputes':'All repeat holds'],['unchecked','Not inspected'],['checked','Inspected']];
  const mode=el.wh.inspections?.[kind]||'all',checked=rows.filter(r=>marked(el,r)).length;
  box.querySelector('.whr-modes').innerHTML=modes.map(([k,label],i)=>'<button type="button" data-inspection-mode="'+k+'" aria-pressed="'+(k===mode)+'">'+label+' <b>'+[rows.length,rows.length-checked,checked][i]+'</b></button>').join('');
  return rows.filter(r=>mode==='all'||marked(el,r)===(mode==='checked'));
 }
 function card(el,r){
  if(!el.wh.reviews)return '';
  const review=get(el,r),m=review.mark,done=m?.inspected,busy=el.wh.saving?.has(key(r)),full=canReview(r.kind),notes=review.notes||[];
  const note=n=>'<p class="whr-note-body">'+esc(n.body)+'</p><small>'+esc(n.signer)+' · '+esc(time(n.at))+'</small>';
  return '<section class="whr-card" data-hold-key="'+esc(key(r))+'" aria-label="'+esc(labels[r.kind])+' follow-up"><div class="whr-info"><strong class="'+(done?'whr-done':'')+'">'+(full?(done?'✓ Inspected':'Not inspected'):'Team notes')+'</strong>'+
   (done?'<small>'+esc(m.signer)+' · '+esc(time(m.at))+'</small>':'')+'</div><div class="whr-buttons">'+(full?'<button type="button" class="whr-mark" '+(busy?'disabled':'')+'>'+ (busy?'Saving…':done?'Undo inspection':'Mark inspected')+'</button><button type="button" class="whr-task">Create task</button>'+(window.WeeklyRefundReminders?.card(el,r)||''):'')+'<button type="button" class="whr-note">Add note</button></div>'+
   ((review.tasks||[]).length?'<ul>'+review.tasks.map(t=>'<li><a href="team-tasks.html?taskId='+encodeURIComponent(t.id)+'" target="_blank" rel="noopener">View task ↗</a> · '+esc(t.owner||'Unassigned')+' · '+esc(String(t.status).replace(/_/g,' '))+'</li>').join('')+'</ul>':'')+
   (notes.length?'<section class="whr-notes"><strong>Latest note</strong>'+note(notes[0])+(notes.length>1?'<details><summary>Earlier notes ('+(notes.length-1)+')</summary>'+notes.slice(1).map(n=>'<div>'+note(n)+'</div>').join('')+'</details>':'')+'</section>':'')+'</section>';
 }
 const dialogHTML='<dialog class="whr-dialog" aria-labelledby="whr-title"><form><h3 id="whr-title">Create a follow-up task</h3><p class="whr-context"></p><label>Assign to<select name="owner" required></select></label><label>What needs to be done?<textarea name="note" rows="4" maxlength="4000" required></textarea></label><p class="whr-error" role="alert"></p><div><button type="button" class="whr-cancel">Cancel</button><button type="submit">Assign task</button></div></form></dialog>';
 const notify=(el,msg)=>{el.querySelector('.whr-notice').textContent=msg;};
 async function rpc(s,name,args){
  const {data,error}=await s.client.rpc(name,args);if(error)throw Error(error.message||'Could not save. Try again.');return data;
 }
 function focusAt(el,id,selector){
  const target=el.querySelector('[data-hold-key="'+CSS.escape(id)+'"] '+selector)||el.querySelector('[data-inspection-mode][aria-pressed=true]');
  target?.focus({preventScroll:true});
 }
 function saveLocal(el,s,ref,result,redraw){
  if(el.wh!==s)return;
  s.reviews={...s.reviews,[ref]:result};redraw(el);
  // Retire any report read already in flight before the successful write.
  s.load?.();
 }
 async function mark(el,r,redraw){
  const s=el.wh,m=get(el,r).mark,done=!m?.inspected,id=key(r);
  s.saving??=new Set();if(s.saving.has(id))return;s.saving.add(id);redraw(el);
  try{
   const result=await rpc(s,'set_ebay_hold_inspected',{_kind:r.kind,_ref:r.ref,_inspected:done,_revision:m?.revision||0});
   if(el.wh!==s)return;notify(el,labels[r.kind]+' '+r.ref+(done?' marked inspected.':' marked not inspected.'));
   saveLocal(el,s,id,result,redraw);
  }catch(e){if(el.wh===s)notify(el,e.message);}
  finally{s.saving.delete(id);if(el.wh===s){redraw(el);focusAt(el,id,'.whr-mark');}}
 }
 async function compose(el,r,redraw,isNote=false){
  const s=el.wh,id=key(r);
  const d=el.querySelector('.whr-dialog'),form=d.querySelector('form'),owner=form.elements.owner,note=form.elements.note,send=form.querySelector('[type=submit]'),cancel=form.querySelector('.whr-cancel'),error=form.querySelector('.whr-error');
  const request=crypto.randomUUID();d.dataset.request=request;
  form.reset();error.textContent='';d.querySelector('.whr-context').textContent=labels[r.kind]+' '+r.ref+(r.oid?' · Order '+r.oid:'');
  const verb=isNote?'Save note':'Assign task';d.querySelector('h3').textContent=isNote?'Add a team note':'Create a follow-up task';
  owner.closest('label').hidden=isNote;note.closest('label').firstChild.textContent=isNote?'Note for the team':'What needs to be done?';
  send.textContent=verb;owner.innerHTML='<option value="">Loading employees…</option>';send.disabled=!isNote;owner.disabled=true;cancel.disabled=false;note.disabled=false;
  d.showModal();let submitting=false;
  cancel.onclick=()=>d.close();d.oncancel=e=>{if(submitting)e.preventDefault();};
  d.onclose=()=>{if(el.wh===s)focusAt(el,id,isNote?'.whr-note':'.whr-task');};
  form.onsubmit=async e=>{
   e.preventDefault();if(submitting||send.disabled)return;
   if(!note.value.trim()){error.textContent=isNote?'Write a note first.':'Describe the follow-up first.';note.focus();return;}
   submitting=true;send.disabled=cancel.disabled=owner.disabled=note.disabled=true;error.textContent='';send.textContent='Saving…';
   try{
    const result=await rpc(s,isNote?'add_ebay_hold_note':'create_ebay_hold_task',{_request:request,_kind:r.kind,_ref:r.ref,...(isNote?{}:{_owner:owner.value}),_note:note.value.trim()});
    if(el.wh!==s)return;d.close();notify(el,(isNote?'Note saved for ':'Task assigned for ')+labels[r.kind]+' '+r.ref+'.');saveLocal(el,s,id,result,redraw);
   }catch(e){error.textContent=e.message;}
   finally{submitting=false;send.disabled=cancel.disabled=note.disabled=false;owner.disabled=isNote;send.textContent=verb;}
  };
  if(isNote){note.focus();return;}
  try{
   const users=await rpc(s,'list_team_task_assignees');if(el.wh!==s||!d.open||d.dataset.request!==request)return;
   owner.innerHTML='<option value="">Choose an employee</option>'+users.map(u=>'<option value="'+esc(u.user_id)+'">'+esc(u.display_name||u.email)+'</option>').join('');
   send.disabled=owner.disabled=!users.length;if(!users.length)error.textContent='No active employees available for assignment.';
  }catch(e){if(d.dataset.request===request){owner.innerHTML='<option value="">Unavailable</option>';error.textContent='Could not load employees. Close and try again.';}}
 }
 function click(el,b,redraw){
  if(b.hasAttribute('data-refund-remind')){window.WeeklyRefundReminders?.open(el,b.dataset.refundRemind,redraw);return true;}
  if(b.hasAttribute('data-inspection-mode')){
   (el.wh.inspections??={})[el.querySelector('.wh-kind').value]=b.dataset.inspectionMode;el.wh.page=0;redraw(el);el.querySelector('[data-inspection-mode][aria-pressed=true]')?.focus({preventScroll:true});return true;
  }
  const id=b.closest('[data-hold-key]')?.dataset.holdKey;if(!id)return false;
  const r=el.wh.entries.find(v=>key(v)===id);if(!r)return false;
  if(b.matches('.whr-mark')){mark(el,r,redraw);return true;}
  if(b.matches('.whr-task,.whr-note')){compose(el,r,redraw,b.matches('.whr-note'));return true;}
  return false;
 }
 window.WeeklyReturnHoldReview={controls,dialogHTML,filter,card,click,identity,labels,key};
})();
