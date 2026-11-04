(() => {
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const day=s=>new Date(s+'T12:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 function card(el,ref){
  if(!el.wh.reminders)return '';
  const rem=el.wh.reminders[ref];return '<button type="button" data-refund-remind="'+esc(ref)+'">'+(rem&&!rem.sent?'Edit reminder':'Remind me to refund')+'</button>'+
   (rem?'<small class="whr-reminder-stamp">'+(rem.sent?'Reminder sent':'Your reminder')+' · '+esc(day(rem.day))+'</small>':'');
 }
 function list(el){
  const slot=el.querySelector('.whr-reminder-list');if(!slot)return;
  const pending=Object.entries(el.wh.reminders||{}).filter(([,r])=>!r.sent).sort((a,b)=>a[1].day.localeCompare(b[1].day));
  const open=slot.firstElementChild?.open;slot.innerHTML=pending.length?'<details'+(open?' open':'')+'><summary>My scheduled refund reminders ('+pending.length+')</summary><ul>'+pending.map(([ref,r])=>'<li><span><b>'+esc(day(r.day))+'</b> · Return '+esc(ref)+(r.order?' · Order '+esc(r.order):'')+'</span> <button type="button" data-refund-remind="'+esc(ref)+'">Edit reminder</button></li>').join('')+'</ul></details>':'';
 }
 function open(el,ref,redraw){
  const s=el.wh,rem=s.reminders?.[ref];let d=el.querySelector('.whr-reminder-dialog');
  if(!d){d=document.createElement('dialog');d.className='whr-dialog whr-reminder-dialog';d.setAttribute('aria-labelledby','whr-reminder-title');
   d.innerHTML='<form><h3 id="whr-reminder-title">Remind me to refund</h3><p class="whr-context"></p><label>Refund by<input type="date" name="day" required></label><small>Invsto will notify you at 9:00 AM Eastern on this date, even when the report is closed. If that time has passed today, the reminder is due now.</small><p class="whr-error" role="alert"></p><div><button type="button" class="whr-remove">Remove reminder</button><button type="button" class="whr-cancel">Cancel</button><button type="submit">Save reminder</button></div></form>';
   el.append(d);}
  const form=d.querySelector('form'),field=form.elements.day,error=d.querySelector('.whr-error'),remove=d.querySelector('.whr-remove'),cancel=d.querySelector('.whr-cancel');
  const order=s.entries.find(r=>r.kind==='return'&&r.ref===ref)?.oid||rem?.order;
  d.querySelector('.whr-context').textContent='Return '+ref+(order?' · Order '+order:'');field.min=today();field.value=rem&&!rem.sent?rem.day:'';remove.hidden=!rem||!!rem.sent;error.textContent='';
  let saving=false;const save=async chosen=>{
   if(saving)return;saving=true;for(const e of form.elements)e.disabled=true;
   try{
    const {data,error:failure}=await s.client.rpc('set_hold_refund_reminder',{_ref:ref,_day:chosen});
    if(failure)throw Error(failure.message);if(el.wh!==s)return;s.reminders=data;d.close();redraw(el);
    el.querySelector('.whr-notice').textContent=chosen?'Refund reminder saved for '+day(chosen)+'.':'Refund reminder removed.';
    s.load?.();
   }catch(e){error.textContent=e.message||'Could not save. Try again.';}
   finally{saving=false;for(const e of form.elements)e.disabled=false;}
  };
  form.onsubmit=e=>{e.preventDefault();save(field.value);};remove.onclick=()=>save(null);cancel.onclick=()=>d.close();
  d.oncancel=e=>{if(saving)e.preventDefault();};d.onclose=()=>el.querySelector('[data-return-ref="'+CSS.escape(ref)+'"] [data-refund-remind]')?.focus({preventScroll:true});d.showModal();
 }
 window.WeeklyRefundReminders={card,list,open};
})();
