(() => {
 'use strict';
 const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}),money=n=>n==null?'Not confirmed':usd.format(n);
 const when=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric'});
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const paid=o=>['paid','partial','refunded'].includes(o.buyer),unpaid=o=>['unpaid','pending','failed'].includes(o.buyer);
 const funds={held:'On hold',available:'Available for payout',processing:'Processing',paid_out:'Paid out',initiated:'Payout started',mixed:'Mixed funds status',unknown:'Funds status unconfirmed'};
 const pay={paid:'Paid',refunded:'Paid · fully refunded',partial:'Paid · order partly refunded',unpaid:'Not paid',pending:'Payment pending',failed:'Payment failed',date_only:'Paid date only',unknown:'Payment not confirmed'};
 const filters={all:'All lines',paid:'Buyer paid (including refunds)',unpaid:'Not paid / pending / failed',unknown:'No buyer payment confirmation',sent:'Order linked to a sent payout',off:'Not on hold · no confirmed payout (all or part)',held:'Funds on hold',unclear:'Seller payout status unclear',refund:'Order refunded or partly refunded',cancel:'Canceled lines'};
 function payout(o){
  const receipts=o.payouts||[],sent=receipts.filter(r=>r.status==='SUCCEEDED');
  const sum=(key)=>sent.every(r=>r[key]!=null)?sent.reduce((n,r)=>n+Math.round(r[key]*100),0)/100:null;
  const credited=sum('sale'),isPaid=paid(o),off=isPaid&&['available','processing','initiated'].includes(o.fund)&&
   (credited==null||o.credit==null||!sent.length||Math.round(o.credit*100)>Math.round(credited*100));
  return {sent:sent.length>0,net:sum('net'),off,remaining:!off||o.credit==null||credited==null?null:Math.max(0,Math.round((o.credit-credited)*100)/100),
   unclear:isPaid&&!off&&!sent.length&&o.fund!=='held'};
 }
 function withPayout(o){
  const sent=(o.payouts||[]).filter(r=>r.status==='SUCCEEDED'&&r.sale!=null),sale=sent.reduce((n,r)=>n+Math.round(r.sale*100),0);
  if(sale<=0||o.credit==null)return o;
  const remaining=Math.max(0,Math.round(o.credit*100)-sale);
  if(remaining===0)return {...o,fund:'paid_out',held:null};
  return o.fund==='held'&&o.held!=null?{...o,held:Math.min(o.held,remaining/100)}:o;
 }
 function stats(orders){
  const held=orders.filter(o=>o.fund==='held'),checked=held.filter(o=>o.held!=null),refundHeld=checked.filter(o=>['partial','refunded'].includes(o.buyer));
  return {paid:orders.reduce((n,o)=>n+(paid(o)?o.items.length:0),0),unpaid:orders.reduce((n,o)=>n+(unpaid(o)?o.items.length:0),0),
   unknown:orders.reduce((n,o)=>n+(!unpaid(o)&&!paid(o)?o.items.length:0),0),
   held:checked.reduce((s,o)=>s+Number(o.held),0),missing:held.length-checked.length,heldN:held.length,refundHeld:refundHeld.reduce((s,o)=>s+Number(o.held),0),refundN:refundHeld.length,
   unknownFunds:orders.filter(o=>['unknown','mixed'].includes(o.fund)).length};
 }
 const matches=(o,i,f)=>f==='all'||(f==='paid'?paid(o):f==='unpaid'?unpaid(o):f==='unknown'?!paid(o)&&!unpaid(o):f==='held'?o.fund==='held':f==='sent'?payout(o).sent:f==='off'?payout(o).off:f==='unclear'?payout(o).unclear:f==='refund'?['partial','refunded'].includes(o.buyer):i.cancel);
 function update(host,data){
  if(!Array.isArray(data?.ebay_item_orders)){host.hidden=true;host.replaceChildren();delete host.itemState;return;}
  const fresh=!host.itemState||host.itemState.month!==data.month;
  if(fresh){
   host.innerHTML='<h3>eBay payments by purchase week</h3><p>Every saved eBay order line for the selected month. Select a week, or a payout figure to see just the orders behind it.</p><div class="wi-summary"></div><details class="wi-transfers"><summary>Account transfers sent by eBay · by transfer date</summary><div></div></details>'+
    '<details class="wi-browser"><summary>Browse order lines and payments</summary><div class="ws-controls"><label>Purchase week <select class="wi-week"></select></label>'+
    '<label>Show <select class="wi-filter">'+Object.entries(filters).map(([k,t])=>'<option value="'+k+'">'+t+'</option>').join('')+'</select></label>'+
    '<label>Find <input class="wi-find" type="search" placeholder="Order, item title, or username"></label></div>'+
    '<p class="wi-key">Item sales kept excludes cancellations and merchandise refunds, before fees. The original sale credit includes buyer shipping and is after sale fees, before later refunds, postage, or adjustments. It is not a bank deposit. Final proceeds are shown once per order.</p>'+
    '<div class="wi-count" role="status"></div><div class="wi-orders"></div><div class="ws-controls wi-pages"><button type="button" data-step="-1">Previous</button><span></span><button type="button" data-step="1">Next</button></div></details>';
   host.itemState={month:data.month,page:0};
   host.onchange=e=>{if(e.target.matches('select')){host.itemState.page=0;list(host);}};
   host.oninput=e=>{if(e.target.matches('.wi-find')){host.itemState.page=0;list(host);}};
   host.onclick=e=>{const week=e.target.closest('[data-item-week]'),step=e.target.closest('[data-step]');
    if(week){host.querySelector('.wi-week').value=week.dataset.itemWeek;host.querySelector('.wi-filter').value=week.dataset.bucket||'all';host.querySelector('.wi-find').value='';host.querySelector('.wi-browser').open=true;host.itemState.page=0;list(host);host.querySelector('.wi-browser').scrollIntoView({block:'start'});}
    if(step){host.itemState.page+=Number(step.dataset.step);list(host);}};
  }
  host.hidden=false;
  const s=host.itemState;s.orders=data.ebay_item_orders.map(withPayout);
  const rows=data.rows.filter(r=>r.market==='ebay'),weeks=rows.map(r=>r.week);
  const wk=host.querySelector('.wi-week'),before=wk.value;
  const label=r=>day(r.first_day)+' – '+day(new Date(Date.parse(r.end_day+'T12:00Z')-86400000).toISOString().slice(0,10));
  wk.innerHTML='<option value="">Whole month</option>'+[...rows].reverse().map(r=>'<option value="'+r.week+'">'+label(r)+'</option>').join('');
  wk.value=weeks.includes(before)?before:'';
  const summaryRow=(name,w,orders,cn,rf,total=false)=>{
   const st=stats(orders),cell=(k,v)=>'<td data-col="'+k+'">'+v+'</td>';
   const amountCell=(bucket,value)=>'<button type="button" data-item-week="'+w+'" data-bucket="'+bucket+'" aria-label="'+esc(name+' · '+filters[bucket]+': '+value)+'">'+value+'</button>';
   const groups=(key)=>orders.filter(o=>payout(o)[key]),sent=groups('sent'),off=groups('off'),unclear=groups('unclear');
   const subtotal=(a,key)=>a.reduce((n,o)=>n+Math.round((payout(o)[key]??0)*100),0)/100;
   const info=a=>a.length+' orders · '+a.reduce((n,o)=>n+o.items.length,0)+' lines';
   const missing=(a,key)=>a.filter(o=>payout(o)[key]==null).length;
   const scopedAmount=(a,key)=>a.length&&missing(a,key)===a.length?'Amount unknown':money(subtotal(a,key));
   const reversed=off.filter(o=>o.cancel||['partial','refunded'].includes(o.buyer));
   return '<tr'+(total?' class="wi-total"':'')+'><th scope="row"><button type="button" data-item-week="'+w+'">'+name+'</button><small>'+orders.length+' orders</small></th>'+
    cell('Buyer payments',st.paid+' paid lines<small>'+st.unpaid+' not paid · '+st.unknown+' unconfirmed</small>')+cell('Canceled / refunded',money(cn)+' canceled<small>'+money(rf)+' refunded</small><small>Combined '+money(cn+rf)+'</small>')+
    cell('Paid out · order matched',amountCell('sent',sent.length?scopedAmount(sent,'net'):'No match')+'<small>'+info(sent)+(missing(sent,'net')?' · incomplete amounts':'')+'</small>')+
    cell('Not on hold · payout unconfirmed',amountCell('off',scopedAmount(off,'remaining'))+'<small>'+info(off)+(missing(off,'remaining')?' · '+missing(off,'remaining')+' missing amounts':'')+'</small>'+
    (reversed.length?'<small>Includes '+reversed.length+' canceled / refunded orders</small>':'')+
    (unclear.length?amountCell('unclear',unclear.length+' other orders · status unclear'):'') )+
    cell('Credits on hold',amountCell('held',st.heldN&&st.missing===st.heldN?'Amount unknown':money(st.held))+'<small>'+st.heldN+' orders'+(st.missing?' · '+st.missing+' missing amounts':'')+'</small>'+
    (st.refundN?'<small>Includes '+money(st.refundHeld)+' on '+st.refundN+' later-refunded '+(st.refundN===1?'order':'orders')+'</small>':'')+
    (st.unknownFunds?'<small>'+st.unknownFunds+' funds statuses unclear</small>':''))+'</tr>';
  };
  host.querySelector('.wi-summary').innerHTML='<table><thead><tr><th>Purchase week · Eastern</th><th>Buyer payments</th><th>Canceled / refunded</th><th>Paid out to us<small>Matched to orders</small></th><th>Not on hold<small>Payout not confirmed</small></th><th>Sale credits on hold</th></tr></thead><tbody>'+
   [...rows].reverse().map(r=>summaryRow(label(r),r.week,s.orders.filter(o=>o.week===r.week),r.cancelled,r.refunded)).join('')+
   summaryRow('Month total','',s.orders,rows.reduce((n,r)=>n+r.cancelled,0),rows.reduce((n,r)=>n+r.refunded,0),true)+'</tbody></table>'+
   '<p><b>Paid out to us</b> counts only transactions eBay links to a successful transfer, net of linked debits. <b>No match</b> means eBay has not identified which orders funded a transfer. <b>Not on hold</b> shows original off-hold sale credits without a confirmed payout match, before later refunds and costs. This is not an amount owed. Held credits are shown separately.</p>';
  const batches=data.ebay_account_payouts||[];
  host.querySelector('.wi-transfers>summary').textContent=batches.length?'Seller-account transfers by date · '+money(batches.reduce((n,b)=>n+Math.round(b.amount*100),0)/100)+' sent · '+batches.length+' transfers':'Seller-account transfers by date';
  const coverage=data.ebay_payout_coverage;
  if(coverage&&(coverage.error||coverage.retry||coverage.done<batches.length))host.querySelector('.wi-summary').insertAdjacentHTML('beforeend','<p><b>Payout matching is incomplete.</b> '+(coverage.error?.includes('rate limited')?'eBay is limiting payout requests; Invsto will retry automatically. ':'')+Number(coverage.done||0)+' of '+batches.length+' transfers dated in this month have a completed transaction check. An unmatched sale is not proof you were never paid.</p>');
  host.querySelector('.wi-transfers>div').innerHTML='<p><b>'+money(batches.reduce((n,b)=>n+Math.round(b.amount*100),0)/100)+' across '+batches.length+' recorded USD transfers.</b> These are actual seller-account transfers by eBay’s reporting date, after express payout fees. They can include sales from other weeks or months. Do not add this total to the weekly figures. <a href="https://www.ebay.com/mes/payouts" target="_blank" rel="noopener">Check payouts in Seller Hub ↗</a></p>'+
   (batches.length?'<ul>'+batches.map(b=>'<li>'+day(b.day)+' · Payout '+esc(b.id)+' · <strong>'+money(b.amount)+'</strong></li>').join('')+'</ul>':'<p>No confirmed account transfers recorded for this month.</p>');
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
    '<footer>'+val('Order sale credit',money(o.credit))+val('Matched payout · order',payout(o).sent?money(payout(o).net):'No confirmed match')+
    (payout(o).off?val('Not on hold · no payout match',money(payout(o).remaining)):'')+val('Final proceeds · order',o.final==null?'Not verified yet':money(o.final))+
    (o.fund==='held'?val('Sale credit on hold',money(o.held)):'')+
    (o.checked?'<small>'+esc(o.source)+' · '+esc(when.format(new Date(o.checked)))+'</small>':'')+'</footer>'+
    (o.payouts?.length?'<small>'+o.payouts.map(r=>'Payout '+esc(r.id)+' · '+(r.date?day(r.date)+' · ':'')+esc(r.status||'Status unconfirmed')+(r.status==='SUCCEEDED'?' · '+money(r.net):'')).join('<br>')+'</small>':'')+'</article>';
  }).join('')||'<p>No order lines match these filters.</p>';
  $('.wi-pages span').textContent='Page '+(s.page+1)+' of '+pages;
  $('.wi-pages [data-step="-1"]').disabled=s.page===0;$('.wi-pages [data-step="1"]').disabled=s.page+1>=pages;
 }
 window.WeeklyEbayItems={update};
})();
