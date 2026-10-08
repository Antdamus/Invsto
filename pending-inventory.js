/* Saved inventory attachments use the same item lookup, sources and completion
   accounting as checkout. A scan never closes a line or removes physical stock. */
(() => {
  const byId = id => document.getElementById(id);
  const saved = new Map();
  let line, attachment, item, source, sources = [], generation = 0, busy = false, returnFocus, timer, initialized = false;
  const active = id => { const a = saved.get(id); return a?.status === 'reserved' && a.remaining_quantity > 0 ? a : null; };
  const message = (text, error = false) => { byId('attach-inventory-status').textContent = text; byId('attach-inventory-status').classList.toggle('is-error', error); };
  async function rpc(name, args) { const {data, error} = await supabase.rpc(name, args); if (error) throw error; return data; }
  async function load(lines) {
    const rows = [];
    for (let n = 0; n < lines.length; n += 1000) rows.push(...await rpc('get_pending_inventory_attachments', {_order_line_ids: lines.slice(n,n+1000).map(l => l.id)}));
    if (lines !== state.orders) return;
    saved.clear(); rows.forEach(a => saved.set(a.order_line_id,a)); paint();
  }
  function summary(id) {
    const a = active(id);
    return a ? `${a.remaining_quantity} reserved · ${a.item.title} · ${a.item.barcode || 'No barcode'} · ${a.location.location_name}` : '';
  }
  function paint() {
    document.querySelectorAll('[data-line-inventory]').forEach(el => {
      const id = el.dataset.lineInventory, a = active(id), current = state.orders.find(l => l.id === id);
      const signature = `${saved.get(id)?.revision || 0}:${current?.line_status}`;
      if (el.dataset.inventorySignature === signature) return;
      el.dataset.inventorySignature = signature;
      const open = current && isOpenOrderLine(current);
      el.innerHTML = a ? `<div class="line-inventory-saved"><img alt="Attached inventory item" loading="lazy" hidden><span><small>INVENTORY RESERVED</small><strong>${escapeHtml(a.item.title)}</strong><span>${escapeHtml(a.item.barcode || 'No barcode')} · Qty ${a.remaining_quantity}</span><span>${escapeHtml(a.location.location_name)} · ${escapeHtml(a.store_name)}</span></span></div><button type="button" class="secondary-btn" data-attach-inventory="${escapeHtml(id)}" ${open?'':'disabled'}>Change inventory</button>`
        : open ? `<button type="button" class="secondary-btn" data-attach-inventory="${escapeHtml(id)}">＋ Attach inventory</button>` : '';
      if (a) void photo(a.item, el.querySelector('img'));
    });
  }
  async function photo(candidate, image) {
    const path = candidate.photo_url || candidate.photos?.[0];
    if (!path || !image) return;
    try { const url = await resolvePhotoUrl(path); if (url && image.isConnected) { image.src=url; image.hidden=false; } } catch {}
  }
  function controls() {
    byId('attach-inventory-save').disabled = busy || !item || !source;
    byId('attach-inventory-remove').hidden = attachment?.status !== 'reserved';
    ['attach-inventory-close','attach-inventory-remove','attach-inventory-find','attach-inventory-store','attach-inventory-scan','attach-inventory-quantity'].forEach(id => byId(id).disabled=busy);
  }
  function resetChoice() {
    item=null; source=null; sources=[];
    byId('attach-inventory-results').replaceChildren(); byId('attach-inventory-sources').replaceChildren();
    byId('attach-inventory-selected').replaceChildren(); byId('attach-inventory-quantity-wrap').hidden=true;
    controls();
  }
  async function open(id) {
    if (state.busy || busy) return;
    line=state.orders.find(l=>l.id===id);
    if (!line || !isOpenOrderLine(line)) return;
    invalidateInventoryLookup(); // Cancel an unfinished checkout scan, keeping saved/staged items intact.
    returnFocus=document.activeElement;
    const run=++generation;
    clearTimeout(timer); resetChoice(); attachment=null;
    window.OGTaskNotifications?.dismiss();
    byId('attach-inventory-order').textContent=`${line.order?.buyer_username || 'Customer'} · ${line.order?.order_number || 'Order'} · ${line.item_title}`;
    byId('attach-inventory-store').innerHTML=state.stores.map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    byId('attach-inventory-store').value=state.checkoutStoreId || state.stores[0]?.id || '';
    byId('attach-inventory-scan').value='';
    openModal('attach-inventory-modal'); busy=true; controls(); message('Checking saved inventory…');
    try {
      const rows=await rpc('get_pending_inventory_attachments',{_order_line_ids:[id]});
      if (run!==generation) return;
      attachment=rows[0] || null;
      if (attachment) saved.set(id,attachment); else saved.delete(id);
      paint();
      if (attachment?.status==='reserved') {
        byId('attach-inventory-store').value=attachment.checkout_store_id;
        byId('attach-inventory-scan').value=attachment.item.barcode || attachment.item.id;
        await choose(attachment.item,run);
      } else message('Scan the inventory barcode. Nothing leaves stock until this order is completed.');
    } catch (error) { message(error.message || 'Could not load the attachment. Close and try again.',true); }
    finally { if(run===generation) {busy=false;controls();byId('attach-inventory-scan').focus();} }
  }
  function close() {
    if (busy) return;
    ++generation; clearTimeout(timer); closeModal('attach-inventory-modal');
    const button=[...document.querySelectorAll('[data-attach-inventory]')].find(e=>e.dataset.attachInventory===line?.id);
    (button || returnFocus)?.focus({preventScroll:true}); line=null;
  }
  async function search() {
    if (busy || !line) return;
    clearTimeout(timer); const term=byId('attach-inventory-scan').value.trim(), run=++generation;
    resetChoice();
    if(!term) return message('Scan a barcode or enter an inventory item name.',true);
    if(!byId('attach-inventory-store').value) return message('Choose the packing store first.',true);
    message('Finding inventory…');
    try {
      const data=await rpc('lookup_pending_checkout_items',{_term:term});
      if(run!==generation) return;
      if(data.exact && data.items?.length===1) return await choose(data.items[0],run);
      message(data.items?.length ? 'Choose the inventory item that matches this order.' : 'No inventory item found. Check the barcode.',!data.items?.length);
      for(const candidate of data.items || []) {
        const button=document.createElement('button');button.type='button';button.className='inventory-match';
        button.innerHTML=`<img alt="" hidden><span><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.barcode || 'No barcode')}</small></span>`;
        button.addEventListener('click',()=>{if(!busy) void choose(candidate,++generation);});byId('attach-inventory-results').append(button);void photo(candidate,button.querySelector('img'));
      }
    } catch(error) {if(run===generation) message(error.message || 'Could not search inventory.',true);}
  }
  async function choose(candidate,run) {
    item=candidate;source=null;controls();
    byId('attach-inventory-results').replaceChildren();
    byId('attach-inventory-selected').innerHTML=`<img alt="Inventory item" hidden><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.barcode || 'No barcode')}</small></span>`;
    void photo(item,byId('attach-inventory-selected').querySelector('img'));
    message('Checking available stock…');
    try {
      const rows=await rpc('get_pending_checkout_stock',{_item_id:item.id,_order_line_id:line.id,_checkout_store_id:byId('attach-inventory-store').value});
      if(run!==generation) return;
      sources=rows.filter(r=>!item.checkout_batch_ids?.length || item.checkout_batch_ids.includes(r.batch_id));
      if(!sources.length) return message('No available stock for this item at the selected store.',true);
      const previous=attachment?.status==='reserved' && attachment.item_id===item.id ? sources.find(r=>r.id===attachment.stock_location_row_id) : null;
      if(previous || sources.length===1) selectSource(previous || sources[0]);
      else {
        byId('attach-inventory-sources').innerHTML='<p>Choose the source you took this item from.</p>';
        sources.forEach(row=>{const b=document.createElement('button');b.type='button';b.className='inventory-match';b.textContent=`${row.location?.location_name || 'Location'} · ${row.bag_barcode || row.location?.location_code || 'Loose stock'} · ${row.quantity} available`;b.addEventListener('click',()=>{if(!busy) selectSource(row);});byId('attach-inventory-sources').append(b);});
        message('This barcode has multiple stock sources. Choose the correct one.');
      }
    } catch(error){if(run===generation)message(error.message || 'Could not verify stock.',true);}
  }
  function selectSource(row) {
    source=row;
    const input=byId('attach-inventory-quantity'),max=Math.min(Number(row.quantity),getRemainingLineQuantity(line));
    input.max=String(max);input.value=String(Math.min(max,attachment?.status==='reserved' && attachment.stock_location_row_id===row.id ? attachment.remaining_quantity : 1));
    byId('attach-inventory-quantity-wrap').hidden=false;
    byId('attach-inventory-availability').textContent=`${row.location?.location_name || 'Location'} · ${row.quantity} available · ${getRemainingLineQuantity(line)} needed on this line`;
    byId('attach-inventory-sources').querySelectorAll('button').forEach((b,i)=>b.setAttribute('aria-pressed',String(sources[i]?.id===row.id)));
    message(`${attachment?.status==='reserved' ? `${attachment.remaining_quantity} reserved. ` : ''}Choose the quantity, then attach. This reserves stock; it does not close the order.`);controls();input.focus();input.select();
  }
  async function save(remove=false) {
    if(busy || !line || (!remove && (!item || !source))) return;
    const qty=remove ? 0 : Number(byId('attach-inventory-quantity').value);
    if(!remove && (!Number.isSafeInteger(qty) || qty<1 || qty>Math.min(Number(source.quantity),getRemainingLineQuantity(line)))) return message('Enter a whole quantity within the available stock and remaining order quantity.',true);
    busy=true;clearTimeout(timer);++generation;controls();message(remove?'Removing the inventory attachment…':'Saving and reserving inventory…');
    try {
      const rows=await rpc('save_pending_inventory_attachment',{_order_line_id:line.id,_item_id:remove?null:item.id,_stock_location_row_id:remove?null:source.id,
        _checkout_store_id:byId('attach-inventory-store').value,_quantity:qty,_expected_revision:attachment?.revision || 0});
      rows.forEach(a=>saved.set(a.order_line_id,a));
      // An old browser-only draft must not disagree with the saved attachment.
      state.stagedFulfillments.delete(line.id);renderBuyerBundlePanel();window.PendingOrdersMobile?.sync();paint();
      busy=false;close();
    } catch(error) {
      message(error.code==='40001' ? 'Someone changed this attachment. Close and reopen it to review their changes.' : error.message || 'Could not save. Reopen the attachment to verify before retrying.',true);
      busy=false;controls();
    }
  }
  function init() {
    if(initialized || !byId('attach-inventory-modal')) return; initialized=true;
    document.addEventListener('click',event=>{const b=event.target.closest('[data-attach-inventory]');if(b){event.preventDefault();event.stopPropagation();void open(b.dataset.attachInventory);}},true);
    byId('attach-inventory-close').addEventListener('click',close);
    byId('attach-inventory-find').addEventListener('click',search);
    byId('attach-inventory-save').addEventListener('click',()=>save());
    byId('attach-inventory-remove').addEventListener('click',()=>save(true));
    byId('attach-inventory-store').addEventListener('change',()=>{++generation;resetChoice();message('Scan an item at the selected store.');});
    byId('attach-inventory-scan').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void search();}});
    byId('attach-inventory-scan').addEventListener('input',()=>{++generation;resetChoice();clearTimeout(timer);timer=setTimeout(search,650);});
    byId('attach-inventory-modal').addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.stopPropagation();close();}
      if(e.key==='Tab') {const targets=[...byId('attach-inventory-modal').querySelectorAll('button,input,select')].filter(el=>!el.disabled && el.getBoundingClientRect().height);const first=targets[0],last=targets.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    });
    new MutationObserver(paint).observe(byId('orders-list'),{childList:true,subtree:true});paint();
  }
  window.PendingInventory={load,paint,open,active,summary,init};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
