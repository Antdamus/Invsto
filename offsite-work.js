/* Shared employee/admin outing UI. Evidence is private and signed only when opened. */
(function(root){
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=s=>s?new Date(s).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
 const duration=(start,end)=>{const m=Math.max(0,Math.floor(((end?new Date(end):Date.now())-new Date(start))/60000));return `${Math.floor(m/60)}h ${m%60}m`;};
 const status=w=>!w.ended_at?'Working off-site':w.end_kind==='returned'?'Returned to store':w.end_kind==='offsite_clockout'?'Off-site clock-out':'Admin resolved · location unverified';
 const labels={start:'Left for assignment',update:'Progress & evidence',return:'Returned to store',finish:'Finished shift off-site',break_start:'Break started',break_end:'Break ended',review:'Admin review',resolve:'Admin resolution'};
 const proofActions=new Set(['return','finish','break_start','break_end']);
 let worker, admin;
 function create(host,options){
  const state={host,options,rows:[],active:null,openShift:null,openBreak:null,employee:null,busy:false,loading:false,limit:20,form:null,filter:'active',expanded:new Set()};
  host.classList.add('offsite-panel');
  host.innerHTML=`<div class="ow-heading"><div><span class="ow-kicker">${options.admin?'Attendance & evidence':'Paid work away from the store'}</span><h3>Off-site work</h3></div><button type="button" class="ow-button" data-ow="refresh">Refresh</button></div>
   <p class="ow-intro">${options.admin?'Review assignments, delivery proof, and where each shift ended.':'Stay clocked in while completing a delivery or assignment. Breaks are recorded separately.'}</p>
   ${options.admin?'<div class="ow-filters"><label>Show<select data-ow-filter><option value="active">Currently away</option><option value="review">Needs admin review</option><option value="clockout">All off-site clock-outs</option><option value="history">All outings</option></select></label><label data-ow-month-label hidden>Month<input type="month" data-ow-month></label></div>':'<div data-ow-controls></div>'}
   <p data-ow-message class="ow-message" role="status" aria-live="polite"></p><div data-ow-form></div><div data-ow-list></div><button type="button" class="ow-button" data-ow="more" hidden>Show more outings</button>`;
  host.addEventListener('click',ev=>handle(state,ev));
  host.addEventListener('change',ev=>{
   if(ev.target.matches('[data-ow-filter], [data-ow-month]')){state.filter=host.querySelector('[data-ow-filter]').value;state.limit=20;load(state);}
  });
  if(options.admin){const d=new Date();host.querySelector('[data-ow-month]').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}
  return state;
 }
 function message(st,text,error=false){const el=st.host.querySelector('[data-ow-message]');el.textContent=text;el.classList.toggle('ow-error',error);}
 async function checked(query){const r=await query;if(r.error)throw r.error;return r.data;}
 async function load(st){
  if(st.loading||st.busy)return;
  st.loading=true;
  try{
   const db=st.options.db();
   let q=db.from('work_outings').select('*').order('started_at',{ascending:false}).limit(st.limit+1);
   if(st.options.admin){
    st.host.querySelector('[data-ow-month-label]').hidden=!['history','clockout'].includes(st.filter);
    if(st.filter==='active')q=q.is('ended_at',null);
    if(st.filter==='review')q=q.not('ended_at','is',null).is('reviewed_at',null).in('end_kind',['offsite_clockout','admin_resolved']);
    if(st.filter==='clockout')q=q.eq('shift_ended_offsite',true);
    if(['history','clockout'].includes(st.filter)){
     const val=st.host.querySelector('[data-ow-month]').value;
     if(!val)return;
     const [y,m]=val.split('-').map(Number);
     q=q.gte('started_at',new Date(y,m-1,1).toISOString()).lt('started_at',new Date(y,m,1).toISOString());
    }
   }else{
    st.employee=st.options.employee();if(!st.employee?.id)return;
    q=q.eq('employee_id',st.employee.id);
    const [shifts,active]=await Promise.all([
     checked(db.from('time_entries').select('id').eq('employee_id',st.employee.id).is('clock_out',null).limit(1)),
     checked(db.from('work_outings').select('*').eq('employee_id',st.employee.id).is('ended_at',null).limit(1))
    ]);
    st.openShift=shifts?.[0]||null;st.active=active?.[0]||null;
    const breaks=st.openShift?await checked(db.from('time_breaks').select('id').eq('time_entry_id',st.openShift.id).is('ended_at',null).limit(1)):[];
    st.openBreak=breaks?.[0]||null;
   }
   const rows=await checked(q)||[];
   st.host.querySelector('[data-ow="more"]').hidden=rows.length<=st.limit;
   st.rows=rows.slice(0,st.limit);
   if(st.active&&!st.rows.some(w=>w.id===st.active.id))st.rows.unshift(st.active);
   if(st.options.admin){
    const ids=[...new Set(st.rows.map(w=>w.employee_id))];
    const names=ids.length?await checked(db.from('employees').select('id,display_name').in('id',ids)):[];
    st.names=new Map((names||[]).map(e=>[e.id,e.display_name]));
   }
   render(st);
  }catch(err){message(st,`Off-site work could not refresh: ${err.message}. Use Refresh to retry.`,true);}
  finally{st.loading=false;}
 }
 function render(st){
  if(!st.options.admin){
   st.host.querySelector('[data-ow-controls]').innerHTML=st.active?'':
    `<button class="ow-button ow-primary" data-ow="start" ${!st.openShift||st.openBreak?'disabled':''}>Start off-site work</button><p class="ow-muted">${!st.openShift?'Clock in first to start an assignment.':st.openBreak?'End your break before leaving on an assignment.':'Enter your assignment before leaving. Instructions and screenshots are optional.'}</p>`;
  }
  const cards=st.rows.map(w=>{
   const review=w.ended_at&&w.end_kind!=='returned';const late=!w.ended_at&&w.expected_return_at&&Date.parse(w.expected_return_at)<Date.now();
   return `<article class="ow-card ${!w.ended_at?'ow-active':''}" data-outing="${w.id}"><div class="ow-card-head"><div><span class="ow-badge ${review&&!w.reviewed_at?'ow-warn':''}">${esc(!st.options.admin&&!w.ended_at&&st.openBreak?'On break · away from store':status(w))}</span>${review?`<span class="ow-badge ${w.reviewed_at?'':'ow-warn'}">${w.reviewed_at?'Reviewed':'Review needed'}</span>`:''}${late?'<span class="ow-badge ow-warn">Past expected return</span>':''}<h4>${esc(st.options.admin?st.names?.get(w.employee_id)||'Employee':w.destination)}</h4></div><strong ${!w.ended_at?`data-ow-timer="${esc(w.started_at)}"`:''}>${duration(w.started_at,w.ended_at)} away</strong></div>
    <p class="ow-purpose">${esc(w.purpose)}</p>${st.options.admin?`<p>${esc(w.destination)}</p>`:''}<p class="ow-muted">Left ${date(w.started_at)}${w.ended_at?` · Ended ${date(w.ended_at)}`:''}${w.expected_return_at?` · Expected ${date(w.expected_return_at)}`:''}</p>
    <p class="ow-muted">Away duration includes any separately recorded breaks.</p>
    ${!st.options.admin&&!w.ended_at?`<div class="ow-actions"><button class="ow-button" data-ow="update" data-id="${w.id}">Add update / evidence</button><button class="ow-button" data-ow="return" data-id="${w.id}" ${st.openBreak?'disabled':''}>Back at store</button><button class="ow-button ow-primary" data-ow="finish" data-id="${w.id}" ${st.openBreak?'disabled':''}>Finish shift off-site</button></div>${st.openBreak?'<p class="ow-muted">End your break before returning or finishing your shift.</p>':''}`:''}
    <div class="ow-actions"><button class="ow-button" data-ow="timeline" data-id="${w.id}" aria-expanded="${st.expanded.has(w.id)}">${st.expanded.has(w.id)?'Hide':'View'} timeline & evidence</button>${st.options.admin&&!w.ended_at?`<button class="ow-button" data-ow="resolve" data-id="${w.id}">Resolve outing</button>`:''}${st.options.admin&&review&&!w.reviewed_at?`<button class="ow-button ow-primary" data-ow="review" data-id="${w.id}">Mark reviewed</button>`:''}${!st.options.admin&&w.ended_at?`<button class="ow-button" data-ow="update" data-id="${w.id}">Add evidence</button>`:''}</div><div data-ow-timeline="${w.id}" ${st.expanded.has(w.id)?'':'hidden'}></div></article>`;
  });
  const list=st.host.querySelector('[data-ow-list]');const wasOpen=list.querySelector('details')?.open;
  if(st.options.admin)list.innerHTML=cards.join('')||'<p class="ow-empty">No outings in this view.</p>';
  else{
   const past=cards.filter((_,i)=>st.rows[i].ended_at).join('');
   list.innerHTML=cards.filter((_,i)=>!st.rows[i].ended_at).join('')+(past?`<details class="ow-history" ${wasOpen?'open':''}><summary>Previous outings</summary>${past}</details>`:'');
  }
  for(const id of st.expanded)if(st.rows.some(w=>w.id===id))timeline(st,id);
 }
 async function timeline(st,id){
  const host=st.host.querySelector(`[data-ow-timeline="${id}"]`);if(!host)return;
  host.hidden=false;host.textContent='Loading timeline…';
  try{
   const events=await checked(st.options.db().from('work_outing_events').select('*').eq('outing_id',id).order('created_at',{ascending:true}));
   host.innerHTML=(events||[]).map(e=>`<div class="ow-event"><div><strong>${esc(labels[e.action]||e.action)}</strong><span>${esc(e.actor_name)} · ${date(e.created_at)}</span></div>${e.note?`<p>${esc(e.note)}</p>`:''}${e.action==='resolve'?`<p class="ow-muted">Effective end: ${date(e.details?.resolved_end)} · ${e.details?.finish_shift?'Shift ended':'Shift kept open'} · No verified return location</p>`:''}
    ${Number.isFinite(Number(e.lat))&&e.lat!==null&&e.lng!==null?`<a href="https://www.google.com/maps?q=${encodeURIComponent(`${e.lat},${e.lng}`)}" target="_blank" rel="noopener">View recorded GPS location</a><span class="ow-muted">${esc(e.lat)}, ${esc(e.lng)} · Accuracy ${Math.round(e.accuracy_m)} m${e.store_verified?' · Store verified':''}</span>`:''}
    <div class="ow-evidence">${e.photo_path?fileButton('timeclock-photos',e.photo_path,'Camera photo'):''}${(e.attachments||[]).map(f=>fileButton('offsite-work-evidence',f.path,f.name||'Attachment')).join('')}</div></div>`).join('')||'<p>No events recorded.</p>';
  }catch(e){host.textContent=`Could not load evidence: ${e.message}`;}
 }
 function fileButton(bucket,path,name){return `<button class="ow-button" data-ow="file" data-bucket="${bucket}" data-path="${esc(path)}">${esc(name)}</button>`;}
 function form(st,action,id){
  if(st.busy)return;
  const target=st.host.querySelector('[data-ow-form]');
  st.form={action,id,request:crypto.randomUUID(),payload:null};
  const titles={start:'New work assignment',update:'Add progress or evidence',return:'Back at store',finish:'Finish shift off-site',review:'Review this outing',resolve:'Resolve an unfinished outing',break_start:'Start a break while away',break_end:'End your break'};
  target.innerHTML=`<form class="ow-form"><h4>${esc(titles[action])}</h4>${action==='start'?'<label>What are you going to do?<textarea name="purpose" required minlength="3" maxlength="2000" rows="2" placeholder="Deliver an order, collect supplies…"></textarea></label><label>Destination<input name="destination" required minlength="2" maxlength="300" placeholder="Customer, business, or address"></label><label>Expected return (optional · your device time)<input name="expected_return_at" type="datetime-local"></label>':''}
   ${action==='resolve'?'<p class="ow-warning">This records an admin exception with no verified return photo or GPS. Original evidence is preserved.</p><label>Actual end (your device time)<input name="ended_at" type="datetime-local" required></label><label class="ow-check"><input name="finish_shift" type="checkbox"> Also end the shift at this time</label>':''}
   <label>${action==='start'?'Instructions or extra information (optional)':action==='review'||action==='resolve'?'Reason / review note (required)':action==='finish'?'Delivery / completion note (required)':'Note (optional)'}<textarea name="note" rows="3" maxlength="4000" ${['finish','review','resolve'].includes(action)?'required minlength="3"':''}></textarea></label>
   ${!['review','resolve','break_start','break_end'].includes(action)?'<label>Photos, receipts, or instructions (optional)<input name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"></label><p class="ow-muted">Up to 8 files · 10 MB each. Photos and PDFs stay private.</p>':''}
   ${proofActions.has(action)?`<p class="ow-proof">A fresh camera photo and your current GPS location are required.${action==='return'?' Your location must be at your shift store.':action==='finish'?' This ends your shift and adds an admin review flag.':''}</p>`:''}
   <p class="ow-form-error" role="alert"></p><div class="ow-actions"><button class="ow-button ow-primary" type="submit">${proofActions.has(action)?'Take photo & confirm':action==='start'?'Start assignment':action==='review'?'Save review':'Save'}</button><button class="ow-button" type="button" data-ow="cancel">Cancel</button></div></form>`;
  target.querySelector('form').addEventListener('submit',ev=>{ev.preventDefault();submit(st);});
  target.scrollIntoView({behavior:'smooth',block:'nearest'});target.querySelector('textarea,input')?.focus({preventScroll:true});
 }
 async function submit(st){
  if(st.busy||st.options.isLocked?.()||!st.form)return;
  const f=st.form,el=st.host.querySelector('.ow-form'),err=el.querySelector('.ow-form-error');
  if(!el.reportValidity())return;
  st.busy=true;st.options.lock?.(true);err.textContent='';
  const submit=el.querySelector('[type=submit]');submit.disabled=true;submit.textContent='Saving…';
  try{
   if(!f.payload){
    const data=Object.fromEntries(new FormData(el));delete data.files;
    const chosen=[...(el.querySelector('[name=files]')?.files||[])];
    if(chosen.length>8)throw Error('Attach up to 8 files per update.');
    const allowed=['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'];
    for(const file of chosen)if(file.size>10485760||!allowed.includes(file.type))throw Error('Use photos or PDFs up to 10 MB each. Convert unsupported files to JPG or PDF.');
    if(f.action==='update'&&!String(data.note||'').trim()&&!chosen.length)throw Error('Add a note or evidence.');
    for(const key of ['expected_return_at','ended_at'])if(data[key])data[key]=TimeCorrection.toISO(data[key],Intl.DateTimeFormat().resolvedOptions().timeZone);
    data.finish_shift=!!el.querySelector('[name=finish_shift]')?.checked;
    data.attachments=[];
    for(const file of chosen){
     const path=`${st.employee.id}/${crypto.randomUUID()}/${file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-140)}`;
     await checked(st.options.db().storage.from('offsite-work-evidence').upload(path,file,{contentType:file.type,upsert:false}));
     data.attachments.push({path,name:file.name.slice(0,200),type:file.type,size:file.size});
    }
    if(proofActions.has(f.action)){
     const kind=f.action==='return'?'outing_return':f.action==='finish'?'out':f.action;
     const blob=await st.options.photo(kind);data.photo_path=await st.options.uploadPhoto(kind,blob);
    }
    if(['start','return','finish','break_start','break_end'].includes(f.action)){
     const gps=await st.options.geo();if(!gps.ok)throw Error(gps.msg);
     if(gps.accuracy>150)throw Error(`GPS accuracy is ${Math.round(gps.accuracy)} m. Move near a window or outdoors and retry.`);
     Object.assign(data,{lat:gps.lat,lng:gps.lng,accuracy_m:gps.accuracy});
    }
    f.payload=data;
   }
   await checked(st.options.db().rpc('work_outing_action',{_request_id:f.request,_action:f.action,_outing_id:f.id||null,_data:f.payload}));
   st.form=null;st.host.querySelector('[data-ow-form]').innerHTML='';
   message(st,f.action==='finish'?'Shift finished. Your GPS location, photo, and completion note are saved for admin review.':f.action==='return'?'Return recorded. Your shift is still running.':'Saved to the outing timeline.');
  }catch(e){
   err.textContent=e.message==='cancelled'?'Photo cancelled. Nothing has been submitted.':e.message;
   // A transport failure keeps the exact request for a safe retry. Validation failures allow correction.
   if(e.code){f.payload=null;el.querySelectorAll('input,textarea').forEach(i=>i.disabled=false);}
   if(f.payload){err.textContent+=' Retry Save to confirm the same request.';el.querySelectorAll('input,textarea').forEach(i=>i.disabled=true);}
  }finally{
   st.busy=false;st.options.lock?.(false);submit.disabled=false;submit.textContent=f.payload?'Retry save':proofActions.has(f.action)?'Take photo & confirm':'Save';
   if(!st.form){await load(st);await st.options.changed?.();}
  }
 }
 async function handle(st,event){
  const btn=event.target.closest('[data-ow]');if(!btn||st.busy||st.options.isLocked?.())return;
  const action=btn.dataset.ow,id=btn.dataset.id;
  if(action==='refresh'){await load(st);return;}
  if(action==='more'){st.limit+=20;await load(st);return;}
  if(action==='cancel'){st.form=null;st.host.querySelector('[data-ow-form]').innerHTML='';return;}
  if(action==='timeline'){
   if(st.expanded.has(id)){st.expanded.delete(id);st.host.querySelector(`[data-ow-timeline="${id}"]`).hidden=true;btn.textContent='View timeline & evidence';btn.setAttribute('aria-expanded','false');}
   else{st.expanded.add(id);btn.textContent='Hide timeline & evidence';btn.setAttribute('aria-expanded','true');await timeline(st,id);}return;
  }
  if(action==='file'){
   const win=window.open('about:blank','_blank');if(win)win.opener=null;
   try{const data=await checked(st.options.db().storage.from(btn.dataset.bucket).createSignedUrl(btn.dataset.path,300));if(win)win.location.href=data.signedUrl;else message(st,'Allow pop-ups to open the evidence file.',true);}
   catch(e){win?.close();message(st,`Could not open evidence: ${e.message}`,true);}return;
  }
  form(st,action,id);
 }
 const api={
  initWorker(options){if(!worker)worker=create(document.getElementById('offsiteWorker'),options);return api;},
  async loadWorker(){if(worker)await load(worker);},
  active:()=>worker?.active,
  busy:()=>!!worker?.busy||!!admin?.busy,
  clockOut(){if(!worker?.active)return false;worker.host.scrollIntoView({behavior:'smooth',block:'start'});message(worker,'Choose Back at store or Finish shift off-site below.');return true;},
  breakAction(){if(!worker?.active)return false;form(worker,worker.openBreak?'break_end':'break_start',worker.active.id);return true;},
  async loadAdmin(db){if(!admin){const host=document.getElementById('offsiteAdmin');if(!host)return;admin=create(host,{admin:true,db:()=>db,changed:()=>root.overviewApi?.loadLiveNow?.()});}await load(admin);},
  async focus(id){if(!admin)return;admin.filter='active';admin.host.querySelector('[data-ow-filter]').value='active';admin.expanded.add(id);await load(admin);admin.host.querySelector(`[data-outing="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});},
  status,duration
 };
 setInterval(()=>document.querySelectorAll('[data-ow-timer]').forEach(el=>el.textContent=`${duration(el.dataset.owTimer)} away`),30000);
 root.OffsiteWork=api;
})(window);
