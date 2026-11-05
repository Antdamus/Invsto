(() => {
  const $=id=>document.getElementById(id);
  const form=$('add-item-form');if(!form)return;
  let lookupVersion=0, lookupTimer, lastSaved=null, lastSimilar=null, printing=false;
  const printQueue=new Map();
  const text=id=>$(id)?.value?.trim() || '';
  const snapshotFields=ids=>Object.fromEntries(ids.map(([key,id])=>[key,text(id)]));
  function captureSimilar() {
    const wizard=window.addItemWizard.getDraft();
    if (wizard.pricing && !$('item-keep-prices').checked) wizard.pricing.autoMinimum = true;
    const watch=Object.fromEntries(['name','brand','model','department'].map(key=>[key,wizard.watchDetails[key] || '']));
    const coin=Object.fromEntries(['name','country','denomination','metal','fineness','fineMetalContent','composition','finish'].map(key=>[key,wizard.coinDetails[key] || '']));
    // Grade, year, mint, modifications, conditions, unique IDs and photos belong to the individual item.
    coin.gradingStatus='ungraded';
    if(wizard.coinDetails.ebay?.categoryId)coin.ebay={categoryId:wizard.coinDetails.ebay.categoryId,categoryLabel:wizard.coinDetails.ebay.categoryLabel || '',photosConfirmed:false};
    const main=snapshotFields([['category','category'],['pricePerWeight','price-per-weight'],['distributorName','distributor-name'],['distributorPhone','distributor-phone'],['distributorNotes','distributor-notes']]);
    if($('item-keep-prices').checked)Object.assign(main,snapshotFields([['cost','cost'],['salePrice','sale-price'],['minimumSalePrice','minimum-sale-price']]));
    main.sharedMaterialRate=Boolean($('use-shared-material-cost')?.checked);
    main.ebaySyncEnabled=$('ebay-sync-enabled').checked;
    if(wizard.itemKind!=='coin')main.ebayCategoryId=text('ebay-category-id');
    const material=window.addItemAssistedModule.getSelectedMaterialPurity();
    return {activeWorkflow:'assisted',wizard:{...wizard,step:'information',furthest:0,watchDetails:watch,coinDetails:coin,autoWatchTitle:'',autoCoinTitle:'',manualRetail:$('item-keep-prices').checked},mainFields:main,assistedFields:{...material,copyEdited:{title:false,description:false},lastAutoCopy:{title:'',description:''}},recentUploadedImages:[],saveSelectedUploadedImagePaths:[]};
  }
  async function checkBarcode() {
    clearTimeout(lookupTimer);
    const code=text('scanned-barcode'),version=++lookupVersion,panel=$('item-barcode-result');
    window.addItemBarcodeMatch=null;panel.replaceChildren();
    if(!code)return null;
    panel.textContent='Checking barcode…';
    try {
      const {data,error}=await window.supabase.from('item_types').select('id,title,barcode,deleted_at').eq('barcode',code).limit(1).maybeSingle();
      if(version!==lookupVersion || code!==text('scanned-barcode'))return null;
      if(error)throw error;
      panel.replaceChildren();
      if(!data?.id){panel.textContent='New barcode — ready for this item.';return null;}
      window.addItemBarcodeMatch=data;
      const message=document.createElement('p');message.textContent=`Already in inventory: ${data.title || data.barcode}${data.deleted_at?' (archived)':''}.`;panel.append(message);
      const link=document.createElement('a');link.className='add-button';link.textContent=data.deleted_at?'View archived item':'Add quantity to this item';
      link.href=data.deleted_at?`stock.html?barcode=${encodeURIComponent(code)}`:`add-inventory.html?mode=quick-add&barcode=${encodeURIComponent(code)}&returnItem=${encodeURIComponent(data.id)}`;
      link.addEventListener('click',async event=>{event.preventDefault();await window.addItemAssistedModule?.persistDraft();window.location.href=link.href;});
      const fresh=document.createElement('button');fresh.type='button';fresh.className='add-button-secondary';fresh.textContent='Create a different item';fresh.addEventListener('click',()=>window.startNewItemBarcode());panel.append(link,fresh);
      $('item-barcode-options').open=true;
      return data;
    }catch(error){if(version===lookupVersion)panel.textContent='Could not check this barcode yet. It will be checked again when you save.';return null;}
  }
  $('scanned-barcode').addEventListener('input',()=>{lookupVersion++;window.addItemBarcodeMatch=null;clearTimeout(lookupTimer);lookupTimer=setTimeout(checkBarcode,450);});
  $('scanned-barcode').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();void checkBarcode();}});
  function resetBarcodeMatch(){lookupVersion++;clearTimeout(lookupTimer);window.addItemBarcodeMatch=null;$('item-barcode-result').replaceChildren();}
  document.addEventListener('add-item:new-barcode',resetBarcodeMatch);
  async function startNext(similar) {
    $('item-save-success-modal').classList.add('hidden');$('item-save-success-modal').setAttribute('aria-hidden','true');document.body.classList.remove('modal-open');
    await window.resetForNextIntake(similar?lastSimilar:null);
    resetBarcodeMatch();window.addItemWizard.goTo('information');
  }
  function updateQueue() {
    $('item-print-session').textContent=`Print batch (${printQueue.size})`;$('item-print-session').disabled=printing || !printQueue.size;
    $('item-print-last').disabled=printing || !lastSaved;
    ['item-label-print-batch','item-label-print-one','item-label-print-later','item-save-success-continue','item-save-success-similar'].forEach(id=>$(id).disabled=printing);
    $('item-label-quantity').disabled=printing;
    $('item-label-two-up').disabled=printing;
    $('item-label-print-batch').disabled=printing || !labelPrintPlan();
  }
  function labelPrintPlan(requested=Number($('item-label-quantity').value)) {
    const perCopy=$('item-label-two-up').checked?2:1;
    if(!Number.isInteger(requested) || requested<1 || requested>100*perCopy)return null;
    const copies=Math.ceil(requested/perCopy);
    return {requested,perCopy,copies,produced:copies*perCopy};
  }
  function updateLabelEstimate() {
    const plan=labelPrintPlan(),max=$('item-label-two-up').checked?200:100;
    $('item-label-quantity').max=String(max);
    $('item-label-print-count').textContent=plan?`${plan.copies} printed strip${plan.copies===1?'':'s'}`:'Enter a label quantity';
    $('item-label-print-formula').textContent=plan
      ?`${plan.requested} individual label${plan.requested===1?'':'s'} needed → ${plan.copies} printed strip${plan.copies===1?'':'s'} → ${plan.produced} labels${plan.produced>plan.requested?' (1 spare)':''}. ${plan.perCopy===2?'Rounded up automatically.':'One label per strip.'}`
      :`Enter a whole number from 1 to ${max} labels. For more, print another batch.`;
    $('item-label-print-batch').textContent=plan?`Print ${plan.copies} strip${plan.copies===1?'':'s'}`:'Choose printer';
    updateQueue();
    return plan;
  }
  async function recordPrintChoice(item,strategy,copies,units=1,printNote='') {
    try {
      const {error}=await window.supabase.rpc('set_item_label_print_preference',{
        _item_id:item.id,_strategy:strategy,_labels_per_order:units,
        _label_print_quantity:copies,_notes:strategy==='deferred'?'Print later from the intake batch or Stock.':printNote || 'Labels queued to the selected print destination.'
      });
      if(error)throw error;
      return true;
    }catch(error){console.warn('Label preference could not be recorded',error);return false;}
  }
  async function printItems(entries,copies=1,strategy='individual_batch',labelQuantity=null) {
    if(printing)return;
    printing=true;updateQueue();
    const status=$('item-print-session-status');const modalStatus=$('item-label-print-status');
    let done=0,preferenceFailed=false;
    try {
      const printDestination=window.printStations?await window.printStations.chooseDestination({copies,labelCount:entries.length,labelQuantity}):null;
      copies=printDestination?.copies || copies;
      for(const entry of entries){
        status.textContent=modalStatus.textContent=`Preparing label ${done+1} of ${entries.length}…`;
        if(!entry.xml)entry.xml=(await window.dymoModule.prepareSavedItemLabel(entry.item)).templateXml;
        await window.dymoModule.printDymoLabelXml(entry.xml,{copies,barcode:entry.item.barcode,title:entry.item.title,labelKind:'ItemLabel',listenerOnly:true,printDestination});
        printQueue.delete(entry.item.id);done++;
        const note=labelQuantity?`${labelQuantity.requested} individual labels requested; ${copies} printed strips queued, ${labelQuantity.perCopy} labels per strip (${copies*labelQuantity.perCopy} labels).` : '';
        if(!await recordPrintChoice(entry.item,strategy,copies,1,note))preferenceFailed=true;
      }
      status.textContent=modalStatus.textContent=`Queued ${done*copies} printed strip${done*copies===1?'':'s'}${labelQuantity?` (${done*copies*labelQuantity.perCopy} individual labels)`:''}${printDestination?.stationId?' for '+printDestination.name:''}. View Print stations for job status.${preferenceFailed?' The label preference could not be recorded.':''}`;
    }catch(error){status.textContent=modalStatus.textContent=`${done} item labels queued. ${error.message || 'Printing unavailable'}. Remaining items are still saved; retry printing later.`;}
    finally{printing=false;updateQueue();}
  }
  async function saved(item,options) {
    await recordPrintChoice(item,'deferred',null);
    lastSaved={item,xml:''};lastSimilar=options.similar;printQueue.set(item.id,lastSaved);
    $('item-draft-status').textContent='Item saved';
    $('item-saved-bar').hidden=false;$('item-last-saved').textContent=`Saved: ${item.title || item.barcode}`;updateQueue();
    $('item-save-success-name').textContent=item.title;
    $('item-save-success-barcode').textContent=`Barcode ${item.barcode}`;
    $('item-save-success-stock').textContent=options.stockSaved && options.stockInfo?`${options.stockInfo.quantity} units added to ${options.stockInfo.location_name}`:'No stock quantity assigned';
    $('item-save-success-copy').textContent=options.warnings.length?`Item saved. ${options.warnings.join(' ')}`:'Item and photos saved. You can print labels now or later from Stock.';
    if(item.pricing_status==='pending')$('item-save-success-copy').textContent+=` Cost and selling prices are queued for ${window.addItemPricing?.ownerName() || 'the pricing owner'}.`;
    document.getElementById('item-retry-bag-save')?.remove();
    if(options.retryBulkBag){
      const retry=document.createElement('button');retry.id='item-retry-bag-save';retry.type='button';retry.className='add-button-secondary';retry.textContent='Retry bag save';
      $('item-save-success-stock').after(retry);
      retry.onclick=async()=>{
        retry.disabled=true;retry.textContent='Checking bag save…';printing=true;updateQueue();
        try {
          const result=await options.retryBulkBag();
          if(result?.error || !result?.data)throw new Error(result?.error?.message || 'Bag save was not confirmed.');
          options.retryBulkBag=null;options.stockSaved=Boolean(result.receipt?.stock_location_id);
          if(options.stockInfo && options.stockSaved)options.stockInfo.quantity=result.receipt.quantity_added;
          options.warnings=options.warnings.filter(w=>!w.startsWith('The bag save was not confirmed.'));
          await saved(item,options);
        }catch(error){$('item-save-success-copy').textContent='Bag save not confirmed: '+error.message;retry.disabled=false;retry.textContent='Retry bag save';}
        finally{printing=false;updateQueue();}
      };
    }
    $('item-label-print-status').textContent='Printing is optional. Your inventory is already saved.';
    const quantity=options.stockSaved && options.stockInfo?Math.max(1,Number(options.stockInfo.quantity)):1;
    $('item-label-quantity').value=String(quantity);
    $('item-label-two-up').checked=true;
    $('item-label-quantity').oninput=updateLabelEstimate;
    $('item-label-two-up').onchange=updateLabelEstimate;
    updateLabelEstimate();
    $('item-label-print-batch').onclick=()=>{const plan=updateLabelEstimate();if(plan)return printItems([lastSaved],plan.copies,'individual_batch',plan);};
    const oneStrip=entries=>{const plan=labelPrintPlan($('item-label-two-up').checked?2:1);return printItems(entries,1,entries.length===1?'collective_only':'individual_batch',plan);};
    $('item-label-print-one').onclick=()=>oneStrip([lastSaved]);
    $('item-label-print-later').onclick=()=>startNext(false);
    $('item-save-success-continue').onclick=()=>startNext(false);
    $('item-save-success-similar').onclick=()=>startNext(true);
    $('item-print-last').onclick=()=>printItems([lastSaved]);
    $('item-print-session').onclick=()=>printItems([...printQueue.values()]);
    if(options.nextMode==='similar' && !options.warnings.length){await startNext(true);window.showToast?.('Item saved. Shared details are ready for the next item.');}
    else{$('item-save-success-modal').classList.remove('hidden');$('item-save-success-modal').setAttribute('aria-hidden','false');document.body.classList.add('modal-open');$('item-save-success-similar').focus();}
  }
  window.addItemIntake={captureSimilar,checkBarcode,saved};
})();
