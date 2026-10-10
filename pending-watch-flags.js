/* Watch markers are staff-owned and survive eBay imports and queue refreshes. */
(() => {
  const saved = new Map(), loaded = new Set(), busy = new Set(), versions = new Map(), errors = new Map();
  let started = false;
  const marked = id => saved.get(id)?.is_watch === true;
  const icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6V2h6v4M9 18v4h6v-4M12 9v3l2 1"/></svg>';
  function line(row) {
    const id=row.id, active=marked(id), ready=loaded.has(id), error=errors.get(id);
    return `<button type="button" class="line-watch-toggle" data-watch-toggle="${escapeHtml(id)}" aria-pressed="${active}" title="${active?'Remove Watch marker':'Mark this item as a watch requiring extra processing'}" ${busy.has(id)||!ready||!isOpenOrderLine(row)?'disabled':''}>${icon}<span>${busy.has(id)?'Saving…':!ready&&!error?'Checking…':active?'Watch · Extra processing':'Watch'}</span>${active?'<span aria-hidden="true">✓</span>':''}</button>${error?`<span class="line-watch-error" role="status">${escapeHtml(error)} <button type="button" data-watch-retry="${escapeHtml(id)}">Retry</button></span>`:''}`;
  }
  function summary(rows) {
    const count=rows.filter(row=>marked(row.id)).length;
    return count?`<span class="buyer-card-meta-pill watch-order-marker">${icon}${count===1?'Watch':`${count} watch lines`} · Extra processing</span>`:'';
  }
  function paint() {
    document.querySelectorAll('[data-watch-line]').forEach(host=>{
      const row=state.orders.find(row=>row.id===host.dataset.watchLine);
      if(row){const html=line(row);if(host.innerHTML!==html)host.innerHTML=html;}
    });
    document.querySelectorAll('[data-watch-buyer]').forEach(host=>{
      const html=summary(state.filteredOrders.filter(row=>getBuyerKey(row)===host.dataset.watchBuyer));
      if(host.innerHTML!==html)host.innerHTML=html;
    });
  }
  async function load(rows=state.orders) {
    const ids=[...new Set(rows.map(row=>row.id))].filter(id=>!busy.has(id));
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
          if(next)saved.set(id,next);else saved.delete(id);
          loaded.add(id);errors.delete(id);
        }
      } catch(error){
        for(const id of batch)if(!busy.has(id)&&reads.get(id)===versions.get(id))errors.set(id,'Could not refresh Watch marker.');
        console.warn('Could not load Watch markers:',error);
      }
    }
    paint();
  }
  async function set(id) {
    const row=state.orders.find(row=>row.id===id);
    if(!row||busy.has(id)||!loaded.has(id)||!isOpenOrderLine(row))return;
    busy.add(id);versions.set(id,(versions.get(id)||0)+1);errors.delete(id);paint();
    let retry=false;
    try {
      const {data,error}=await supabase.rpc('set_order_line_watch',{_order_line_id:id,_is_watch:!marked(id),_expected_revision:saved.get(id)?.revision||0});
      if(error)throw error;
      const result=Array.isArray(data)?data[0]:data;
      if(result?.order_line_id!==id||typeof result.is_watch!=='boolean')throw Error('Could not confirm the Watch marker. Retry.');
      saved.set(id,result);loaded.add(id);
      setStatus(result.is_watch?'Watch marked — extra processing needed.':'Watch marker removed.','success');
    } catch(error){
      errors.set(id,error.message||'Could not save Watch marker.');retry=error.code==='40001';
      setStatus(error.message||'Could not save Watch marker.','error');
    } finally {busy.delete(id);paint();}
    if(retry)await load([row]);
  }
  function start() {
    if(started)return;started=true;
    // Capture prevents this inline toggle from opening the item's checkout.
    document.addEventListener('click',event=>{
      const button=event.target.closest('[data-watch-toggle],[data-watch-retry]');if(!button)return;
      event.preventDefault();event.stopPropagation();
      if(button.dataset.watchToggle)void set(button.dataset.watchToggle);
      else {const row=state.orders.find(row=>row.id===button.dataset.watchRetry);if(row)void load([row]);}
    },true);
    window.OGOrderLiveUpdates?.subscribe(supabase,change=>{
      if(change.kind==='watch_flag'){const row=state.orders.find(row=>row.id===change.line_id);if(row)void load([row]);}
      else if(change.kind==='reconnected')void load();
    });
    const resume=()=>{if(document.visibilityState!=='hidden')void load();};
    window.setInterval(resume,60000);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  }
  window.OGOrderWatches={line,summary,load,start};
})();
