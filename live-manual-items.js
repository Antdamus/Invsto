(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let api,editing=null,lotId=null,saving=false;
  const drafts={add:{},edit:{}};
  const prefix=mode=>mode==='add'?'manual-live-item':'manual-edit';
  const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
  function photoMarkup(mode){const p=prefix(mode);return `<div class="manual-photo-controls"><span>Item photo (optional)</span><div class="button-row"><button type="button" id="${p}-camera-button" class="secondary-btn">Take photo</button><button type="button" id="${p}-photo-button" class="secondary-btn">Choose photo</button></div><input id="${p}-camera" type="file" accept="image/*" capture="environment" hidden><input id="${p}-photo" type="file" accept="image/*" hidden><img id="${p}-preview" alt="Manual item photo" hidden><button type="button" id="${p}-remove-photo" class="secondary-btn" hidden>Remove photo</button><p id="${p}-photo-status" role="status"></p></div>`;}
  function clean(mode){const d=drafts[mode];if(d.url)URL.revokeObjectURL(d.url);drafts[mode]={};const p=prefix(mode);$(p+'-preview').hidden=true;$(p+'-preview').removeAttribute('src');$(p+'-remove-photo').hidden=true;$(p+'-photo-status').textContent='';}
  async function preparePhoto(file){
    if(!file||file.size>25*1024*1024)throw Error('Choose a photo smaller than 25 MB.');
    if(file.type && !file.type.startsWith('image/'))throw Error('Choose an image file.');
    const source=URL.createObjectURL(file),img=new Image();
    try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('This photo could not be read. Take a new photo or choose a JPEG, PNG or WebP image.'));img.src=source;});
      const scale=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));if(!blob)throw Error('Could not prepare the photo. Please try again.');return blob;
    }finally{URL.revokeObjectURL(source);}
  }
  function bindPhoto(mode){const p=prefix(mode);
    for(const kind of ['camera','photo']){
      $(p+'-'+kind+'-button').onclick=()=>$(p+'-'+kind).click();
      $(p+'-'+kind).onchange=async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;const d=drafts[mode];d.processing=true;$(p+'-photo-status').textContent='Preparing photo…';sync();
        try{const blob=await preparePhoto(file);if(d!==drafts[mode])return;if(d.url)URL.revokeObjectURL(d.url);d.blob=blob;d.path=null;d.url=URL.createObjectURL(blob);$(p+'-preview').src=d.url;$(p+'-preview').hidden=false;$(p+'-remove-photo').hidden=false;$(p+'-photo-status').textContent='Photo ready. It will be saved with this item.';}
        catch(error){$(p+'-photo-status').textContent=error.message;}finally{d.processing=false;api.gate();sync();}}
    }
    $(p+'-remove-photo').onclick=()=>{clean(mode);sync();};
  }
  function sync(){
    if(!api)return;
    const current=api.state.currentLot?.id||null;
    if(current!==lotId){lotId=current;clean('add');$('manual-live-item-minimum').value='';$('manual-live-item-description').value='';$('manual-live-item-quantity').value='1';if($('manual-item-editor').open)$('manual-item-editor').close();}
    const addDisabled=$('add-manual-live-item').disabled||saving||drafts.add.processing;
    for(const suffix of ['category','quantity','description','minimum','camera-button','photo-button','remove-photo'])$('manual-live-item-'+suffix).disabled=addDisabled;
    if(drafts.add.processing||saving)$('add-manual-live-item').disabled=true;
    $('manual-edit-save').disabled=saving||!!drafts.edit.processing;
    $('manual-edit-cancel').disabled=saving;
    for(const suffix of ['category','description','quantity','minimum','camera-button','photo-button','remove-photo'])$('manual-edit-'+suffix).disabled=saving||!!drafts.edit.processing;
  }
  async function save(mode){
    if(saving||api.state.busy||drafts[mode].processing)return;
    const p=prefix(mode),error=$('manual-edit-error');if(mode==='edit')error.textContent='';
    for(const suffix of ['category','quantity','minimum','description'])if(!$(p+'-'+suffix).reportValidity())return;
    const d=drafts[mode];d.id ||= editing?.manualId&&mode==='edit'?editing.manualId:crypto.randomUUID();
    const targetLot=api.state.currentLot?.id;if(!targetLot)return;
    try{
      saving=true;api.state.busy=true;api.gate();sync();api.status('Saving manual item…');
      if(d.blob&&!d.path){const path=`live-manual/${targetLot}/${d.id}/${crypto.randomUUID()}.jpg`;const {error}=await window.supabase.storage.from('photos').upload(path,d.blob,{contentType:'image/jpeg',upsert:false});if(error)throw error;d.path=path;}
      const raw=$(p+'-minimum').value.trim();
      const {error:rpcError}=await window.supabase.rpc('save_live_sale_manual_item',{_lot_id:targetLot,_item_id:d.id,_category:$(p+'-category').value,_description:$(p+'-description').value.trim()||null,_quantity:Number($(p+'-quantity').value),_unit_minimum:raw===''?null:Number(raw),_photo_path:d.path||null,_expected_revision:mode==='edit'?editing.manualRevision:null});
      if(rpcError)throw rpcError;
      if(mode==='edit')$('manual-item-editor').close();else{$(p+'-description').value='';$(p+'-quantity').value='1';$(p+'-minimum').value='';}
      clean(mode);await api.reload();await window.ebayLive?.refresh();api.status(mode==='edit'?'Manual item updated.':'Manual item added.','success');
    }catch(e){if(mode==='edit')error.textContent=e.message;else $('manual-live-item-photo-status').textContent=e.message;api.status(e.message||'Could not save the manual item.','error');}
    finally{saving=false;api.state.busy=false;api.gate();sync();}
  }
  async function open(group){
    if(!group?.isManual||saving)return;editing=group;clean('edit');const p='manual-edit';drafts.edit.id=group.manualId;drafts.edit.path=group.manualPhoto||null;
    const select=$(p+'-category');select.innerHTML=$('manual-live-item-category').innerHTML;
    if(![...select.options].some(o=>o.value===group.manualCategory))select.add(new Option(group.manualCategory,group.manualCategory));
    select.value=group.manualCategory;$(p+'-description').value=group.manualDescription||'';$(p+'-quantity').value=group.quantity;$(p+'-minimum').value=group.unitMinimum??'';$(p+'-error').textContent='';
    $('manual-item-editor').showModal();sync();
    if(group.manualPhoto){const d=drafts.edit;const url=await api.photo(group.manualPhoto);if(d!==drafts.edit||!$('manual-item-editor').open)return;if(url){$(p+'-preview').src=url;$(p+'-preview').hidden=false;$(p+'-remove-photo').hidden=false;}}
  }
  function priceText(group){if(!group.isManual)return '';return group.unitMinimum==null?'Break-even not entered':`Break-even ${money(group.unitMinimum)} each · ${money(group.unitMinimum*group.quantity)} total`;}
  function summary(){const el=$('manual-break-even-summary');if(!el||!api)return;const entries=api.state.lotItems.filter(i=>i.status==='reserved');const sale=window.ebayLive?.current();el.hidden=!sale||!entries.length;if(el.hidden)return;
    const complete=entries.every(i=>i.live_unit_minimum!=null),minimum=entries.reduce((sum,i)=>sum+Number(i.live_unit_minimum||0)*Number(i.quantity),0);
    el.textContent=complete?`Sale ${money(sale.amount)} · Break-even ${money(minimum)} · Result vs break-even ${money(Number(sale.amount)-minimum)}`:`Sale ${money(sale.amount)} · Break-even incomplete: enter the missing item prices.`;
    el.classList.toggle('is-loss',complete&&Number(sale.amount)<minimum);
  }
  function init(bridge){api=bridge;const host=document.querySelector('.manual-live-item-box');host.querySelector('.manual-live-item-add').insertAdjacentHTML('beforebegin',`<label>Minimum / break-even per item ($)<input id="manual-live-item-minimum" type="number" inputmode="decimal" min="0" max="9999999999.99" step="0.01" placeholder="Optional; leave blank if unknown"><small>For quantity 2, this amount is counted twice.</small></label>${photoMarkup('add')}`);
    const dialog=document.createElement('dialog');dialog.id='manual-item-editor';dialog.innerHTML=`<h2>Edit manual item</h2><p>Update this item, then continue reviewing the same bag.</p><label>Type<select id="manual-edit-category" required></select></label><label>Description<input id="manual-edit-description" maxlength="1000"></label><div class="manual-edit-grid"><label>Quantity<input id="manual-edit-quantity" type="number" min="1" max="9999" step="1" required></label><label>Minimum / break-even each ($)<input id="manual-edit-minimum" type="number" inputmode="decimal" min="0" max="9999999999.99" step="0.01" placeholder="Unknown"></label></div>${photoMarkup('edit')}<p id="manual-edit-error" role="alert"></p><div class="button-row"><button type="button" id="manual-edit-save" class="primary-btn">Save changes</button><button type="button" id="manual-edit-cancel" class="secondary-btn">Cancel</button></div>`;document.body.append(dialog);
    $('label-review-manifest').insertAdjacentHTML('afterend','<p id="manual-break-even-summary" class="ebay-current" role="status" hidden></p>');
    for(const mode of ['add','edit'])bindPhoto(mode);
    $('manual-edit-save').onclick=()=>save('edit');$('manual-edit-cancel').onclick=()=>dialog.close();dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});
  }
  window.liveManualItems={init,open,add:()=>save('add'),sync,priceText,summary};
})();
