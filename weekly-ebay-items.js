(() => {
 'use strict';
 const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}),money=n=>n==null?'Not confirmed':usd.format(n);
 const when=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'});
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const paid=o=>['paid','partial','refunded'].includes(o.buyer),unpaid=o=>['unpaid','pending','failed'].includes(o.buyer);
 const funds={held:'On hold',available:'Available for payout',processing:'Processing',paid_out:'Paid out',initiated:'Payout started',mixed:'Mixed funds status',unknown:'Funds status unconfirmed'};
 const pay={paid:'Paid',refunded:'Paid · fully refunded',partial:'Paid · order partly refunded',unpaid:'Not paid',pending:'Payment pending',failed:'Payment failed',date_only:'Paid date only',unknown:'Payment not confirmed'};
 const balanceLabels={released:'Released to eBay balance',held:'On hold',processing:'Still processing',unpaid:'Buyer payment outstanding',mixed:'Mixed funds status',unknown:'Release unconfirmed'};
 const filters={all:'All lines',released:'Released to eBay balance',held:'Funds on hold',processing:'Still processing',outstanding:'Awaiting buyer payment',review:'Mixed or unconfirmed release',paid:'Buyer paid (including refunds)',unpaid:'Not paid / pending / failed',unknown:'No buyer payment confirmation',sent:'Order linked to a sent payout',off:'Not on hold · no confirmed payout (all or part)',unclear:'Seller payout status unclear',refund:'Order refunded or partly refunded',cancel:'Canceled lines'};
 // Use positive release evidence. Processing and a missing hold flag do not establish availability.
 function balanceState(o){
  if(['available','initiated','paid_out'].includes(o.fund))return 'released';
  const partialHold=o.fund==='held'&&o.held!=null&&o.credit!=null&&Math.round(o.held*100)<Math.round(o.credit*100);
  if(partialHold||o.fund==='mixed'||(o.payouts||[]).some(r=>r.status==='SUCCEEDED'&&r.sale>0))return 'mixed';
  if(o.fund==='held'||o.fund==='processing')return o.fund;
  return unpaid(o)?'unpaid':'unknown';
 }
 function matchesBalance(o,filter){
  const state=balanceState(o);
  if(filter==='review')return ['mixed','unknown'].includes(state);
  return state===(filter==='outstanding'?'unpaid':filter);
 }
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
  return {paid:orders.reduce((n,o)=>n+(paid(o)?o.items.length:0),0),unpaid:orders.reduce((n,o)=>n+(unpaid(o)?o.items.length:0),0),
   unknown:orders.reduce((n,o)=>n+(!unpaid(o)&&!paid(o)?o.items.length:0),0)};
 }
 const cents=n=>n==null||!Number.isFinite(Number(n))?null:Math.round(Number(n)*100);
 const dollars=n=>money(n==null?null:n/100);
 const signed=n=>(n>0?'+':n<0?'−':'')+dollars(Math.abs(n));
 function reconciliation(sales,orders){
  const net=cents(sales.net),canceled=cents(sales.cancelled),refunded=cents(sales.refunded),review=cents(sales.held);
  let released=0,held=0,other=0,shipping=0,fees=0,ancillary=0,merchDiff=0,missingReleased=0,missingOther=0,missingParts=0;
  for(const o of orders){
   const state=balanceState(o),credit=cents(o.credit),p=o.parts;
   if(state==='released'){if(credit==null)missingReleased++;else released+=credit;}
   else if(state==='held'){const onHold=cents(o.held);if(onHold==null)missingOther++;else held+=onHold;}
   else if(credit!=null)other+=credit;
   else if(state!=='unpaid')missingOther++;
   if(credit==null)continue;
   const v=p&&['item','shipping','fees','other'].map(k=>cents(p[k]));
   if(!v||v.some(n=>n==null)||v.reduce((x,y)=>x+y,0)!==credit||cents(p.credit)!==credit){missingParts++;continue;}
   shipping+=v[1];fees+=v[2];ancillary+=v[3];
   if(Object.hasOwn(o,'booked'))merchDiff+=v[0]-(cents(o.booked)??0);
  }
  const completeAmounts=[net,canceled,refunded,review,cents(sales.booked)].every(x=>x!=null);
  const gap=net!=null&&!missingReleased?released-net:null;
  const steps=[
   ['Canceled item sales',canceled],['Refunded item sales',refunded],['Item sales pending verification',review],
   ['Difference in original item subtotals',merchDiff],['Shipping paid by buyers',shipping],
   ['Fees on original sales',fees],['Other recorded sale charges or credits',ancillary],
   ['Original credits still on hold',-held],['Credits with other funds statuses',-other]
  ];
  const rest=completeAmounts&&gap!=null?gap-steps.reduce((a,s)=>a+s[1],0):null;
  const reasons=[
   [(canceled??0)+(refunded??0),'Net sales deduct '+dollars((canceled??0)+(refunded??0))+' in cancellations and refunds. Original credits do not.'],
   [review,'Includes item sales still under review.'],[shipping,'Buyer-paid shipping adds to sale credits.'],
   [fees,'Sale fees reduce original credits by '+dollars(Math.abs(fees))+'.'],[-held,dollars(held)+' in original credits is still on hold.'],
   [-other,'Some credits have another funds status.'],[ancillary,'Other recorded sale charges or credits.'],
   [merchDiff,'The recorded original item subtotals differ.']
  ];
  const main=gap==null?'Released amount is not fully verified.':rest||missingParts||missingOther||!completeAmounts?'Some credit details still need verification.':
   !gap?'Net sales and released credits match.':(reasons.filter(s=>Math.sign(s[0])===Math.sign(gap)).sort((a,b)=>Math.abs(b[0])-Math.abs(a[0]))[0]?.[1]??'See the calculation below.');
  return {gap,net,released,steps,rest,missingReleased,missingOther,missingParts,completeAmounts,main};
 }
 function reconciliationDetail(name,id,b){
  const line=(title,value,style='')=>'<div class="wi-eq-line '+style+'"><dt>'+title+'</dt><dd>'+value+'</dd></div>';
  const partial=b.missingReleased||b.missingOther||b.missingParts||!b.completeAmounts;
  return '<section id="'+id+'" class="wi-equation" aria-label="'+esc(name)+' reconciliation"><div><span class="wi-eyebrow">FOLLOW THE MONEY · '+esc(name)+'</span><h4>From net item sales to released credits</h4><p>Net sales already deduct reversals. To compare with eBay’s <b>original sale credits</b>, add back those deductions, include shipping and sale fees, then remove credits that were not released.</p><p>Released credits are before later refund debits and postage. They are not final earnings or bank transfers.</p></div><dl>'+
   line('Start · Verified net item sales',dollars(b.net),'wi-eq-end')+
   b.steps.filter(s=>s[1]!==0).map(([label,n])=>line(label,n==null?'Not confirmed':signed(n))).join('')+
   (b.rest?line('Difference not yet explained',signed(b.rest),'wi-eq-review'):'')+
   line(b.missingReleased?'Known released credits only':'End · Original credits released to eBay balance',dollars(b.released),'wi-eq-end')+
   '</dl>'+(partial?'<p class="wi-eq-warning">Partial explanation. '+[b.missingReleased&&b.missingReleased+' orders missing released amounts',b.missingOther&&b.missingOther+' orders missing held or other credit amounts',b.missingParts&&b.missingParts+' orders without itemized sale-credit details',!b.completeAmounts&&'incomplete sales totals'].filter(Boolean).join('; ')+'.</p>':'')+'</section>';
 }
 const matches=(o,i,f)=>f==='all'||(f==='paid'?paid(o):f==='unpaid'?unpaid(o):f==='unknown'?!paid(o)&&!unpaid(o):['released','held','processing','outstanding','review'].includes(f)?matchesBalance(o,f):f==='sent'?payout(o).sent:f==='off'?payout(o).off:f==='unclear'?payout(o).unclear:f==='refund'?['partial','refunded'].includes(o.buyer):i.cancel);
 function update(host,data,client,reload){
  if(!Array.isArray(data?.ebay_item_orders)){host.hidden=true;host.replaceChildren();delete host.itemState;return;}
  const fresh=!host.itemState||host.itemState.month!==data.month;
  if(fresh){
   host.innerHTML='<header class="wi-intro"><span class="wi-eyebrow">EBAY · WEEKLY SALES</span><h3>eBay balance by purchase week</h3><p>Read left to right: what sold, what remained after reversals, then why eBay released more or less. Select the difference for the calculation or a sales or funds amount for its orders.</p></header><div class="wi-summary wi-balance"></div>'+
    '<details class="wi-transfers wi-matches"><summary>Bank transfers matched to specific orders</summary><div class="wi-summary"></div></details>'+
    '<details class="wi-transfers wi-bank"><summary>Account transfers sent by eBay · by transfer date</summary><div></div></details>'+
    '<details class="wi-browser"><summary>Browse order lines and payments</summary><div class="ws-controls"><label>Purchase week <select class="wi-week"></select></label>'+
    '<label>Payment filter <select class="wi-filter">'+Object.entries(filters).map(([k,t])=>'<option value="'+k+'">'+t+'</option>').join('')+'</select></label>'+
    '<label>Hold reason <select class="wi-hold-reason"><option value="all">All orders</option></select></label>'+
    '<label>Estimated release date <select class="wi-release-date"><option value="all">All estimated dates</option></select></label>'+
    '<label>Find <input class="wi-find" type="search" placeholder="Order, item title, or username"></label></div>'+
    '<p class="wi-key">Each line shows the latest funds status of its order. Item sales kept reflects cancellations and merchandise refunds before fees. Original sale credits include buyer shipping and sale fees. When eBay provides only one credit for several lines, the amount appears once in the order footer.</p>'+
    '<div class="wi-production-filter" hidden></div><div class="wi-count" role="status"></div><div class="wi-orders"></div><div class="ws-controls wi-pages"><button type="button" data-step="-1">Previous</button><span></span><button type="button" data-step="1">Next</button></div></details>';
   host.itemState={month:data.month,page:0,productionOpen:new Set(),productionViews:{}};
   host.onchange=e=>{if(e.target.matches('select')){if(e.target.matches('.wi-hold-reason'))host.querySelector('.wi-release-date').value='all';if(e.target.matches('.wi-week'))host.itemState.productionFilter=null;host.itemState.page=0;list(host);}};
   host.oninput=e=>{if(e.target.matches('.wi-find')){host.itemState.page=0;list(host);}};
   host.onclick=e=>{const week=e.target.closest('[data-item-week]'),step=e.target.closest('[data-step]'),bridge=e.target.closest('[data-bridge]');
    const production=e.target.closest('[data-production-toggle]'),view=e.target.closest('[data-production-view]'),orders=e.target.closest('[data-production-orders]'),assign=e.target.closest('[data-production-assign]');
    const report=e.target.closest('[data-production-report]'),hours=e.target.closest('[data-production-hours]');
    if(report||hours){window.WeeklyProductionReport.open(host.itemState.production,(report||hours).getAttribute(report?'data-production-report':'data-production-hours'),host.itemState.client,Boolean(hours));return;}
    if(production){const w=production.dataset.productionToggle,open=production.getAttribute('aria-expanded')!=='true';production.setAttribute('aria-expanded',String(open));host.querySelector('#'+production.getAttribute('aria-controls')).hidden=!open;if(open)host.itemState.productionOpen.add(w);else host.itemState.productionOpen.delete(w);return;}
    if(view){const w=view.dataset.productionWeek;host.itemState.productionViews[w]=view.dataset.productionView;host.querySelector('#wi-production-'+(w||'month')+' td').innerHTML=window.WeeklyEbayProduction.render(host.itemState.production,w,view.dataset.productionView);return;}
    if(assign){window.WeeklyEbayProduction.assignment(host,assign.dataset.productionAssign,host.itemState.client,host.itemState.reload);return;}
    if(e.target.closest('[data-production-clear]')){host.itemState.productionFilter=null;list(host);return;}
    if(orders){host.itemState.productionFilter={week:orders.dataset.productionWeek,kind:orders.dataset.productionOrders,key:orders.dataset.productionKey,day:orders.dataset.productionDay,seller:orders.dataset.productionSeller};host.querySelector('.wi-week').value=orders.dataset.productionWeek;host.querySelector('.wi-filter').value='all';host.querySelector('.wi-hold-reason').value='all';host.querySelector('.wi-release-date').value='all';host.querySelector('.wi-find').value='';host.querySelector('.wi-browser').open=true;host.itemState.page=0;list(host);host.querySelector('.wi-browser').scrollIntoView({block:'start'});return;}
    if(bridge){const panel=host.querySelector('.wi-balance');host.itemState.bridge=bridge.getAttribute('aria-expanded')==='true'?null:bridge.dataset.bridge;
     for(const b of panel.querySelectorAll('[data-bridge]')){const show=b.dataset.bridge===host.itemState.bridge;b.setAttribute('aria-expanded',String(show));host.querySelector('#'+b.getAttribute('aria-controls')).hidden=!show;}return;}
    if(week){host.itemState.productionFilter=null;host.querySelector('.wi-week').value=week.dataset.itemWeek;host.querySelector('.wi-filter').value=week.dataset.bucket||'all';host.querySelector('.wi-hold-reason').value='all';host.querySelector('.wi-release-date').value='all';host.querySelector('.wi-find').value='';host.querySelector('.wi-browser').open=true;host.itemState.page=0;list(host);host.querySelector('.wi-browser').scrollIntoView({block:'start'});}
    if(step){host.itemState.page+=Number(step.dataset.step);list(host);}};
  }
  host.hidden=false;
  const s=host.itemState;s.client=client;s.reload=reload;s.production=data.ebay_production;s.orders=data.ebay_item_orders.map(withPayout).map(o=>({...o,holdInfo:window.OGEbayHoldDetails?.model(o.id,o.hold_detail||{},o.fund==='held'?true:o.fund==='mixed'?undefined:false)}));
  const rows=data.rows.filter(r=>r.market==='ebay'),weeks=rows.map(r=>r.week);
  if(s.production){const days=[];for(const r of rows){for(let d=r.first_day;d<r.end_day&&(!data.cutoff||d<=data.cutoff.slice(0,10));){days.push({week:r.week,day:d});d=new Date(Date.parse(d+'T12:00:00Z')+86400000).toISOString().slice(0,10);}}s.production={...s.production,days,timing:data.ebay_show_timing||[],as_of:data.as_of};}
  const wk=host.querySelector('.wi-week'),before=wk.value;
  const label=r=>day(r.first_day)+' – '+day(new Date(Date.parse(r.end_day+'T12:00Z')-86400000).toISOString().slice(0,10));
  wk.innerHTML='<option value="">Whole month</option>'+[...rows].reverse().map(r=>'<option value="'+r.week+'">'+label(r)+'</option>').join('');
  wk.value=weeks.includes(before)?before:'';
  const lineCount=orders=>orders.reduce((n,o)=>n+o.items.length,0);
  const info=a=>a.length+' '+(a.length===1?'order':'orders')+' · '+lineCount(a)+' '+(lineCount(a)===1?'line':'lines');
  const cell=(k,v)=>'<td data-col="'+k+'">'+v+'</td>';
  const drill=(name,w,bucket,value)=>'<button type="button" data-item-week="'+w+'" data-bucket="'+bucket+'" aria-label="'+esc(name+' · '+filters[bucket]+': '+value)+'">'+value+'</button>';
  const weekCell=(name,w,orders)=>'<th scope="row"><button type="button" data-item-week="'+w+'">'+name+'</button><small>'+info(orders)+'</small></th>';
  function balanceRow(name,w,orders,sales,total){
   const productionId='wi-production-'+(w||'month'),productionOpen=s.productionOpen.has(w);
   const productionButton=window.WeeklyEbayProduction?'<button type="button" class="wp-expand" data-production-toggle="'+w+'" aria-expanded="'+productionOpen+'" aria-controls="'+productionId+'">By seller, day &amp; show <span aria-hidden="true">▾</span></button>':'';
   const productionRow=window.WeeklyEbayProduction?'<tr id="'+productionId+'" class="wi-production-detail" '+(productionOpen?'':'hidden')+'><td colspan="8">'+window.WeeklyEbayProduction.render(s.production,w,s.productionViews[w]||'seller')+'</td></tr>':'';
   const st=stats(orders);
   const deduction=n=>n==null?money(null):(n>0?'−':'')+money(n);
   const combined=sales.cancelled!=null&&sales.refunded!=null?Number(sales.cancelled)+Number(sales.refunded):null;
   const original='<strong>'+money(sales.booked)+'</strong>'+(combined===0?'<small>No cancellations or refunds</small>':
    '<div class="wi-deductions"><small>'+deduction(sales.cancelled)+' canceled</small><small>'+deduction(sales.refunded)+' refunded</small></div>'+
    (combined!=null?'<small class="wi-combined">'+money(combined)+' total deductions</small>':''));
   const net='<button type="button" data-item-week="'+w+'" data-bucket="all" aria-label="'+esc(name+' · Net item sales: '+money(sales.net)+' · View order lines')+'">'+money(sales.net)+'</button>'+
    (sales.held>0?'<small>'+money(sales.held)+' excluded pending verification</small>':'');
   function amountCell(bucket){
    const group=orders.filter(o=>matchesBalance(o,bucket));
    const key=bucket==='held'?'held':'credit',known=group.filter(o=>o[key]!=null);
    const missing=group.length-known.length;
    const value=group.length&&!known.length?'Amount unconfirmed':money(known.reduce((n,o)=>n+Math.round(o[key]*100),0)/100);
    const reversed=known.filter(o=>o.cancel||['partial','refunded'].includes(o.buyer));
    const flagged=reversed.length?'<details class="wi-credit-note"><summary>'+reversed.length+' canceled / refunded</summary><small>'+money(reversed.reduce((n,o)=>n+Math.round(o[key]*100),0)/100)+' in original credits on '+(reversed.length===1?'that order':'those orders')+'.</small></details>':'';
    return drill(name,w,bucket,value)+'<small>'+info(group)+'</small>'+(missing?'<small>'+missing+' '+(missing===1?'order amount':'order amounts')+' unconfirmed</small>':'')+flagged;
   }
   const other=['processing','outstanding','review'].map(bucket=>{
    const group=orders.filter(o=>matchesBalance(o,bucket));
    return group.length?'<div>'+drill(name,w,bucket,lineCount(group)+' lines · '+filters[bucket])+'</div>':'';
   }).join('');
   const b=reconciliation(sales,orders),id='wi-bridge-'+(w||'month'),open=s.bridge===w;
   const bridge='<button type="button" class="wi-bridge-toggle" data-bridge="'+w+'" aria-expanded="'+open+'" aria-controls="'+id+'" aria-label="'+esc(name+' · Why released differs: '+(b.gap==null?'Not confirmed':signed(b.gap)))+'">'+(b.gap==null?'Not confirmed':signed(b.gap))+' <span aria-hidden="true">▾</span></button>'+
    (b.gap?'<small class="wi-gap-direction">'+(b.gap>0?'More':'Less')+' released than net sales</small>':'')+'<small>'+esc(b.main)+'</small>';
   return '<tr'+(total?' class="wi-total"':'')+'>'+weekCell(name,w,orders).replace('</th>',productionButton+'</th>')+
    cell('Original item sales',original)+cell('Net item sales',net)+cell('Why released differs',bridge)+
    cell('Released to eBay balance',amountCell('released'))+cell('On hold',amountCell('held'))+
    cell('Other funds statuses',other||'0 lines')+cell('Buyer payments',st.paid+' paid lines<small>'+st.unpaid+' not paid · '+st.unknown+' unconfirmed</small>')+'</tr>'+
    '<tr id="'+id+'" class="wi-bridge-detail" '+(open?'':'hidden')+'><td colspan="8">'+reconciliationDetail(name,id+'-math',b)+'</td></tr>'+productionRow;
  }
  const payoutRow=(name,w,orders,sales,total)=>{
   const amountCell=(bucket,value)=>drill(name,w,bucket,value);
   const groups=(key)=>orders.filter(o=>payout(o)[key]),sent=groups('sent'),off=groups('off'),unclear=groups('unclear');
   const subtotal=(a,key)=>a.reduce((n,o)=>n+Math.round((payout(o)[key]??0)*100),0)/100;
   const missing=(a,key)=>a.filter(o=>payout(o)[key]==null).length;
   const scopedAmount=(a,key)=>a.length&&missing(a,key)===a.length?'Amount unknown':money(subtotal(a,key));
   const reversed=off.filter(o=>o.cancel||['partial','refunded'].includes(o.buyer));
   return '<tr'+(total?' class="wi-total"':'')+'>'+weekCell(name,w,orders)+
    cell('Paid out · order matched',amountCell('sent',sent.length?scopedAmount(sent,'net'):'No match')+'<small>'+info(sent)+(missing(sent,'net')?' · incomplete amounts':'')+'</small>')+
    cell('Not on hold · payout unconfirmed',amountCell('off',scopedAmount(off,'remaining'))+'<small>'+info(off)+(missing(off,'remaining')?' · '+missing(off,'remaining')+' missing amounts':'')+'</small>'+
    (reversed.length?'<small>Includes '+reversed.length+' canceled / refunded orders</small>':'')+
    (unclear.length?amountCell('unclear',unclear.length+' other orders · status unclear'):'') )+'</tr>';
  };
  // Use the same eBay purchase-week totals as the sales report below. Order credits include shipping and fees.
  const monthSales=Object.fromEntries(['booked','cancelled','refunded','held','net'].map(k=>[k,rows.every(r=>r[k]!=null)?rows.reduce((n,r)=>n+Math.round(r[k]*100),0)/100:null]));
  const renderRows=render=>[...rows].reverse().map(r=>render(label(r),r.week,s.orders.filter(o=>o.week===r.week),r,false)).join('')+
   render('Month total','',s.orders,monthSales,true);
  const noteKey=d=>{const b=d.closest('td').querySelector('button');return b.dataset.itemWeek+':'+b.dataset.bucket;};
  const balanceTable=host.querySelector('.wi-balance'),expandedNotes=new Set([...balanceTable.querySelectorAll('.wi-credit-note[open]')].map(noteKey));
  const expandedProduction=new Set([...balanceTable.querySelectorAll('[data-production-group][open]')].map(d=>d.closest('tr').id+':'+d.dataset.productionGroup));
  balanceTable.innerHTML='<table aria-label="Item sales and eBay funds by purchase week"><colgroup><col style="width:12%"></colgroup><colgroup><col style="width:13%"><col style="width:14%"></colgroup><colgroup><col style="width:17%"><col style="width:14%"><col style="width:12%"><col style="width:8%"></colgroup><colgroup><col style="width:10%"></colgroup>'+
   '<thead><tr class="wi-band"><th scope="col" rowspan="2">Purchase week<small>Eastern time</small></th><th scope="colgroup" colspan="2">01 · Item sales</th><th scope="colgroup" colspan="4">02 · From sales to eBay funds</th><th scope="col" rowspan="2">Buyer payments</th></tr>'+
   '<tr><th scope="col">Original item sales</th><th scope="col" class="wi-net-head">Net item sales<small>Verified · before fees</small></th><th scope="col">Why released differs<small>Released minus net sales</small></th><th scope="col">Released to eBay balance<small>Original sale credits</small></th><th scope="col">On hold</th><th scope="col">Other funds statuses</th></tr></thead><tbody>'+renderRows(balanceRow)+'</tbody></table>'+
   '<p><b>Net item sales</b> exclude cancellations, refunds, and amounts still under review. They cover merchandise only, before selling fees. <b>Released</b> and <b>On hold</b> show original sale credits including buyer shipping and after sale fees. A sale can count in net sales while eBay holds its funds.</p>';
  for(const d of balanceTable.querySelectorAll('[data-production-group]'))d.open=expandedProduction.has(d.closest('tr').id+':'+d.dataset.productionGroup);
  for(const d of balanceTable.querySelectorAll('.wi-credit-note'))d.open=expandedNotes.has(noteKey(d));
  host.querySelector('.wi-matches>div').innerHTML='<table><thead><tr><th>Purchase week · Eastern</th><th>Paid out to us<small>Matched to orders</small></th><th>Not on hold<small>Payout not confirmed</small></th></tr></thead><tbody>'+renderRows(payoutRow)+'</tbody></table>'+
   '<p><b>Paid out to us</b> counts only transactions eBay links to a successful transfer, net of linked debits. <b>No match</b> means eBay has not identified which orders funded a transfer. Off-hold credits can include processing funds and are shown before later refunds and costs.</p>';
  const batches=data.ebay_account_payouts||[];
  host.querySelector('.wi-bank>summary').textContent=batches.length?'Bank transfers received by date · '+money(batches.reduce((n,b)=>n+Math.round(b.amount*100),0)/100)+' · '+batches.length+' transfers':'Bank transfers received by date';
  const coverage=data.ebay_payout_coverage;
  if(coverage&&(coverage.error||coverage.retry||coverage.done<batches.length))host.querySelector('.wi-matches>div').insertAdjacentHTML('beforeend','<p><b>Payout matching is incomplete.</b> '+(coverage.error?.includes('rate limited')?'eBay is limiting payout requests; Invsto will retry automatically. ':'')+Number(coverage.done||0)+' of '+batches.length+' transfers dated in this month have a completed transaction check.</p>');
  host.querySelector('.wi-bank>div').innerHTML='<p><b>'+money(batches.reduce((n,b)=>n+Math.round(b.amount*100),0)/100)+' across '+batches.length+' recorded USD transfers.</b> Transfers eBay marks sent count as received, after express payout fees. They can include orders from multiple purchase weeks. <a href="https://www.ebay.com/mes/payouts" target="_blank" rel="noopener">Check payouts in Seller Hub ↗</a></p>'+
   (batches.length?'<ul>'+batches.map(b=>'<li>'+day(b.day)+' · Payout '+esc(b.id)+' · <strong>'+money(b.amount)+'</strong></li>').join('')+'</ul>':'<p>No confirmed account transfers recorded for this month.</p>');
  list(host);
 }
 function list(host){
  const $=q=>host.querySelector(q),s=host.itemState,w=$('.wi-week').value,f=$('.wi-filter').value,q=$('.wi-find').value.trim().toLowerCase();
  const holdSelect=$('.wi-hold-reason'),reason=holdSelect.value||'all',pf=s.productionFilter,chosen=pf?window.WeeklyEbayProduction?.filteredOrders(s.production,pf.week,pf.kind,pf.key,pf):null,scope=s.orders.filter(o=>(!w||o.week===w)&&(!chosen||chosen.has(o.id)));
  const filterNote=$('.wi-production-filter');filterNote.hidden=!pf;filterNote.innerHTML=pf?'Filtered by '+esc(pf.kind==='show'?(s.production?.orders.find(r=>(r.show||r.show_source)===pf.key)?.show_title||'Unlinked / mixed show'):pf.key)+' <button type="button" data-production-clear>Clear breakdown filter</button>':'';
  if(window.OGEbayHoldDetails){holdSelect.innerHTML=window.OGEbayHoldDetails.options(scope.map(o=>o.holdInfo),reason);holdSelect.value=reason;}
  const byReason=scope.filter(o=>!window.OGEbayHoldDetails||window.OGEbayHoldDetails.matches(o.holdInfo,reason));
  const dateSelect=$('.wi-release-date'),releaseDate=dateSelect.value||'all';
  if(window.OGEbayHoldDetails){dateSelect.innerHTML=window.OGEbayHoldDetails.dateOptions(byReason.map(o=>o.holdInfo),releaseDate);dateSelect.value=releaseDate;}
  const orders=byReason.filter(o=>!window.OGEbayHoldDetails||window.OGEbayHoldDetails.matchesDate(o.holdInfo,releaseDate)).map(o=>{
   const orderMatch=[o.id,o.user].some(v=>String(v||'').toLowerCase().includes(q));
   return {o,lines:o.items.filter(i=>matches(o,i,f)&&(orderMatch||[i.title,i.item,i.line].some(v=>String(v||'').toLowerCase().includes(q))))};
  }).filter(g=>g.lines.length);
  const pages=Math.max(1,Math.ceil(orders.length/15));s.page=Math.max(0,Math.min(s.page,pages-1));
  $('.wi-count').textContent=orders.reduce((n,g)=>n+g.lines.length,0)+' matching order lines · '+orders.length+' orders';
  const val=(label,v)=>'<span><small>'+label+'</small><b>'+esc(v)+'</b></span>';
  $('.wi-orders').innerHTML=orders.slice(s.page*15,s.page*15+15).map(({o,lines})=>{
   const id=esc(o.id),link=/^\d{2}-\d{5}-\d{5}$/.test(o.id)?'<a target="_blank" rel="noopener" href="https://www.ebay.com/mesh/ord/details?orderid='+id+'">'+id+' ↗</a>':id;
   const state=balanceState(o),creditLabel=state==='released'?'Released credit · line':state==='held'?'On hold · line credit':'Original sale credit';
   return '<article class="wi-order"><header><div><b>'+link+'</b><small>'+esc(o.user||'Buyer name unavailable')+' · '+esc(when.format(new Date(o.date)))+' · '+o.items.length+' order '+(o.items.length===1?'line':'lines')+'</small></div>'+
    '<div class="wi-badges"><span>'+esc(pay[o.buyer]||pay.unknown)+'</span><span class="wi-state-'+state+'">'+esc(balanceLabels[state])+'</span></div></header>'+
    (window.OGEbayHoldDetails?.render(o.holdInfo)||'')+
    lines.map(i=>'<div class="wi-line"><div><strong>'+esc(i.title||'Item title not saved')+'</strong><small>Qty '+esc(i.qty)+(i.item?' · Item '+esc(i.item):'')+(i.cancel?' · Canceled':'')+'</small></div>'+
     val('Sold for · line',money(i.sold))+val('Item sales kept',i.kept==null?(o.buyer==='partial'?'Refund not split':'Under review'):money(i.kept))+
     val(creditLabel,i.credit==null&&o.items.length>1&&o.credit!=null?'Order total only':money(i.credit))+'</div>').join('')+
    '<footer>'+val('Order sale credit',money(o.credit))+val('Last reported by eBay',funds[o.fund]||funds.unknown)+val('Matched payout · order',payout(o).sent?money(payout(o).net):'No confirmed match')+
    (payout(o).off?val('Not on hold · no payout match',money(payout(o).remaining)):'')+val('Final proceeds · order',o.final==null?'Not verified yet':money(o.final))+
    (o.fund==='held'?val('Sale credit on hold',money(o.held)):'')+
    (o.checked?'<small>'+esc(o.source)+' · '+esc(when.format(new Date(o.checked)))+'</small>':'')+'</footer>'+
    (o.payouts?.length?'<small>'+o.payouts.map(r=>'Payout '+esc(r.id)+' · '+(r.date?day(r.date)+' · ':'')+esc(r.status||'Status unconfirmed')+(r.status==='SUCCEEDED'?' · '+money(r.net):'')).join('<br>')+'</small>':'')+'</article>';
  }).join('')||'<p>No order lines match these filters.</p>';
  $('.wi-pages span').textContent='Page '+(s.page+1)+' of '+pages;
  $('.wi-pages [data-step="-1"]').disabled=s.page===0;$('.wi-pages [data-step="1"]').disabled=s.page+1>=pages;
 }
 window.WeeklyEbayItems={update,fundsForReport(order){
  const o=withPayout(order);
  return {state:balanceState(o),credit:o.credit,onHold:o.held};
 }};
})();
