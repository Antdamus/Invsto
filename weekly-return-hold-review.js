(() => {
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const time=s=>new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const get=(el,ref)=>el.wh.reviews?.[ref]||{};
 const modes=[['all','All returns'],['unchecked','Not inspected'],['checked','Inspected']];
 const marked=(el,r)=>!!get(el,r.ref).mark?.inspected;
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
 const controls='<section class="whr-filters" hidden aria-label="Return inspection filters"><strong>Return inspections</strong><div class="whr-modes"></div></section><p class="whr-notice" role="status" aria-live="polite"></p>';
 function filter(el,rows,kind){
  const box=el.querySelector('.whr-filters');
  box.hidden=kind!=='return'||!el.wh.reviews;
  if(box.hidden)return rows;
  const mode=el.wh.inspection||'all',checked=rows.filter(r=>marked(el,r)).length;
  box.querySelector('.whr-modes').innerHTML=modes.map(([k,label],i)=>'<button type="button" data-inspection-mode="'+k+'" aria-pressed="'+(k===mode)+'">'+label+' <b>'+[rows.length,rows.length-checked,checked][i]+'</b></button>').join('');
  return rows.filter(r=>mode==='all'||marked(el,r)===(mode==='checked'));
 }
 function card(el,r){
  if(r.kind!=='return'||!el.wh.reviews)return '';
  const review=get(el,r.ref),m=review.mark,done=m?.inspected,busy=el.wh.saving?.has(r.ref);
  return '<section class="whr-card" data-return-ref="'+esc(r.ref)+'" aria-label="Return inspection"><div class="whr-info"><strong class="'+(done?'whr-done':'')+'">'+(done?'✓ Inspected':'Not inspected')+'</strong>'+
   (done?'<small>'+esc(m.signer)+' · '+esc(time(m.at))+'</small>':'')+'</div><div class="whr-buttons"><button type="button" class="whr-mark" '+(busy?'disabled':'')+'>'+ (busy?'Saving…':done?'Undo inspection':'Mark inspected')+'</button><button type="button" class="whr-task">Create task</button></div>'+
   ((review.tasks||[]).length?'<ul>'+review.tasks.map(t=>'<li><a href="team-tasks.html?taskId='+encodeURIComponent(t.id)+'" target="_blank" rel="noopener">View task ↗</a> · '+esc(t.owner||'Unassigned')+' · '+esc(String(t.status).replace(/_/g,' '))+'</li>').join('')+'</ul>':'')+'</section>';
 }
 const dialogHTML='<dialog class="whr-dialog" aria-labelledby="whr-title"><form><h3 id="whr-title">Create a follow-up task</h3><p class="whr-context"></p><label>Assign to<select name="owner" required></select></label><label>What needs to be done?<textarea name="note" rows="4" maxlength="4000" required></textarea></label><p class="whr-error" role="alert"></p><div><button type="button" class="whr-cancel">Cancel</button><button type="submit">Assign task</button></div></form></dialog>';
 const notify=(el,msg)=>{el.querySelector('.whr-notice').textContent=msg;};
 async function rpc(s,name,args){
  const {data,error}=await s.client.rpc(name,args);if(error)throw Error(error.message||'Could not save. Try again.');return data;
 }
 function focusAt(el,ref,selector){
  const target=el.querySelector('[data-return-ref="'+CSS.escape(ref)+'"] '+selector)||el.querySelector('[data-inspection-mode][aria-pressed=true]');
  target?.focus({preventScroll:true});
 }
 function saveLocal(el,s,ref,result,redraw){
  if(el.wh!==s)return;
  s.reviews={...s.reviews,[ref]:result};redraw(el);
  // Retire any report read already in flight before the successful write.
  s.load?.();
 }
 async function mark(el,ref,redraw){
  const s=el.wh,m=get(el,ref).mark,done=!m?.inspected;
  s.saving??=new Set();if(s.saving.has(ref))return;s.saving.add(ref);redraw(el);
  try{
   const result=await rpc(s,'set_return_hold_inspected',{_ref:ref,_inspected:done,_revision:m?.revision||0});
   if(el.wh!==s)return;notify(el,'Return '+ref+(done?' marked inspected.':' marked not inspected.'));
   saveLocal(el,s,ref,result,redraw);
  }catch(e){if(el.wh===s)notify(el,e.message);}
  finally{s.saving.delete(ref);if(el.wh===s){redraw(el);focusAt(el,ref,'.whr-mark');}}
 }
 async function compose(el,ref,redraw){
  const s=el.wh,r=s.entries.find(v=>v.kind==='return'&&v.ref===ref);if(!r)return;
  const d=el.querySelector('.whr-dialog'),form=d.querySelector('form'),owner=form.elements.owner,note=form.elements.note,send=form.querySelector('[type=submit]'),cancel=form.querySelector('.whr-cancel'),error=form.querySelector('.whr-error');
  const request=crypto.randomUUID();d.dataset.request=request;
  form.reset();error.textContent='';d.querySelector('.whr-context').textContent='Return '+ref+(r.oid?' · Order '+r.oid:'');
  owner.innerHTML='<option value="">Loading employees…</option>';send.disabled=owner.disabled=true;cancel.disabled=false;note.disabled=false;
  d.showModal();let submitting=false;
  cancel.onclick=()=>d.close();d.oncancel=e=>{if(submitting)e.preventDefault();};
  d.onclose=()=>{if(el.wh===s)focusAt(el,ref,'.whr-task');};
  form.onsubmit=async e=>{
   e.preventDefault();if(submitting||send.disabled)return;
   if(!note.value.trim()){error.textContent='Describe the follow-up first.';note.focus();return;}
   submitting=true;send.disabled=cancel.disabled=owner.disabled=note.disabled=true;error.textContent='';send.textContent='Assigning…';
   try{
    const result=await rpc(s,'create_return_hold_task',{_request:request,_ref:ref,_owner:owner.value,_note:note.value.trim()});
    if(el.wh!==s)return;d.close();notify(el,'Task assigned for return '+ref+'.');saveLocal(el,s,ref,result,redraw);
   }catch(e){error.textContent=e.message;}
   finally{submitting=false;send.disabled=cancel.disabled=owner.disabled=note.disabled=false;send.textContent='Assign task';}
  };
  try{
   const users=await rpc(s,'list_team_task_assignees');if(el.wh!==s||!d.open||d.dataset.request!==request)return;
   owner.innerHTML='<option value="">Choose an employee</option>'+users.map(u=>'<option value="'+esc(u.user_id)+'">'+esc(u.display_name||u.email)+'</option>').join('');
   send.disabled=owner.disabled=!users.length;if(!users.length)error.textContent='No active employees available for assignment.';
  }catch(e){if(d.dataset.request===request){owner.innerHTML='<option value="">Unavailable</option>';error.textContent='Could not load employees. Close and try again.';}}
 }
 function click(el,b,redraw){
  if(b.hasAttribute('data-inspection-mode')){
   el.wh.inspection=b.dataset.inspectionMode;el.wh.page=0;redraw(el);el.querySelector('[data-inspection-mode][aria-pressed=true]')?.focus({preventScroll:true});return true;
  }
  const ref=b.closest('[data-return-ref]')?.dataset.returnRef;if(!ref)return false;
  if(b.matches('.whr-mark')){mark(el,ref,redraw);return true;}
  if(b.matches('.whr-task')){compose(el,ref,redraw);return true;}
  return false;
 }
 window.WeeklyReturnHoldReview={controls,dialogHTML,filter,card,click,identity};
})();
