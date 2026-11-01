(() => {
 'use strict';
 const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}),money=n=>n==null?'Not confirmed':usd.format(n);
 const when=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric'});
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const paid=o=>['paid','partial','refunded'].includes(o.buyer),unpaid=o=>['unpaid','pending','failed'].includes(o.buyer);
 const funds={held:'On hold',available:'Available for payout',processing:'Processing',paid_out:'Paid out',initiated:'Payout started',mixed:'Mixed funds status',unknown:'Funds status unconfirmed'};
 const pay={paid:'Paid',refunded:'Paid · fully refunded',partial:'Paid · order partly refunded',unpaid:'Not paid',pending:'Payment pending',failed:'Payment failed',date_only:'Paid date only',unknown:'Payment not confirmed'};
 const filters={all:'All lines',paid:'Buyer paid (including refunds)',unpaid:'Not paid / pending / failed',unknown:'No payment confirmation',held:'Funds on hold',refund:'Order refunded or partly refunded',cancel:'Canceled lines'};
 function stats(orders){
  const held=orders.filter(o=>o.fund==='held'),checked=held.filter(o=>o.held!=null),refundHeld=checked.filter(o=>['partial','refunded'].includes(o.buyer));
  return {paid:orders.reduce((n,o)=>n+(paid(o)?o.items.length:0),0),unpaid:orders.reduce((n,o)=>n+(unpaid(o)?o.items.length:0),0),
   unknown:orders.reduce((n,o)=>n+(!unpaid(o)&&!paid(o)?o.items.length:0),0),
   held:checked.reduce((s,o)=>s+Number(o.held),0),missing:held.length-checked.length,heldN:held.length,refundHeld:refundHeld.reduce((s,o)=>s+Number(o.held),0),refundN:refundHeld.length,
   unknownFunds:orders.filter(o=>['unknown','mixed'].includes(o.fund)).length};
 }
 const matches=(o,i,f)=>f==='all'||(f==='paid'?paid(o):f==='unpaid'?unpaid(o):f==='unknown'?!paid(o)&&!unpaid(o):f==='held'?o.fund==='held':f==='refund'?['partial','refunded'].includes(o.buyer):i.cancel);
 function update(host,data){
  if(!Array.isArray(data?.ebay_item_orders)){host.hidden=true;host.replaceChildren();delete host.itemState;return;}
  const fresh=!host.itemState||host.itemState.month!==data.month;
  if(fresh){
   host.innerHTML='<h3>eBay payments by purchase week</h3><p>Every saved eBay order line for the selected month, including unpaid orders. Select a week to inspect its items.</p><div class="wi-summary"></div>'+
    '<details class="wi-browser"><summary>Browse order lines and payments</summary><div class="ws-controls"><label>Purchase week <select class="wi-week"></select></label>'+
    '<label>Show <select class="wi-filter">'+Object.entries(filters).map(([k,t])=>'<option value="'+k+'">'+t+'</option>').join('')+'</select></label>'+
    '<label>Find <input class="wi-find" type="search" placeholder="Order, item title, or username"></label></div>'+
    '<p class="wi-key">Item sales kept excludes cancellations and merchandise refunds, before fees. The original sale credit includes buyer shipping and is after sale fees, before later refunds, postage, or adjustments. It is not a bank deposit. Final proceeds are shown once per order.</p>'+
    '<div class="wi-count" role="status"></div><div class="wi-orders"></div><div class="ws-controls wi-pages"><button type="button" data-step="-1">Previous</button><span></span><button type="button" data-step="1">Next</button></div></details>';
   host.itemState={month:data.month,page:0};
   host.onchange=e=>{if(e.target.matches('select')){host.itemState.page=0;list(host);}};
   host.oninput=e=>{if(e.target.matches('.wi-find')){host.itemState.page=0;list(host);}};
   host.onclick=e=>{const week=e.target.closest('[data-item-week]'),step=e.target.closest('[data-step]');
    if(week){host.querySelector('.wi-week').value=week.dataset.itemWeek;host.querySelector('.wi-browser').open=true;host.itemState.page=0;list(host);host.querySelector('.wi-browser').scrollIntoView({block:'start'});}
    if(step){host.itemState.page+=Number(step.dataset.step);list(host);}};
  }
  host.hidden=false;
  const s=host.itemState;s.orders=data.ebay_item_orders;
  const rows=data.rows.filter(r=>r.market==='ebay'),weeks=rows.map(r=>r.week);
  const wk=host.querySelector('.wi-week'),before=wk.value;
  const label=r=>day(r.first_day)+' – '+day(new Date(Date.parse(r.end_day+'T12:00Z')-86400000).toISOString().slice(0,10));
  wk.innerHTML='<option value="">Whole month</option>'+[...rows].reverse().map(r=>'<option value="'+r.week+'">'+label(r)+'</option>').join('');
  wk.value=weeks.includes(before)?before:'';
  const summaryRow=(name,w,orders,cn,rf,total=false)=>{
   const st=stats(orders),cell=(k,v)=>'<td data-col="'+k+'">'+v+'</td>';
   return '<tr'+(total?' class="wi-total"':'')+'><th scope="row"><button type="button" data-item-week="'+w+'">'+name+'</button><small>'+orders.length+' orders</small></th>'+
    cell('Buyer paid',st.paid+' lines')+cell('Not paid / unconfirmed',st.unpaid+' / '+st.unknown)+cell('Canceled',money(cn))+cell('Refunded',money(rf)+'<small>Combined deductions '+money(cn+rf)+'</small>')+
    cell('Credits on hold','<strong>'+money(st.held)+'</strong><small>'+st.heldN+' orders'+(st.missing?' · '+st.missing+' missing amounts':'')+'</small>'+
    (st.refundN?'<small>Includes '+money(st.refundHeld)+' on '+st.refundN+' later-refunded '+(st.refundN===1?'order':'orders')+'</small>':'')+
    (st.unknownFunds?'<small>'+st.unknownFunds+' funds statuses unclear</small>':''))+'</tr>';
  };
  host.querySelector('.wi-summary').innerHTML='<table><thead><tr><th>Purchase week · Eastern</th><th>Buyer paid</th><th>Not paid / unconfirmed<small>Order lines</small></th><th>Canceled items</th><th>Refunded items</th><th>Sale credits on hold</th></tr></thead><tbody>'+
   [...rows].reverse().map(r=>summaryRow(label(r),r.week,s.orders.filter(o=>o.week===r.week),r.cancelled,r.refunded)).join('')+
   summaryRow('Month total','',s.orders,rows.reduce((n,r)=>n+r.cancelled,0),rows.reduce((n,r)=>n+r.refunded,0),true)+'</tbody></table>'+
   '<p>Held dollars are the original sale credits eBay last marked on hold for these orders. Later refunds are flagged separately. This is not your account-wide hold balance. Cancellations and refunds reduce the original purchase week once.</p>';
  list(host);
 }
 function list(host){
  const $=q=>host.querySelector(q),s=host.itemState,w=$('.wi-week').value,f=$('.wi-filter').value,q=$('.wi-find').value.trim().toLowerCase();
  const orders=s.orders.filter(o=>!w||o.week===w).map(o=>{
   const orderMatch=[o.id,o.user].some(v=>String(v||'').toLowerCase().includes(q));
   return {o,lines:o.items.filter(i=>matches(o,i,f)&&(orderMatch||[i.title,i.item,i.line].some(v=>String(v||'').toLowerCase().includes(q))))};
  }).filter(g=>g.lines.length);
  const pages=Math.max(1,Math.ceil(orders.length/15));s.page=Math.max(0,Math.min(s.page,pages-1));
  $('.wi-count').textContent=orders.reduce((n,g)=>n+g.lines.length,0)+' matching order lines · '+orders.length+' orders';
  const val=(label,v)=>'<span><small>'+label+'</small><b>'+esc(v)+'</b></span>';
  $('.wi-orders').innerHTML=orders.slice(s.page*15,s.page*15+15).map(({o,lines})=>{
   const id=esc(o.id),link=/^\d{2}-\d{5}-\d{5}$/.test(o.id)?'<a target="_blank" rel="noopener" href="https://www.ebay.com/mesh/ord/details?orderid='+id+'">'+id+' ↗</a>':id;
   return '<article class="wi-order"><header><div><b>'+link+'</b><small>'+esc(o.user||'Buyer name unavailable')+' · '+esc(when.format(new Date(o.date)))+' · '+o.items.length+' order '+(o.items.length===1?'line':'lines')+'</small></div>'+
    '<div class="wi-badges"><span>'+esc(pay[o.buyer]||pay.unknown)+'</span><span class="'+(o.fund==='held'?'wi-held':'')+'">'+esc(funds[o.fund]||funds.unknown)+'</span></div></header>'+
    lines.map(i=>'<div class="wi-line"><div><strong>'+esc(i.title||'Item title not saved')+'</strong><small>Qty '+esc(i.qty)+(i.item?' · Item '+esc(i.item):'')+(i.cancel?' · Canceled':'')+'</small></div>'+
     val('Sold for · line',money(i.sold))+val('Item sales kept',i.kept==null?(o.buyer==='partial'?'Refund not split':'Under review'):money(i.kept))+
     val('Original sale credit',i.credit==null&&o.items.length>1&&o.credit!=null?'Order total only':money(i.credit))+'</div>').join('')+
    '<footer>'+val('Order sale credit',money(o.credit))+val('Final proceeds · order',o.final==null?'Not verified yet':money(o.final))+
    (o.fund==='held'?val('Sale credit on hold',money(o.held)):'')+
    (o.checked?'<small>'+esc(o.source)+' · '+esc(when.format(new Date(o.checked)))+'</small>':'')+'</footer></article>';
  }).join('')||'<p>No order lines match these filters.</p>';
  $('.wi-pages span').textContent='Page '+(s.page+1)+' of '+pages;
  $('.wi-pages [data-step="-1"]').disabled=s.page===0;$('.wi-pages [data-step="1"]').disabled=s.page+1>=pages;
 }
 window.WeeklyEbayItems={update};
})();
