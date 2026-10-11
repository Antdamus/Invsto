/* Explicit blockers decide the work queue; ordinary customer tasks remain notes. */
(() => {
  const records = new Map(), known = new Set();
  let view = 'ready', watchFilter = '', failure = '', generation = 0, started = false, timer, filterRows = [];
  let dialog, context, requestId, saving = false, dialogRun = 0;
  let notice, undoEntry = null, undoBusy = false;
  const esc = value => escapeHtml(String(value ?? ''));
  const openRows = rows => rows.filter(isOpenOrderLine);
  const forBuyer = key => [...records.values()].filter(b => b.buyer_key === key);
  const active = key => forBuyer(key).filter(b => b.active);
  const cglFor = id => [...records.values()].find(b => b.kind === 'cgl' && b.line_ids.includes(id));
  const pendingCgl = key => active(key).filter(b => b.kind === 'cgl');
  const missingWatches = key => active(key).filter(b => b.kind === 'watch_missing');
  const missingFor = id => [...records.values()].find(b => b.kind === 'watch_missing' && b.active && b.line_ids.includes(id));
  const isNotFound = row => isOpenOrderLine(row) && row.item_search?.is_missing === true;
  const isKnown = key => known.has(key);
  const $ = id => document.getElementById(id);
  const stamp = value => formatDate(value);
  function showNotice(text, entry=null, error=false) {
    if(!notice){
      notice=document.createElement('aside');notice.className='pending-work-notice';notice.setAttribute('aria-label','Waiting update');
      notice.innerHTML='<p role="status" aria-live="polite"></p><button type="button" data-work-undo>Undo</button><button type="button" data-work-dismiss aria-label="Dismiss waiting update">×</button>';
      document.body.append(notice);
      notice.querySelector('[data-work-undo]').onclick=undoLast;
      notice.querySelector('[data-work-dismiss]').onclick=()=>{if(!undoBusy){notice.hidden=true;undoEntry=null;}};
    }
    undoEntry=entry;notice.hidden=false;notice.classList.toggle('is-error',error);
    notice.querySelector('p').textContent=text;
    notice.querySelector('[data-work-undo]').hidden=!entry;
    notice.querySelector('[data-work-undo]').disabled=undoBusy||saving;
    notice.querySelector('[data-work-dismiss]').disabled=undoBusy;
  }
  const removalMessage = key => active(key).length
    ? `Hold removed. This order is still Waiting on ${active(key).length} other ${active(key).length===1?'requirement':'requirements'}.`
    : 'Removed from Waiting. The order is back in Ready to work.';
  async function undoLast() {
    if(!undoEntry||undoBusy||saving)return;
    const entry=undoEntry;undoBusy=true;showNotice('Undoing the last waiting change…',entry);
    try{
      // Use the original revision. Never undo a later change by another employee.
      const reason='Added to Waiting by mistake — undone by staff';
      const result=entry.kind==='cgl'
        ? await supabase.rpc('confirm_pending_cgl',{_id:entry.id,_expected_revision:entry.revision,_correction_reason:reason})
        : await supabase.rpc('release_pending_order_work',{_id:entry.id,_expected_revision:entry.revision,_reason:reason});
      if(result.error)throw result.error;
      await load();
      showNotice(failure?'Undone, but the queue could not refresh. Use Retry to check its status.':removalMessage(entry.key));
      if(dialog?.open)await renderExisting();
    }catch(error){
      const changed=error.code==='40001';
      showNotice(changed?'This hold changed after you added it. Open Manage waiting to review it.':error.message||'Could not undo. Try again.',changed?null:entry,true);
    }finally{
      undoBusy=false;notice.querySelectorAll('button').forEach(button=>button.disabled=false);
    }
  }
  function reset() { generation++; records.clear(); known.clear(); failure = ''; filterRows = []; }
  function snapshot() { return JSON.stringify([...records.values()].sort((a,b) => a.id.localeCompare(b.id))); }
  async function load(rows = state.orders, {paint = true} = {}) {
    const run = ++generation, before = snapshot(), previous = new Map([...records].map(([id,b])=>[id,{key:b.buyer_key,value:JSON.stringify(b)}])), beforeKnown = [...known].sort().join(), beforeFailure = failure;
    const ids = [...new Set(openRows(rows).map(r => r.id))], next = new Map(), loaded = new Set();
    try {
      for (let i=0;i<ids.length;i+=250) {
        const batch=ids.slice(i,i+250);
        for(let offset=0;;offset+=500) {
          const {data,error}=await supabase.rpc('list_pending_order_work',{_line_ids:batch}).range(offset,offset+499);
          if(error)throw error;
          for(const b of data||[])next.set(b.id,b);
          if(!data||data.length<500)break;
        }
        rows.filter(r=>batch.includes(r.id)).forEach(r=>loaded.add(getBuyerKey(r)));
      }
      if(run!==generation)return;
      records.clear();next.forEach((b,id)=>records.set(id,b));known.clear();loaded.forEach(key=>known.add(key));failure='';
    } catch(error) {
      if(run!==generation)return;
      // Never present an unverified buyer as ready after a failed refresh.
      known.clear();failure='Waiting status could not be checked. Retry before completing an order.';
      console.warn('Pending work refresh failed',error);
    }
    if(before!==snapshot()){
      const changed=new Set();
      for(const [id,b] of records)if(previous.get(id)?.value!==JSON.stringify(b))changed.add(b.buyer_key);
      for(const [id,b] of previous)if(!records.has(id))changed.add(b.key);
      for(const row of rows)if(changed.has(getBuyerKey(row))){state.customerTaskNotes?.delete(getBuyerKey(row));state.sharedOrderNoteHistory?.delete(row.order_id);}
    }
    if(paint&&(before!==snapshot()||beforeKnown!==[...known].sort().join()||beforeFailure!==failure))refreshView();
  }
  function refreshView() {
    const anchors=[...document.querySelectorAll('.buyer-order-card')].map(el=>({key:el.dataset.buyerKey,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom})).filter(r=>r.bottom>140);
    applyOrderFilters();
    let tries=0;
    const restore=()=>{
      const cards=[...document.querySelectorAll('.buyer-order-card')];
      for(const anchor of anchors){const card=cards.find(el=>el.dataset.buyerKey===anchor.key);if(card){window.scrollBy(0,card.getBoundingClientRect().top-anchor.top);return;}}
      if(anchors.length&&++tries<20)requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  }
  function isSearch() {
    return Boolean($('order-search')?.value.trim() || state.selectedLiveLot || state.ebayLaunchBuyerKeys?.size || state.ebayLaunchOrderNumbers?.size);
  }
  function filter(rows) {
    filterRows=rows;
    const groups=groupLinesByBuyer(rows), history=$('order-status-filter')?.value==='fulfilled';
    const searching=isSearch();
    const counts={ready:0,waiting:0,all:groups.length,cgl:0,missing:0,'not-found':rows.filter(isNotFound).length,checking:0};
    for(const g of groups){
      if(!g.lines.some(isOpenOrderLine))continue;
      if(!isKnown(g.key))counts.checking++;
      else counts[active(g.key).length?'waiting':'ready']++;
      counts.cgl+=pendingCgl(g.key).length;
      counts.missing+=missingWatches(g.key).length;
    }
    document.querySelectorAll('[data-work-view]').forEach(b=>{
      b.setAttribute('aria-pressed',String(!searching&&b.dataset.workView===view));b.disabled=history||searching;
      const counter=b.querySelector('[data-work-count]');if(counter)counter.textContent=counts.checking?'…':String(counts[b.dataset.workView]);
    });
    for(const kind of ['cgl','missing','not-found']){
      const button=$(`pending-work-${kind}`);
      if(button){button.setAttribute('aria-pressed',String(!searching&&watchFilter===kind));button.disabled=history||searching;button.querySelector('span').textContent=counts.checking&&kind!=='not-found'?'…':String(counts[kind]);}
    }
    const help=$('pending-work-status');
    if(help){help.innerHTML=failure?`${esc(failure)} <button type="button" data-work-retry>Retry</button>`
      :history?'Completed orders are shown here.':searching?'Search and scans include ready and waiting orders.':counts.checking?'Checking which orders are ready…':watchFilter==='not-found'?'Items explicitly marked not found, across Ready and Waiting. Counts are item lines; each buyer’s package stays together.':'Waiting orders keep their shipping deadlines. Counts are buyer groups; item filters count lines.';}
    if(history||searching)return rows;
    const keys=new Set(groups.filter(g=>{
      if(watchFilter==='not-found'&&!g.lines.some(isNotFound))return false;
      if(!isKnown(g.key))return view==='all';
      const blockers=active(g.key);
      return (view==='all'||(view==='waiting')===Boolean(blockers.length))&&(!watchFilter||watchFilter==='not-found'||(watchFilter==='cgl'?pendingCgl(g.key).length:missingWatches(g.key).length));
    }).map(g=>g.key));
    return rows.filter(r=>keys.has(getBuyerKey(r)));
  }
  function itemSearchChanged() {
    // The existing item-search stream supplies changes; no extra reads or writes.
    if(watchFilter==='not-found'&&!isSearch())refreshView();
    else filter(filterRows);
  }
  function summaryCounts() {
    const groups=groupLinesByBuyer(openRows(state.orders));
    for(const name of ['all','overdue','today','tomorrow']){
      const matching=groups.filter(g=>name==='all'||g.lines.some(l=>getOrderUrgency(l.order?.ship_by_date)?.level===name));
      const host=document.querySelector(`[data-work-summary="${name}"]`);if(!host)continue;
      const ready=matching.filter(g=>isKnown(g.key)&&!active(g.key).length).length;
      const waiting=matching.filter(g=>isKnown(g.key)&&active(g.key).length).length;
      host.innerHTML=matching.some(g=>!isKnown(g.key))?'Checking work status…':`<button type="button" data-work-summary-view="ready" data-work-due="${name}">${ready} ready</button><span> · </span><button type="button" data-work-summary-view="waiting" data-work-due="${name}">${waiting} waiting</button>`;
    }
    const total=$('summary-pending-cgl');if(total)total.textContent=groups.some(g=>!isKnown(g.key))?'…':String(groups.reduce((n,g)=>n+pendingCgl(g.key).length,0));
    const missing=$('summary-missing-watches');if(missing)missing.textContent=groups.some(g=>!isKnown(g.key))?'…':String(groups.reduce((n,g)=>n+missingWatches(g.key).length,0));
  }
  function control(group) {
    if(!group.lines.some(isOpenOrderLine))return '';
    return `<button type="button" class="buyer-card-expand-btn pending-work-action" data-work-buyer="${esc(group.key)}" ${isKnown(group.key)?'':'disabled'}>${!isKnown(group.key)?'Checking work…':active(group.key).length?'Manage waiting':'Set as waiting'}</button>`;
  }
  function summary(group) {
    const blockers=active(group.key);if(!blockers.length)return '';
    const cgl=blockers.filter(b=>b.kind==='cgl').length;
    const missing=blockers.filter(b=>b.kind==='watch_missing').length;
    const ordinary=blockers.filter(b=>!['cgl','watch_missing'].includes(b.kind));
    return `<div class="pending-work-summary" role="note"><div class="pending-work-badges"><strong>Waiting</strong>${missing?`<button type="button" class="missing-watch-badge" data-work-buyer="${esc(group.key)}">Watch missing · ${missing} ${missing===1?'item':'items'}</button>`:''}${cgl?`<button type="button" data-work-buyer="${esc(group.key)}">Pending CGL · ${cgl} ${cgl===1?'item':'items'}</button>`:''}${ordinary.length?`<span>${ordinary.length} ${ordinary.length===1?'blocker':'blockers'}</span>`:''}</div>${ordinary.slice(0,2).map(b=>`<p>${esc(b.reason)} <small>${esc(b.assignee)} · Since ${esc(stamp(b.created_at))}${b.task_id?` · <a href="team-tasks.html?taskId=${encodeURIComponent(b.task_id)}">Open task</a>`:''}</small></p>`).join('')}${ordinary.length>2?`<button type="button" data-work-buyer="${esc(group.key)}">View all ${ordinary.length} blockers</button>`:''}</div>`;
  }
  function line(row) {
    if(!isOpenOrderLine(row))return '';
    const cgl=cglFor(row.id),missing=missingFor(row.id);
    if(!cgl&&!missing&&!window.OGOrderWatches?.marked(row.id))return '';
    const disabled=isKnown(getBuyerKey(row))?'':'disabled';
    const certificate=cgl?`<button type="button" class="line-cgl-toggle ${cgl.active?'is-pending':'is-confirmed'}" data-work-cgl-manage="${esc(row.id)}">${cgl.active?'Pending CGL':'CGL confirmed'}</button>`:`<button type="button" class="line-cgl-toggle" data-work-cgl-add="${esc(row.id)}" ${disabled}>Set Pending CGL</button>`;
    return certificate+`<button type="button" class="line-cgl-toggle line-missing-toggle ${missing?'is-missing':''}" ${missing?'data-work-missing-manage':'data-work-missing-add'}="${esc(row.id)}" ${disabled}>${missing?'Watch missing · Mark found':'Watch missing'}</button>`;
  }
  function createDialog() {
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.id='pending-work-dialog';dialog.className='pending-work-dialog';dialog.setAttribute('aria-labelledby','pending-work-title');
    dialog.innerHTML=`<header><div><small>ORDER PROCESSING</small><h2 id="pending-work-title">Waiting on follow-up</h2></div><button type="button" id="pending-work-close" aria-label="Close waiting details">×</button></header><p id="pending-work-buyer"></p><section id="pending-work-existing"></section><form id="pending-work-form"><label for="pending-work-task">What is holding this package?</label><select id="pending-work-task"><option value="">A waiting reason without a task</option></select><label for="pending-work-reason">Waiting reason</label><textarea id="pending-work-reason" maxlength="2000" rows="3" required placeholder="For example: waiting for the replacement clasp"></textarea><p class="pending-work-hint">A linked task clears this hold when it is fully resolved or accepted. Completing only your part keeps it waiting for review.</p><button type="submit" class="primary-btn" id="pending-work-save">Set as waiting</button></form><p id="pending-work-message" role="status" aria-live="polite"></p>`;
    document.body.append(dialog);
    $('pending-work-close').onclick=()=>{if(!saving)dialog.close();};
    dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});
    dialog.addEventListener('close',()=>{dialogRun++;context=null;});
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.addEventListener('click',e=>{if(!e.target.closest('[data-certificate-line]'))e.stopPropagation();});
    $('pending-work-form').onsubmit=saveHold;
    $('pending-work-task').onchange=()=>{const o=$('pending-work-task').selectedOptions[0];if(o.value)$('pending-work-reason').value=o.dataset.reason||o.textContent;};
    $('pending-work-existing').onclick=event=>{
      const release=event.target.closest('[data-work-release]');if(release)void releaseHold(release.dataset.workRelease);
      const confirm=event.target.closest('[data-work-confirm]');if(confirm)void confirmCgl(confirm.dataset.workConfirm);
      const correction=event.target.closest('[data-work-correct]');if(correction)void correctCgl(correction.dataset.workCorrect);
      const found=event.target.closest('[data-work-found]');if(found)void markWatchFound(found.dataset.workFound);
    };
  }
  function message(text,error=false){$('pending-work-message').textContent=text;$('pending-work-message').classList.toggle('is-error',error);}
  function setBusy(value){saving=value;dialog?.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=value);if(notice)notice.querySelector('[data-work-undo]').disabled=value||undoBusy;}
  async function show(key, {onlyCgl = null, onlyMissing = null} = {}) {
    createDialog();const group=groupLinesByBuyer(state.orders).find(g=>g.key===key);if(!group)return;
    context={group,onlyCgl,onlyMissing};requestId=crypto.randomUUID();const run=++dialogRun;
    $('pending-work-buyer').textContent=`${group.buyer} · ${openRows(group.lines).length} pending item lines`;
    $('pending-work-form').hidden=Boolean(onlyCgl||onlyMissing);$('pending-work-reason').value='';
    $('pending-work-task').innerHTML='<option value="">A waiting reason without a task</option>';
    $('pending-work-title').textContent=onlyCgl?'Watch certificate':onlyMissing?'Missing watch':'Waiting on follow-up';
    message('Loading waiting details…');dialog.showModal();
    await load(state.orders);
    if(run!==dialogRun)return;
    if(failure){message(failure,true);return;}
    await renderExisting(run);
    if(run!==dialogRun)return;
    message('');
    if(!onlyCgl&&!onlyMissing){try{
      // Fetch current choices; a task completed in another tab must not be offered.
      getGroupCustomerTaskKeys(group.lines).forEach(b=>state.customerTaskNotes.delete(b));
      const tasks=(await loadCustomerTaskNotes(group.lines)).flat();
      if(run!==dialogRun)return;
      $('pending-work-task').innerHTML='<option value="">A waiting reason without a task</option>'+tasks.map(t=>`<option value="${esc(`${t.source}:${t.id}`)}" data-reason="${esc(t.question||t.title)}">${esc(t.question||t.title)} — ${esc(t.assignee_name||t.assigned_to_email||'Unassigned')}</option>`).join('');
    }catch{if(run===dialogRun)message('Tasks could not be loaded. You can still enter a waiting reason.',true);}}
  }
  async function renderExisting(run=dialogRun) {
    if(!context)return;
    const entries=forBuyer(context.group.key).filter(b=>context.onlyCgl?b.kind==='cgl'&&b.line_ids.includes(context.onlyCgl):context.onlyMissing?b.kind==='watch_missing'&&b.active&&b.line_ids.includes(context.onlyMissing):b.active);
    $('pending-work-existing').innerHTML=entries.map(b=>{
      const row=state.orders.find(r=>b.line_ids.includes(r.id));
      if(b.kind==='watch_missing')return `<article class="pending-work-entry"><h3>${esc(row?.item_title||'Watch')}</h3><strong class="missing-watch-badge">Watch missing</strong><p>${esc(b.assignee)} · Since ${esc(stamp(b.created_at))}</p><p>This buyer’s package stays in Waiting until this watch is found. Other requirements, including CGL, remain separate.</p><label class="pending-work-check"><input type="checkbox" id="found-${esc(b.id)}">I have located and checked this watch.</label><button type="button" class="primary-btn" data-work-found="${esc(b.id)}">Mark watch found</button><details><summary>Marked missing by mistake</summary><label for="release-${esc(b.id)}">Correction reason</label><textarea id="release-${esc(b.id)}" rows="2" maxlength="2000"></textarea><button type="button" data-work-release="${esc(b.id)}">Remove missing marker</button></details></article>`;
      if(b.kind==='cgl')return `<article class="pending-work-entry"><h3>${esc(row?.item_title||'Watch')}</h3><strong>${b.active?'Pending CGL':'CGL confirmed'}</strong><p>A saved copy must match this watch before its package can be completed.</p><button type="button" class="secondary-btn" data-certificate-line="${esc(row?.id)}" data-certificate-title="${esc(row?.item_title)}">Open / add certificate</button><div data-work-certificates="${esc(b.id)}">Loading saved certificates…</div><details><summary>CGL is not required / marked by mistake</summary><label for="correct-${esc(b.id)}">Correction reason</label><textarea id="correct-${esc(b.id)}" rows="2" maxlength="2000"></textarea><button type="button" data-work-correct="${esc(b.id)}">Remove requirement</button></details></article>`;
      return `<article class="pending-work-entry"><strong>${esc(b.reason)}</strong><p>${esc(b.assignee)} · Since ${esc(stamp(b.created_at))}</p>${b.task_id?`<a href="team-tasks.html?taskId=${encodeURIComponent(b.task_id)}">Open linked task</a><p class="pending-work-hint">Removing this hold leaves the task open.</p>`:''}<p class="pending-work-hint">Resolved or sent here by mistake? Remove this hold. Other requirements will still apply.</p><label for="release-${esc(b.id)}">Reason for removing (optional)</label><textarea id="release-${esc(b.id)}" rows="2" maxlength="2000" placeholder="For example: sent to Waiting by mistake"></textarea><button type="button" data-work-release="${esc(b.id)}">Remove from waiting</button></article>`;
    }).join('')||'<p class="pending-work-hint">No active blockers for this buyer.</p>';
    for(const b of entries.filter(b=>b.kind==='cgl')) {
      try{
        const {data,error}=await supabase.from('ebay_order_line_certificates').select('id,report_number,watch_serial,created_at').in('order_line_id',b.line_ids).is('voided_at',null).order('created_at',{ascending:false});if(error)throw error;
        if(run!==dialogRun)return;
        const host=dialog.querySelector(`[data-work-certificates="${b.id}"]`);if(!host)continue;
        host.innerHTML=!b.active?'<p class="pending-work-hint">Certificate confirmed. If it is marked incorrect, this requirement reopens automatically.</p>':data?.length?`<label for="certificate-${b.id}">Saved certificate</label><select id="certificate-${b.id}">${data.map(c=>`<option value="${esc(c.id)}">${esc(c.report_number||'Certificate copy')}${c.watch_serial?` · Serial ${esc(c.watch_serial)}`:''} · ${esc(stamp(c.created_at))}</option>`).join('')}</select><label class="pending-work-check"><input type="checkbox" id="verified-${b.id}">I checked that this certificate belongs to this watch.</label><button type="button" class="primary-btn" data-work-confirm="${b.id}">Confirm certificate</button>`:'<p class="pending-work-hint">Add a PDF or photo copy first, then return here to confirm it.</p>';
      }catch{if(run===dialogRun){const host=dialog.querySelector(`[data-work-certificates="${b.id}"]`);if(host)host.textContent='Could not load saved certificates. Close and reopen to retry.';}}
    }
  }
  async function mutate(operation, success, close=false, undo=null) {
    if(saving)return;setBusy(true);message('Saving…');
    try{const {data,error}=await operation();if(error)throw error;
      if(undo&&data===undo.id)showNotice(`Moved to Waiting · ${undo.buyer}`,undo);
      await load();if(failure)throw Error('Saved, but the queue could not refresh. Retry the status check.');
      const text=typeof success==='function'?success():success;
      if(close){dialog.close();setStatus(text,'success');if(!undo)showNotice(text);}else{await renderExisting();message(text);}
    }catch(error){message(error.message||'Could not save. Retry.',true);}finally{setBusy(false);}
  }
  async function saveHold(event) {
    event.preventDefault();if(!context||saving)return;
    const reason=$('pending-work-reason').value.trim(),value=$('pending-work-task').value;
    if(!reason){message('Enter a waiting reason.',true);return;}
    const [source,id]=value.split(':');
    const undo={id:requestId,kind:value?'task':'manual',revision:1,key:context.group.key,buyer:context.group.buyer};
    await mutate(()=>supabase.rpc('create_pending_order_work',{_id:undo.id,_line_ids:openRows(context.group.lines).map(r=>r.id),_kind:undo.kind,_reason:reason,_task_source:source||null,_task_id:id||null}), 'Moved to Waiting.',true,undo);
  }
  async function releaseHold(id) {
    const b=records.get(id);if(!b)return;
    const ordinary=['manual','task'].includes(b.kind);
    const reason=$(`release-${id}`).value.trim()||(ordinary?'Waiting hold removed by staff — resolved or added by mistake':'');
    if(!reason){message('Enter the correction reason.',true);return;}
    await mutate(()=>supabase.rpc('release_pending_order_work',{_id:id,_expected_revision:b.revision,_reason:reason}),()=>removalMessage(b.buyer_key),ordinary);
  }
  async function confirmCgl(id) {
    const b=records.get(id);if(!b||!$(`verified-${id}`)?.checked){message('Check that the saved certificate belongs to this watch first.',true);return;}
    await mutate(()=>supabase.rpc('confirm_pending_cgl',{_id:id,_expected_revision:b.revision,_certificate_id:$(`certificate-${id}`).value}),'Certificate confirmed. Any other blockers still apply.');
  }
  async function markWatchFound(id) {
    const b=records.get(id);if(!b||!$(`found-${id}`)?.checked){message('Confirm that you located and checked this watch first.',true);return;}
    await mutate(()=>supabase.rpc('release_pending_order_work',{_id:id,_expected_revision:b.revision,_reason:'Watch found and checked'}),'Watch marked found. Any other blockers still apply.',Boolean(context.onlyMissing));
  }
  async function correctCgl(id) {
    const b=records.get(id),reason=$(`correct-${id}`).value.trim();if(!b||!reason){message('Enter why CGL is not required.',true);return;}
    await mutate(()=>supabase.rpc('confirm_pending_cgl',{_id:id,_expected_revision:b.revision,_correction_reason:reason}),'CGL requirement removed; the correction is saved in history.');
  }
  async function addWatchHold(id,button,kind) {
    const row=state.orders.find(r=>r.id===id);if(!row||button.disabled||saving)return;
    button.disabled=true;setBusy(true);
    const label=kind==='cgl'?'Pending CGL':'Watch missing';
    const undo={id:crypto.randomUUID(),kind,revision:1,key:getBuyerKey(row),buyer:getBuyerLabel(row)};
    try{const {data,error}=await supabase.rpc('create_pending_order_work',{_id:undo.id,_line_ids:[id],_kind:kind,_reason:kind==='cgl'?'Pending CGL certificate':'Watch missing — locate before shipping'});if(error)throw error;
      if(data===undo.id)showNotice(`${label} saved · ${undo.buyer}`,undo);
      await load();if(failure)throw Error('Saved, but the queue could not refresh. Retry the status check.');setStatus(`${label} saved. This buyer’s package is now Waiting.`,'success');
    }catch(error){setStatus(error.message||`Could not set ${label}.`,'error');button.disabled=false;}finally{setBusy(false);}
  }
  async function assertReady(rows) {
    await load(state.orders);
    if(failure)throw Error(failure);
    for(const row of rows){const key=getBuyerKey(row);if(!isKnown(key))throw Error('Waiting status has not loaded. Refresh Pending Orders.');const b=active(key)[0];if(b)throw Error(`Package is waiting: ${b.reason}. Open Manage waiting on the buyer summary.`);}
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(document.visibilityState!=='hidden')void load();},250);}
  function start() {
    if(started)return;started=true;
    document.addEventListener('click',event=>{
      const b=event.target.closest('[data-work-view],[data-work-summary-view],[data-work-buyer],[data-work-cgl-add],[data-work-cgl-manage],[data-work-missing-add],[data-work-missing-manage],[data-work-retry],#pending-work-cgl,#pending-work-missing,#pending-work-not-found,#summary-cgl-button,#summary-missing-button');if(!b)return;
      event.preventDefault();event.stopPropagation();
      if(b.disabled||saving||undoBusy)return;
      if(b.hasAttribute('data-work-retry')){void load();return;}
      if(b.dataset.workCglAdd){void addWatchHold(b.dataset.workCglAdd,b,'cgl');return;}
      if(b.dataset.workMissingAdd){void addWatchHold(b.dataset.workMissingAdd,b,'watch_missing');return;}
      if(b.dataset.workMissingManage){const row=state.orders.find(r=>r.id===b.dataset.workMissingManage);if(row)void show(getBuyerKey(row),{onlyMissing:row.id});return;}
      if(b.dataset.workCglManage){const row=state.orders.find(r=>r.id===b.dataset.workCglManage);if(row)void show(getBuyerKey(row),{onlyCgl:row.id});return;}
      if(b.dataset.workBuyer){void show(b.dataset.workBuyer);return;}
      if(['pending-work-cgl','pending-work-missing','pending-work-not-found'].includes(b.id)){const kind=b.id.slice('pending-work-'.length);watchFilter=watchFilter===kind?'':kind;if(watchFilter)view=kind==='not-found'?'all':'waiting';}
      else if(['summary-cgl-button','summary-missing-button'].includes(b.id)){watchFilter=b.id==='summary-cgl-button'?'cgl':'missing';view='waiting';state.orderDueFilter='all';clearOrderSearch({apply:false});}
      else{view=b.dataset.workView||b.dataset.workSummaryView;watchFilter='';if(b.dataset.workDue){state.orderDueFilter=b.dataset.workDue;clearOrderSearch({apply:false});}}
      applyOrderFilters();
    },true);
    window.OGOrderLiveUpdates?.subscribe(supabase,change=>{if(['work_blocker','reconnected'].includes(change.kind))schedule();});
    window.addEventListener('online',schedule);document.addEventListener('visibilitychange',schedule);
    window.addEventListener('order-certificate-changed',async()=>{await load();if(dialog?.open&&!saving)await renderExisting();});
    window.setInterval(schedule,60000);
  }
  const emptyMessage=()=>watchFilter==='not-found'&&!isSearch()?'No pending items are marked not found in this view.':failure?'Waiting status is unavailable. Use Retry above.':!known.size&&state.orders.some(isOpenOrderLine)?'Checking order work status…':view==='waiting'&&!isSearch()?watchFilter==='missing'?'No watches are marked missing in this view.':watchFilter==='cgl'?'No watches are waiting for CGL in this view.':'No orders are waiting in this view. Choose Ready to work to continue.':'No orders match this view.';
  window.OGPendingWork={reset,load,filter,summaryCounts,control,summary,line,start,assertReady,emptyMessage,itemSearchChanged};
})();
