(function(){
 'use strict';
 const $=id=>document.getElementById(id),marketNames={ebay:'eBay',tiktok:'TikTok Shop',whatnot:'Whatnot'};
 const usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
 const fmt=n=>usd.format(Number(n)||0);
 const etMonth=()=>new Intl.DateTimeFormat('fr-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7);
 const etStamp=s=>new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(s));
 function dayLabel(date,offset=0){
  const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);
  return d.toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric'});
 }
 const sum=(rows,k)=>rows.reduce((s,r)=>s+Number(r[k]||0),0);
 function dateOffset(iso,days){const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
 const pacificHour=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',hour:'2-digit',hourCycle:'h23'});
 function pacificMidnight(iso){const early=Date.parse(iso+'T07:00:00Z');return pacificHour.format(early)==='00'?early:early+3600000;}
 function hubUrl(first,last){
  const query=new URLSearchParams({referencePeriodFilter:'CUSTOM',benchmarkPeriodFilter:'CUSTOM',benchmarkStart:String(pacificMidnight(dateOffset(first,-7))),referenceStart:String(pacificMidnight(first)),referenceEnd:String(pacificMidnight(last))});
  return 'https://www.ebay.com/sh/performance/sales?'+query.toString();
 }
 function hubLink(first,last,label){return '<a target="_blank" rel="noopener" href="'+hubUrl(first,last)+'">'+label+' ↗</a>';}
 function hubOverview(data,groups){
  const saved=data.seller_hub||[],last=data.current_month?data.cutoff.slice(0,10):dateOffset(data.rows.at(-1).end_day,-1);
  const first=data.month,find=(a,b)=>saved.find(r=>r.first_day===a&&r.last_day===b),month=find(first,last);
  const link=hubLink(first,last,'Open this period in eBay');
  if(!month)return '<section class="ws-hub"><h3>eBay Seller Hub</h3><p>'+link+' to see the latest sales after fees and postage for these Pacific reporting dates.</p></section>';
  const weekly=Array.from(groups.values()).reverse().map(part=>{
   const a=part[0].first_day,b=[dateOffset(part[0].end_day,-1),last].sort()[0],r=find(a,b);
   return '<tr><th>'+hubLink(a,b,dayLabel(a)+' – '+dayLabel(b))+'</th><td>'+(r?fmt(r.item_sales):'See eBay')+'</td><td>'+(r?fmt(r.reported_net):'See eBay')+'</td></tr>';
  }).join('');
  const start=data.anchor>first?data.anchor:first,focus=find(start,last),prior=find(dateOffset(start,-7),dateOffset(last,-7));
  const compare=focus&&prior?'<p><b>'+dayLabel(start)+' – '+dayLabel(last)+'</b> compared with '+hubLink(prior.first_day,prior.last_day,dayLabel(prior.first_day)+' – '+dayLabel(prior.last_day))+'. After selling costs, '+change(Number(focus.reported_net),Number(prior.reported_net))+' ('+fmt(prior.reported_net)+' previously).</p>':'';
  return '<section class="ws-hub"><h3>eBay Seller Hub · sales and selling costs</h3><p>Returns and cancellations are reflected on eBay’s reporting dates (Pacific). Figures checked '+etStamp(month.checked_at)+'. '+link+'</p>'+
   '<div class="ws-headline"><div><small>ITEM SALES</small><strong>'+fmt(month.item_sales)+'</strong><p>Shipping collected separately · '+fmt(month.shipping_collected)+'</p></div><div><small>AFTER SELLING COSTS</small><strong>'+fmt(month.reported_net)+'</strong><p>eBay fees '+fmt(month.selling_fees)+' · Shipping labels '+fmt(month.label_cost)+'</p></div></div>'+compare+
   '<table><thead><tr><th>Reporting dates</th><th>Item sales</th><th>After selling costs</th></tr></thead><tbody>'+weekly+'</tbody></table></section>';
 }
 function change(now,prior){
  const delta=now-prior,absolute=fmt(Math.abs(delta));
  if(delta===0)return 'Even with the prior week at the same point';
  return absolute+(delta>0?' more':' less')+(prior>0?' ('+(Math.abs(delta)/prior*100).toFixed(1)+'%)':'')+' than the prior week at the same point';
 }
 function feedNote(name,feed){
  if(feed?.state==='ready')return name+' refunds checked through '+etStamp(feed.through)+'.';
  if(feed?.state==='permission')return name+' refund access is missing. Sales awaiting that check are held out.';
  if(feed?.state==='error')return name+' refund sync needs attention. Unverified sales are held out.';
  return name+' refund reconciliation is incomplete. Unverified sales are held out.';
 }
 function cell(label,value){return '<div><small>'+label+'</small><strong>'+value+'</strong></div>';}
 function deduction(rows,key){const value=sum(rows,key);return value?'−'+fmt(value):fmt(0);}
 function postedProceeds(rows){return sum(rows,'settled_orders')||sum(rows,'proceeds')!==0?fmt(sum(rows,'proceeds')):'Awaiting records';}
 function salesCalculation(rows,period){
  const booked=sum(rows,'booked'),afterCancellations=booked-sum(rows,'cancelled'),afterRefunds=afterCancellations-sum(rows,'refunded');
  const step=(label,amount,balance)=>'<tr><th scope="row">'+label+'</th><td>'+amount+'</td><td>'+fmt(balance)+'</td></tr>';
  return '<div class="ws-calculation"><table><caption>'+period+' · from original sales to sales kept</caption><thead><tr><th>Item sales</th><th>Deduction</th><th>Balance</th></tr></thead><tbody>'+
   step('Originally sold<small>Booked item value</small>', '—',booked)+step('After cancellations',deduction(rows,'cancelled'),afterCancellations)+step('After refunds',deduction(rows,'refunded'),afterRefunds)+
   '<tr class="ws-kept"><th scope="row">Verified net item sales<small>After setting aside amounts under review</small></th><td>'+deduction(rows,'held')+'</td><td>'+fmt(sum(rows,'net'))+'</td></tr></tbody></table></div>';
 }
 function render(data,market){
  const rows=data.rows,open=new Set(Array.from($('ws-results').querySelectorAll('.ws-week[open]'),d=>d.dataset.week));
  const hubOpen=Boolean($('ws-results').querySelector('.ws-hub-reference[open]'));
  const groups=new Map();for(const r of rows){if(!groups.has(r.week))groups.set(r.week,[]);groups.get(r.week).push(r);}
  const weekCard=([week,part])=>{
   const r=part[0],current=week===data.anchor,scope=dayLabel(r.first_day)+' – '+dayLabel(r.end_day,-1);
   const range=dayLabel(week)+' – '+dayLabel(week,6);
   const comparable=r.comparable!=null;
   const partial=sum(part,'settled_orders')<sum(part,'orders');
   const details=part.map(m=>'<tr><th scope="row">'+marketNames[m.market]+'</th><td>'+(m.net===0&&m.held>0?'Awaiting check':fmt(m.net))+'</td><td>'+fmt(m.held)+'</td><td>'+postedProceeds([m])+'</td></tr>').join('');
   return '<details class="ws-week" data-week="'+week+'" '+(open.has(week)?'open':'')+'><summary><span><strong>'+range+'</strong><small>'+
    (current&&data.current_month?'This week so far':scope!==range?'In this month · '+scope:'Monday–Sunday')+'</small></span>'+
    '<span><small>Verified net item sales</small><b>'+fmt(sum(part,'net'))+'</b></span><span><small>'+(partial?'Proceeds so far · partial':'Seller proceeds')+'</small><b>'+postedProceeds(part)+'</b></span><span class="ws-arrow" aria-hidden="true">⌄</span></summary>'+
    '<div class="ws-inner">'+salesCalculation(part,'Week')+
    '<table><thead><tr><th>Marketplace</th><th>Net sales</th><th>Awaiting verification</th><th>Proceeds</th></tr></thead><tbody>'+details+'</tbody></table>'+
    '<p>'+sum(part,'settled_orders')+' of '+sum(part,'orders')+' included orders have reconciled proceeds. '+
    (comparable?'At the same point in the comparison week, verified net item sales were '+fmt(sum(part,'comparable'))+'.':'This partial week does not supply a full same-days comparison.')+'</p></div></details>';
  };
  const caption=data.current_month?'This week so far':'Last week in this month';
  const period=dayLabel(data.anchor)+' through '+etStamp(data.as_of);
  const unresolved=sum(rows,'orders')-sum(rows,'settled_orders');
  const scan=data.ebay_adjustments;
  const scanNote=scan?' <small class="ws-scan">'+(scan.checked?'eBay order changes checked through '+etStamp(scan.through)+'.':'The first eBay change scan is pending.')+(scan.error?' A retry is scheduled.':'')+'</small>':'';
  const hub=market==='ebay'&&data.month&&data.cutoff?'<details class="ws-hub-reference" '+(hubOpen?'open':'')+'><summary>Compare with eBay Seller Hub · by posting date (Pacific)</summary>'+hubOverview(data,groups)+'</details>':'';
  return '<h3 class="ws-source-title">Sales by original purchase week (Eastern)</h3><p class="ws-intro">A later refund reduces the week the item was bought. A fully canceled or fully refunded item contributes $0 in item sales. A partial refund leaves only the portion kept.'+scanNote+'</p>'+
   '<div class="ws-headline"><div><small>MONTH · NET ITEM SALES AFTER REFUNDS AND CANCELLATIONS</small><strong>'+fmt(sum(rows,'net'))+'</strong><p>Merchandise only · '+fmt(sum(rows,'held'))+' excluded pending verification</p></div>'+
   '<div><small>MONTH · '+(unresolved?'CONFIRMED PROCEEDS SO FAR':'CONFIRMED SELLER PROCEEDS')+'</small><strong>'+postedProceeds(rows)+'</strong><p>'+(unresolved?'Final proceeds pending for '+unresolved+' of '+sum(rows,'orders')+' orders. ':'All included orders reconciled. ')+'Includes shipping collected, less marketplace fees and recorded postage. Before inventory cost.</p></div></div>'+
   salesCalculation(rows,'Month')+
   (market==='all'&&sum(rows,'held')>0?'<p class="ws-coverage"><strong>Excluded from verified net sales</strong> '+Object.keys(marketNames).map(k=>marketNames[k]+' '+fmt(sum(rows.filter(r=>r.market===k),'held'))).join(' · ')+'.</p>':'')+
   '<div class="ws-comparison"><h3>'+caption+'</h3><p>'+(data.current_month?period:'Through '+dayLabel(rows.at(-1).end_day,-1))+' · compared with the same elapsed days and time one week earlier.</p>'+
   '<div>'+cell('Verified net item sales',fmt(data.focus_net))+ '<span>'+change(data.focus_net,data.previous_net)+' · previous '+fmt(data.previous_net)+'</span></div>'+
   (data.focus_unsettled===0&&data.previous_unsettled===0?'<div>'+cell('Seller proceeds',fmt(data.focus_proceeds))+'<span>'+change(data.focus_proceeds,data.previous_proceeds)+' · previous '+fmt(data.previous_proceeds)+'</span></div>':'<p>The proceeds comparison will appear when both periods are fully reconciled.</p>')+'</div>'+
   '<div class="ws-list">'+Array.from(groups).reverse().map(weekCard).join('')+'</div>'+
   '<details class="ws-method"><summary>Adjustments and coverage</summary><p>USD orders from eBay, TikTok Shop, and Whatnot are counted once by purchase week in Eastern time. Booked items include cancellations. Confirmed merchandise refunds and cancellations reduce that week once. Failed payments, buyer tax, and shipping collected are outside net item sales.</p>'+
   '<p>Seller proceeds include buyer shipping credited by the marketplace, less fees, refunds, adjustments, and recorded postage. A shared eBay label is split once across its linked orders. eBay funds on hold or processing are included when costs are recorded. Positive balances with incomplete costs stay out. Recorded losses can appear before an order fully settles. This shows the reconciled portion of sales. It excludes inventory cost, off-platform postage, and account-wide charges without an order.</p>'+
   (market==='ebay'?'':'<p>'+(['all','tiktok'].includes(market)?feedNote('TikTok Shop',data.feeds?.tiktok)+' ':'')+(['all','whatnot'].includes(market)?feedNote('Whatnot',data.feeds?.whatnot)+(data.whatnot_backfill?' Whatnot order history is still importing.':''):'')+'</p>')+'</details>'+hub;
 }
 function init(client){
  const panel=$('weekly-sales-report'),month=$('ws-month');if(!panel||month.dataset.ready)return;month.dataset.ready='true';
  const params=new URLSearchParams(location.search),requested=params.get('month'),market=$('ws-market');
  market.value=['all','ebay','tiktok','whatnot'].includes(params.get('market'))?params.get('market'):'ebay';
  month.max=etMonth();
  let seq=0,manualMonth=Boolean(requested&&/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)&&requested>='2000-01'&&requested<=month.max);
  month.value=manualMonth?requested:month.max;
  const connect=$('ws-ebay-connect'),earnStatus=$('ws-ebay-status');
  async function earningsStatus(){
   connect.hidden=earnStatus.hidden=market.value!=='ebay'||!client.functions;if(connect.hidden)return;
   try{const {data,error}=await client.functions.invoke('ebay-weekly-earnings',{body:{action:'status'}});if(error)throw error;
    if(market.value!=='ebay')return;
    connect.hidden=Boolean(data.connected_at&&!data.last_error);earnStatus.textContent=data.last_error||(!data.connected_at?'Order Earnings API is available to connect.':data.last_success?'Order Earnings API · Last checked '+etStamp(data.last_success):'Connected · Waiting for the first earnings import.');
   }catch{earnStatus.textContent='Could not check the eBay earnings connection.';}
  }
  connect.onclick=async()=>{connect.disabled=true;try{const {data,error}=await client.functions.invoke('ebay-weekly-earnings',{body:{action:'connect'}});if(error)throw error;
   if(data.url&&new URL(data.url).origin==='https://auth.ebay.com'){location.assign(data.url);return;}if(!data.ok)throw Error();await earningsStatus();load();
  }catch{earnStatus.textContent='Could not start eBay authorization. Try again.';}finally{connect.disabled=false;}};
  async function load(){
   const version=++seq;if(!panel.open||document.hidden)return;
   month.max=etMonth();if(!manualMonth)month.value=month.max;
   if(!/^\d{4}-\d{2}$/.test(month.value)||month.value>month.max||month.value<'2000-01'){$('ws-results').replaceChildren();$('ws-status').textContent='Choose the current month or a past month.';return;}
   $('ws-status').textContent='Checking marketplace records…';earningsStatus();
   try{
    const {data,error}=await client.rpc('get_weekly_sales_for_market',{_month:month.value+'-01',_market:market.value});if(error||!data)throw error||Error();
    if(seq!==version||!panel.open)return;
    $('ws-results').innerHTML=render(data,market.value);$('ws-status').textContent=(marketNames[market.value]||'All marketplaces')+' · Checked '+etStamp(data.as_of)+' · Refreshes every minute while open.';
   }catch{if(seq===version){$('ws-results').replaceChildren();$('ws-status').textContent='Could not verify these totals. Use Refresh sales to retry.';}}
  }
  panel.addEventListener('toggle',()=>{if(panel.open)load();else seq++;});month.onchange=()=>{manualMonth=true;$('ws-results').replaceChildren();load();};
  market.onchange=()=>{$('ws-results').replaceChildren();load();};
  $('ws-refresh').onclick=load;
  document.addEventListener('visibilitychange',()=>{if(panel.open&&!document.hidden)load();});
  setInterval(()=>{if(panel.open&&!document.hidden)load();},60000);
  if(location.hash==='#weekly-sales-report'){panel.open=true;panel.scrollIntoView({block:'start'});}
 }
 window.WeeklyMarketplaceSales={init};
})();
