(function boot(){
 'use strict';
 if(!window.supabase?.auth){document.addEventListener('supabase-ready',boot,{once:true});return;}
 const db=window.supabase,M=window.OGCustomerFollowups,esc=M.escape,$=id=>document.getElementById(id),time=M.displayTime,check=M.checked;
 const state={rows:[],tab:'calls',packet:null,request:0,detailRequest:0,report:null,loading:false};
 const params=new URLSearchParams(location.search),buyer=params.get('buyer')||'',channel=params.get('channel')||'',line=params.get('lineId')||'';
 const status=message=>{$('cf-status').textContent=message;};
 const nice=value=>String(value||'').replaceAll('_',' ');
 const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
 const overdue=r=>!['closed','cancelled'].includes(r.status)&&r.due_at&&Date.parse(r.due_at)<Date.now();
 const pageLink=r=>new URL('customer-followups.html?id='+r.id,location.href).href;
 function filtered(kind=state.tab){
  const search=$('cf-search').value.trim().toLowerCase(),statusFilter=$('cf-filter-status').value,due=$('cf-filter-due').value;
  return state.rows.filter(r=>
   (kind==='all'||(kind==='returns'?r.kind==='manual_return':r.kind!=='manual_return'))&&
   (statusFilter==='all'||(statusFilter==='active'?!['closed','cancelled'].includes(r.status):r.status===statusFilter))&&
   (!search||[r.title,r.buyer_username,...Object.values(r.contact||{}),r.order_snapshot?.order_number,r.order_snapshot?.title,r.order_snapshot?.item_number,r.tracking_number,r.carrier].join(' ').toLowerCase().includes(search))&&
   (!buyer||r.buyer_username.toLowerCase()===buyer.toLowerCase()||r.order_snapshot?.buyer_id===buyer)&&(!channel||r.channel===channel)&&
   (!line||r.ebay_order_line_id===line||r.tiktok_order_line_id===line)&&
   (due==='all'||(due==='none'?!r.due_at:due==='overdue'?overdue(r):r.due_at&&day(r.due_at)===day(Date.now())))
  ).sort((a,b)=>(a.due_at?Date.parse(a.due_at):Infinity)-(b.due_at?Date.parse(b.due_at):Infinity)||b.created_at.localeCompare(a.created_at));
 }
 function render(){
  const rows=filtered();$('cf-count').textContent=`${rows.length} records · ${rows.filter(overdue).length} overdue`;
  document.querySelectorAll('[data-cf-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cfTab===state.tab)));
  $('cf-list').innerHTML=rows.length?rows.map(r=>`<article class="cf-card"><div><span class="cf-badge">${esc(M.labels[r.kind])}</span><span class="cf-badge">${esc(nice(r.status))}</span>${overdue(r)?'<span class="cf-badge overdue">Overdue</span>':''}<h3>${esc(r.title)}</h3><p>${esc(r.contact.name||r.buyer_username)}${r.buyer_username&&r.contact.name?' · '+esc(r.buyer_username):''}${r.contact.phone?' · '+esc(r.contact.phone):''}</p>${r.order_snapshot.order_number?`<p>Order ${esc(r.order_snapshot.order_number)} · ${esc(r.order_snapshot.title)}</p>`:''}<p>Next follow-up: ${esc(time(r.due_at))} · ${esc(nice(r.priority))} priority</p>${r.kind==='manual_return'?`<p>${esc(M.stages[r.return_stage])}${r.tracking_number?' · '+esc(r.carrier)+' '+esc(r.tracking_number):' · Return tracking not added'}</p>`:''}</div><button data-cf-open="${r.id}">Open record</button></article>`).join(''):'<div class="cf-empty"><h3>No matching follow-ups</h3><p>Create a call reminder or manual return, or change the filters above.</p></div>';
 }
 const facts=items=>`<dl class="cf-facts">${items.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value||'Not provided')}</dd>`).join('')}</dl>`;
 function contact(r){return facts([['Customer',r.contact.name],['Username / ID',r.buyer_username],['Marketplace',nice(r.channel)],['Phone',r.contact.phone],['Email',r.contact.email],['Address',r.contact.address]]);}
 function order(r){const o=r.order_snapshot;return o.order_number?facts([['Order',o.order_number],['Item',o.title],['Item / SKU',o.item_number],['Quantity',o.quantity],['Line amount',o.amount==null?'Not provided':o.amount],['Purchased',M.orderTime(o)],['Order status',nice(o.order_status)],['Outbound tracking',o.outbound_tracking]]):'<p>No purchased item linked.</p>';}
 function taskRows(tasks){return tasks.length?tasks.map(t=>`<div class="cf-task-row"><a href="team-tasks.html?taskId=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">${esc(t.title)} ↗</a><p>${esc(t.assigned_to_email||'Unassigned')} · ${esc(nice(t.status))} · Due ${esc(time(t.due_at))}</p>${t.latest_note?`<p>${esc(t.latest_note)}</p>`:''}</div>`).join(''):'<p>No tasks assigned yet.</p>';}
 function history(events,print=false){return events.map(e=>{
  const changes=e.before_values?['title','status','return_quantity','return_stage','tracking_number','carrier','due_at','priority','contact'].filter(k=>JSON.stringify(e.before_values[k])!==JSON.stringify(e.after_values?.[k])).map(k=>`${nice(k)}: ${typeof e.before_values[k]==='object'?JSON.stringify(e.before_values[k]):e.before_values[k]||'Not set'} → ${typeof e.after_values[k]==='object'?JSON.stringify(e.after_values[k]):e.after_values[k]||'Not set'}`).join('\n'):'';
  return `<article class="cf-event"><small>${esc(time(e.created_at))} · ${esc(e.created_by_email)} · ${esc(nice(e.action))}</small>${e.note?`<p>${esc(e.note)}</p>`:''}${changes?(print?`<p>${esc(changes)}</p>`:`<details><summary>Changes saved</summary><p>${esc(changes)}</p></details>`):''}<div class="cf-photos">${(e.photos||[]).map(p=>`<a data-cf-photo="${esc(p.path)}" target="_blank" rel="noopener"><span>${esc(p.label||'Photo')} · loading…</span></a>`).join('')}</div></article>`;
 }).join('');}
 async function photos(container){await Promise.allSettled([...container.querySelectorAll('[data-cf-photo]')].map(async a=>{
  try{const {signedUrl}=check(await db.storage.from('customer-followup-photos').createSignedUrl(a.dataset.cfPhoto,3600));if(!a.isConnected)return;
   const label=a.textContent.replace(' · loading…','');a.href=signedUrl;a.innerHTML=`<img src="${esc(signedUrl)}" alt="${esc(label)}" loading="lazy"><span>${esc(label)}</span>`;
   a.querySelector('img').addEventListener('error',()=>{a.querySelector('img')?.remove();a.querySelector('span').textContent=label+' · Open original photo';},{once:true});
  }catch{a.textContent=a.textContent.replace(' · loading…',' · Could not load; refresh to retry');}
 }));}
 async function detail(id,scroll=true){const request=++state.detailRequest;$('cf-detail').hidden=false;$('cf-detail').innerHTML='<p>Loading record…</p>';try{
  const p=check(await db.rpc('customer_followup_packet',{_id:id}));if(request!==state.detailRequest)return;state.packet=p;const r=p.record;
  $('cf-detail').innerHTML=`<div class="cf-toolbar"><span class="cf-eyebrow">${esc(M.labels[r.kind])}</span><button id="cf-close-detail">Close record</button></div><h2>${esc(r.title)}</h2><p><span class="cf-badge">${esc(r.status)}</span> Next follow-up ${esc(time(r.due_at))} · ${esc(r.priority)} priority</p><div class="cf-actions"><button id="cf-update">Add note / photos or update</button>${!['closed','cancelled'].includes(r.status)?'<button id="cf-task">Create task</button>':''}${r.source_context.conversation_link?`<a class="cf-link" href="${esc(r.source_context.conversation_link)}" target="_blank" rel="noopener">Original chat ↗</a>`:''}${r.order_snapshot.history_link?`<a class="cf-link" href="${esc(r.order_snapshot.history_link)}" target="_blank" rel="noopener">Open order ↗</a>`:''}</div>
   <div class="cf-detail-grid"><section><h3>Customer information</h3>${contact(r)}</section><section><h3>Purchased item</h3>${order(r)}</section></div>
   ${r.kind==='manual_return'?`<h3>Manual return</h3>${facts([['Return quantity',r.return_quantity],['Progress',M.stages[r.return_stage]],['Return tracking',r.tracking_number],['Carrier',r.carrier]])}<p class="cf-help">This is the internal follow-up record. Receiving inventory and issuing refunds use their existing actions.</p>`:''}
   ${r.source_context.message_preview?`<h3>Original message</h3><p>${esc(r.source_context.message_preview)}</p>`:''}
   <h3>Assigned tasks</h3>${taskRows(p.tasks)}<p class="cf-help">Open a task to add updates, complete your part, or review completion. Finish linked tasks before closing this record.</p>
   <h3>Notes, photos &amp; activity</h3>${history(p.events)}`;
  $('cf-update').onclick=()=>M.update(r).catch(e=>status(e.message));$('cf-task')?.addEventListener('click',()=>M.task(r).catch(e=>status(e.message)));
  $('cf-close-detail').onclick=()=>{state.detailRequest++;state.packet=null;$('cf-detail').hidden=true;const u=new URL(location.href);u.searchParams.delete('id');historyReplace(u);};
  const u=new URL(location.href);u.searchParams.set('id',r.id);historyReplace(u);
  void photos($('cf-detail'));if(scroll)$('cf-detail').scrollIntoView({behavior:'smooth',block:'start'});
 }catch(e){if(request===state.detailRequest)$('cf-detail').textContent=e.message;}}
 function historyReplace(url){rootHistory().replaceState(null,'',url);}function rootHistory(){return window.history;}
 async function load(){const request=++state.request;state.loading=true;status('Loading shared records…');try{
  const rows=[];for(let offset=0;;offset+=200){const batch=check(await db.from('customer_followups').select('*').order('created_at',{ascending:false}).order('id').range(offset,offset+199));rows.push(...batch);if(batch.length<200)break;if(offset>=19800)throw Error('This workspace has more than 20,000 records. Contact an administrator to narrow the server query.');}
  if(request!==state.request)return;state.rows=rows;render();status(`Shared with all active inventory staff.${buyer?' Customer: '+buyer+'.':''}${line?' Showing follow-ups for the selected order item.':''} Last refreshed ${time(new Date())}.`);
 }catch(e){if(request===state.request)status('Could not load records: '+e.message);}finally{if(request===state.request)state.loading=false;}}
 function csvCell(value){let s=String(value??'');if(/^[\s]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
 function csvReport(packets){
  const header=['Type','Title','Status','Customer','Username / ID','Phone','Email','Address','Marketplace','Order number','Item','Item / SKU','Quantity','Amount','Purchase time','Outbound tracking','Return quantity','Return stage','Return tracking','Carrier','Follow-up due (Eastern)','Priority','Tasks','Notes and activity','Record'];
  const rows=packets.map(p=>{const r=p.record,o=r.order_snapshot;return [M.labels[r.kind],r.title,r.status,r.contact.name,r.buyer_username,r.contact.phone,r.contact.email,r.contact.address,r.channel,o.order_number,o.title,o.item_number,o.quantity,o.amount,M.orderTime(o),o.outbound_tracking,r.kind==='manual_return'?r.return_quantity:'',r.kind==='manual_return'?M.stages[r.return_stage]:'',r.tracking_number,r.carrier,time(r.due_at),r.priority,p.tasks.map(t=>`${t.title} | ${t.assigned_to_email} | ${t.status} | ${time(t.due_at)}`).join('\n'),p.events.map(e=>`${time(e.created_at)} | ${e.created_by_email} | ${e.note}${e.photos.length?' | '+e.photos.length+' photos in record':''}`).join('\n'),pageLink(r)];});
  return '\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
 }
 async function report(kind){if(state.loading)return;const rows=filtered(kind);if(!rows.length){status('No matching '+(kind==='returns'?'manual returns':'calls')+' to report. Change the filters or add a record.');return;}
  const buttons=[$('cf-report-calls'),$('cf-report-returns')];buttons.forEach(b=>b.disabled=true);
  try{
   const packets=[];for(let n=0;n<rows.length;n+=4){status(`Preparing report: ${Math.min(n+4,rows.length)} of ${rows.length} records…`);packets.push(...await Promise.all(rows.slice(n,n+4).map(r=>db.rpc('customer_followup_packet',{_id:r.id}).then(check))));}
   const title=kind==='returns'?'Manual returns report':'Customer calls report',generated=time(new Date());
   const filters=`Status: ${$('cf-filter-status').selectedOptions[0].textContent}; Due: ${$('cf-filter-due').selectedOptions[0].textContent}; Search: ${$('cf-search').value||'All'}${buyer?'; Customer: '+buyer:''}${line?'; Item: '+line:''}`;
   document.getElementById('cf-report')?.remove();const el=document.createElement('section');el.id='cf-report';el.className='cf-report-only';
   el.innerHTML=`<h1>OG Jewelers · ${title}</h1><p>Generated ${esc(generated)} · ${packets.length} records</p><p>${esc(filters)}</p>${packets.map(p=>{const r=p.record;return `<article><h2>${esc(r.title)}</h2><p>${esc(M.labels[r.kind])} · ${esc(r.status)} · ${esc(r.priority)} priority · Next follow-up ${esc(time(r.due_at))}</p>${contact(r)}<h3>Order details</h3>${order(r)}${r.kind==='manual_return'?`<p>Return quantity: ${esc(r.return_quantity)} � ${esc(M.stages[r.return_stage])} · ${esc(r.carrier)} · Tracking ${esc(r.tracking_number||'Not provided')}</p>`:''}${r.source_context.message_preview?`<p>Original message: ${esc(r.source_context.message_preview)}</p>`:''}<h3>Assigned tasks</h3>${taskRows(p.tasks)}<h3>Notes, photos &amp; activity</h3>${history(p.events,true)}<p><a href="${esc(pageLink(r))}">Open complete record</a></p></article>`;}).join('')}`;
   $('cf-page').append(el);await photos(el);el.querySelectorAll('img').forEach(img=>{img.loading='eager';});
   await Promise.allSettled([...el.querySelectorAll('img')].map(img=>img.decode()));
   document.getElementById('cf-report-ready')?.remove();const ready=document.createElement('section');ready.id='cf-report-ready';ready.className='cf-board';
   ready.innerHTML=`<h2>${title} ready</h2><p>${packets.length} records, including customer details, linked items, tasks, notes and photos.</p><p>${esc(filters)}</p><div class="cf-actions"><button id="cf-print">Print / save PDF</button><button id="cf-csv">Download CSV</button><button id="cf-preview-report">Show report preview</button></div>`;
   $('cf-page').insertBefore(ready,$('cf-detail'));$('cf-print').onclick=()=>window.print();$('cf-preview-report').onclick=()=>{el.style.display=el.style.display==='block'?'':'block';if(el.style.display)el.scrollIntoView({behavior:'smooth'});};
   $('cf-csv').onclick=()=>{const url=URL.createObjectURL(new Blob([csvReport(packets)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`${kind==='returns'?'manual-returns':'customer-calls'}-${day(Date.now())}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
   status(`${title} ready. Print or save PDF to include photos; CSV includes the notes and links to the full records.`);ready.scrollIntoView({behavior:'smooth'});
  }catch(e){status('The report could not be completed: '+e.message);}finally{buttons.forEach(b=>b.disabled=false);}
 }
 document.querySelectorAll('[data-cf-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.cfTab;render();});
 for(const id of ['cf-search','cf-filter-status','cf-filter-due'])$(id).addEventListener('input',render);
 $('cf-refresh').onclick=async()=>{await load();if(state.packet)await detail(state.packet.record.id,false);};
 $('cf-list').addEventListener('click',e=>{const b=e.target.closest('[data-cf-open]');if(b)void detail(b.dataset.cfOpen);});
 $('cf-report-calls').onclick=()=>report('calls');$('cf-report-returns').onclick=()=>report('returns');
 window.addEventListener('customer-followup-saved',async e=>{await load();await detail(e.detail.id);});
 async function start(){try{const session=check(await db.auth.getSession()).session;if(!session){location.href='index.html';return;}if(!check(await db.rpc('can_access_customer_followups')))throw Error('Active staff access is required.');
  if(line)state.tab='returns';await load();if(params.get('id'))await detail(params.get('id'),false);
 }catch(e){status(e.message);}}
 window.CustomerFollowupsReport={csvCell,csvReport};void start();
})();
