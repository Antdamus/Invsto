(() => {
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const day=s=>new Date(s+'T12:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const review=()=>window.WeeklyReturnHoldReview;
 function card(el,r){
  if(!el.wh.reminders)return '';
  const id=review().key(r),rem=el.wh.reminders[id];return '<button type="button" data-refund-remind="'+esc(id)+'">'+(rem&&!rem.sent?'Edit reminder':r.kind==='return'?'Remind me to refund':'Remind me to follow up')+'</button>'+
   (rem?'<small class="whr-reminder-stamp">'+(rem.sent?'Reminder sent':'Your reminder')+' · '+esc(day(rem.day))+'</small>':'');
 }
 function list(el){
  const slot=el.querySelector('.whr-reminder-list');if(!slot)return;
  const pending=Object.entries(el.wh.reminders||{}).filter(([,r])=>!r.sent).sort((a,b)=>a[1].day.localeCompare(b[1].day));
  const open=slot.firstElementChild?.open;slot.innerHTML=pending.length?'<details'+(open?' open':'')+'><summary>My scheduled hold reminders ('+pending.length+')</summary><ul>'+pending.map(([id,r])=>'<li><span><b>'+esc(day(r.day))+'</b> · '+esc(review().labels[r.kind])+' '+esc(r.ref)+(r.order?' · Order '+esc(r.order):'')+'</span> <button type="button" data-refund-remind="'+esc(id)+'">Edit reminder</button></li>').join('')+'</ul></details>':'';
 }
 function open(el,id,redraw){
  const s=el.wh,rem=s.reminders?.[id],entry=s.entries.find(r=>review().key(r)===id)||rem;if(!entry)return;
  const {kind,ref}=entry,isReturn=kind==='return';let d=el.querySelector('.whr-reminder-dialog');
  if(!d){d=document.createElement('dialog');d.className='whr-dialog whr-reminder-dialog';d.setAttribute('aria-labelledby','whr-reminder-title');
   d.innerHTML='<form><h3 id="whr-reminder-title">Remind me to refund</h3><p class="whr-context"></p><label>Refund by<input type="date" name="day" required></label><small>Invsto will notify you at 9:00 AM Eastern on this date, even when the report is closed. If that time has passed today, the reminder is due now.</small><p class="whr-error" role="alert"></p><div><button type="button" class="whr-remove">Remove reminder</button><button type="button" class="whr-cancel">Cancel</button><button type="submit">Save reminder</button></div></form>';
   el.append(d);}
  const form=d.querySelector('form'),field=form.elements.day,error=d.querySelector('.whr-error'),remove=d.querySelector('.whr-remove'),cancel=d.querySelector('.whr-cancel');
  const order=entry.oid||rem?.order;
  d.querySelector('h3').textContent=isReturn?'Remind me to refund':'Remind me to follow up';field.closest('label').firstChild.textContent=isReturn?'Refund by':'Follow up by';
  d.querySelector('.whr-context').textContent=review().labels[kind]+' '+ref+(order?' · Order '+order:'');field.min=today();field.value=rem&&!rem.sent?rem.day:'';remove.hidden=!rem||!!rem.sent;error.textContent='';
  let saving=false;const save=async chosen=>{
   if(saving)return;saving=true;for(const e of form.elements)e.disabled=true;
   try{
    const {data,error:failure}=await s.client.rpc('set_ebay_hold_reminder',{_kind:kind,_ref:ref,_day:chosen});
    if(failure)throw Error(failure.message);if(el.wh!==s)return;s.reminders=data;d.close();redraw(el);
    el.querySelector('.whr-notice').textContent=chosen?'Reminder saved for '+day(chosen)+'.':'Reminder removed.';
    s.load?.();
   }catch(e){error.textContent=e.message||'Could not save. Try again.';}
   finally{saving=false;for(const e of form.elements)e.disabled=false;}
  };
  form.onsubmit=e=>{e.preventDefault();save(field.value);};remove.onclick=()=>save(null);cancel.onclick=()=>d.close();
  d.oncancel=e=>{if(saving)e.preventDefault();};d.onclose=()=>el.querySelector('[data-hold-key="'+CSS.escape(id)+'"] [data-refund-remind]')?.focus({preventScroll:true});d.showModal();
 }
 window.WeeklyRefundReminders={card,list,open};
})();
