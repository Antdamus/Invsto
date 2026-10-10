(() => {
  'use strict';
  const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=value=>value?new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):'Not recorded';
  const money=value=>value==null?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
  let config,items=[],selected=null,total=0,offset=0,status='waiting',busy=false,loading=false,request=0,photoVersion=0,searchTimer;
  const drafts=new Map(),photoCache=new Map();
  const message=(text,error=false)=>{$('pricing-message').textContent=text;$('pricing-message').classList.toggle('is-error',error);};
  async function rpc(name,args={}){const {data,error}=await window.supabase.rpc(name,args);if(error)throw error;return data;}
  const args=()=>({_scope:$('pricing-scope').value,_status:status,_search:$('pricing-search').value.trim(),_offset:offset});
  const ownerOptions=owner=>(config.owners||[]).map(o=>`<option value="${esc(o.user_id)}" ${o.user_id===owner?'selected':''}>${esc(o.name)}</option>`).join('');
  function setBusy(value){busy=value;document.querySelectorAll('#pricing-detail button,#pricing-detail input,#pricing-detail select,#pricing-detail summary,#pricing-list button,#pricing-picker,#pricing-scope,#pricing-search,.pricing-tabs button,#pricing-refresh,#pricing-previous,#pricing-next').forEach(e=>{if('disabled'in e)e.disabled=value;});}
  async function load(preferred=selected,{quiet=false}={}) {
    if(busy)return;
    const version=++request;loading=true;
    if(!quiet)message('Loading pricing queue…');
    try {
      const data=await rpc('list_inventory_pricing',args());
      if(version!==request)return;
      items=data.items||[];total=data.total||0;
      for(const key of ['waiting','skipped','priced'])$(`pricing-count-${key}`).textContent=data.counts[key]||0;
      if(!items.length && offset>0){offset=Math.max(0,offset-20);loading=false;return load(null,{quiet});}
      selected=items.some(i=>i.id===preferred)?preferred:items[0]?.id || null;
      renderList();renderDetail();$('pricing-message').classList.remove('is-error');if(!quiet)message('');
    } catch(error){message(`Could not load pricing: ${error.message}. Your entered prices are kept; use Refresh to retry.`,true);}
    finally{if(version===request)loading=false;}
  }
  function renderList(){
    $('pricing-total').textContent=`${total} ${total===1?'item':'items'}`;
    $('pricing-list').innerHTML=items.map(i=>`<button type="button" class="pricing-list-item" data-item="${esc(i.id)}" aria-current="${i.id===selected}"><strong>${esc(i.title)}</strong><small>${esc(i.barcode || 'No barcode')} · ${esc(i.owner_name || 'Unassigned')}</small></button>`).join('');
    $('pricing-picker').innerHTML=items.map(i=>`<option value="${esc(i.id)}">${esc(i.title)} · ${esc(i.barcode||'')}</option>`).join('');
    $('pricing-picker').value=selected || '';
    $('pricing-page').textContent=total?`${offset+1}–${Math.min(offset+items.length,total)} of ${total}`:'0 items';
    $('pricing-previous').disabled=offset===0;$('pricing-next').disabled=offset+items.length>=total;
  }
  function choose(id){if(busy || !items.some(i=>i.id===id))return;selected=id;renderList();renderDetail();}
  function fact(label,value){return value==null||value===''?'':`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;}
  function renderDetail(){
    const i=items.find(i=>i.id===selected),version=++photoVersion;
    if(!i){
      $('pricing-detail').innerHTML=`<div class="pricing-empty"><span class="pricing-pill">${status==='priced'?'PRICING RECORDS':'PRICING QUEUE'}</span><h2>${status==='skipped'?'Nothing set aside.':status==='priced'?'No priced items here yet.':'All clear in this queue.'}</h2><p>${status==='skipped'?'Skip for now keeps an item here until you are ready to price it.':status==='priced'?'Items priced through this queue are recorded here.':'New items appear here when employees save them for pricing.'}</p><p>Use Everyone to see other owners, or check Skipped for items saved for later.</p><a href="add-item.html">Add an item ↗</a></div>`;return;
    }
    const ready=i.pricing_status==='ready',d=drafts.get(i.id)||{cost:'',retail:'',minimum:''};
    const facts=[fact('Barcode',i.barcode),fact('Category',(i.categories||[]).join(', ')),fact('Brand',i.watch_details?.brand),fact('Reference',i.watch_details?.model),fact('Condition',i.watch_details?.condition?.replaceAll('_',' ').toLowerCase()),fact('Year',i.coin_details?.year),fact('Grade',i.coin_details?.grade),fact('Weight',i.weight==null?'Not recorded':`${i.weight} g`),fact('Material',i.metal),fact('Stone',i.stone_type),fact('Length',i.item_length),fact('Supplier',i.distributor_name),fact('Stock location',(i.locations||[]).map(l=>`${l.name} · ${l.quantity}`).join('; '))].join('');
    const special=Object.entries(i.watch_details||i.coin_details||{}).filter(([key,value])=>value && typeof value!=='object').map(([key,value])=>fact(key.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()),value)).join('');
    $('pricing-detail').innerHTML=`<header class="pricing-item-header"><span class="pricing-pill">${ready?'PRICED':i.pricing_skipped_at?'SAVED FOR LATER':'AWAITING PRICING'}</span><h2 tabindex="-1" id="pricing-item-title">${esc(i.title)}</h2><p>Added ${esc(date(i.created_at))} · ${esc(i.added_by_name || i.added_by_email || 'Inventory team')}<br>Pricing owner: ${esc(i.owner_name || 'Unassigned')}</p></header>
      <div class="pricing-item-body"><div class="pricing-gallery" id="pricing-gallery"><div class="pricing-no-photo">Loading photos…</div></div>
      <div class="pricing-info"><dl>${facts}</dl><details><summary>Full item details</summary><p>${esc(i.description || 'No description added.')}</p><dl>${special}</dl>${i.distributor_notes?`<p>Supplier notes: ${esc(i.distributor_notes)}</p>`:''}${i.distributor_phone?`<p>Supplier phone: ${esc(i.distributor_phone)}</p>`:''}</details><a href="stock.html?barcode=${encodeURIComponent(i.barcode||'')}" target="_blank" rel="noopener">View in Stock ↗</a></div></div>
      ${ready?`<div class="pricing-entry"><h3>Pricing saved ${esc(date(i.pricing_completed_at))}</h3><div class="pricing-info"><dl>${fact('Cost',money(i.cost))}${fact('Retail',money(i.sale_price))}${fact('Minimum sale',money(i.minimum_sale_price))}</dl></div></div>`:i.can_price?`<form id="pricing-form" class="pricing-entry"><h3>Set prices <small>· USD</small></h3><div class="pricing-amounts"><label>Cost ($)<input name="cost" inputmode="decimal" autocomplete="off" required placeholder="0.00" value="${esc(d.cost)}"></label><label>Retail price ($)<input name="retail" inputmode="decimal" autocomplete="off" required placeholder="0.00" value="${esc(d.retail)}"></label><label>Minimum selling price ($)<input name="minimum" inputmode="decimal" autocomplete="off" placeholder="Optional" value="${esc(d.minimum)}"><small>Your selling floor. Online listings use retail.</small></label></div><p class="pricing-form-error" id="pricing-form-error" role="alert"></p><div class="pricing-actions"><button type="button" id="pricing-skip">Skip for now</button><button type="submit" class="pricing-primary">Save &amp; next →</button></div></form>`:`<div class="pricing-entry">Waiting for ${esc(i.owner_name || 'the pricing owner')} to set the cost and selling prices.</div>`}
      ${!ready&&config.is_admin?`<details class="pricing-reassign"><summary>Change this item’s pricing owner</summary><form id="pricing-reassign-form"><label>Pricing owner<select name="owner">${ownerOptions(i.pricing_owner)}</select></label><button type="submit">Reassign</button></form></details>`:''}`;
    const form=$('pricing-form');
    form?.addEventListener('input',()=>drafts.set(i.id,Object.fromEntries(new FormData(form))));
    form?.addEventListener('submit',event=>{event.preventDefault();let prices;try{prices=window.InventoryPricing.prices(form.elements.cost.value,form.elements.retail.value,form.elements.minimum.value);}catch(error){$('pricing-form-error').textContent=error.message;return;}void act(i,'price',{_cost:prices.cost,_retail:prices.retail,_minimum:prices.minimum});});
    $('pricing-skip')?.addEventListener('click',()=>act(i,'skip'));
    $('pricing-reassign-form')?.addEventListener('submit',event=>{event.preventDefault();void act(i,'reassign',{_owner:event.target.elements.owner.value});});
    void photos(i,version);
  }
  async function photoUrl(path){
    if(/^https:\/\//i.test(path))return path;
    if(!path || typeof path!=='string')return '';
    const cached=photoCache.get(path);if(cached&&cached.expires>Date.now())return cached.url;
    const {data,error}=await window.supabase.storage.from('photos').createSignedUrl(path,1800);
    if(error)throw error;photoCache.set(path,{url:data.signedUrl,expires:Date.now()+1500000});return data.signedUrl;
  }
  async function photos(i,version){
    const paths=[...new Set([...(i.photos||[]),i.photo_url].filter(Boolean))];
    const settled=await Promise.allSettled(paths.map(photoUrl));
    if(version!==photoVersion)return;
    const urls=settled.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value),gallery=$('pricing-gallery');
    if(!urls.length){gallery.innerHTML=`<div class="pricing-no-photo">${paths.length?'Photos could not load. Use Refresh to retry.':'No photos added yet.'}</div>`;return;}
    gallery.innerHTML=`<button type="button" class="pricing-cover" aria-label="Enlarge item photo"><img alt="${esc(i.title)}" src="${esc(urls[0])}"></button><div class="pricing-thumbnails">${urls.map((url,n)=>`<button type="button" class="pricing-thumb" aria-label="View photo ${n+1}" data-photo="${n}" aria-pressed="${n===0}"><img alt="Photo ${n+1}" loading="lazy" src="${esc(url)}"></button>`).join('')}</div><small>${urls.length} ${urls.length===1?'photo':'photos'} · Tap to enlarge${urls.length<paths.length?' · Some photos unavailable':''}</small>`;
    let current=0;
    gallery.querySelectorAll('[data-photo]').forEach(button=>button.addEventListener('click',()=>{current=Number(button.dataset.photo);gallery.querySelector('.pricing-cover img').src=urls[current];gallery.querySelectorAll('[data-photo]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));}));
    gallery.querySelector('.pricing-cover').addEventListener('click',()=>{$('pricing-full-photo').src=urls[current];$('pricing-photo-dialog').showModal();});
  }
  async function act(i,action,extra={}) {
    if(busy)return;
    const index=items.findIndex(row=>row.id===i.id),next=items[index+1]?.id || items[index-1]?.id;
    setBusy(true);
    try {
      await rpc('act_inventory_pricing',{_item_id:i.id,_revision:i.pricing_revision,_action:action,...extra});
      if(action==='price')drafts.delete(i.id);
      setBusy(false);await load(next,{quiet:true});
      const heading=$('pricing-item-title');heading?.focus({preventScroll:true});(heading || $('pricing-detail')).scrollIntoView({block:'start',behavior:'instant'});
      if(!$('pricing-message').classList.contains('is-error'))message(action==='price'?`Prices saved for ${i.title}.`:action==='skip'?`${i.title} is in Skipped. Its prices are still blank.`:'Pricing owner updated.');
    }catch(error){const errorEl=$('pricing-form-error');if(errorEl)errorEl.textContent=error.message;else message(error.message,true);}
    finally{setBusy(false);renderList();}
  }
  async function boot(){
    try {
      config=await rpc('inventory_pricing_config');
      $('pricing-settings').hidden=!config.is_admin;
      $('pricing-default-owner').innerHTML=`<option value="">Choose owner</option>${ownerOptions(config.default_owner)}`;
      await load();
    }catch(error){message(`Pricing is unavailable: ${error.message}. Check that you are signed in to Invsto, then refresh.`,true);}
  }
  $('pricing-list').addEventListener('click',e=>{const button=e.target.closest('[data-item]');if(button)choose(button.dataset.item);});
  $('pricing-picker').addEventListener('change',e=>choose(e.target.value));
  $('pricing-refresh').addEventListener('click',()=>config?load():boot());
  $('pricing-scope').addEventListener('change',()=>{offset=0;void load(null);});
  $('pricing-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;void load(null);},350);});
  document.querySelectorAll('[data-pricing-status]').forEach(button=>button.addEventListener('click',()=>{status=button.dataset.pricingStatus;offset=0;document.querySelectorAll('[data-pricing-status]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));void load(null);}));
  $('pricing-previous').addEventListener('click',()=>{offset=Math.max(0,offset-20);void load(null);});
  $('pricing-next').addEventListener('click',()=>{offset+=20;void load(null);});
  $('pricing-photo-close').addEventListener('click',()=>$('pricing-photo-dialog').close());
  $('pricing-settings-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await rpc('set_inventory_pricing_owner',{_owner:$('pricing-default-owner').value});config.default_owner=$('pricing-default-owner').value;message('Default owner saved for new items.');}catch(error){message(error.message,true);}finally{button.disabled=false;}});
  window.addEventListener('beforeunload',e=>{if([...drafts.values()].some(d=>Object.values(d).some(Boolean))){e.preventDefault();e.returnValue='';}});
  // Refresh counts without replacing an item or prices being typed.
  setInterval(async()=>{if(!config||busy||loading||document.hidden)return;try{const data=await rpc('list_inventory_pricing',args());for(const key of ['waiting','skipped','priced'])$(`pricing-count-${key}`).textContent=data.counts[key]||0;if(JSON.stringify(data.items.map(i=>[i.id,i.pricing_revision]))!==JSON.stringify(items.map(i=>[i.id,i.pricing_revision])))message('The queue has updates. Tap Refresh when ready; entered prices are kept.');}catch{ /* Manual refresh reports connection errors. */ }},60000);
  if(window.supabase?.rpc)void boot();
  else document.addEventListener('supabase-ready',boot,{once:true});
})();
