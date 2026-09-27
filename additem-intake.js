(() => {
  const $=id=>document.getElementById(id);
  const form=$('add-item-form');if(!form)return;
  let lookupVersion=0, lookupTimer, lastSaved=null, lastSimilar=null, printing=false;
  const printQueue=new Map();
  const text=id=>$(id)?.value?.trim() || '';
  const snapshotFields=ids=>Object.fromEntries(ids.map(([key,id])=>[key,text(id)]));
  function captureSimilar() {
    const wizard=window.addItemWizard.getDraft();
    const watch=Object.fromEntries(['name','brand','model','department'].map(key=>[key,wizard.watchDetails[key] || '']));
    const coin=Object.fromEntries(['name','country','denomination','metal','fineness','fineMetalContent','composition','finish'].map(key=>[key,wizard.coinDetails[key] || '']));
    // Grade, year, mint, modifications, conditions, unique IDs and photos belong to the individual item.
    coin.gradingStatus='ungraded';
    if(wizard.coinDetails.ebay?.categoryId)coin.ebay={categoryId:wizard.coinDetails.ebay.categoryId,categoryLabel:wizard.coinDetails.ebay.categoryLabel || '',photosConfirmed:false};
    const main=snapshotFields([['category','category'],['pricePerWeight','price-per-weight'],['distributorName','distributor-name'],['distributorPhone','distributor-phone'],['distributorNotes','distributor-notes']]);
    if($('item-keep-prices').checked)Object.assign(main,snapshotFields([['cost','cost'],['salePrice','sale-price'],['minimumSalePrice','minimum-sale-price']]));
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
  }
  async function recordPrintChoice(item,strategy,copies,units=1) {
    try {
      const {error}=await window.supabase.rpc('set_item_label_print_preference',{
        _item_id:item.id,_strategy:strategy,_labels_per_order:units,
        _label_print_quantity:copies,_notes:strategy==='deferred'?'Print later from the intake batch or Stock.':'Labels queued to the selected print destination.'
      });
      if(error)throw error;
      return true;
    }catch(error){console.warn('Label preference could not be recorded',error);return false;}
  }
  async function printItems(entries,copies=1,strategy='individual_batch',units=1) {
    if(printing)return;
    printing=true;updateQueue();
    const status=$('item-print-session-status');const modalStatus=$('item-label-print-status');
    let done=0,preferenceFailed=false;
    try {
      const printDestination=window.printStations?await window.printStations.chooseDestination({copies,labelCount:entries.length}):null;
      copies=printDestination?.copies || copies;
      for(const entry of entries){
        status.textContent=modalStatus.textContent=`Preparing label ${done+1} of ${entries.length}…`;
        if(!entry.xml)entry.xml=(await window.dymoModule.prepareSavedItemLabel(entry.item)).templateXml;
        await window.dymoModule.printDymoLabelXml(entry.xml,{copies,barcode:entry.item.barcode,title:entry.item.title,labelKind:'ItemLabel',listenerOnly:true,printDestination});
        printQueue.delete(entry.item.id);done++;
        if(!await recordPrintChoice(entry.item,strategy,copies,units))preferenceFailed=true;
      }
      status.textContent=modalStatus.textContent=`Queued ${done*copies} label${done*copies===1?'':'s'}${printDestination?.stationId?' for '+printDestination.name:''}. View Print stations for job status.${preferenceFailed?' The label preference could not be recorded.':''}`;
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
    $('item-label-print-status').textContent='Printing is optional. Your inventory is already saved.';
    $('item-labels-per-order').value='1';
    const quantity=options.stockSaved && options.stockInfo?Math.max(1,Number(options.stockInfo.quantity)):1;
    function estimate(){const count=Math.max(1,Math.ceil(quantity/Math.max(1,Number($('item-labels-per-order').value)||1)));$('item-label-print-count').textContent=`${count} labels`;$('item-label-print-formula').textContent=`${quantity} units; one label for every ${$('item-labels-per-order').value || 1} units.`;$('item-label-print-batch').textContent=`Print ${count} labels`;return count;}
    $('item-labels-per-order').oninput=estimate;estimate();
    $('item-label-print-batch').onclick=()=>printItems([lastSaved],estimate(),'individual_batch',Math.max(1,Math.floor(Number($('item-labels-per-order').value)||1)));
    $('item-label-print-one').onclick=()=>printItems([lastSaved],1,'collective_only');
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
