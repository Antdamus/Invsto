/* Watch markers are staff-owned and survive eBay imports and queue refreshes. */
(() => {
  const saved = new Map(), loaded = new Set(), busy = new Set(), versions = new Map(), errors = new Map();
  let started = false;
  const brands = {cartier:'Cartier',rolex:'Rolex',ap:'AP',other:'Other'};
  let selectedFilter='',pickerId='',hasRead=false;
  const marked = id => saved.get(id)?.is_watch === true;
  const brand = id => marked(id) ? brands[saved.get(id).brand] || '' : '';
  const matches = (row,key) => isOpenOrderLine(row) && marked(row.id) && (key==='all'||saved.get(row.id).brand===key);
  const icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6V2h6v4M9 18v4h6v-4M12 9v3l2 1"/></svg>';
  function line(row) {
    const id=row.id, active=marked(id), ready=loaded.has(id), error=errors.get(id);
    return `<button type="button" class="line-watch-toggle" data-watch-toggle="${escapeHtml(id)}" aria-pressed="${active}" aria-haspopup="dialog" title="Choose or change the watch brand" ${busy.has(id)||!ready||!isOpenOrderLine(row)?'disabled':''}>${icon}<span>${busy.has(id)?'Saving…':!ready&&!error?'Checking…':active?'Watch · '+(brand(id)||'Choose brand'):'Watch'}</span><span aria-hidden="true">⌄</span></button>${error?`<span class="line-watch-error" role="status">${escapeHtml(error)} <button type="button" data-watch-retry="${escapeHtml(id)}">Retry</button></span>`:''}`;
  }
  function summary(rows) {
    const watches=rows.filter(row=>marked(row.id));
    const labels=[...new Set(watches.map(row=>brand(row.id)).filter(Boolean))].join(' / ');
    return watches.length?`<span class="buyer-card-meta-pill watch-order-marker">${icon}${watches.length===1?'Watch':`${watches.length} watch lines`}${labels?' · '+labels:''} · Extra processing</span>`:'';
  }
  function orderCounts(rows){
    const groups=Object.fromEntries(['all',...Object.keys(brands)].map(k=>[k,new Set()]));
    let unidentified=0;
    for(const row of rows){
      if(!matches(row,'all'))continue;
      const order=row.order_id||row.order?.id||row.order?.order_number;
      groups.all.add(order);
      const key=saved.get(row.id).brand;
      if(brands[key])groups[key].add(order);else unidentified++;
    }
    return {counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.size])),unidentified};
  }
  function counters(filter=selectedFilter) {
    selectedFilter=filter;
    const panel=document.getElementById?.('pending-watch-directory');if(!panel)return;
    panel.hidden=document.getElementById('order-status-filter')?.value==='fulfilled';
    const rows=state.orders.filter(isOpenOrderLine);
    const ready=(hasRead||rows.length>0)&&rows.every(r=>loaded.has(r.id)&&!errors.has(r.id));
    const {counts,unidentified}=orderCounts(rows);
    panel.querySelectorAll('[data-watch-filter]').forEach(button=>{
      const key=button.dataset.watchFilter;
      button.querySelector('strong').textContent=ready?String(counts[key]):'…';
      button.disabled=!ready;button.setAttribute('aria-pressed',String(key===filter));
    });
    panel.querySelector('[data-watch-count-note]').textContent=ready?
      (filter?'Showing '+(brands[filter]||'all')+' watch lines. Select the active filter again to clear it.':'Select a count to see its watch lines. Each order counts once per brand.')+
      (unidentified?' '+unidentified+' marked lines still need a brand.':''):
      rows.some(r=>errors.has(r.id))?'Watch counts unavailable. Refresh to retry.':'Checking saved Watch markers…';
  }
  function paint() {
    counters();
    document.querySelectorAll('[data-watch-line]').forEach(host=>{
      const row=state.orders.find(row=>row.id===host.dataset.watchLine);
      if(row){const html=window.OGOrderWatches.line(row);if(host.innerHTML!==html)host.innerHTML=html;}
    });
    document.querySelectorAll('[data-watch-buyer]').forEach(host=>{
      const html=summary(state.filteredOrders.filter(row=>getBuyerKey(row)===host.dataset.watchBuyer));
      if(host.innerHTML!==html)host.innerHTML=html;
    });
  }
  async function load(rows=state.orders) {
    const ids=[...new Set(rows.map(row=>row.id))].filter(id=>!busy.has(id));
    let changed=false;
    for(let n=0;n<ids.length;n+=300){
      const batch=ids.slice(n,n+300), reads=new Map(batch.map(id=>{
        const version=(versions.get(id)||0)+1;versions.set(id,version);return[id,version];
      }));
      try {
        const {data,error}=await supabase.from('order_line_watch_flags').select('*').in('order_line_id',batch);
        if(error)throw error;
        const records=new Map((data||[]).map(row=>[row.order_line_id,row]));
        for(const id of batch){
          if(busy.has(id)||reads.get(id)!==versions.get(id))continue;
          const next=records.get(id);
          if((next?.revision||0)<(saved.get(id)?.revision||0))continue;
          if(!loaded.has(id)||saved.get(id)?.is_watch!==next?.is_watch||saved.get(id)?.brand!==next?.brand)changed=true;
          if(next)saved.set(id,next);else saved.delete(id);
          loaded.add(id);errors.delete(id);
        }
      } catch(error){
        for(const id of batch)if(!busy.has(id)&&reads.get(id)===versions.get(id))errors.set(id,'Could not refresh Watch marker.');
        console.warn('Could not load Watch markers:',error);
      }
    }
    hasRead=true;paint();
    if(changed&&selectedFilter)applyOrderFilters();
  }
  async function set(id,key,expectedRevision) {
    const row=state.orders.find(row=>row.id===id);
    if(!row||busy.has(id)||!loaded.has(id)||!isOpenOrderLine(row)||(key!==null&&!brands[key]))return false;
    busy.add(id);versions.set(id,(versions.get(id)||0)+1);errors.delete(id);paint();
    let retry=false;
    try {
      const {data,error}=await supabase.rpc('set_order_line_watch_brand',{_order_line_id:id,_is_watch:key!==null,_expected_revision:expectedRevision,_brand:key});
      if(error)throw error;
      const result=Array.isArray(data)?data[0]:data;
      if(result?.order_line_id!==id||result.is_watch!==(key!==null)||(result.brand??null)!==key)throw Error('Could not confirm the watch brand. Retry.');
      saved.set(id,result);loaded.add(id);
      setStatus(key?brands[key]+' watch saved.':'Watch marker removed.','success');
      if(selectedFilter)applyOrderFilters();
      return true;
    } catch(error){
      errors.set(id,error.message||'Could not save Watch marker.');retry=error.code==='40001';
      setStatus(error.message||'Could not save Watch marker.','error');
    } finally {busy.delete(id);paint();}
    if(retry)await load([row]);
    return false;
  }
  function start() {
    if(started)return;started=true;
    // Capture prevents this inline toggle from opening the item's checkout.
    document.addEventListener('click',event=>{
      const button=event.target.closest('[data-watch-toggle],[data-watch-retry]');if(!button)return;
      event.preventDefault();event.stopPropagation();
      if(button.dataset.watchToggle)openPicker(button.dataset.watchToggle);
      else {const row=state.orders.find(row=>row.id===button.dataset.watchRetry);if(row)void load([row]);}
    },true);
    window.OGOrderLiveUpdates?.subscribe(supabase,change=>{
      if(change.kind==='watch_flag'){const row=state.orders.find(row=>row.id===change.line_id);if(row)void load([row]);}
      else if(change.kind==='reconnected')void load();
    });
    const resume=()=>{if(document.visibilityState!=='hidden')void load();};
    window.setInterval(resume,60000);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  }
  function openPicker(id){
    const row=state.orders.find(r=>r.id===id),dialog=document.getElementById('watch-brand-picker');
    if(!row||!dialog||!loaded.has(id)||busy.has(id)||!isOpenOrderLine(row))return;
    pickerId=id;
    let expectedRevision=saved.get(id)?.revision||0;
    dialog.querySelector('[data-watch-item]').textContent=[row.order?.order_number,row.item_title].filter(Boolean).join(' · ');
    function updatePicker(message){
      dialog.querySelector('[data-watch-message]').textContent=message;
      dialog.querySelector('[data-watch-remove]').hidden=!marked(id);
      dialog.querySelectorAll('[data-watch-choice]').forEach(b=>b.setAttribute('aria-pressed',String(marked(id)&&b.dataset.watchChoice===saved.get(id)?.brand)));
    }
    updatePicker('Choose a brand to save it to this order line.');
    dialog.onclick=async event=>{
      const b=event.target.closest('[data-watch-choice],[data-watch-remove]');
      if(!b||busy.has(id))return;
      const key=b.dataset.watchChoice||null;
      dialog.querySelectorAll('button').forEach(el=>el.disabled=true);
      updatePicker('Saving…');
      const success=await set(id,key,expectedRevision);
      if(pickerId!==id)return;
      dialog.querySelectorAll('button').forEach(el=>el.disabled=false);
      if(success){if(dialog.open)dialog.close();}
      else {
        expectedRevision=saved.get(id)?.revision||0;
        updatePicker(errors.get(id)||'Review the current watch brand and try again.');
      }
    };
    dialog.oncancel=event=>{if(busy.has(id))event.preventDefault();};
    dialog.onclose=()=>document.querySelector(`[data-watch-toggle="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
    dialog.showModal();
  }
  const watchLine=line;
  window.OGOrderWatches={line:row=>watchLine(row)+(window.OGPendingWork?.line(row,{watchOnly:true})||''),summary,load,start,marked,brands,matches,counters,orderCounts};
})();
