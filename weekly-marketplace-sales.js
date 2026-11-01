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
 function render(data){
  const rows=data.rows,open=new Set(Array.from($('ws-results').querySelectorAll('details[open]'),d=>d.dataset.week));
  const groups=new Map();for(const r of rows){if(!groups.has(r.week))groups.set(r.week,[]);groups.get(r.week).push(r);}
  const weekCard=([week,part])=>{
   const r=part[0],current=week===data.anchor,scope=dayLabel(r.first_day)+' – '+dayLabel(r.end_day,-1);
   const range=dayLabel(week)+' – '+dayLabel(week,6);
   const comparable=r.comparable!=null;
   const proceeds=(list)=>sum(list,'settled_orders')||sum(list,'proceeds')!==0?fmt(sum(list,'proceeds')):'Awaiting settlement';
   const details=part.map(m=>'<tr><th scope="row">'+marketNames[m.market]+'</th><td>'+(m.net===0&&m.held>0?'Awaiting check':fmt(m.net))+'</td><td>'+fmt(m.held)+'</td><td>'+proceeds([m])+'</td></tr>').join('');
   return '<details class="ws-week" data-week="'+week+'" '+(open.has(week)?'open':'')+'><summary><span><strong>'+range+'</strong><small>'+
    (current&&data.current_month?'This week so far':scope!==range?'In this month · '+scope:'Monday–Sunday')+'</small></span>'+
    '<span><small>Net item sales</small><b>'+fmt(sum(part,'net'))+'</b></span><span><small>Seller proceeds</small><b>'+proceeds(part)+'</b></span><span class="ws-arrow" aria-hidden="true">⌄</span></summary>'+
    '<div class="ws-inner"><div class="ws-facts">'+cell('Booked items',fmt(sum(part,'booked')))+cell('Cancellations',fmt(sum(part,'cancelled')))+cell('Merchandise refunds',fmt(sum(part,'refunded')))+cell('Awaiting verification',fmt(sum(part,'held')))+'</div>'+
    '<table><thead><tr><th>Marketplace</th><th>Net sales</th><th>Awaiting verification</th><th>Proceeds</th></tr></thead><tbody>'+details+'</tbody></table>'+
    '<p>'+sum(part,'settled_orders')+' of '+sum(part,'orders')+' included orders have reconciled proceeds. '+
    (comparable?'At the same point in the week as the comparison date, verified sales were '+fmt(sum(part,'comparable'))+' and recorded proceeds were '+fmt(sum(part,'comparable_proceeds'))+'.':'This partial week does not supply a full same-days comparison.')+'</p></div></details>';
  };
  const caption=data.current_month?'This week so far':'Last week in this month';
  const period=dayLabel(data.anchor)+' through '+etStamp(data.as_of);
  return '<div class="ws-headline"><div><small>MONTH · VERIFIED NET ITEM SALES</small><strong>'+fmt(sum(rows,'net'))+'</strong><p>'+fmt(sum(rows,'held'))+' awaiting verification</p></div>'+
   '<div><small>MONTH · RECORDED SELLER PROCEEDS</small><strong>'+(sum(rows,'settled_orders')||sum(rows,'proceeds')!==0?fmt(sum(rows,'proceeds')):'Awaiting settlement')+'</strong><p>'+sum(rows,'settled_orders')+' of '+sum(rows,'orders')+' included orders reconciled</p></div></div>'+
   (sum(rows,'held')>0?'<p class="ws-coverage"><strong>Excluded from verified net sales</strong> '+Object.keys(marketNames).map(k=>marketNames[k]+' '+fmt(sum(rows.filter(r=>r.market===k),'held'))).join(' · ')+'.</p>':'')+
   '<div class="ws-comparison"><h3>'+caption+'</h3><p>'+(data.current_month?period:'Through '+dayLabel(rows.at(-1).end_day,-1))+' · compared with the same elapsed days and time one week earlier.</p>'+
   '<div>'+cell('Net sales',fmt(data.focus_net))+ '<span>'+change(data.focus_net,data.previous_net)+' · previous '+fmt(data.previous_net)+'</span></div>'+
   '<div>'+cell('Seller proceeds',fmt(data.focus_proceeds))+'<span>'+change(data.focus_proceeds,data.previous_proceeds)+' · previous '+fmt(data.previous_proceeds)+'</span></div></div>'+
   '<div class="ws-list">'+Array.from(groups).reverse().map(weekCard).join('')+'</div>'+
   '<details class="ws-method"><summary>Adjustments and coverage</summary><p>USD orders from eBay, TikTok Shop, and Whatnot are counted once by purchase week in Eastern time. Booked items include cancellations. Confirmed merchandise refunds and cancellations reduce that week once. Failed payments, buyer tax, and shipping collected are outside net item sales.</p>'+
   '<p>Seller proceeds include buyer shipping credited by the marketplace, less fees, refunds, adjustments, and recorded postage. A shared eBay label is split once across its linked orders. eBay funds on hold or processing are included when costs are recorded. Positive balances with incomplete costs stay out. Recorded losses can appear before an order fully settles. This shows the reconciled portion of sales. It excludes inventory cost, off-platform postage, and account-wide charges without an order.</p>'+
   '<p>'+feedNote('TikTok Shop',data.feeds?.tiktok)+' '+feedNote('Whatnot',data.feeds?.whatnot)+(data.whatnot_backfill?' Whatnot order history is still importing.':'')+'</p></details>';
 }
 function init(client){
  const panel=$('weekly-sales-report'),month=$('ws-month');if(!panel||month.dataset.ready)return;month.dataset.ready='true';
  const requested=new URLSearchParams(location.search).get('month');
  month.max=etMonth();
  let seq=0,manualMonth=Boolean(requested&&/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)&&requested>='2000-01'&&requested<=month.max);
  month.value=manualMonth?requested:month.max;
  async function load(){
   const version=++seq;if(!panel.open||document.hidden)return;
   month.max=etMonth();if(!manualMonth)month.value=month.max;
   if(!/^\d{4}-\d{2}$/.test(month.value)||month.value>month.max||month.value<'2000-01'){$('ws-results').replaceChildren();$('ws-status').textContent='Choose the current month or a past month.';return;}
   $('ws-status').textContent='Checking marketplace records…';
   try{
    const {data,error}=await client.rpc('get_weekly_marketplace_sales',{_month:month.value+'-01'});if(error||!data)throw error||Error();
    if(seq!==version||!panel.open)return;
    $('ws-results').innerHTML=render(data);$('ws-status').textContent='Checked '+etStamp(data.as_of)+' · Refreshes every minute while open.';
   }catch{if(seq===version){$('ws-results').replaceChildren();$('ws-status').textContent='Could not verify these totals. Use Refresh sales to retry.';}}
  }
  panel.addEventListener('toggle',()=>{if(panel.open)load();else seq++;});month.onchange=()=>{manualMonth=true;$('ws-results').replaceChildren();load();};
  $('ws-refresh').onclick=load;
  document.addEventListener('visibilitychange',()=>{if(panel.open&&!document.hidden)load();});
  setInterval(()=>{if(panel.open&&!document.hidden)load();},60000);
  if(location.hash==='#weekly-sales-report'){panel.open=true;panel.scrollIntoView({block:'start'});}
 }
 window.WeeklyMarketplaceSales={init};
})();
