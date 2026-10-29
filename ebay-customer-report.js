(function(root){
  'use strict';
  const buyer=root.OGBuyerReport||(typeof require==='function'?require('./ebay-buyer-report.js'):null);
  const shared=root.OGMissingReport||(typeof require==='function'?require('./ebay-missing-report.js'):null);
  const refunds=root.OGBuyerRefundReport||(typeof require==='function'?require('./buyer-report-refunds.js'):null);
  const html=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const scopeName=scope=>scope==='pending'?'Pending items':'Full purchase history';
  const NOTES='Financial statistics always cover all saved purchases for this exact eBay username, including closed orders. Confirmed refunds are counted once per order; partial refunds are included in total refunds. Requests and pending refunds are not deducted. Order totals include recorded shipping and tax; item values are original amounts before refunds, excluding shipping and tax. Missing or inconsistent amounts leave net spent unconfirmed. This is a saved-record snapshot; regenerate after updates.';
  const DEADLINE_NOTES='Pending items include pending and partially fulfilled lines. Shipping deadlines show Eastern time and the equivalent eBay Pacific time. Due today and due tomorrow follow the Pacific shipping calendar. Overdue duration is measured at report preparation, from the saved deadline. Date-only deadlines expire at the start of the next Pacific day. Closed lines are never presented as currently overdue.';
  function state(line,order){
    const raw=String(line.line_status||order.status||'').toLowerCase();
    if(['pending','partially_fulfilled'].includes(raw))return {kind:'pending',label:raw==='partially_fulfilled'?'Pending / partially fulfilled':'Pending',raw};
    const labels={fulfilled:'Closed / fulfilled',cancelled:'Closed / canceled',canceled:'Closed / canceled',skipped:'Closed / skipped',closed:'Closed',refunded:'Closed / refunded'};
    return labels[raw]?{kind:'closed',label:labels[raw],raw}:{kind:'unknown',label:raw?`Status: ${raw}`:'Status not recorded',raw};
  }
  function shippingLabel(order){
    const attached=Boolean(String(order.label_file_path||'').trim());
    return {attached,label:attached?'Label attached':'No label attached',uploadedAt:attached?order.label_uploaded_at:null};
  }
  function timeline(order,line,row,now){
    const events=[{label:'Purchased',text:buyer.purchaseDate(order),at:Date.parse(order.sale_date),tone:'normal'}];
    if(row.shippingLabel.uploadedAt)events.push({label:'Shipping label attached',text:shared.date(row.shippingLabel.uploadedAt),at:Date.parse(row.shippingLabel.uploadedAt),tone:'normal'});
    if(row.pending)events.push({label:'Shipping deadline',text:row.deadline.due,at:row.deadline.sort,tone:row.deadline.level});
    if(row.state.kind==='closed'&&line.fulfilled_at)events.push({label:'System line completed',text:shared.date(line.fulfilled_at),at:Date.parse(line.fulfilled_at),tone:'normal'});
    // A closed line is not itself evidence of carrier shipment or delivery.
    if(order.shipped_on_date){const exact=/T/.test(order.shipped_on_date);events.push({label:'Recorded ship date',text:exact?shared.date(order.shipped_on_date):`${order.shipped_on_date} / Time not recorded`,at:Date.parse(order.shipped_on_date),tone:'normal'});}
    events.push({label:row.pending&&row.deadline.level==='overdue'?`Snapshot / ${row.deadline.age} overdue`:`Report snapshot / ${row.state.label}`,text:shared.date(now),at:Number(now),tone:row.pending?row.deadline.level:'normal'});
    return events.filter(e=>Number.isFinite(e.at)).sort((a,b)=>a.at-b.at);
  }
  function makeModel(username,records,scope,baseUrl,now=new Date()){
    scope=scope==='pending'?'pending':'all';
    const customer=shared.makeCustomer(username,records,[],baseUrl,now),orders=new Map(records.orders.map(o=>[o.id,o])),lines=new Map(records.lines.map(l=>[l.id,l]));
    const allRows=buyer.buildRows(records,baseUrl).map(row=>{
      const order=orders.get(row.orderId),line=lines.get(row.id),savedState=state(line,order),pending=savedState.kind==='pending';
      const pendingUrl=new URL('pending-orders.html',baseUrl);pendingUrl.searchParams.set('orderId',row.orderNumber);
      const api=order.raw_payload?.order||{},raw=order.raw_payload||{},sync=raw.api_order_status||{};
      const ebayStatus=[['Payment',api.orderPaymentStatus||raw.orderPaymentStatus||sync.payment_status],['Fulfillment',api.orderFulfillmentStatus||raw.orderFulfillmentStatus||sync.fulfillment_status],['Cancellation',api.cancelStatus?.cancelState||sync.cancel_status]].filter(([,v])=>v&&v!=='NONE').map(([k,v])=>`${k}: ${v}`).join(' | ')||'Not recorded';
      const result={...row,state:savedState,pending,shippingLabel:shippingLabel(order),deadline:shared.deadline(order,now),notes:shared.itemNotes(records,row.id),customerName:String(order.buyer_name||'').trim()||customer.name,pendingUrl:pendingUrl.href,ebayStatus};
      result.timeline=timeline(order,line,result,now);return result;
    });
    const rows=allRows.filter(r=>scope!=='pending'||r.pending).sort((a,b)=>{
      const rank=r=>r.pending?0:r.state.kind==='closed'?1:2;
      return rank(a)-rank(b)||(a.pending&&b.pending?a.deadline.sort-b.deadline.sort:0)||b.sortDate.localeCompare(a.sortDate)||a.orderNumber.localeCompare(b.orderNumber)||a.id.localeCompare(b.id);
    });
    const pending=rows.filter(r=>r.pending),closed=rows.filter(r=>r.state.kind==='closed');
    const missingOrders=records.orders.filter(o=>!allRows.some(r=>r.orderId===o.id));
    return {username,customer,rows,scope,title:scopeName(scope),preparedAt:now.toISOString(),date:shared.date(now),count:rows.length,orderCount:new Set(rows.map(r=>r.orderId)).size,
      pending:pending.length,closed:closed.length,unknown:rows.length-pending.length-closed.length,overdue:pending.filter(r=>r.deadline.level==='overdue').length,today:pending.filter(r=>r.deadline.level==='today').length,
      labeled:pending.filter(r=>r.shippingLabel.attached).length,unlabeled:pending.filter(r=>!r.shippingLabel.attached).length,itemValue:buyer.totalsFor(rows),unknownPrices:rows.filter(r=>r.price.total==null).length,
      missingOrders,orphanLines:records.lines.filter(l=>!orders.has(l.order_id)).length};
  }
  function urgency(row){return row.pending?(row.deadline.level==='overdue'?`Overdue for ${row.deadline.age}`:row.deadline.label):row.state.label;}
  function render(model){
    const c=model.customer;
    const indexRow=(r,i)=>`<a href="#purchase-${html(r.id)}" class="${r.pending?r.deadline.level:'closed'}${r.refund?.itemRefundConfirmed?' is-refunded':''}"><span><strong>${i+1}. ${html(r.title)}</strong><small>Order ${html(r.orderNumber)} · Qty ${r.price.quantity}</small><small>Purchased ${html(r.date)}</small>${r.groups.length?'<small>Grouped completion · details inside</small>':''}</span><span><small>Original item amount</small><strong class="index-item-price">${html(shared.money(r.price.total,r.price.currency))}</strong><small class="refund-index">${html(r.refund?.label||'Refund status not recorded')}</small></span><span class="index-shipping"><small>${r.pending?html(r.state.label):"System status"}</small><strong class="index-item-deadline">${html(urgency(r))}</strong>${r.pending?`<small class="label-status ${r.shippingLabel.attached?'attached':'absent'}">${html(r.shippingLabel.label)}</small><small>Ship by · ${html(r.deadline.dueEastern||'Not recorded')}</small>`:''}</span></a>`;
    return `<header class="report-hero" id="customer-summary"><div class="eyebrow">OG JEWELERS / CUSTOMER COLLECTION</div><h1>${html(c.name||'Customer name not recorded')}<br><em>${html(model.title)}.</em></h1><p>eBay: ${html(model.username)}</p><div class="edition">Prepared ${html(model.date)}<br>${model.count} item lines across ${model.orderCount} orders · Original item value: ${html(model.itemValue)}${model.unknownPrices?` (${model.unknownPrices} prices not recorded)`:''}</div></header>
      <nav class="report-jump"><a href="#item-index">Explore the item index ↓</a><a href="#financial-summary">Customer financial summary ↓</a></nav>
      <div class="overview"><div><strong>${model.pending}</strong><span>Pending item lines</span></div><div><strong>${model.scope==='pending'?model.labeled:model.closed}</strong><span>${model.scope==='pending'?'Pending lines with a label':'Closed item lines'}</span></div><div class="is-overdue"><strong>${model.overdue}</strong><span>Overdue pending lines</span></div><div class="is-today"><strong>${model.today}</strong><span>Due today</span></div></div>
      <p class="scope-note">${model.scope==='pending'?'Only pending and partially fulfilled item lines appear below.':'All saved item lines appear below, with pending items first and closed items after.'} ${model.labeled} pending lines have a label attached; ${model.unlabeled} do not.${model.unknown?` ${model.unknown} lines have an unrecognized status and need review.`:''}</p>
      <section id="financial-summary"><div class="section-title"><span>01 / THE CUSTOMER</span><h2>Lifetime purchase summary</h2><p>All saved history for this buyer, in both report versions.</p></div><div class="customer-stats">${shared.stats(c).map(([label,value,note])=>`<div><small>${label}</small><strong>${html(value)}</strong><span>${html(note)}</span></div>`).join('')}</div>
      <div class="customer-history"><span><b>First purchase</b>${html(c.firstPurchase)}</span><span><b>Most recent purchase</b>${html(c.lastPurchase)}</span></div><p class="timing-note">${html(refunds.timingText(c.financial))}</p>
      ${c.financial.unverifiedOrders||c.financial.unmatched.length?`<p class="verification">Financial verification needed: ${c.financial.unverifiedOrders} orders with uncertain amounts; ${c.financial.unmatched.length} unmatched cases. Net spent may be unconfirmed.</p>`:''}</section>
      ${model.missingOrders.length?`<p class="verification">${model.missingOrders.length} saved orders have no item lines: ${model.missingOrders.map(o=>html(o.order_number)).join(', ')}. Their order totals are included in lifetime finances; item details are unavailable.</p>`:''}
      <section id="item-index"><div class="section-title"><span>02 / FIND A PURCHASE</span><h2>Your item index</h2><p>Select any item to open its details. Rose backgrounds identify confirmed item refunds; red deadline text identifies overdue pending items.</p></div>
      ${['pending','closed','unknown'].map(kind=>{const selected=model.rows.map((r,i)=>({r,i})).filter(({r})=>r.state.kind===kind);return selected.length?`<h3 class="item-index-heading">${{pending:'Pending items / earliest deadline first',closed:'Closed items / newest purchases first',unknown:'Status needs review'}[kind]} · ${selected.length}</h3><nav class="missing-item-index purchase-index" aria-label="${kind} items">${selected.map(({r,i})=>indexRow(r,i)).join('')}</nav>`:''}).join('')}
      ${!model.count?'<p class="empty-report">No pending item lines are saved for this buyer.</p>':''}</section>
      ${model.rows.map((r,i)=>`<article class="missing-item purchase ${r.pending?r.deadline.level:'closed'}${r.refund?.itemRefundConfirmed?' is-refunded':''}" id="purchase-${html(r.id)}"><div class="item-heading"><div><strong class="item-customer">${html(r.customerName||'Customer name not recorded')}</strong><span class="item-owner">eBay: ${html(model.username)}</span>ITEM ${i+1} / ORDER ${html(r.orderNumber)}</div><span class="pill ${r.pending?r.deadline.level:'normal'}">${html(r.state.label)}</span></div>
      ${r.pending?`<div class="deadline-banner"><strong>${html(urgency(r))}</strong><span>${html(r.deadline.since?`Overdue since ${r.deadline.since}`:`Ship by ${r.deadline.due}`)}</span></div>`:''}
      <div class="item-body"><div class="item-image">${r.image?`<img src="${r.image.crop}" alt="Saved item evidence for ${html(r.title)}"><small>${r.image.cropped?'Item view cropped from saved evidence':'Saved evidence; no item crop was recorded'} · verify against the title</small>`:`<div class="image-placeholder"><span>ITEM EVIDENCE</span><p>${html(r.imageStatus)}</p><a data-report-receipt="${html(r.id)}" href="${html(buyer.receiptAction(r).href)}" target="_blank" rel="noopener">${html(buyer.receiptAction(r).label)} ↗</a></div>`}</div><div class="item-details"><div class="eyebrow">ORIGINAL PURCHASE</div><h3>${html(r.title)}</h3><p class="item-price">${html(shared.money(r.price.total,r.price.currency))}<small>Qty ${r.price.quantity} · original item amount before refunds</small></p><dl><dt>Purchased</dt><dd>${html(r.date)}</dd><dt>System status</dt><dd>${html(r.state.label)}</dd><dt>Shipping label</dt><dd class="label-status ${r.shippingLabel.attached?'attached':'absent'}">${html(r.shippingLabel.label)}</dd><dt>eBay item</dt><dd>${html(r.item||'Not recorded')}</dd></dl></div></div>
      <div class="timeline-panel"><h3 class="item-index-heading">The item timeline</h3><ol class="item-timeline">${r.timeline.map(e=>`<li class="${e.tone}"><b>${html(e.label)}</b><span>${html(e.text)}</span></li>`).join('')}</ol></div>
      ${r.groups.length?`<div class="item-note"><b>Grouped order context</b>${r.groups.map(g=>`<p>${html(g)}</p>`).join('')}</div>`:''}
      ${r.notes.length?`<div class="item-note"><b>Item notes · newest first</b>${r.notes.map(n=>`<div class="item-note-entry"><strong>${html(n.author)}</strong><small>${html(n.date)} · Eastern time</small><p>${html(n.text)}</p></div>`).join('')}</div>`:''}${r.review?`<p class="verification">${html(r.review)}</p>`:''}
      <section class="refund-context"><strong>${html(r.refund?.label||'Refund status not recorded')}</strong>${refunds.detailLines(r.refund).map(s=>`<p>${html(s)}</p>`).join('')}${(r.refund?.requests||[]).map(q=>`<a href="${html(q.url)}" target="_blank" rel="noopener">Review case ${html(q.caseNumber)}</a>`).join('')}</section>
      <p class="fallback-note">Saved eBay status: ${html(r.ebayStatus)}</p><nav class="item-navigation"><a href="#item-index">↑ Item index</a><a href="#customer-summary">↑ Customer summary</a></nav>
      <div class="item-links"><a href="${html(r.orderUrl)}" target="_blank" rel="noopener">eBay order ↗</a><a href="${html(r.pending?r.pendingUrl:r.historyUrl)}" target="_blank" rel="noopener">${r.pending?'Pending order':'System record'} ↗</a><a data-report-receipt="${html(r.id)}" href="${html(buyer.receiptAction(r).href)}" target="_blank" rel="noopener">${html(buyer.receiptAction(r).label)} ↗</a></div>${!r.videoUrl?'<p class="fallback-note">No direct video URL is saved. The receipt link opens the eBay order to find its Live receipt.</p>':''}</article>`).join('')}
      <footer class="report-notes"><div class="eyebrow">HOW TO READ THIS REPORT</div><p>${NOTES}</p><p>${DEADLINE_NOTES}</p><p>A label is attached only when that order has a saved label file. A label does not establish shipment or delivery. Screenshots use the saved item crop when available; a duplicate full screenshot is omitted. Order, receipt and case links may require sign-in.</p></footer>`;
  }
  let busy=false,pdfUrl='';
  async function start(){
    if(busy)return;busy=true;const $=id=>document.getElementById(id),progress=s=>$('progress').textContent=s;
    $('retry').disabled=true;$('report-scope').disabled=true;$('download').hidden=true;$('error').hidden=true;$('sign-in').hidden=true;$('report').innerHTML='';
    if(pdfUrl){URL.revokeObjectURL(pdfUrl);pdfUrl='';}
    try{
      const params=new URLSearchParams(location.search),username=(params.get('buyer')||'').trim(),scope=$('report-scope').value;
      if(!username)throw Error('Choose a buyer from Pending Orders or Order History.');
      params.set('scope',scope);history.replaceState(null,'',`${location.pathname}?${params}`);
      document.title=`${username} / ${scopeName(scope)} | OG Jewelers`;
      $('history-link').href=`ebay-order-history.html?historySearch=${encodeURIComponent(username)}`;
      const client=root.supabase;if(!client?.auth)throw Error('The connection did not load. Refresh this page.');
      const {data,error}=await client.auth.getSession();if(error)throw error;
      if(!data.session){$('sign-in').hidden=false;throw Error('Sign in to generate the customer report.');}
      const records=await buyer.loadRecords(client,username,progress),model=makeModel(username,records,scope,location.href,new Date());
      await buyer.loadImages(client,model.rows,progress);$('report').innerHTML=render(model);buyer.bindReceiptLinks($('report'),model.rows);
      const bytes=await root.OGCustomerReportPdf.build(model,progress);pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      $('download').href=pdfUrl;$('download').download=`${username.replace(/[^a-z0-9_.-]/gi,'_')}-${scope==='pending'?'pending-items':'full-history'}.pdf`;$('download').hidden=false;
      progress(`${model.title} ready: ${model.orderCount} orders / ${model.count} item lines / ${model.pending} pending / ${model.overdue} overdue.`);
    }catch(error){progress('Report could not be completed.');$('error').textContent=error.message||'Please try again.';$('error').hidden=false;}
    finally{busy=false;$('retry').disabled=false;$('report-scope').disabled=false;}
  }
  const api={state,shippingLabel,timeline,makeModel,urgency,render,start,scopeName,NOTES,DEADLINE_NOTES};root.OGCustomerReport=api;if(typeof module!=='undefined')module.exports=api;
  if(typeof document!=='undefined'&&document.body?.dataset.page==='ebay-customer-report'){
    const boot=()=>{document.getElementById('report-scope').value=new URLSearchParams(location.search).get('scope')==='pending'?'pending':'all';document.getElementById('retry').addEventListener('click',start);document.getElementById('report-scope').addEventListener('change',start);start();};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
  }
})(typeof window!=='undefined'?window:globalThis);
