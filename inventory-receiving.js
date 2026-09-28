/* Existing-item receiving: one destination, editable quantities, one atomic save. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validQuantity = value => /^[1-9]\d{0,5}$/.test(String(value));
  const slimItem = item => Object.fromEntries(['id','title','barcode','weight','qr_code','qr_type','dymo_label_url','photos','photo_url','labels_per_order'].map(key=>[key,item[key]]));
  async function init({user,openLabels}) {
    const root=document.getElementById('inventory-receiving');
    if(!root)throw new Error('The Add Inventory page needs a refresh.');
    document.querySelector('.add-inventory-wrapper').hidden=true;root.hidden=false;document.body.classList.add('receiving-mode');
    const key='invsto.receiving.v1.'+user.id;
    let state={locationId:'',lines:[],notes:'',pending:null,receipt:null,receiptItems:[]};
    let locations=[],stores=[],itemsFound=[],searchSequence=0,stockSequence=0,searchTimer,removed=null,busy=false,currentStock=new Map();
    const photoCache=new Map();
    let restored=false;
    try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved&&Array.isArray(saved.lines)){state={...state,...saved};restored=state.lines.length>0||Boolean(state.pending);}}catch{}
    root.innerHTML=`<div class="receiving-heading"><a href="stock.html">Back to Stock</a><a href="add-inventory.html?mode=count">Scan counting / bulk bags</a></div><h1>Add inventory</h1><p class="receiving-intro">Add more stock to items already in your catalog. Scan or search, enter quantities, then save together.</p><p id="receive-status" role="status" aria-live="polite"></p>
      <section class="receiving-card"><h2>1. Destination</h2><details id="receive-destination-details" open><summary>Choose or change destination</summary><p>Everything in this batch goes here. The destination stays selected for your next batch.</p><form id="receive-location-form" class="receiving-find"><label for="receive-location-search">Find a tray or container</label><div><input id="receive-location-search" type="search" placeholder="Location name or barcode" autocomplete="off" data-camera-scan><button type="submit" id="receive-location-find">Find</button></div><button type="button" data-scan-target="receive-location-search" data-scan-action="receive-location-find">Scan location with camera</button></form><label for="receive-location">Destination</label><select id="receive-location"><option value="">Loading locations...</option></select><button type="button" id="receive-reload-locations" class="receiving-secondary">Refresh locations</button></details><p id="receive-location-info"></p></section>
      <section class="receiving-card"><h2>2. Add existing items</h2><form id="receive-search-form" class="receiving-find"><label for="receive-search">Item name or barcode</label><div><input id="receive-search" type="search" placeholder="Scan a barcode or search by name" autocomplete="off" data-camera-scan><button id="receive-find" type="submit">Find item</button></div><button type="button" data-scan-target="receive-search" data-scan-action="receive-find">Scan item with camera</button></form><p id="receive-search-status" role="status"></p><div id="receive-results"></div></section>
      <section class="receiving-card"><div class="receiving-section-head"><h2>3. Review quantities</h2><span id="receive-summary"></span></div><p>Enter how many units you are adding, not the total already in stock. Scanning the same item again adds one to this batch.</p><div id="receive-lines"></div><button id="receive-undo" type="button" hidden>Undo removal</button><button id="receive-add-another" type="button" class="receiving-secondary">Add another item</button><details class="receiving-notes"><summary>Batch note (optional)</summary><label for="receive-notes">Note for this batch</label><input id="receive-notes" maxlength="1000" placeholder="e.g. Shipment received today"></details><div class="receiving-save"><button id="receive-save" type="button" disabled>Review and add stock</button><button id="receive-clear" type="button" class="receiving-secondary">Clear draft</button><small id="receive-draft-status">Draft stays on this device until you save.</small></div></section>
      <section id="receive-receipt" class="receiving-card receiving-receipt" hidden></section>`;
    const $=id=>root.querySelector('#'+id);
    const tell=(text,error=false)=>{$('receive-status').textContent=text;$('receive-status').classList.toggle('receiving-error',error);};
    const persist=()=>{try{localStorage.setItem(key,JSON.stringify(state));$('receive-draft-status').textContent=state.pending?'Save awaiting confirmation. Retry this same batch to avoid duplicate stock.':'Draft saved on this device.';return true;}catch{tell('This browser could not keep your draft. Free up device storage before saving stock.',true);return false;}};
    const total=()=>state.lines.reduce((sum,line)=>sum+(validQuantity(line.quantity)?Number(line.quantity):0),0);
    const chosen=()=>locations.find(location=>location.id===state.locationId);
    const isTray=location=>location.is_tray||location.location_role==='tray';
    const canChoose=location=>isTray(location)||Boolean(location.parent_location_id&&locations.some(p=>p.id===location.parent_location_id));
    const locationLabel=location=>{
      const store=stores.find(s=>s.id===(location.tray_current_store_id||location.store_id));
      const parent=locations.find(p=>p.id===location.parent_location_id);
      return [store?.name,parent?.location_name,location.location_name,location.location_code].filter(Boolean).join(' / ');
    };
    function syncControls(){
      const frozen=busy||Boolean(state.pending);
      root.querySelectorAll('input,select,[data-remove],[data-step],#receive-find,#receive-location-find,[data-scan-target],#receive-clear,[data-add-item],#receive-undo').forEach(el=>el.disabled=frozen);
      $('receive-summary').textContent=`${state.lines.length} item${state.lines.length===1?'':'s'} / ${total().toLocaleString()} units`;
      $('receive-save').disabled=busy||(!state.pending&&(!chosen()||!state.lines.length||state.lines.some(line=>!validQuantity(line.quantity))));
      $('receive-save').textContent=state.pending?'Confirm previous save':'Review and add stock';
      $('receive-undo').hidden=!removed;
    }
    function locationOptions(){
      const q=$('receive-location-search').value.trim().toLowerCase();
      $('receive-location').innerHTML='<option value="">Choose a destination...</option>'+locations.filter(canChoose).filter(l=>l.id===state.locationId||!q||locationLabel(l).toLowerCase().includes(q)).map(l=>`<option value="${esc(l.id)}">${esc(locationLabel(l))}</option>`).join('');
      $('receive-location').value=state.locationId;
      const loc=chosen();$('receive-location-info').textContent=loc?`Selected: ${locationLabel(loc)}${loc.max_capacity>0?' (capacity '+loc.max_capacity+' units)':''}`:'Choose or scan a destination. Container names include their parent storage.';
      syncControls();
    }
    async function loadLocations(){
      try{
        const [locationResult,storeResult]=await Promise.all([allLocations(),window.supabase.from('store_locations').select('id,name').eq('active',true).order('name')]);
        if(storeResult.error)throw storeResult.error;locations=locationResult;stores=storeResult.data||[];
        if(state.locationId&&!locations.some(l=>l.id===state.locationId&&canChoose(l))&&!state.pending){state.locationId='';tell('Your previous destination is no longer available. Choose another.',true);persist();}
        locationOptions();$('receive-destination-details').open=!chosen();await refreshStock();
      }catch(error){tell('Could not load locations: '+error.message,true);$('receive-location').innerHTML='<option value="">Locations unavailable - tap Refresh locations</option>';}
    }
    async function allLocations(){
      const result=[];
      for(let start=0;;start+=500){const {data,error}=await window.supabase.from('locations').select('id,location_name,location_code,store_id,active,parent_location_id,location_role,is_tray,tray_current_store_id,max_capacity').eq('active',true).order('id').range(start,start+499);if(error)throw error;result.push(...(data||[]));if((data||[]).length<500)return result;}
    }
    function photo(item){
      const path=item.photos?.[0]||item.photo_url;if(!path)return;
      if(!photoCache.has(path))photoCache.set(path,/^https:\/\//i.test(path)?Promise.resolve(path):window.supabase.storage.from('photos').createSignedUrl(path,3600).then(result=>result.data?.signedUrl).catch(()=>null));
      photoCache.get(path).then(url=>{if(!url)return;root.querySelectorAll('[data-photo]').forEach(el=>{if(el.dataset.photo===item.id){el.src=url;el.hidden=false;}});});
    }
    function renderLines(){
      $('receive-lines').innerHTML=state.lines.length?state.lines.map(({item,quantity})=>`<article class="receiving-line" data-line="${esc(item.id)}"><div class="receiving-item-head"><img data-photo="${esc(item.id)}" alt="" hidden loading="lazy"><div><h3>${esc(item.title)}</h3><small>${esc(item.barcode||'No barcode')}</small></div><button type="button" data-remove="${esc(item.id)}" aria-label="Remove ${esc(item.title)}">Remove</button></div><div class="receiving-line-bottom"><label>Quantity to add<div class="receiving-quantity"><button type="button" data-step="-1" data-item="${esc(item.id)}" aria-label="Decrease ${esc(item.title)}">−</button><input type="number" inputmode="numeric" min="1" max="999999" step="1" data-quantity="${esc(item.id)}" aria-label="Quantity to add: ${esc(item.title)}" value="${esc(quantity)}"><button type="button" data-step="1" data-item="${esc(item.id)}" aria-label="Increase ${esc(item.title)}">+</button></div></label><p data-stock="${esc(item.id)}"></p></div></article>`).join(''):'<p class="receiving-empty">No items yet. Scan a label or search your catalog above.</p>';
      state.lines.forEach(line=>photo(line.item));updateStockText();syncControls();
    }
    function updateStockText(){root.querySelectorAll('[data-stock]').forEach(el=>{const line=state.lines.find(l=>l.item.id===el.dataset.stock),stock=currentStock.get(el.dataset.stock);el.textContent=!state.locationId?'Choose a destination to see stock.':stock===undefined?'Current stock unavailable.':`Here now: ${stock.toLocaleString()}${validQuantity(line.quantity)?' / After adding: '+(stock+Number(line.quantity)).toLocaleString():''}`;});}
    async function refreshStock(){
      const seq=++stockSequence;currentStock=new Map();updateStockText();if(!state.locationId||!state.lines.length)return;
      const destination=state.locationId,ids=state.lines.map(l=>l.item.id),data=[];let error=null;
      for(let start=0;;start+=500){const result=await window.supabase.from('item_stock_locations').select('item_id,quantity').eq('location_id',destination).eq('condition_status','good').in('item_id',ids).order('id').range(start,start+499);if(result.error){error=result.error;break;}data.push(...(result.data||[]));if((result.data||[]).length<500)break;}
      if(seq!==stockSequence)return;if(!error){state.lines.forEach(l=>currentStock.set(l.item.id,0));for(const row of data||[])currentStock.set(row.item_id,(currentStock.get(row.item_id)||0)+row.quantity);}updateStockText();
    }
    function addItem(item){
      if(busy||state.pending)return;const existing=state.lines.find(line=>line.item.id===item.id);
      if(existing){if(!validQuantity(existing.quantity)||Number(existing.quantity)>=999999){tell('Enter a valid quantity before adding another unit.',true);return;}existing.quantity=String(Number(existing.quantity)+1);}
      else{if(state.lines.length>=100){tell('Save this batch before adding more than 100 different items.',true);return;}state.lines.push({item:slimItem(item),quantity:'1'});}
      searchSequence++;clearTimeout(searchTimer);$('receive-search').value='';$('receive-results').replaceChildren();$('receive-search-status').textContent=`${item.title}: ${existing?'one more unit added':'added to your draft'}.`;
      persist();renderLines();void refreshStock();
    }
    async function searchItems(addExact=false){
      clearTimeout(searchTimer);if(busy||state.pending)return;const query=$('receive-search').value.trim();const seq=++searchSequence;
      if(!query){$('receive-results').replaceChildren();return;}
      $('receive-search-status').textContent='Finding items...';
      try{
        const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
        const [exact,names]=await Promise.all([window.supabase.from('item_types').select('*').eq('barcode',query).is('deleted_at',null).limit(20),window.supabase.from('item_types').select('*').ilike('title',pattern).is('deleted_at',null).order('title').limit(20)]);
        if(seq!==searchSequence)return;if(exact.error||names.error)throw exact.error||names.error;
        itemsFound=Array.from(new Map([...(exact.data||[]),...(names.data||[])].map(item=>[item.id,item])).values());
        if(addExact&&exact.data?.length===1){addItem(exact.data[0]);return;}
        $('receive-search-status').textContent=itemsFound.length?'Tap the matching item to add it.':'No existing item found. Check the name or barcode. To create a new product, use Add Item.';
        $('receive-results').innerHTML=itemsFound.map(item=>`<button type="button" class="receiving-result" data-add-item="${esc(item.id)}"><img data-photo="${esc(item.id)}" hidden alt=""><span><strong>${esc(item.title)}</strong><small>${esc(item.barcode||'No barcode')}</small></span><span>Add</span></button>`).join('');itemsFound.forEach(photo);syncControls();
      }catch(error){if(seq===searchSequence)$('receive-search-status').textContent='Could not search: '+error.message;}
    }
    function renderReceipt(){
      const receipt=state.receipt,box=$('receive-receipt');box.hidden=!receipt;if(!receipt)return;
      const stockUrl=receipt.lines.length===1?'stock.html?'+new URLSearchParams({barcode:receipt.lines[0].barcode||state.receiptItems.find(item=>item.id===receipt.lines[0].item_id)?.barcode||'',highlightItem:receipt.lines[0].item_id,inventoryAdded:'1'}):'stock.html';
      box.innerHTML=`<h2>Stock added</h2><p>${receipt.quantity_added.toLocaleString()} units saved to <strong>${esc(receipt.location_name)}</strong>. You can start the next batch above.</p><div>${receipt.lines.map(line=>`<article class="receiving-saved-line"><div><strong>${esc(line.title)}</strong><span>+${line.quantity_added} / ${line.quantity_after} after this addition</span></div><button type="button" data-print="${esc(line.item_id)}">Print labels</button></article>`).join('')}</div><a href="${esc(stockUrl)}">View Stock</a>`;
    }
    function completeSave(receipt){
      state.receiptItems=state.lines.map(line=>line.item);state.receipt=receipt;state.pending=null;state.lines=[];state.notes='';removed=null;$('receive-notes').value='';persist();renderLines();renderReceipt();tell(`${receipt.quantity_added} units added to ${receipt.location_name}.`);$('receive-receipt').scrollIntoView({block:'nearest'});
    }
    async function review(){
      if(busy)return;
      if(state.pending){busy=true;syncControls();try{const {data,error}=await window.supabase.rpc('get_inventory_receiving_receipt',{_request_id:state.pending.requestId});if(error)throw error;if(data){completeSave(data);return;}}catch(error){tell('Could not confirm the previous save. Your batch is kept; retry when connected.',true);return;}finally{busy=false;syncControls();}}
      if(!state.pending&&(!chosen()||!state.lines.length||state.lines.some(l=>!validQuantity(l.quantity)))){tell('Choose a destination and enter whole quantities for each item.',true);return;}
      const draft=state.pending||{requestId:crypto.randomUUID(),locationId:state.locationId,lines:state.lines.map(l=>({item_id:l.item.id,quantity:Number(l.quantity)})),notes:state.notes};
      const dialog=document.createElement('dialog');dialog.className='receiving-confirm';
      dialog.innerHTML=`<form><h2>Confirm inventory addition</h2><p><strong>${esc(chosen()?locationLabel(chosen()):'Previously selected destination')}</strong></p><ul>${state.lines.map(l=>`<li>${esc(l.item.title)} <strong>+${esc(l.quantity)}</strong></li>`).join('')}</ul><p>${total().toLocaleString()} units will be added. Existing item details and prices stay the same.</p><label for="receive-password">Confirm with your password</label><input id="receive-password" type="password" autocomplete="current-password" required><p role="status" data-confirm-status></p><div class="receiving-confirm-actions"><button type="button" data-cancel>Back</button><button type="submit">Add stock</button></div></form>`;
      document.body.append(dialog);dialog.showModal();
      const cleanup=()=>{if(!busy)dialog.close();};dialog.querySelector('[data-cancel]').onclick=cleanup;dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.addEventListener('close',()=>dialog.remove());
      dialog.querySelector('form').onsubmit=async event=>{
        event.preventDefault();if(busy)return;const password=dialog.querySelector('input').value;if(!password)return;
        busy=true;syncControls();dialog.querySelectorAll('button,input').forEach(el=>el.disabled=true);const status=dialog.querySelector('[data-confirm-status]');status.textContent='Confirming your identity...';
        let submitted=false;
        try{
          const auth=await window.supabase.auth.signInWithPassword({email:user.email,password});dialog.querySelector('input').value='';
          if(auth.error||auth.data?.user?.id!==user.id)throw new Error(auth.error?.message||'Please sign in with your own account.');
          const previousPending=state.pending;state.pending=draft;if(!persist()){state.pending=previousPending;throw new Error('Could not preserve the save request on this device. Stock was not submitted.');}
          status.textContent='Saving inventory...';submitted=true;
          const {data,error}=await window.supabase.rpc('receive_inventory_batch',{_request_id:draft.requestId,_location_id:draft.locationId,_lines:draft.lines,_notes:draft.notes});
          if(error)throw error;if(!data?.request_id||!Array.isArray(data.lines))throw new Error('Save response was incomplete.');
          completeSave(data);dialog.close();
        }catch(error){
          if(submitted&&/^(22023|42501|23503|23514|22003)$/.test(error.code||'')){state.pending=null;persist();}
          status.textContent=state.pending?'The save is not confirmed. Your batch is kept. Close this window and choose Confirm previous save before making changes.':error.message||'Could not add inventory.';
          if(!submitted)status.textContent=error.message||'Could not confirm your identity.';
          tell(status.textContent,true);
        }finally{busy=false;syncControls();dialog.querySelectorAll('button,input').forEach(el=>el.disabled=false);}
      };
    }
    root.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.addItem)addItem(itemsFound.find(item=>item.id===button.dataset.addItem));
      if(button.dataset.remove&&!state.pending){const index=state.lines.findIndex(l=>l.item.id===button.dataset.remove);removed={line:state.lines[index],index};state.lines.splice(index,1);persist();renderLines();}
      if(button.dataset.step&&!state.pending){const line=state.lines.find(l=>l.item.id===button.dataset.item);line.quantity=String(Math.min(999999,Math.max(1,(Number(line.quantity)||1)+Number(button.dataset.step))));persist();renderLines();}
      if(button.dataset.print){const line=state.receipt.lines.find(l=>l.item_id===button.dataset.print),item=state.receiptItems.find(i=>i.id===line.item_id);if(item)openLabels({item,quantityAdded:line.quantity_added,locationName:state.receipt.location_name,stockTransactionId:line.transaction_id,stockTransactionNotes:'Added via Add Inventory batch'});}
    });
    $('receive-lines').addEventListener('input',event=>{const id=event.target.dataset.quantity;if(!id)return;const line=state.lines.find(l=>l.item.id===id);line.quantity=event.target.value;persist();updateStockText();syncControls();});
    $('receive-undo').onclick=()=>{
      if(!removed||state.pending)return;const existing=state.lines.find(line=>line.item.id===removed.line.item.id);
      if(existing){const amount=Number(existing.quantity)+Number(removed.line.quantity);if(!validQuantity(amount)){tell('The restored quantity would be invalid. Correct the item quantity first.',true);return;}existing.quantity=String(amount);}
      else{if(state.lines.length>=100){tell('Remove an item before restoring this line.',true);return;}state.lines.splice(removed.index,0,removed.line);}
      removed=null;persist();renderLines();void refreshStock();
    };
    $('receive-clear').onclick=()=>{if(state.pending||!confirm('Clear this unsaved batch? No saved inventory will change.'))return;state.lines=[];state.notes='';removed=null;$('receive-notes').value='';persist();renderLines();};
    $('receive-save').onclick=()=>void review();
    $('receive-add-another').onclick=()=>{$('receive-search-form').scrollIntoView({block:'center'});$('receive-search').focus({preventScroll:true});};
    $('receive-search-form').onsubmit=event=>{event.preventDefault();void searchItems(true);};
    $('receive-search').oninput=()=>{clearTimeout(searchTimer);searchSequence++;searchTimer=setTimeout(()=>void searchItems(false),300);};
    $('receive-location-search').oninput=locationOptions;
    $('receive-location-form').onsubmit=event=>{event.preventDefault();const q=$('receive-location-search').value.trim().toLowerCase();const matches=locations.filter(canChoose).filter(l=>l.location_code.toLowerCase()===q);if(matches.length===1){state.locationId=matches[0].id;persist();locationOptions();$('receive-destination-details').open=false;void refreshStock();}else{locationOptions();tell('Choose the matching destination from the list.',true);}};
    $('receive-location').onchange=()=>{state.locationId=$('receive-location').value;persist();locationOptions();$('receive-destination-details').open=!chosen();void refreshStock();};
    $('receive-notes').value=state.notes;$('receive-notes').oninput=()=>{state.notes=$('receive-notes').value;persist();};
    $('receive-reload-locations').onclick=()=>void loadLocations();
    renderLines();renderReceipt();await loadLocations();
    if(restored)tell(state.pending?'A previous save needs confirmation. Your batch is locked until its result is checked.':'Your unsaved batch has been restored. Review its quantities before saving.');
    const params=new URLSearchParams(location.search);
    if(params.get('mode')==='quick-add'&&params.get('barcode')&&!state.pending){if(!state.lines.some(line=>line.item.barcode===params.get('barcode'))){$('receive-search').value=params.get('barcode');await searchItems(true);}history.replaceState(null,'','add-inventory.html');}
    window.supabase.auth.onAuthStateChange?.((event,session)=>{if(event==='SIGNED_OUT'||(session?.user?.id&&session.user.id!==user.id))location.href='index.html';});
    window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
  }
  window.inventoryReceiving={init};
})();
