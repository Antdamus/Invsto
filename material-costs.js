(() => {
 'use strict';
 const $=id=>document.getElementById(id),C=window.MaterialCosts,form=$('material-form');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v);
 let settings,preview,busy=false,dirty=false;
 const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
 const rpc=async(name,args={})=>{const {data,error}=await window.supabase.rpc(name,args);if(error)throw error;return data;};
 for(const [n,key] of C.keys.entries())$(n<3?'primary-rates':'other-rates').insertAdjacentHTML('beforeend',`<label class="${n<3?'material-rate-card '+key:''}">${esc(C.label(key))}<input name="${key}" type="number" min="0.0001" max="1000000" step="0.0001" ${n<3?'required':''} placeholder="Not set"><small>USD per gram</small></label>`);
 function lock(value){busy=value;form.querySelectorAll('input,button').forEach(e=>e.disabled=value||!settings?.can_edit);$('reload').disabled=value;}
 function rates(){const result={};for(const key of C.keys){const value=form.elements[key].value;if(value!=='')result[key]=Number(value);}return result;}
 async function load(){if(busy)return;lock(true);try{settings=await rpc('get_material_cost_settings');for(const key of C.keys)form.elements[key].value=settings.rates[key]??'';dirty=false;preview=null;$('stock-preview').hidden=true;
   $('updated').textContent='Last updated '+new Date(settings.updated_at).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'})+' Eastern';status(settings.can_edit?'':'You can view the rates. An administrator can update them.');
 }catch(e){status('Could not load material costs. Check your sign-in and use Reload rates. '+e.message,true);}finally{lock(false);}}
 form.oninput=()=>{dirty=true;preview=null;$('stock-preview').hidden=true;status('Unsaved changes');};
 $('preview').onclick=async()=>{if(!form.reportValidity())return;lock(true);try{preview=await rpc('material_cost_stock_preview',{_rates:rates()});$('stock-preview').hidden=false;
   $('stock-preview').innerHTML=`<div class="material-impact"><div><strong>${preview.count}</strong><small>eligible inventory records</small></div><div><strong>${money(preview.old_total)}</strong><small>current stock base cost</small></div><div><strong>${money(preview.new_total)}</strong><small>proposed stock base cost</small></div></div><p>Totals include the available quantity of each item. ${preview.count>100?'Showing the first 100 records; all eligible records will be updated.':''}</p><div class="table-wrap"><table><thead><tr><th>Item</th><th>Material / grams</th><th>Units</th><th>Cost each / before → after</th></tr></thead><tbody>${preview.items.map(i=>`<tr><td><a href="stock.html?barcode=${encodeURIComponent(i.barcode||'')}" target="_blank" rel="noopener">${esc(i.title)}</a><small>${esc(i.source)}</small></td><td>${esc(C.label(i.key))}<small>${esc(i.weight)} g</small></td><td>${esc(i.quantity)}</td><td>${money(i.old_cost)} → <b>${money(i.new_cost)}</b></td></tr>`).join('')}</tbody></table></div>`;status('Stock preview ready. Save to apply your selected option.');
 }catch(e){preview=null;status(e.message,true);}finally{lock(false);}};
 form.onsubmit=async e=>{e.preventDefault();if($('apply-stock').checked&&!preview){status('Preview the stock impact before saving with stock updates.',true);return;}lock(true);try{const result=await rpc('save_material_cost_settings',{_rates:rates(),_expected_updated_at:settings.updated_at,_apply_stock:$('apply-stock').checked,_preview_token:preview?.token||null});settings=result;dirty=false;preview=null;$('stock-preview').hidden=true;$('apply-stock').checked=false;status(`Global rates saved. ${result.updated_items} stock records updated. New inventory and live reports can now use these rates.`);$('updated').textContent='Saved just now · shared across Invsto';}catch(e){preview=null;status(e.message,true);}finally{lock(false);}};
 $('reload').onclick=load;
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 if(window.supabase?.rpc)void load();else document.addEventListener('supabase-ready',load,{once:true});
})();
