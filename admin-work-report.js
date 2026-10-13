(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const zone = 'America/New_York';
  const categories = {closed_orders:'Pending orders closed',tasks:'Tasks',inventory:'Inventory changes',stock:'Stock movements',orders:'Orders & fulfillment',packaging:'Packaging',messages:'Messages',returns:'Returns',transfers:'Trays & transfers',photos:'Photos',pricing:'Pricing',live_sales:'Live sales',sales:'Sales',catalogues:'Catalogues',offsite:'Off-site work',attendance:'Time & breaks',administration:'Administration'};
  const metrics = {pending_orders_closed:'Pending orders closed',tasks_completed:'Tasks marked completed',tasks_closed:'Tasks closed',items_created:'Item types created',units_checked_in:'Units checked in',replies_sent:'Replies sent',packages_packed:'Packages packed',packages_dispatched:'Packages dispatched',admin_closeouts:'Admin package closeouts'};
  const actionLabels = {fulfilled_no_inventory:'Order completion recorded',pack:'Package packed',dispatch:'Package dispatched',admin_closeout:'Administrative closeout',prior_dispatch_closeout:'Historical closeout',send_attempt_succeeded:'Reply sent',marked_read:'Explicitly marked read',read_by_reply:'Marked read by replying',marked_unread:'Marked unread',checkin:'Stock checked in',checkout:'Stock checked out',status_changed:'Task status changed',completed_by_employee:'Task marked completed',resolved:'Task closed',batch_recorded:'Batch recorded'};
  const state = {initialized:false,version:0,report:null,focus:null,workers:new Map(),panels:new Map()};
  const human = v => String(v ?? '').replaceAll('_',' ').replace(/^./,s=>s.toUpperCase());
  const number = v => Number(v || 0).toLocaleString();
  const date = (v,seconds=true) => v ? new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',...(seconds?{second:'2-digit'}:{}),timeZoneName:'short'}).format(new Date(v)) : '—';
  const day = v => new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(v ? new Date(v) : new Date());
  const duration = seconds => `${Math.floor(Number(seconds || 0)/3600)}h ${Math.floor(Number(seconds || 0)%3600/60)}m`;
  const name = w => w.display_name || w.email || 'Worker';
  async function rpc(args) {
    const client=window.supabaseClient || window.supabase;
    const {data,error}=await client.rpc('admin_employee_work_report',args);
    if(error) throw new Error(error.message || 'Unable to load the work report.');
    return data;
  }
  function stats(w) {
    return `<div class="work-stats">${Object.entries(metrics).map(([key,label])=>key==='pending_orders_closed'?`<button class="work-closed-stat" type="button" data-work-closed><strong>${number(w.metrics?.[key])}</strong><span>${label}</span><small>View orders ↗</small></button>`:`<div><strong>${number(w.metrics?.[key])}</strong><span>${label}</span></div>`).join('')}</div>`;
  }
  function recordDetails(value,depth=0) {
    if(value===null || value===undefined) return '<span class="muted">Not recorded</span>';
    if(typeof value!=='object') return esc(typeof value==='boolean'?(value?'Yes':'No'):value);
    if(depth>3) return `<pre>${esc(JSON.stringify(value,null,2))}</pre>`;
    if(Array.isArray(value)) return value.length?`<ol>${value.map(v=>`<li>${recordDetails(v,depth+1)}</li>`).join('')}</ol>`:'<span class="muted">None</span>';
    return `<dl class="work-fields">${Object.entries(value).filter(([,v])=>v!==null && v!=='').map(([k,v])=>`<div><dt>${esc(human(k))}</dt><dd>${recordDetails(v,depth+1)}</dd></div>`).join('')}</dl>`;
  }
  function sourceLink(e) {
    const d=e.details || {};
    const query=params=>new URLSearchParams(params).toString();
    if(d.task_id && d.task_source) return ['Open task',`team-tasks.html?${query({taskId:d.task_id,source:d.task_source})}`];
    if(d.conversation_id) return ['Open conversation',`email-triage.html?${query({ebayConversationDbId:d.conversation_id,...(d.buyer_username?{ebayBuyer:d.buyer_username}:{}),...(d.message_id?{ebayMessageDbId:d.message_id}:{})})}`];
    if(e.category==='packaging' && d.shipment_id) return ['Open package',`packaging.html?${query({package:d.shipment_id})}`];
    if(e.category==='closed_orders' && d.order_number) return ['Open order history',`ebay-order-history.html?${query({focusOrder:d.order_number})}`];
    const orderNumber=d.payload?.order_number || d.order_numbers?.[0];
    if(orderNumber) return ['Open order',`pending-orders.html?${query({orderId:orderNumber})}`];
    return null;
  }
  function eventHTML(e,w) {
    const link=sourceLink(e), d=e.details || {};
    return `<article class="work-event">
      <div class="work-event-time"><time datetime="${esc(e.occurred_at)}">${esc(date(e.occurred_at))}</time><span>${esc(categories[e.category] || human(e.category))}</span></div>
      <div class="work-event-body"><h4>${esc(e.action==='pending_order_closed'?'Pending order closed':actionLabels[e.action] || human(e.action))}</h4><p class="work-event-title">${esc(e.title)}</p>
      ${e.category==='closed_orders'?`<ul class="work-order-items">${(d.items || []).map(item=>`<li><span>${esc(item.item_title || item.item_number || 'Item')}</span><small>${item.status==='fulfilled'?`${number(item.fulfilled_quantity)} fulfilled`:esc(human(item.status))}</small></li>`).join('')}</ul><p class="work-completed-by">Completed by ${esc(name(w))}</p>`:''}
      ${d.old_status!==undefined || d.new_status?`<p class="work-transition">${esc(human(d.old_status) || 'New')} → ${esc(human(d.new_status) || 'Unchanged')}</p>`:''}
      ${e.quantity?`<p>Quantity: <strong>${number(e.quantity)}</strong></p>`:''}
      ${e.notes?`<p class="work-note">${esc(e.notes)}</p>`:''}
      ${link?`<a class="work-source" href="${esc(link[1])}" target="_blank" rel="noopener">${link[0]} ↗</a>`:''}
      <details class="work-evidence"><summary>Details & source record</summary><p>${e.category==='attendance'?'Time record for':'Recorded actor:'} <strong>${esc(name(w))}</strong></p><p class="work-record-id">${esc(e.event_key)}</p>${recordDetails(d)}</details>
      </div></article>`;
  }
  function filterWorkers() {
    const query=$('workWorkerSearch').value.trim().toLowerCase();
    let visible=0;
    document.querySelectorAll('.work-worker').forEach(card=>{
      const w=state.workers.get(card.dataset.worker);
      card.hidden=!`${name(w)} ${w.email || ''}`.toLowerCase().includes(query);
      if(!card.hidden) visible++;
    });
    $('workNoWorkers').hidden=visible>0;
  }
  function panelState(id) {
    if(!state.panels.has(id)) state.panels.set(id,{shift:'',category:'',search:'',generation:0,loaded:false,events:[]});
    return state.panels.get(id);
  }
  function summaryHTML(w) {
    return `
      <span class="work-person"><strong>${esc(name(w))}</strong><small>${w.active?'':'Inactive · '}${w.shifts.some(s=>!s.clock_out)?'Shift open · ':''}${w.shifts.length?`${duration(w.clocked_seconds)} clocked · ${duration(w.break_seconds)} breaks`:'No shift recorded for this day'}</small></span>
      <span class="work-mini"><span><b>${number(w.metrics.pending_orders_closed)}</b> order${Number(w.metrics.pending_orders_closed)===1?'':'s'} closed</span><span><b>${number(w.metrics.tasks_completed)}</b> tasks completed</span><span><b>${number(w.metrics.units_checked_in)}</b> units in</span><span><b>${number(w.records)}</b> records</span></span>
      <span class="work-expand" aria-hidden="true">⌄</span>`;
  }
  function workerHTML(w) {
    return `<details class="work-worker" data-worker="${esc(w.id)}"><summary>${summaryHTML(w)}</summary><div class="work-worker-body"></div></details>`;
  }
  function renderPanel(card) {
    const id=card.dataset.worker,w=state.workers.get(id),p=panelState(id);
    card.querySelector('.work-worker-body').innerHTML=`
      <div class="work-detail-summary"></div>
      <div class="work-detail-filters"><label ${state.focus?'hidden':''}>Day or shift<select data-work-shift>${state.focus?'':'<option value="">Entire calendar day</option>'}${w.shifts.map(s=>`<option value="${esc(s.id)}">${esc(date(s.clock_in,false))} → ${s.clock_out?esc(date(s.clock_out,false)):'Still open'}${s.store?' · '+esc(s.store):''}</option>`).join('')}</select></label>
      <label>Type of work<select data-work-category><option value="">All recorded work</option></select></label>
      <form class="work-find"><label>Find an action<input type="search" maxlength="200" data-work-query placeholder="Task, item, order, note…" /></label><button class="btn" type="submit">Search</button></form></div>
      <p class="work-detail-status" role="status"></p><div class="work-events"></div>
      <button class="btn work-more" type="button" hidden>Load more actions</button>`;
    card.querySelector('[data-work-shift]').value=p.shift;
    card.querySelector('[data-work-query]').value=p.search;
    card.querySelector('[data-work-shift]').addEventListener('change',e=>{p.shift=e.target.value;p.category='';loadWorker(card);});
    card.querySelector('[data-work-category]').addEventListener('change',e=>{p.category=e.target.value;loadWorker(card);});
    card.querySelector('form').addEventListener('submit',e=>{e.preventDefault();p.search=card.querySelector('[data-work-query]').value.trim();loadWorker(card);});
    card.querySelector('.work-more').addEventListener('click',()=>loadWorker(card,true));
    card.querySelector('.work-detail-summary').addEventListener('click',e=>{
      if(!e.target.closest('[data-work-closed]')) return;
      p.category='closed_orders';p.search='';card.querySelector('[data-work-query]').value='';
      loadWorker(card).then(()=>card.querySelector('.work-detail-status')?.scrollIntoView({block:'start',behavior:'smooth'}));
    });
  }
  async function loadWorker(card,more=false) {
    const id=card.dataset.worker,p=panelState(id),version=state.version,generation=++p.generation;
    if(!card.querySelector('.work-detail-status')) renderPanel(card);
    const status=card.querySelector('.work-detail-status'),button=card.querySelector('.work-more');
    status.textContent=more?'Loading more actions…':'Loading recorded work…';
    button.disabled=true;p.loaded=false;
    if(!more) {p.events=[];card.querySelector('.work-events').innerHTML='';card.querySelector('.work-detail-summary').innerHTML='';button.hidden=true;card.querySelector('.work-mini').textContent='Loading selected totals…';}
    try {
      const r=await rpc({_day:state.report.day,_employee_id:id,_shift_id:p.shift || null,_category:p.category || null,_search:p.search || null,_offset:p.events.length,_limit:50,_as_of:state.report.as_of});
      if(version!==state.version || generation!==p.generation || !card.isConnected) return;
      const w=r.workers[0];if(!w) throw new Error('Worker is no longer available. Refresh the report.');
      card.querySelector(':scope > summary').innerHTML=summaryHTML(w);
      p.loaded=true;p.events.push(...r.events);p.result=r;
      const options=card.querySelector('[data-work-category]');
      options.innerHTML='<option value="">All recorded work</option>'+Object.entries(categories).filter(([key])=>w.categories[key]).map(([key,label])=>`<option value="${key}">${label} (${number(w.categories[key])})</option>`).join('');
      if(p.category && !w.categories[p.category]) options.insertAdjacentHTML('beforeend',`<option value="${esc(p.category)}">${esc(categories[p.category] || p.category)} (0)</option>`);
      options.value=p.category;
      card.querySelector('.work-detail-summary').innerHTML=`${stats(w)}<p class="work-window">${esc(date(r.start_at,false))} → ${esc(date(r.end_at,false))}${!p.shift?' (end exclusive)':''}<br>${duration(w.clocked_seconds)} clocked · ${duration(w.break_seconds)} breaks${w.shifts.some(s=>s.correction_count)?' · Shift time has corrections; see Administration records.':''}</p>`;
      card.querySelector('.work-events').insertAdjacentHTML('beforeend',r.events.map(e=>eventHTML(e,w)).join(''));
      status.textContent=r.total?`Showing ${number(p.events.length)} of ${number(r.total)} matching records · newest first. Summary counts cover the full selected day or shift.`:'No recorded actions match this selection.';
      button.hidden=p.events.length>=r.total;button.disabled=false;
    } catch(error) {
      if(version!==state.version || generation!==p.generation) return;
      status.textContent=`Could not load actions: ${error.message}`;
      if(!more) card.querySelector('.work-mini').textContent='Totals unavailable · Retry below';
      button.hidden=false;button.disabled=false;button.textContent='Retry loading actions';
    }
    if(p.loaded) button.textContent='Load more actions';
  }
  async function refresh() {
    const version=++state.version;
    const open=[...document.querySelectorAll('.work-worker[open]')].map(c=>c.dataset.worker);
    const oldDay=state.report?.day,selectedDay=$('workDay').value;
    if(!selectedDay) { $('workStatus').textContent='Choose a date.';$('workWorkers').innerHTML='';state.report=null;$('workRefresh').disabled=false;return; }
    $('workStatus').textContent='Loading employee work records…';$('workRefresh').disabled=true;
    // Remove the previous date immediately: it must never masquerade as the new date.
    $('workWorkers').innerHTML='';state.report=null;
    try {
      const focus=state.focus;
      const r=await rpc({_day:selectedDay,...(focus?{_employee_id:focus.employeeId,_shift_id:focus.shiftId}: {})});
      if(version!==state.version) return;
      if(oldDay!==selectedDay) state.panels.clear();
      state.report=r;state.workers=new Map(r.workers.map(w=>[w.id,w]));
      $('workWorkers').innerHTML=r.workers.map(workerHTML).join('');
      const active=r.workers.filter(w=>w.records>0).length;
      $('workStatus').textContent=`${active} worker${active===1?'':'s'} with recorded activity · ${number(r.workers.reduce((n,w)=>n+Number(w.records),0))} records · Updated ${date(r.as_of)}${r.unattributed_records?` · ${number(r.unattributed_records)} records belong to accounts without an employee profile.`:''}`;
      document.querySelectorAll('.work-worker').forEach(card=>{
        card.addEventListener('toggle',()=>{if(card.open && !panelState(card.dataset.worker).loaded) loadWorker(card);});
        const p=panelState(card.dataset.worker);p.loaded=false;
        if(focus) p.shift=focus.shiftId;
        if(focus || (open.includes(card.dataset.worker) && oldDay===selectedDay)) card.open=true;
      });
      if(focus) {
        const w=r.workers[0],s=w?.shifts.find(s=>s.id===focus.shiftId);
        $('workScopeTitle').textContent=`${w?name(w):'Worker'} · Shift work`;
        $('workScopeTime').textContent=s?`${date(s.clock_in,false)} → ${s.clock_out?date(s.clock_out,false):'Still open'}${s.store?' · '+s.store:''}`:'Selected shift';
      }
      filterWorkers();
    } catch(error) {
      if(version!==state.version) return;
      $('workStatus').textContent=`Could not load the work report: ${error.message}. Use Refresh to retry.`;
    } finally {if(version===state.version) $('workRefresh').disabled=false;}
  }
  function renderScope() {
    $('workScope').hidden=!state.focus;
    document.querySelector('#panelWorkReport .work-toolbar').hidden=!!state.focus;
    $('panelWorkReport').classList.toggle('work-shift-focus',!!state.focus);
  }
  async function init(load=true) {
    if(state.initialized) return;
    state.initialized=true;
    $('workDay').value=day();
    $('workRefresh').addEventListener('click',refresh);
    $('workDay').addEventListener('change',refresh);
    $('workWorkerSearch').addEventListener('input',filterWorkers);
    $('workBackToDay').addEventListener('click',()=>{state.focus=null;state.panels.clear();$('workWorkerSearch').value='';renderScope();refresh();});
    $('workToday').addEventListener('click',()=>{$('workDay').value=day();refresh();});
    document.querySelectorAll('[data-work-day-step]').forEach(button=>button.addEventListener('click',()=>{
      const d=new Date(`${$('workDay').value || day()}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+Number(button.dataset.workDayStep));$('workDay').value=d.toISOString().slice(0,10);refresh();
    }));
    if(load) await refresh();
  }
  async function openShift(employeeId,shiftId,clockIn) {
    await init(false);
    state.focus={employeeId,shiftId};state.panels.clear();
    $('workDay').value=day(clockIn);$('workWorkerSearch').value='';
    $('workScopeTitle').textContent='Shift work';$('workScopeTime').textContent='Loading selected shift…';
    renderScope();$('tabWorkReport').click();
    await refresh();
    if(state.focus?.shiftId===shiftId) $('workScope').scrollIntoView({block:'start',behavior:'smooth'});
  }
  window.AdminWorkReport={init,openShift};
})();
