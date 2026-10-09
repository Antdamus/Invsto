/* Customer Issues: a case workspace over the shared order, evidence and task system. */
(function(root){
 'use strict';
 const $=id=>document.getElementById(id),escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const finish=new Set(['resolved','cancelled','closed','approved_by_admin']);
 const nice=v=>v==='received_no_restock'?'Received · not added to inventory':String(v||'Not reported').replace(/_/g,' ').toLowerCase().replace(/^./,x=>x.toUpperCase());
 const date=v=>v&&!Number.isNaN(Date.parse(v))?new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Not provided';
 const kind=c=>['request','return','dispute'].includes(c.issue_kind)?c.issue_kind:'request';
 const closed=c=>/(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)/i.test(c.ebay_status||'');
 const safeUrl=value=>{try{const u=new URL(value,location.href);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}};
 let ctx,db,ready=false,view='attention',scope='all',search='',offset=0,total=0,rows=[],counts={},people=[],selected=null,detail=null,version=0,listVersion=0,timer,poll,saving=false,syncing=false;
 const PAGE=30;
 const checked=r=>{if(r.error)throw r.error;return r.data;};
 const person=id=>id===ctx?.user?.id?'You':people.find(p=>p.user_id===id)?.display_name||people.find(p=>p.user_id===id)?.email||'Needs an owner';
 const taskLink=t=>`team-tasks.html?taskId=${encodeURIComponent(t.id)}`;
 function feedback(message,error=false){$('issues-feedback').textContent=message;$('issues-feedback').classList.toggle('is-error',error);}
 function nextText(c){
  if(!c.order_id)return 'Match the order';
  if(c.status==='needs_review'&&kind(c)==='return')return 'Inspect returned items';
  if(c.status==='needs_review')return 'Review the customer request';
  if(c.status==='partially_received'&&kind(c)==='return')return 'Check the remaining items';
  if(closed(c)&&c.open_tasks)return 'Finish internal follow-up';
  if(closed(c))return 'Review the case outcome';
  if(c.source_lane==='payment_dispute'&&c.ebay_status==='ACTION_NEEDED')return 'Respond to the payment dispute';
  if(c.source_lane==='payment_dispute'&&c.ebay_status==='OPEN')return 'Monitor payment-dispute updates';
  if(kind(c)==='return'&&/READY_FOR_SHIPPING|ITEM_READY_TO_SHIP/.test(c.ebay_status||''))return 'Waiting for the buyer to ship';
  if(kind(c)==='return'&&/^(ITEM_SHIPPED|RETURN_SHIPPED)$/.test(c.ebay_status||''))return 'Watch for the returned package';
  if(/WAITING.*BUYER|BUYER_RESPONSE/i.test(c.ebay_status||''))return 'Waiting on the buyer';
  if(c.ebay_action&&!/^\d{4}-\d{2}-\d{2}T/i.test(c.ebay_action))return nice(c.ebay_action);
  return c.next_user?'Continue assigned work':'Choose the next person';
 }
 function cards(){
  $('issues-list').innerHTML=rows.length?rows.map(c=>`<button type="button" class="issue-card" data-case="${escape(c.id)}" aria-current="${selected===c.id}">
   <div class="issue-card-top"><span class="issue-kind is-${kind(c)}">${kind(c)==='request'?'Customer request':kind(c)==='return'?'Physical return':'Dispute'}</span><small>${escape(c.order_number||`Case ${c.ebay_return_id||'not linked'}`)}</small></div>
   <h2>${escape(c.buyer_username||'Buyer not identified')}</h2><p>${escape(c.item_title||c.return_reason||'Open this case to review the order and next step.')}</p>
   <div class="issue-card-footer"><span class="issue-tag">${escape(nextText(c))}</span>${c.ebay_due_at&&!closed(c)?`<span class="issue-tag ${c.overdue?'is-overdue':''}">${c.overdue?'Response overdue':'Respond by'} ${escape(date(c.ebay_due_at))}</span>`:''}</div>
   <div class="issue-card-top" style="margin:11px 0 0"><small>${c.watching_tasks===c.open_tasks&&c.watching_tasks?'Following eBay updates':escape(person(c.next_user))}${c.open_tasks>Number(c.watching_tasks||0)?` · ${c.open_tasks-Number(c.watching_tasks||0)} active task${c.open_tasks-Number(c.watching_tasks||0)===1?'':'s'}`:''}</small>${c.stale||c.sync_error?'<span class="issue-tag is-stale">Needs refresh</span>':''}</div></button>`).join(''):
   `<div class="issues-empty"><h2>${search?'No matching cases':'You’re caught up here'}</h2><p>${search?'Try the buyer username, order number, case ID or return tracking.':'Choose another view or responsibility filter to see other work.'}</p></div>`;
  $('issues-count').textContent=`${total} ${view==='history'?'finished':'active'} case${total===1?'':'s'}`;
  $('issues-page').textContent=total?`${offset+1}–${Math.min(offset+PAGE,total)} of ${total}`:'0 cases';
  $('issues-prev').disabled=offset===0;$('issues-next').disabled=offset+PAGE>=total;
  document.querySelectorAll('[data-issue-view]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.issueView===view));b.querySelector('b').textContent=counts[b.dataset.issueView]??'–';});
 }
 async function refresh(options={}){
  const request=++listVersion;$('issues-list').setAttribute('aria-busy','true');
  try{
   const result=checked(await db.rpc('list_customer_issues',{_view:view,_scope:scope,_search:search,_offset:offset,_limit:PAGE}));
   if(request!==listVersion)return;
   rows=result.rows||[];counts=result.counts||{};total=result.total||0;cards();
   if($('issues-feedback').classList.contains('is-error'))feedback('');
   const selectedChanged=detail&&rows.some(c=>c.id===selected&&c.updated_at!==detail.c.updated_at);
   if((options.detail!==false||selectedChanged)&&selected&&!$('issue-action-form')&&!ctx.state.busy&&!$('issue-evidence-package')?.dataset.ready)await openCase(selected,{quiet:true});
  }catch(error){if(request===listVersion)feedback(error.message||'Could not load customer issues. Please retry.',true);}
  finally{if(request===listVersion)$('issues-list').setAttribute('aria-busy','false');}
 }
 async function health(){
  try{
   const result=checked(await db.rpc('customer_issue_sync_health'));const lanes=result.lanes||[];
   const problems=result.problems||[],broken=lanes.filter(l=>['needs_access','error'].includes(l.status));
   const stale=lanes.some(l=>!l.last_progress_at&&!l.last_success_at||Date.parse(l.last_progress_at||l.last_success_at)<Date.now()-20*60000);
   const summary=$('issues-health-summary');summary.classList.toggle('is-warning',!!problems.length||!!broken.length||stale);
   summary.textContent=problems.length?'eBay updates need attention · view recovery steps':broken.length?'An eBay update failed · automatic retries active'
    :result.queued||result.retrying?`Updating in the background · ${result.queued} queued${result.urgent?` · ${result.urgent} prioritized`:''}${result.retrying?` · ${result.retrying} retrying`:''}`
    :stale?'eBay data needs a refresh · details':'eBay connected · background updates active';
   const labels={worker:'Customer issues',return:'Returns',inquiry:'Customer requests',case:'Escalated cases',payment_dispute:'Payment disputes'};
   const access=problems.some(p=>p.reason==='access')||lanes.some(l=>l.status==='needs_access');
   let connect='';try{const url=new URL(root.SUPABASE_URL);if(/^https:$/.test(url.protocol)&&/^[a-z0-9]+\.supabase\.co$/.test(url.hostname))connect=`https://${url.hostname.split('.')[0]}.functions.supabase.co/ebay-oauth-callback`;}catch{}
   const guidance={access:'eBay authorization needs attention. Reconnect eBay and save the replacement refresh token before retrying.',failures:'Updates have failed repeatedly. Inspect the errors below, correct the reported problem, then retry.',stalled:'No recent sync progress. Retry sync; if it remains stalled, check the scheduled worker in Supabase.',backlog:'Some updates have waited over 30 minutes. Urgent cases are prioritized while the queue catches up.'};
   $('issues-health-detail').innerHTML=
    (problems.length?`<section class="issue-sync-recovery"><h3>Restore automatic updates</h3>${problems.map(p=>`<p><b>${escape(labels[p.monitor_key]||p.monitor_key)}</b>${escape(guidance[p.reason]||'Check the latest sync status.')}</p>`).join('')}
     ${ctx.employee.role==='admin'?`<div class="issue-sync-actions">${access&&connect?`<a class="secondary-btn" href="${escape(connect)}" target="_blank" rel="noopener">Reconnect eBay ↗</a>`:''}<button class="primary-btn" data-retry-sync ${syncing?'disabled':''}>Retry sync</button></div>`:'<p>Ask an administrator to restore the eBay connection.</p>'}<p class="issue-subtitle">The warning clears after successful recovery. Existing case information stays available.</p></section>`:'')+
    `<p><b>Background worker</b>Last completed: ${escape(date(result.worker?.last_finished_at))}<br>New changes and urgent response deadlines are checked before routine work. Older retries retain a share of each batch.</p>`+
    lanes.map(l=>`<p><b>${labels[l.lane]||escape(l.lane)}</b>${l.status==='needs_access'?'eBay authorization is needed for this feed.':escape(l.error||nice(l.status))}<br>Last progress: ${escape(date(l.last_progress_at||l.last_success_at))}</p>`).join('')+
    '<p>Each case keeps its last successful information while failed updates retry.</p>'+
    (result.failures?.length?`<section class="issue-sync-retries"><h3>Updates needing attention</h3>${result.failures.map(f=>`<article><b>${escape(labels[f.lane]||f.lane)} · ${escape(f.external_id)}</b>${f.failure_kind==='access'?'Check the eBay connection.':f.failure_kind==='review'?'Verify this case on eBay; it may need a manual correction.':'Temporary failure; an automatic retry is scheduled.'} Attempt ${escape(f.attempts)}. Next check: ${escape(date(f.next_attempt_at))}${f.case_id?` <button class="secondary-btn" data-case="${escape(f.case_id)}">Inspect case</button>`:''}<details><summary>Error details</summary>${escape(f.last_error||'No error details')}</details></article>`).join('')}</section>`:'');
  }catch(error){$('issues-health-summary').textContent='Connection status unavailable · refresh to retry';$('issues-health-summary').classList.add('is-warning');}
 }
 async function sync(caseId){
  if(syncing)return;syncing=true;$('issues-sync').disabled=true;document.querySelectorAll('[data-retry-sync]').forEach(b=>b.disabled=true);
  feedback('Queuing a background refresh…');
  try{const result=checked(await db.functions.invoke('ebay-return-sync',{body:{action:'refresh',...(caseId?{caseId}:{})}}));feedback(result.message||'Refresh queued. You can keep working.');await health();}
  catch(error){feedback(error.message||'Could not queue the refresh.',true);}
  finally{syncing=false;$('issues-sync').disabled=false;document.querySelectorAll('[data-retry-sync]').forEach(b=>b.disabled=false);}
 }
 function actions(task){
  const next=root.OGTaskWorkflow.next(task,people),mine=next.userId===ctx.user.id;
  if(next.kind==='monitoring')return '<span class="issue-subtitle">No seller response requested. A new request from eBay brings this back automatically.</span>';
  const participant=ctx.employee.role==='admin'||[task.assigned_to_user_id,task.created_by,task.assigned_by].includes(ctx.user.id);
  let buttons=participant&&!(mine&&next.kind==='approval'&&task.status!=='completed_by_employee')?`<button class="secondary-btn" data-task-action="update" data-task="${task.id}">Add update / hand back</button>`:'';
  if(mine&&next.kind==='work')buttons+=`<button class="primary-btn" data-task-action="complete" data-task="${task.id}">Complete my part</button>`;
  if(mine&&next.kind==='approval')buttons+=task.status==='completed_by_employee'
   ?`<button class="primary-btn" data-task-action="accept" data-task="${task.id}">Accept completed work</button><button class="secondary-btn" data-task-action="return" data-task="${task.id}">Request changes</button>`
   :`<button class="primary-btn" data-task-action="instructions" data-task="${task.id}">Update / give instructions</button><button class="secondary-btn" data-task-action="decide" data-task="${task.id}">Decision finishes this task</button>`;
  if(mine&&task.task_type==='return_review'&&detail.c.source_lane==='payment_dispute'&&detail.c.ebay_status==='OPEN'&&task.status!=='completed_by_employee')buttons=`<button class="primary-btn" data-follow-task="${task.id}">Reviewed · follow updates</button>`+buttons;
  return buttons;
 }
 function renderTasks(){
  const tasks=detail.tasks.filter(t=>!finish.has(t.status));
  return `<section class="issue-detail-section"><h3>Who acts next</h3>${tasks.length?tasks.map(t=>`<div class="issue-task"><strong>${escape(root.OGTaskWorkflow.label(t,people,ctx.user.id))}</strong><p>${escape(t.question||t.title||'Review this case')}</p>
   <span class="issue-tag">${escape(nice(t.status))}</span>${t.due_at?` <span class="issue-tag">Internal follow-up: ${escape(date(t.due_at))}</span>`:''}
   <div class="issue-actions">${actions(t)}<a class="secondary-btn" href="${taskLink(t)}">Full task</a>${ctx.employee.role==='admin'?`<button class="secondary-btn" data-assign="${t.id}">Assign next step</button>`:''}</div></div>`).join(''):'<p class="issue-subtitle">No open internal task. Assign work or a decision if someone needs to act.</p>'}
   ${ctx.employee.role==='admin'||(kind(detail.c)==='return'&&!['closed','cancelled'].includes(detail.c.status))?'<button class="secondary-btn" data-assign="">Create a task</button>':''}<div id="issue-form-slot"></div></section>`;
 }
 function caseHref(c){
  const id=encodeURIComponent(c.ebay_return_id||'');
  if(c.source_lane==='return'&&id)return `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${id}`;
  if(c.source_lane==='inquiry'&&id)return `https://www.ebay.com/res/ItemNotReceived/ViewRequest?id=${id}`;
  const raw=c.raw_payload||{},url=safeUrl(raw.detailsUrl||raw.apiExtractedDetails?.detailsUrl||'');
  if(url){const u=new URL(url);if(/(^|\.)ebay\.com$/.test(u.hostname)&&!/(ViewItem|\/itm\/)/i.test(url))return url;}
  return c.order_number?`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(c.order_number)}`:'';
 }
 function renderDetail(){
  if(!detail||detail.c.id!==selected)return;
  const {c,tasks,items,lines,events}=detail,summary=rows.find(r=>r.id===c.id)||{...c,open_tasks:tasks.filter(t=>!finish.has(t.status)).length};
  const primary={...(tasks.find(t=>!finish.has(t.status))||{id:'',metadata:c.raw_payload}),order_line_ids:lines.map(l=>l.id),ebay_return_cases:c};
  const receipt=ctx.renderReceipt(primary),complaint=ctx.renderComplaint(primary),messages=ctx.renderMessages(primary);
  const url=caseHref(c),remaining=items.some(i=>i.received_quantity<i.expected_quantity)||!items.length;
  const reason=/^(CLOSED|OPEN|WAITING_.*)$/i.test(c.return_reason||'')?'No customer reason captured':nice(c.return_reason);
  $('issues-detail').innerHTML=`<div class="issue-detail-bar"><button type="button" class="secondary-btn issue-back" data-close-case>← Cases</button><span>${escape(c.ebay_return_id?`Case ${c.ebay_return_id}`:'Internal return')}</span>${c.ebay_return_id?'<button type="button" class="secondary-btn" data-sync-case>Refresh case</button>':''}</div>
   <div class="issue-detail-content"><span class="issue-kind is-${kind(c)}">${kind(c)==='dispute'?(c.source_lane==='payment_dispute'?'Payment dispute':'Escalated eBay case'):nice(kind(c))}</span><h2>${escape(c.buyer_username||'Buyer not identified')}</h2><p class="issue-subtitle">${escape(c.item_title||'Review the linked order items below')}</p>
   <section class="issue-original-order"><div><small>ORIGINAL ORDER</small><strong>${escape(c.order_number||'Not identified yet')}</strong><span>${c.order_id?`${lines.length} linked item${lines.length===1?'':'s'} · Saved in Invsto`:c.order_number?'Not found in saved orders yet':'Match the original order to see its evidence'}</span></div>${c.order_number?`<a class="secondary-btn" href="ebay-order-history.html?orderHistorySearch=${encodeURIComponent(c.order_number)}&historyAllDates=true">Open full order ↗</a>`:''}</section>
   <div class="issue-next"><span>NEXT STEP</span><strong>${escape(nextText(summary))}</strong><p>${closed(c)?'eBay has closed its case. Internal tasks and returned inventory are tracked separately.':'Keep the case open until the customer issue and your internal work are both handled.'}</p></div>
   <div class="issue-facts"><div><small>eBay status</small><b>${escape(nice(c.ebay_status))}</b></div><div><small>Our return / case status</small><b>${escape(nice(c.status))}</b></div><div><small>eBay response deadline</small><b>${escape(date(c.ebay_due_at))}</b></div><div><small>Last successful case update</small><b>${escape(date(c.synced_at))}${c.sync_error?' · Retry needed':''}</b></div><div><small>Opened</small><b>${escape(date(c.opened_at))}</b></div><div><small>Customer’s reason</small><b>${escape(reason)}</b></div></div>
   ${c.sync_error?`<p class="issue-tag is-stale">Update failed. The previous case information was kept. ${escape(c.sync_error)}</p>`:''}
   <div class="issue-actions">${c.issue_kind==='return'&&remaining&&lines.some(l=>l.line_status==='fulfilled')&&!['closed','cancelled'].includes(c.status)?'<button class="primary-btn" data-receive>Receive returned items</button>':''}
    ${url?`<a class="secondary-btn" href="${escape(url)}" target="_blank" rel="noopener">${c.source_lane==='case'||c.source_lane==='payment_dispute'?'Open eBay order / case':'Open eBay case'} ↗</a>`:''}
    ${lines[0]?`<a class="secondary-btn" href="email-triage.html?orderLineId=${encodeURIComponent(lines[0].id)}&from=returns" target="_blank" rel="noopener">Buyer chat ↗</a>`:''}
    ${!lines.length&&ctx.employee.role==='admin'?'<button class="primary-btn" data-match-order>Match order items</button>':''}</div>
   <details class="issue-detail-section" open><summary>Order items &amp; saved photos</summary>${receipt||'<p class="issue-subtitle">No item screenshot is saved yet.</p>'}${lines.map(l=>`<div class="issue-line"><strong>${escape(l.item_title)}</strong><p>${escape(l.item_number||'')} · Order qty ${l.quantity||0} · Fulfilled ${l.fulfilled_quantity||0}</p></div>`).join('')}
    ${items.map(i=>`<div class="issue-line"><strong>${escape(i.item_title)}</strong><p>Received ${i.received_quantity} of ${i.expected_quantity} · Restocked ${i.restocked_quantity||0} · ${escape(nice(i.disposition))}</p>${i.received_quantity>i.restocked_quantity&&!['closed','cancelled'].includes(c.status)?`<button class="secondary-btn" data-inspect="${i.id}">Inspect received item</button>`:''}</div>`).join('')}
    <div id="issue-original-evidence"><p class="issue-subtitle">Loading saved order evidence…</p></div><h3 style="margin-top:20px">Return evidence</h3><div id="issue-return-evidence" class="issues-evidence-grid"></div></details>
   <details class="issue-detail-section issue-evidence-package"><summary>Evidence package</summary><p class="issue-subtitle">Gather item photos, packing evidence, tracking, certificates and messages. Choose what belongs in the download.</p><button class="secondary-btn" data-prepare-evidence>Prepare evidence</button><div id="issue-evidence-package"></div></details>
   ${renderTasks()}
   <details class="issue-detail-section"><summary>Money &amp; payment</summary><p>Case amount: <strong>${escape(c.raw_payload?.apiExtractedDetails?.requestAmount||c.raw_payload?.requestAmount||c.raw_payload?.refundText||'Not provided by eBay')}</strong></p>${ctx.financeBadge?.(primary)||''}<p class="issue-subtitle">Payment information updates separately in the background. The case amount is not confirmation that a refund was issued. Check eBay before making a financial decision.</p></details>
   <details class="issue-detail-section"><summary>Buyer’s complaint &amp; eBay conversation</summary>${complaint||''}${messages||'<p class="issue-subtitle">No case messages were returned by eBay. Open Buyer chat or the eBay case to check the conversation.</p>'}</details>
   <details class="issue-detail-section"><summary>Activity &amp; internal updates</summary>${events.length?events.map(e=>`<div class="issue-update"><small>${escape(date(e.created_at))} · ${escape(e.signed_by_email||'eBay / system')}</small><p>${escape(e.notes||nice(e.action))}</p></div>`).join(''):'<p class="issue-subtitle">No recorded updates yet.</p>'}${detail.moreEvents?'<p class="issue-subtitle">Showing the latest 50 events from each source. Open Full task for its complete work history.</p>':''}</details>
   ${ctx.employee.role==='admin'&&(closed(c)||!c.ebay_return_id)&&!['closed','cancelled'].includes(c.status)?'<details class="issue-detail-section"><summary>Finish this case</summary><p class="issue-subtitle">This finishes the internal case. It does not send a refund or change eBay. All tasks and inventory checks must be complete.</p><button class="secondary-btn" data-finish-case>Record final outcome</button></details>':''}</div>`;
  ctx.bindReceipt($('issues-detail'));ctx.hydrateReceipts().catch(()=>{});
  loadEvidence(version);loadOriginalEvidence(version);
 }
 async function loadEvidence(stamp){
  const photos=[],seen=new Set();
  detail.events.forEach(e=>(e.evidence_photos||e.photo_attachments||[]).forEach(p=>{const bucket=p.bucket||p.storage_bucket||'ebay-return-evidence',path=p.path||p.storage_path;if(path&&!seen.has(bucket+path)){seen.add(bucket+path);photos.push({...p,bucket,path});}}));
  const target=$('issue-return-evidence');if(!photos.length){target.innerHTML='<p class="issue-subtitle">No return photos or videos received yet.</p>';return;}
  target.innerHTML=photos.map((p,i)=>`<button class="issue-media" type="button" data-media="${i}"><span>Loading ${/video|mp4|mov|webm/i.test(p.mime_type||p.path)?'video':'photo'}…</span></button>`).join('');
  detail.photos=photos;
  // Small batches avoid signing hundreds of evidence files in parallel.
  for(let at=0;at<photos.length;at+=4){await Promise.all(photos.slice(at,at+4).map(async(p,index)=>{
   const video=/video|\.(mp4|mov|webm|m4v)$/i.test(p.mime_type||p.path),url=await ctx.signEvidence(p,{thumbnail:!video});
   if(stamp!==version)return;const b=target.querySelector(`[data-media="${at+index}"]`);if(!b)return;
   b.setAttribute('aria-label',video?'Play video':'View full photo');
   b.innerHTML=url?`${video?'<span style="font-size:32px;padding:45px 20px">▶</span>':`<img loading="lazy" src="${escape(url)}" alt="Returned item evidence" />`}<span>${video?'Play video':'View full photo'}</span>`:'<span>Preview unavailable · tap to retry</span>';
  }));if(stamp!==version)return;}
 }
 async function loadOriginalEvidence(stamp){
  const target=$('issue-original-evidence');
  if(!detail.c.order_id){target.innerHTML='<p class="issue-subtitle">Connect the original order to see its saved photos, video receipts and packaging evidence.</p>';return;}
  try{
   const data=checked(await db.rpc('customer_issue_evidence',{_case_id:detail.c.id}));if(stamp!==version||!target.isConnected)return;
   detail.originalEvidence=data;detail.originalLimits={};
   const receipts=ctx.evidenceReceipts?ctx.evidenceReceipts(detail.lines):[],shown=new Set(receipts.map(p=>`${p.bucket||p.storage_bucket}:${p.path||p.storage_path}`));
   detail.originalFiles=root.OGIssueEvidence.collect(data).filter(p=>p.group!=='returned'&&!shown.has(`${p.bucket}:${p.path}`));
   await renderOriginalEvidence(stamp);
  }catch(error){if(stamp===version&&target.isConnected)target.innerHTML=`<p class="issue-form-error">Saved order evidence could not load: ${escape(error.message)}. Refresh this case to retry.</p>`;}
 }
 async function renderOriginalEvidence(stamp){
  const target=$('issue-original-evidence'),data=detail.originalEvidence,files=detail.originalFiles;
  const groups={item:'Live bag photos',completion:'Order completion photos',packaging:'Packaging photos & videos',certificate:'Certificate copies'};
  target.innerHTML=`<p class="issue-subtitle">Evidence from original order ${escape(detail.c.order_number)}. Completion and packaging photos may include other items shipped in the same package.</p>`+
   Object.entries(groups).map(([key,title])=>{const found=files.map((p,i)=>({...p,i})).filter(p=>p.group===key),limit=detail.originalLimits[key]||6;
    if(!found.length)return `<p class="issue-evidence-empty"><b>${title}</b> · None saved</p>`;
    return `<section class="issue-original-group"><h3>${title} <small>${found.length}</small></h3>${found.length?`<div class="issues-evidence-grid">${found.slice(0,limit).map(p=>`<button class="issue-media" type="button" data-original-media="${p.i}" aria-label="${escape(p.video?'Play packaging video':p.label)}"><span>Loading ${p.video?'video':'file'}…</span></button>`).join('')}</div>${found.length>limit?`<button class="secondary-btn" data-more-original="${key}">Show ${Math.min(6,found.length-limit)} more</button>`:''}`:'<p class="issue-subtitle">No saved files in this category.</p>'}</section>`;}).join('')+
   (data.certificates||[]).filter(c=>safeUrl(c.certificate_url)).map(c=>`<p><a class="secondary-btn" href="${escape(safeUrl(c.certificate_url))}" target="_blank" rel="noopener">Certificate ${escape(c.report_number||'link')} ↗</a></p>`).join('')+
   (data.packages||[]).map(p=>`<p class="issue-subtitle">Package: ${escape(nice(p.status))}${p.tracking_code?` · Tracking ${escape(p.tracking_code)}`:''}</p>`).join('');
  const buttons=Array.from(target.querySelectorAll('[data-original-media]'));
  for(let at=0;at<buttons.length;at+=4){await Promise.all(buttons.slice(at,at+4).map(async button=>{
   const p=files[Number(button.dataset.originalMedia)],pdf=/pdf/i.test(p.mime_type||p.path),url=await ctx.signEvidence(p,{thumbnail:!p.video&&!pdf}).catch(()=>null);
   if(stamp!==version||!button.isConnected)return;
   const label=`${escape(p.label)}${p.created_at?` · ${escape(date(p.created_at))}`:''}`;
   if(pdf&&url){const a=document.createElement('a');a.className='issue-media';a.href=url;a.target='_blank';a.rel='noopener';a.innerHTML=`<span class="issue-file-symbol">PDF ↗</span><span>${label}</span>`;button.replaceWith(a);}
   else button.innerHTML=url?`${p.video?'<span class="issue-file-symbol">▶ Play video</span>':`<img loading="lazy" src="${escape(url)}" alt="${escape(p.label)}" />`}<span>${label}</span>`:`<span>Preview unavailable · tap to retry</span><span>${label}</span>`;
  }));if(stamp!==version)return;}
 }
 async function originalMedia(index){
  const p=detail?.originalFiles?.[index];if(!p)return;
  try{const url=await ctx.signEvidence(p,{thumbnail:false});if(!url)throw Error('File unavailable');ctx.openEvidence(url,p.label,p.path,p.video?'video':'image');}
  catch{feedback('Could not open this saved file. Please retry.',true);}
 }
 async function openCase(id,{quiet=false}={}){
  const initialForm=$('issue-action-form');
  const scroll=quiet?$('issues-detail').scrollTop:0;
  const expanded=quiet?new Set(Array.from($('issues-detail').querySelectorAll('details[open]>summary'),el=>el.textContent)):null;
  if(saving)return;selected=id;const stamp=++version;document.querySelector('.issues-columns').classList.add('is-selected');cards();
  if(!quiet)$('issues-detail').innerHTML='<div class="issues-empty">Loading the case and its evidence…</div>';
  try{
   const [c,tasks,items,caseEvents]=await Promise.all([
    db.from('ebay_return_cases').select('*').eq('id',id).single(),db.from('ebay_return_tasks').select('*').eq('return_case_id',id).order('created_at',{ascending:false}),
    db.from('ebay_return_items').select('*').eq('return_case_id',id),db.from('ebay_return_events').select('*').eq('return_case_id',id).order('created_at',{ascending:false}).limit(50)
   ]).then(rs=>rs.map(checked));
   if(stamp!==version)return;
   const ids=[...new Set([...tasks.flatMap(t=>t.order_line_ids||[]),...items.map(i=>i.order_line_id),...(c.raw_payload?.manualOrderMatch?.line_ids||c.raw_payload?.automaticOrderMatch?.line_ids||[])])].filter(Boolean);
   const [rawLines,taskEvents]=await Promise.all([ids.length?db.from('ebay_order_lines').select(ctx.lineSelect).in('id',ids):{data:[]},
    db.from('ebay_return_task_events').select('*').eq('return_case_id',id).order('created_at',{ascending:false}).limit(50)]).then(rs=>rs.map(checked));
   if(stamp!==version)return;
   const lines=rawLines.filter(l=>!l.order_id||l.order_id===c.order_id).map(ctx.normalizeLine);tasks.forEach(t=>t.ebay_return_cases=c);
   const orderEvents=await ctx.loadOrderEvents(ids);if(stamp!==version)return;
   ctx.state.returnTasks=tasks;ctx.state.returnTaskLines=new Map(lines.map(l=>[l.id,l]));ctx.state.returnTaskOrderEvents=orderEvents;ctx.state.returnCases=[{...c,ebay_return_items:items}];
   ctx.state.returnTaskEvents=taskEvents;ctx.state.returnAssignees=people;ctx.mergeLines(lines);
   if(tasks[0])await Promise.all([ctx.loadMessages(tasks[0]),ctx.hydrateComplaint(tasks)]);
   if(stamp!==version)return;
   if(quiet&&(($('issue-action-form')&&$('issue-action-form')!==initialForm)||ctx.state.busy))return;
   detail={c,tasks,items,lines,events:[...caseEvents,...taskEvents].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)),moreEvents:caseEvents.length===50||taskEvents.length===50};
   renderDetail();if(expanded)$('issues-detail').querySelectorAll('details').forEach(el=>el.open=expanded.has(el.querySelector('summary')?.textContent));$('issues-detail').scrollTop=scroll;
   const url=new URL(location.href);url.searchParams.delete('returnTaskId');url.searchParams.set('caseId',id);history.replaceState(null,'',url);
  }catch(error){if(stamp===version){$('issues-detail').innerHTML=`<div class="issues-empty"><button class="secondary-btn" data-close-case>← Cases</button><h2>Couldn’t load this case</h2><p>${escape(error.message)}</p><button class="primary-btn" data-retry-case>Retry</button></div>`;}}
 }
 function closeCase(){if(saving)return;version++;selected=null;detail=null;document.querySelector('.issues-columns').classList.remove('is-selected');const url=new URL(location.href);url.searchParams.delete('caseId');history.replaceState(null,'',url);cards();}
 function form(title,body,submit){
  $('issue-form-slot').innerHTML=`<form id="issue-action-form" class="issue-form"><h3>${escape(title)}</h3>${body}<p class="issue-form-error" role="alert"></p><div class="issue-actions"><button class="primary-btn" type="submit">${escape(submit)}</button><button class="secondary-btn" type="button" data-cancel-form>Cancel</button></div></form>`;
  $('issue-action-form').scrollIntoView({block:'nearest'});$('issue-action-form').querySelector('textarea,input,select')?.focus();
 }
 function taskForm(id,action){
  const task=detail.tasks.find(t=>t.id===id);if(!task)return;
  const titles={instructions:'Update or give instructions',update:'Update or hand back',complete:'Complete my part',accept:'Accept completed work',return:'Request changes',decide:'Record your decision'};
  const assignee=task.assigned_by&&task.assigned_by!==ctx.user.id?task.assigned_by:task.created_by;
  const update=action==='update'||action==='instructions';
  form(titles[action],`${update?`<label>What happens next?<select name="mode"><option value="update">Add information · responsibility stays the same</option>${assignee&&assignee!==ctx.user.id?`<option value="work">Ask ${escape(person(assignee))} to do work</option><option value="decision">Ask ${escape(person(assignee))} for a decision</option>`:''}</select></label>`:'<p class="issue-subtitle">Only this task changes. The order and eBay case stay separate.</p>'}<label>Update / instructions<textarea name="note" required maxlength="10000" placeholder="What happened, and what should happen next?"></textarea></label>`,update?'Save update':'Confirm');
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>{
   if(update)checked(await db.rpc('respond_task_request',{_source:'return',_task_id:task.id,_note:f.get('note'),_mode:f.get('mode'),_expected_assignee:task.assigned_to_user_id||null,_expected_assigner:task.assigned_by||null,_expected_updated_at:task.updated_at,_photos:[]}));
   else if(action==='decide'&&task.task_type==='return_review'&&!task.assigned_to_user_id)checked(await db.rpc('finish_customer_issue_review',{_task_id:task.id,_expected_updated_at:task.updated_at,_note:f.get('note')}));
   else checked(await db.rpc('advance_task_workflow',{_source:'return',_task_id:task.id,_action:action,_note:f.get('note'),_expected_status:task.status,_expected_assignee:task.assigned_to_user_id||null,_expected_updated_at:task.updated_at,_photos:[]}));
  });
 }
 function assignForm(id){
  const task=detail.tasks.find(t=>t.id===id),request=crypto.randomUUID();
  form(task?'Assign the next step':'Create a task',`<label>Person responsible<select name="owner" required><option value="">Choose a person</option>${people.map(p=>`<option value="${p.user_id}" ${p.user_id===task?.assigned_to_user_id?'selected':''}>${escape(p.display_name||p.email)}</option>`).join('')}</select></label><label>They need to<select name="kind"><option value="work">Do work</option><option value="decision">Make a decision / give instructions</option></select></label><label>Instructions<textarea name="note" required maxlength="10000">${escape(task?.question||'')}</textarea></label><label>Internal follow-up (optional)<input type="datetime-local" name="followup" /></label>`,'Assign task');
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>checked(await db.rpc(!task&&kind(detail.c)==='return'?'request_customer_return_followup':'assign_customer_issue',{_case_id:selected,...(!task&&kind(detail.c)==='return'?{_request_id:request}:{_task_id:task?.id||null}),_owner:f.get('owner'),_kind:f.get('kind'),_note:f.get('note'),_follow_up:f.get('followup')?new Date(f.get('followup')).toISOString():null})));
 }
 async function submitForm(event,operation){
  event.preventDefault();if(saving)return;const el=event.currentTarget;const f=new FormData(el);saving=true;el.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{await operation(f);saving=false;feedback('Saved. The next step and activity are updated.');await openCase(selected,{quiet:true});await refresh({detail:false});}
  catch(error){el.querySelector('.issue-form-error').textContent=error.message||'Could not save. Your instructions are still here.';}
  finally{saving=false;el.querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 function inspectionForm(id){
  const item=detail.items.find(i=>i.id===id),key=crypto.randomUUID();
  form('Inspect received item',`<p class="issue-subtitle">${escape(item.item_title)} · ${item.received_quantity-item.restocked_quantity} units not restocked</p><label>Inspection outcome<select name="outcome"><option value="quarantine">Keep on hold</option><option value="received_no_restock">Inspected, good · received without restocking</option>${item.internal_item_id?'<option value="restock">Inspected and sellable · restock</option>':''}<option value="damaged">Damaged · do not restock</option><option value="wrong_item">Wrong item · needs review</option><option value="admin_review">Needs a decision</option></select></label><p class="issue-subtitle">Received without restocking saves the inspection and evidence. It does not create an inventory item or change stock.</p><label>Restock location code (only for restocking)<input name="location" placeholder="Scan the tray or location code" /></label><label>Inspection notes<textarea name="note" required></textarea></label>`,'Save inspection');
  const note=$('issue-action-form').querySelector('[name="note"]');
  note.closest('label').insertAdjacentHTML('afterend','<div class="inspection-evidence"><label>Inspection photos / videos<input id="inspection-files" type="file" accept="image/*,video/*" multiple /></label><button type="button" class="secondary-btn" id="inspection-camera">Take a photo</button><input id="inspection-camera-file" type="file" accept="image/*" capture="environment" hidden /><p id="inspection-file-summary" class="issue-subtitle">Add close-ups of any damage, the item and its packaging.</p></div>');
  const location=$('issue-action-form').querySelector('[name="location"]');location.id='inspection-location';location.setAttribute('data-camera-scan','');
  const outcome=$('issue-action-form').querySelector('[name="outcome"]');
  const showLocation=()=>{location.closest('label').hidden=outcome.value!=='restock';location.required=outcome.value==='restock';};outcome.onchange=showLocation;showLocation();
  let uploaded=null,uploadedFiles=[];
  $('inspection-camera').onclick=()=>$('inspection-camera-file').click();
  $('inspection-camera-file').onchange=()=>{const dt=new DataTransfer();[...$('inspection-files').files,...$('inspection-camera-file').files].forEach(f=>dt.items.add(f));$('inspection-files').files=dt.files;$('inspection-camera-file').value='';$('inspection-files').dispatchEvent(new Event('change'));};
  $('inspection-files').onchange=()=>{$('inspection-file-summary').textContent=[...$('inspection-files').files].map(f=>f.name).join(' · ')||'No new files selected.';};
  $('issue-action-form').onsubmit=e=>submitForm(e,async f=>{
   let locationId=null;if(f.get('outcome')==='restock'){
    const choices=checked(await db.from('locations').select('id').eq('location_code',String(f.get('location')).trim()).eq('active',true).limit(2));
    if(choices.length!==1)throw Error('Scan one exact active location code.');locationId=choices[0].id;
   }
   const files=[...$('inspection-files').files];
   if(files.length>30||files.some(f=>!ctx.isEvidenceFile(f)))throw Error('Choose up to 30 photos or videos.');
   if(!uploaded||files.length!==uploadedFiles.length||files.some((f,i)=>f!==uploadedFiles[i])){uploaded=await ctx.uploadEvidence(files,[detail.c.order_number]);uploadedFiles=files;}
   checked(await db.rpc('inspect_customer_return',{_request_id:key,_item_id:id,_disposition:f.get('outcome'),_location:locationId,_note:f.get('note'),_evidence:uploaded}));
  });
 }
 async function receive(){
  const ids=detail.lines.filter(l=>l.line_status==='fulfilled'&&(!detail.items.find(i=>i.order_line_id===l.id)||detail.items.some(i=>i.order_line_id===l.id&&i.received_quantity<i.expected_quantity))).map(l=>l.id);
  ctx.openIntake(ids);ctx.state.returnIntakeCaseId=selected;$('return-ebay-id').value=detail.c.ebay_return_id||'';$('return-tracking').value=detail.c.return_tracking_number||'';
  $('return-ebay-id').readOnly=true;
 }
 async function media(index){
  const p=detail?.photos?.[index];if(!p)return;
  const url=await ctx.signEvidence(p,{thumbnail:false});if(!url)return feedback('Could not open this evidence. Please retry.',true);
  ctx.openEvidence(url,p.label||'Return evidence',p.path,/video|\.(mp4|mov|webm|m4v)$/i.test(p.mime_type||p.path)?'video':'image');
 }
 async function init(context){
  ctx=context;db=ctx.supabase;ready=true;
  root.OGReturnReceiving?.init({db,ctx,openCase,feedback});
  try{people=checked(await db.from('employees').select('user_id,email,display_name,role,active').eq('active',true).order('display_name')).filter(p=>p.user_id);}catch{people=[ctx.employee];}
  $('issues-workspace').addEventListener('click',e=>{
   const b=e.target.closest('button');if(!b||saving)return;
   if(b.dataset.issueView){view=b.dataset.issueView;offset=0;closeCase();refresh({detail:false});}
   else if(b.dataset.case)openCase(b.dataset.case);
   else if(b.hasAttribute('data-close-case'))closeCase();
   else if(b.hasAttribute('data-retry-case'))openCase(selected);
   else if(b.hasAttribute('data-sync-case'))sync(selected);
   else if(b.hasAttribute('data-retry-sync')&&ctx.employee.role==='admin')sync();
   else if(b.hasAttribute('data-receive'))receive();
   else if(b.dataset.taskAction)taskForm(b.dataset.task,b.dataset.taskAction);
   else if(b.dataset.followTask){const t=detail.tasks.find(t=>t.id===b.dataset.followTask);form('Reviewed · follow updates','<label>Review note<textarea name="note" required placeholder="What did you check? What are we waiting for?"></textarea></label>','Move to Following');$('issue-action-form').onsubmit=e=>submitForm(e,async f=>checked(await db.rpc('follow_customer_issue',{_task_id:t.id,_expected_updated_at:t.updated_at,_note:f.get('note')})));}
   else if(b.hasAttribute('data-prepare-evidence'))root.OGIssueEvidence.open({db,caseId:selected,target:$('issue-evidence-package'),data:detail.originalEvidence,sign:ctx.signEvidence,receipts:ctx.evidenceReceipts?ctx.evidenceReceipts(detail.lines):[],returnEvents:detail.events});
   else if(b.hasAttribute('data-assign'))assignForm(b.dataset.assign);
   else if(b.dataset.inspect)inspectionForm(b.dataset.inspect);
   else if(b.hasAttribute('data-media'))media(Number(b.dataset.media));
   else if(b.hasAttribute('data-original-media'))originalMedia(Number(b.dataset.originalMedia));
   else if(b.hasAttribute('data-more-original')){detail.originalLimits[b.dataset.moreOriginal]=(detail.originalLimits[b.dataset.moreOriginal]||6)+6;renderOriginalEvidence(version);}
   else if(b.hasAttribute('data-cancel-form'))$('issue-form-slot').innerHTML='';
   else if(b.hasAttribute('data-match-order'))matchForm();
   else if(b.hasAttribute('data-finish-case')){form('Record final outcome','<label>Outcome<textarea name="note" required placeholder="What was resolved and how?"></textarea></label>','Finish internal case');$('issue-action-form').onsubmit=e=>submitForm(e,async f=>checked(await db.rpc('finish_customer_issue',{_case_id:selected,_note:f.get('note')})));}
  });
  $('issues-search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>{search=$('issues-search').value.trim();offset=0;refresh({detail:false});},280);});
  $('issues-scope').onchange=()=>{scope=$('issues-scope').value;offset=0;refresh({detail:false});};
  $('issues-prev').onclick=()=>{offset=Math.max(0,offset-PAGE);refresh({detail:false});};$('issues-next').onclick=()=>{offset+=PAGE;refresh({detail:false});};
  $('issues-refresh').onclick=()=>{refresh();health();};$('issues-sync').onclick=()=>sync();
  await Promise.all([refresh({detail:false}),health()]);
  const params=new URLSearchParams(location.search);let id=params.get('caseId');
  if(!id&&params.get('returnTaskId'))try{id=checked(await db.from('ebay_return_tasks').select('return_case_id').eq('id',params.get('returnTaskId')).single()).return_case_id;}catch{}
  if(id)await openCase(id);
  if(params.get('syncHealth')==='1')document.querySelector('.issues-sync-health').open=true;
  poll=setInterval(()=>{if(!document.hidden&&!saving){health();if(!$('issue-action-form')&&!ctx.state.busy)refresh({detail:false});}},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!saving){health();refresh({detail:false});}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&selected&&!document.querySelector('.history-modal:not(.hidden)'))closeCase();});
 }
 function matchForm(){
  form('Find the exact order','<label>eBay order number<input name="order" required placeholder="00-00000-00000" pattern="[0-9]{2}-[0-9]{5}-[0-9]{5}" value="'+escape(detail.c.order_number||'')+'" /></label><div id="issue-match-results"></div>','Find order');
  $('issue-action-form').onsubmit=async e=>{
   e.preventDefault();const f=new FormData(e.currentTarget),target=$('issue-match-results');target.textContent='Finding the order…';
   try{
    const order=checked(await db.from('ebay_orders').select('id,order_number,buyer_username').eq('order_number',f.get('order')).single());
    const lines=checked(await db.from('ebay_order_lines').select('id,item_title,item_number,quantity').eq('order_id',order.id));
    target.innerHTML=`<p><strong>${escape(order.buyer_username)}</strong> · ${escape(order.order_number)}</p>${lines.map(l=>`<label><input type="checkbox" name="line" value="${l.id}" /> ${escape(l.item_title)} · ${escape(l.item_number)} · Qty ${l.quantity}</label>`).join('')}<label>Why these items match<textarea name="match_note" required></textarea></label>`;
    e.currentTarget.querySelector('[type="submit"]').textContent='Confirm matching items';
    e.currentTarget.onsubmit=ev=>submitForm(ev,async values=>checked(await db.rpc('link_customer_issue_order',{_case_id:selected,_order_id:order.id,_line_ids:values.getAll('line'),_note:values.get('match_note'),_expected_updated_at:detail.c.updated_at})));
   }catch(error){target.textContent=error.message||'No exact order found.';}
  };
 }
 root.OGCustomerIssues={init,refresh,openReceivedCase:id=>openCase(id),get ready(){return ready;},testing:{kind,nextText,closed,date,caseHref}};
})(globalThis);
