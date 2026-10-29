(() => {
  'use strict';
  const M=window.OGLiveReportModel,$=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sessionId=new URLSearchParams(location.search).get('session');
  let payload,model,loading=false,exporting=false,settingsDirty=false,settingsVersion=null,editing=null,signature='',lastSuccess=0;
  const photos=new Map(),forms=$('settings-form').elements;
  const nav=buyer=>`<nav class="navigation"><a href="#buyer-index">↑ Buyer index</a>${buyer?`<a href="#${esc(buyer)}">↑ This buyer’s index</a>`:''}<a href="#overview">↑ Show overview</a></nav>`;
  const stat=(label,value,note,kind='')=>`<div class="stat ${kind}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`;
  const pill=r=>`<span class="pill ${r.state}">${esc(r.stateLabel)}</span>`;
  const rateLabel=key=>key==='silver'?'Silver / gram ($)':key.replace('gold_','')+'K gold / gram ($)';
  $('rates').innerHTML=M.RATE_KEYS.map(key=>`<label>${rateLabel(key)}<input name="${key}" type="number" min="0" max="1000000" step="0.0001" placeholder="Not set"></label>`).join('');
  async function rpc(name,args){const {data,error}=await window.supabase.rpc(name,args);if(error)throw Error(error.message);return data;}
  function fillSettings(){
    if(!model||settingsDirty)return;const settings=model.settings;
    for(const key of M.RATE_KEYS)forms[key].value=settings.rates?.[key]??'';
    for(const key of ['fee_percent','fee_fixed','shipping_per_sale'])forms[key].value=settings[key]??'';
    settingsVersion=settings.updated_at||null;
  }
  function overview(){
    const s=model.stats,c=model.connection;
    const sourceFresh=Date.now()-Date.parse(c.source_seen_at)<60000;
    $('overview').innerHTML=`<div class="hero"><div class="eyebrow">OG Jewelers / The live ledger <span class="live-badge">UPDATES EVERY 5 SECONDS</span></div><h1>${esc(model.title)}</h1><p>${esc(model.show.session_code||'')} · ${model.customers.length} buyers · ${s.items} purchases · All times Eastern</p></div>
      <div class="summary-grid">${stat('Confirmed paid',M.money(s.paid.amount),`${s.paid.count} purchases · ${s.expectedItems} expected paid items`,'paid')}${stat('Pending payment',M.money(s.waiting.amount),`${s.waiting.count} purchases · excluded from paid total`,'waiting')}${stat('Payment failed',M.money(s.failed.amount),`${s.failed.count} purchases · excluded from paid total`,'failed')}${stat('Needs review / excluded',s.review.count+s.cancelled.count+s.resolved.count,`${s.review.count} review · ${s.cancelled.count} canceled · ${s.resolved.count} resolved`)}</div>
      <div class="profit-strip"><div><span>Gross margin on priced paid items</span><strong class="${s.margin<0?'negative':''}">${s.pricedPaid?M.money(s.margin):'Needs base prices'}</strong><small>${s.pricedPaid} of ${s.paid.count} paid purchases priced · before expenses / refunds</small></div><div><span>Estimated profit after expenses</span><strong class="${s.profit<0?'negative':''}">${model.expensesKnown&&s.pricedPaid?M.money(s.profit):'Set costs & expenses'}</strong><small>${model.expensesKnown?'Uses saved fee and shipping estimates':'Fee %, fixed fee and shipping must all be set'}</small></div><div><strong class="attention">${s.missingCosts} need base prices</strong><small>Missing costs are excluded from margin, never assumed zero.</small><a href="#cost-settings">Open cost studio</a></div></div>
      <p class="link-note">Capture: ${esc(c.capture_ready&&sourceFresh?'ready':c.capture_ready?'last signal is stale — check the capture tab':c.health?.message||'check the capture tab')} · Last source update: ${esc(M.date(c.source_seen_at)||'not yet received')}${model.unmatched?` · ${model.unmatched} notifications still need matching`:''}${s.missingAmounts?` · ${s.missingAmounts} sale amounts unavailable`:''}</p>`;
  }
  function directory(){
    $('buyer-index').innerHTML=`<div class="section-head"><div><div class="eyebrow">01 / Buyer directory</div><h2>Every buyer, at a glance.</h2></div><p>Click a buyer to review their item index.<br>Expected items include confirmed-paid purchases only.</p></div><div class="table-wrap"><table><thead><tr><th>Buyer / name</th><th>Expected paid items</th><th>Paid total</th><th>Pending</th><th>Failed</th><th>Base prices needed</th></tr></thead><tbody>${model.customers.map(b=>`<tr><td><a href="#${esc(b.key)}">${esc(b.username)}</a><small>${esc(b.name||'Name not yet available')}</small></td><td class="num">${b.stats.expectedItems}<small>${b.stats.paid.count} paid purchases / ${b.stats.items} total</small></td><td class="num">${M.money(b.stats.paid.amount)}</td><td>${b.stats.waiting.count}<small>${M.money(b.stats.waiting.amount)}</small></td><td>${b.stats.failed.count}<small>${M.money(b.stats.failed.amount)}</small></td><td class="attention">${b.stats.missingCosts} paid items<small>${b.rows.filter(r=>r.cost.base==null).length} across all states</small></td></tr>`).join('')||'<tr><td colspan="6">No purchases captured yet. Leave this report open as sales arrive.</td></tr>'}</tbody></table></div>`;
  }
  function imageMarkup(row){return row.photos.length?row.photos.map((p,i)=>`<figure><a data-photo-link="${esc(p.photo_path)}" target="_blank" rel="noopener"><img data-photo-path="${esc(p.photo_path)}" alt="Saved screenshot ${i+1} for ${esc(row.title)}" loading="lazy"></a><figcaption>Screenshot ${i+1} of ${row.photos.length} · ${esc(M.date(p.captured_at)||'Capture time unavailable')}</figcaption></figure>`).join(''):'<div class="empty"><div class="eyebrow">Item evidence</div><p>No screenshots attached yet.<br>New saved photos appear here automatically.</p></div>';}
  function item(row){return `<article id="${row.key}" class="item-card ${row.state}"><div class="item-top"><span>Bag #${esc(row.ordinal)} / ${esc(row.username)}</span>${pill(row)}</div><div class="item-body"><div class="photo-gallery">${imageMarkup(row)}</div><div class="item-details"><div class="eyebrow">Original auction title</div><h3>${esc(row.title)}</h3><p class="item-price">${M.money(row.price)}<small>USD · auction/item amount · quantity ${row.quantity}</small></p><dl><dt>Sold</dt><dd>${esc(row.time)}<small class="link-note"> ${esc(row.timeNote)}</small></dd><dt>Buyer</dt><dd>${esc(row.username)}${row.name?` / ${esc(row.name)}`:''}</dd><dt>Seller</dt><dd>${esc(row.seller_name||'Not recorded')}</dd><dt>Order</dt><dd>${esc(row.orderNumber||'Awaiting order import / matching')}</dd><dt>Bag status</dt><dd>${row.closed_at?'Closed':row.resolved_at?'Resolved':'Open'}${row.payment_hold?' · payment hold':''}</dd></dl><div class="cost-box"><p>Base cost <strong>${row.cost.base==null?'<span class="attention">Needs base price</span>':M.money(row.cost.base)}</strong></p><p>${esc(row.cost.source)}</p>${row.cost.note?`<p>${esc(row.cost.note)}</p>`:''}<p>Gross margin: <b class="${row.margin<0?'negative':''}">${row.state!=='paid'?'Excluded until confirmed paid':row.margin==null?'Needs base price':M.money(row.margin)}</b></p><p>Estimated profit: <b class="${row.profit<0?'negative':''}">${row.state!=='paid'?'Excluded':row.profit==null?'Costs / expenses incomplete':M.money(row.profit)}</b></p><div class="form-actions"><button type="button" data-edit-cost="${esc(row.id)}">${row.cost.base==null?'Set base price':'Adjust cost'}</button></div></div></div></div><footer class="item-footer">${nav(row.customerKey)}<div class="item-links">${row.links.map(([label,url])=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`).join('')}</div>${!row.orderNumber?'<p class="link-note">Order and video-receipt links are not yet matched. They will appear after import; the report keeps checking.</p>':!row.videoUrl?'<p class="link-note">No direct video URL is saved yet. “Find receipt in order” opens the matched eBay order to check its Live receipt.</p>':''}</footer></article>`;}
  function buyerSections(){
    $('buyers').innerHTML=model.customers.map(b=>`<section class="buyer-section"><header id="${esc(b.key)}" class="buyer-heading"><div class="eyebrow">Buyer collection / Item index</div><h2>${esc(b.username)}</h2><p>${esc(b.name||'Customer name not yet available')}</p><div class="buyer-stats"><span><strong>${b.stats.expectedItems}</strong>Expected paid items</span><span><strong>${M.money(b.stats.paid.amount)}</strong>Confirmed paid</span><span><strong>${b.stats.waiting.count} / ${b.stats.failed.count}</strong>Pending / failed</span><span><strong>${b.stats.pricedPaid?M.money(b.stats.margin):'Not priced'}</strong>Gross margin · ${b.stats.pricedPaid}/${b.stats.paid.count} priced</span><span class="attention"><strong>${b.stats.missingCosts}</strong>Paid items needing cost</span></div>${nav()}</header><div class="table-wrap buyer-index"><table><thead><tr><th>Bag / item title</th><th>Sold · Eastern</th><th>Amount</th><th>Payment</th><th>Base cost</th></tr></thead><tbody>${b.rows.map(r=>`<tr><td><a href="#${r.key}">#${esc(r.ordinal)} · ${esc(r.title)}</a><small>${r.photos.length} screenshots${r.orderNumber?' · Order '+esc(r.orderNumber):''}</small></td><td>${esc(r.time)}</td><td class="num">${M.money(r.price)}</td><td>${pill(r)}</td><td class="num">${r.cost.base==null?'<span class="needs-cost">Needs base price</span>':M.money(r.cost.base)}<small>${r.cost.parsed?.assumed?'10K assumed':''}</small></td></tr>`).join('')}</tbody></table></div>${b.rows.map(item).join('')}</section>`).join('');
  }
  async function loadPhotos(targetModel=model){
    const paths=[...new Set(targetModel.rows.flatMap(r=>r.photos.map(p=>p.photo_path)))].filter(p=>!photos.has(p)||photos.get(p).until<Date.now());
    for(let i=0;i<paths.length;i+=75){const batch=paths.slice(i,i+75);try{
      const {data,error}=await window.supabase.storage.from('photos').createSignedUrls(batch,3600);if(error)throw error;
      for(const p of data||[])if(p.signedUrl)photos.set(p.path,{url:p.signedUrl,until:Date.now()+3000000});
    }catch{/* The visible image fallback stays explicit; the next refresh retries. */}}
    for(const img of document.querySelectorAll('[data-photo-path]')){const value=photos.get(img.dataset.photoPath);if(value&&img.getAttribute('src')!==value.url){img.src=value.url;img.closest('a').href=value.url;img.onerror=()=>{img.alt='Screenshot unavailable; refresh to retry';photos.delete(img.dataset.photoPath);};}else if(!value)img.alt='Screenshot could not load; refresh to retry';}
    for(const row of targetModel.rows)for(const p of row.photos)p.url=photos.get(p.photo_path)?.url||'';
  }
  async function refresh(){
    if(loading)return;loading=true;$('refresh').disabled=true;
    try{
      if(!/^[0-9a-f-]{36}$/i.test(sessionId||''))throw Error('Open Live report from a selected show in Live Sales.');
      const client=window.supabase;if(!client?.auth)throw Error('The connection is still loading. Try Refresh.');
      const {data:auth,error}=await client.auth.getSession();if(error)throw error;
      if(!auth.session){$('sign-in').hidden=false;throw Error('Sign in to open the live sales report.');}
      payload=await rpc('get_live_sale_report',{_session_id:sessionId});model=M.makeModel(payload,location.href);lastSuccess=Date.now();
      $('error').hidden=true;$('sign-in').hidden=true;$('download').disabled=exporting;document.title=model.title+' / Live report';
      overview();fillSettings();const next=JSON.stringify([payload.attempts,payload.costs,payload.settings,payload.evidence]);
      if(next!==signature){signature=next;directory();buyerSections();}
      $('progress').textContent=`Live report updated ${M.date(model.updatedAt)} · ${model.stats.items} purchases · refreshes every 5 seconds`;
      await loadPhotos();
    }catch(error){$('error').textContent=error.message;$('error').hidden=false;$('progress').textContent=lastSuccess?`Updates interrupted. Showing the last successful refresh: ${M.date(new Date(lastSuccess).toISOString())}.`:'Report not loaded.';}
    finally{loading=false;$('refresh').disabled=false;}
  }
  $('settings-form').addEventListener('input',()=>{settingsDirty=true;$('settings-status').textContent='Unsaved assumptions';});
  $('reload-settings').onclick=()=>{settingsDirty=false;fillSettings();$('settings-status').textContent='Saved assumptions restored';};
  $('settings-form').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try{const rates={};for(const key of M.RATE_KEYS)if(forms[key].value!=='')rates[key]=Number(forms[key].value);
      await rpc('save_live_sale_report_settings',{_session_id:sessionId,_rates:rates,_fee_percent:M.number(forms.fee_percent.value),_fee_fixed:M.number(forms.fee_fixed.value),_shipping_per_sale:M.number(forms.shipping_per_sale.value),_expected_updated_at:settingsVersion});
      settingsDirty=false;$('settings-status').textContent='Saved for this show on all devices';await refresh();
    }catch(error){$('settings-status').textContent=error.message;}finally{button.disabled=false;}
  };
  const costForm=$('cost-form'),fields=costForm.elements;
  function previewCost(){
    const mode=fields.mode.value;$('manual-fields').hidden=mode!=='manual';$('metal-fields').hidden=mode!=='metal';
    fields.base_cost.required=mode==='manual';fields.grams.required=mode==='metal';fields.purity.required=mode==='metal'&&fields.material.value==='gold';
    fields.base_cost.disabled=mode!=='manual';fields.material.disabled=fields.grams.disabled=mode!=='metal';fields.purity.disabled=mode!=='metal'||fields.material.value!=='gold';
    const cost=M.costFor(editing,{mode,base_cost:fields.base_cost.value,material:fields.material.value,grams:fields.grams.value,purity:fields.purity.value},model.settings);
    $('cost-preview').textContent=`Base cost: ${cost.base==null?'Needs a cost or matching gram rate':M.money(cost.base)}${cost.base!=null&&editing.price!=null&&editing.state==='paid'?' · Gross margin: '+M.money(editing.price-cost.base):''}. ${cost.source}`;
  }
  $('buyers').onclick=event=>{
    const button=event.target.closest('[data-edit-cost]');if(!button)return;editing=model.rows.find(r=>r.id===button.dataset.editCost);if(!editing)return;
    const o=editing.override,p=editing.cost.parsed||{};$('cost-title').textContent=`Bag #${editing.ordinal} · ${editing.username}`;$('cost-detected').textContent=editing.title+' — '+M.parseTitle(editing.title).note;
    fields.mode.value=o.mode||(editing.cost.base==null?'manual':'auto');fields.base_cost.value=o.base_cost??editing.cost.base/100;if(editing.cost.base==null&&o.base_cost==null)fields.base_cost.value='';
    fields.material.value=o.material||p.material||'gold';fields.grams.value=o.grams??p.grams??'';fields.purity.value=o.purity??p.purity??10;fields.note.value=o.note||'';
    $('cost-error').textContent='';previewCost();$('cost-dialog').showModal();
  };
  costForm.oninput=previewCost;
  $('close-cost').onclick=$('cancel-cost').onclick=()=>$('cost-dialog').close();
  costForm.onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;
    try{await rpc('save_live_sale_report_cost',{_session_id:sessionId,_attempt_id:editing.id,_mode:fields.mode.value,_base_cost:M.number(fields.base_cost.value),_material:fields.mode.value==='metal'?fields.material.value:null,_grams:fields.mode.value==='metal'?M.number(fields.grams.value):null,_purity:fields.mode.value==='metal'&&fields.material.value==='gold'?M.number(fields.purity.value):null,_note:fields.note.value,_expected_updated_at:editing.override.updated_at||null});$('cost-dialog').close();await refresh();}
    catch(error){$('cost-error').textContent=error.message;}finally{button.disabled=false;}
  };
  $('refresh').onclick=refresh;
  document.addEventListener('click',event=>{if(event.target.closest('a[href="#cost-settings"]'))$('cost-settings').open=true;});
  $('download').onclick=async()=>{
    if(!model||exporting)return;exporting=true;$('download').disabled=true;
    try{const snapshot=M.makeModel(structuredClone(payload),location.href,new Date());await loadPhotos(snapshot);const bytes=await window.OGLiveReportPdf.build(snapshot,text=>$('progress').textContent=text);
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=`live-sales-${snapshot.show.session_code||sessionId}-${new Date().toISOString().slice(0,10)}.pdf`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      $('progress').textContent=`PDF snapshot ready · ${snapshot.date} · ${snapshot.rows.length} purchases`;
    }catch(error){$('error').textContent='PDF could not be completed: '+error.message;$('error').hidden=false;}finally{exporting=false;$('download').disabled=false;}
  };
  const boot=()=>{void refresh();setInterval(()=>{if(!exporting)void refresh();},5000);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
