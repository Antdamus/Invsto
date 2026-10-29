(() => {
 'use strict';
 const $=id=>document.getElementById(id),price=$('price-per-weight');let config=null,applying=false;
 price.closest('label').insertAdjacentHTML('afterend','<div id="shared-material-controls"><label class="toggle-label"><input id="use-shared-material-cost" type="checkbox" checked> Use shared material cost</label><p id="shared-material-status" class="field-helper" role="status">Loading material rates…</p><a href="material-costs.html" target="_blank" rel="noopener">Manage global material costs ↗</a></div>');
 const shared=$('use-shared-material-cost');
 function sync(){
   const direct=window.addItemWizard?.usesDirectPricing();$('shared-material-controls').hidden=Boolean(direct);if(direct||!shared.checked)return;
   const selected=window.addItemAssistedModule?.getSelectedMaterialPurity?.()||{material:$('assisted-material')?.value,purity:$('assisted-purity')?.value};
   const purity=String(selected.purity||'').toLowerCase(),bp=purity.includes('k')?Math.round(parseFloat(purity)/24*10000):parseFloat(purity)*10;
   const key=window.MaterialCosts.itemKey({metal:selected.material,purity_basis_points:bp||null,title:$('title')?.value});
   const rate=config?.rates?.[key];applying=true;price.value=rate??'';price.dataset.sharedMaterialKey=rate!=null?key:'';
   // Clear the previous computed cost when the material has no configured rate.
   if(rate==null&&$('auto-cost-checkbox').checked&&!window.addItemPricing?.deferred()){$('cost').value='';window.addItemPricing?.calculateMinimum();}
   price.dispatchEvent(new Event('input',{bubbles:true}));applying=false;
   $('shared-material-status').textContent=!config?'Shared rates unavailable. Reload the page or enter a custom cost.':rate!=null?`${window.MaterialCosts.label(key)} · ${window.MaterialCosts.rateMoney(rate)}/g${!purity?' (purity assumed)':''}`:'No matching shared rate. Enter a custom cost or configure this material.';
 }
 function manual(){if(applying)return;shared.checked=false;delete price.dataset.sharedMaterialKey;$('shared-material-status').textContent='Custom cost for this item. Check Use shared material cost to return to the global rate.';}
 price.addEventListener('input',manual);
 $('cost').addEventListener('input',()=>{manual();$('auto-cost-checkbox').checked=false;});
 shared.addEventListener('change',()=>{if(shared.checked){$('auto-cost-checkbox').checked=true;sync();}else manual();});
 document.addEventListener('add-item:mode-change',sync);
 $('item-pricing-mode').addEventListener('change',sync);
 $('title').addEventListener('input',sync);
 document.addEventListener('add-item-form:reset',()=>{shared.checked=true;sync();});
 window.addItemMaterialCosts={sync,restore(main){shared.checked=main?.sharedMaterialRate??!Boolean(main?.pricePerWeight||main?.cost);if(!shared.checked)manual();else queueMicrotask(sync);},fields(){
   const eligible=!window.addItemPricing?.deferred()&&!window.addItemWizard?.usesDirectPricing()&&shared.checked&&$('auto-cost-checkbox').checked&&price.dataset.sharedMaterialKey;
   return {material_cost_key:eligible||null,material_cost_manual:!eligible&&!window.addItemPricing?.deferred()};
 }};
 async function load(){try{const {data,error}=await window.supabase.rpc('get_material_cost_settings');if(error)throw error;config=data;}catch{config=null;}sync();}
 document.addEventListener('DOMContentLoaded',load);
 window.addEventListener('focus',load);
})();
