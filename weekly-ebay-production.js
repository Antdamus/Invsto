(() => {
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n||0);
 const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'});
 const stamp=s=>s?new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'';
 const total=(rows,key)=>rows.reduce((n,r)=>n+Math.round(Number(r[key]||0)*100),0)/100;
 const group=(rows,key)=>{const groups=new Map();for(const r of rows){const k=key(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}return [...groups];};
 const showKey=r=>r.show||r.show_source;
 const showTitle=r=>r.show_title||({multiple:'Multiple shows — review',non_live:'Regular eBay purchase',mixed:'Live and regular purchases — review'}[r.show_source]||'Show not linked');
 const sources={recorded:'Recorded seller',override:'Report assignment',time_rule:'Time rule',multiple:'Multiple sellers',unknown:'Unassigned'};
 const showSources={captured:'Confirmed show link',time_window:'Estimated from show time',multiple:'Multiple shows',non_live:'eBay source: regular purchase',mixed:'Mixed purchase sources',unmatched:'Show not linked'};
 function summary(rows){
  return '<span class="wp-total"><small>Net item sales</small><b>'+money(total(rows,'net'))+'</b></span>';
 }
 function amounts(rows){
  return '<div class="wp-amounts">'+[['Original sales','booked'],['Canceled','cancelled'],['Refunded','refunded'],['Under review','held'],['Net item sales','net']]
   .map(([label,k])=>'<span><small>'+label+'</small><b>'+(k==='cancelled'||k==='refunded'?'−':'')+money(total(rows,k))+'</b></span>').join('')+'</div>';
 }
 function evidence(rows){
  const counts=group(rows,r=>showSources[r.show_source]||'Show not linked').map(([name,a])=>a.length+' '+name.toLowerCase());
  const seller=group(rows,r=>sources[r.seller_source]||'Unassigned').map(([name,a])=>a.length+' '+name.toLowerCase());
  return '<small class="wp-evidence">'+esc(counts.join(' · '))+'<br>'+esc(seller.join(' · '))+'</small>';
 }
 function orderButton(week,kind,key,label,scope={}){return '<button type="button" class="wp-orders" data-production-orders="'+esc(kind)+'" data-production-key="'+esc(key)+'" data-production-week="'+week+'" data-production-day="'+esc(scope.day||'')+'" data-production-seller="'+esc(scope.seller||'')+'">'+esc(label)+'</button>';}
 function showCard(rows,week,scope,data){
  const r=rows[0],id=showKey(r),hasShow=Boolean(r.show),seller=[...new Set(rows.map(r=>r.seller))].join(' / ');
  return '<article class="wp-show"><header><div><strong>'+esc(showTitle(r))+'</strong><small>'+esc(stamp(r.show_start))+(r.show_start?' · ':'')+esc(seller)+'</small></div>'+summary(rows)+'</header>'+
   (hasShow&&window.WeeklyProductionReport?'<p class="wp-timing">'+esc(window.WeeklyProductionReport.timingLabel((data.timing||[]).find(s=>s.event_id===id)||data.shows?.find(s=>s.event_id===id)))+'</p>':'')+amounts(rows)+evidence(rows)+
   '<footer>'+orderButton(week,'show',id,'View '+rows.length+' '+(rows.length===1?'order':'orders'),scope)+
   (hasShow?'<a href="https://www.ebay.com/ebaylive/events/'+encodeURIComponent(id)+'?playback=true" target="_blank" rel="noopener">Open show ↗</a>'+
    '<button type="button" data-production-assign="'+esc(id)+'">Assign seller</button>':'')+'</footer></article>';
 }
 function render(data,week,view='seller'){
  if(!data)return '<p class="wp-empty">Daily and show details will appear after the report refreshes.</p>';
  const rows=data.orders.filter(r=>!week||r.week===week),known=rows.filter(r=>r.show_source==='captured'),estimated=rows.filter(r=>r.show_source==='time_window');
  const tabs='<div class="wp-tabs" role="group" aria-label="Breakdown view">'+[['seller','By seller'],['day','By day'],['show','By show']].map(([k,t])=>'<button type="button" data-production-view="'+k+'" data-production-week="'+week+'" aria-pressed="'+(view===k)+'">'+t+'</button>').join('')+'</div>';
  const orderedShows=(a,scope={})=>group(a,showKey).sort((a,b)=>String(a[1][0].show_start||'~').localeCompare(String(b[1][0].show_start||'~'))).map(([,a])=>showCard(a,week,scope,data)).join('');
  let body='';
  if(view==='show')body=orderedShows(rows);
  else if(view==='day'){
   // Seven days, including zero-sale days; partial months and future dates stay out.
   const days=week?data.days?.filter(d=>d.week===week).map(d=>d.day):data.days?.map(d=>d.day);
   const entries=days?.length?days.map(d=>[d,rows.filter(r=>r.day===d)]):group(rows,r=>r.day).sort((a,b)=>a[0].localeCompare(b[0]));
   body=entries.map(([d,a])=>'<details class="wp-group" data-production-group="day:'+d+'"><summary><span><strong>'+day(d)+'</strong><small>'+a.length+' orders</small></span>'+summary(a)+'</summary><div class="wp-group-body">'+amounts(a)+
    (a.length?orderButton(week,'day',d,'View day’s orders')+orderedShows(a,{day:d}):'<p>No sales recorded for this day.</p>')+'</div></details>').join('');
  } else {
   body=group(rows,r=>r.seller).sort((a,b)=>total(b[1],'net')-total(a[1],'net')).map(([seller,a])=>
    '<details class="wp-group" data-production-group="seller:'+esc(seller)+'"><summary><span><strong>'+esc(seller)+'</strong><small>'+a.length+' '+(a.length===1?'order':'orders')+' · '+new Set(a.map(showKey).filter(k=>!['unmatched','multiple'].includes(k))).size+' recorded / estimated shows</small></span>'+summary(a)+'</summary><div class="wp-group-body">'+amounts(a)+evidence(a)+orderButton(week,'seller',seller,'View seller’s orders')+orderedShows(a,{seller})+'</div></details>').join('');
  }
  const notLinked=rows.length-known.length-estimated.length;
  return '<section class="wp-breakdown" aria-label="Sales by seller, day and show"><header><div><span class="wi-eyebrow">WHO PRODUCED THE SALES</span><h4>Sales by seller, day & show</h4></div>'+summary(rows)+'</header>'+
   (window.WeeklyProductionReport?'<div class="wp-report-actions"><button type="button" data-production-report="'+week+'">Generate report</button><button type="button" data-production-hours="'+week+'">Streamer hours summary</button></div>':'')+
   '<p>Net item sales are after cancellations, refunds and amounts under review, before fees. These amounts add up to the weekly report.</p>'+tabs+
   '<p class="wp-coverage">'+known.length+' orders with confirmed show links · '+estimated.length+' estimated from show time'+(notLinked?' · '+notLinked+' not linked to one show':'')+'</p>'+
   '<div class="wp-groups">'+(body||'<p>No sales in this period.</p>')+'</div>'+
   '<details class="wp-method"><summary>How seller and show assignments work</summary><p>A saved report assignment takes priority, followed by the recorded seller. Otherwise, shows starting at 6 PM–7:59 AM Eastern are assigned to Otello. From 8 AM–5:59 PM, Saturday and Sunday shows default to Manuella; Monday–Friday shows default to Sydney. The show’s Eastern start date determines the day. Without a show, the purchase time supplies that estimate. Date-only orders stay unassigned.</p>'+
   '<p>Confirmed links come from captured order lines. Estimated show links use the purchase time, from a show’s start until the next show or eight hours later, whichever is earlier. A verified show end shortens that window. Estimates may include off-show purchases. Shows crossing midnight appear on each purchase day; By show combines them within the selected week. Orders spanning multiple known shows or sellers remain in a review group. Assign seller changes this report only.</p></details></section>';
 }
 function filteredOrders(data,week,kind,key,scope={}){return new Set((data?.orders||[]).filter(r=>(!week||r.week===week)&&(!scope.day||r.day===scope.day)&&(!scope.seller||r.seller===scope.seller)&&(kind==='seller'?r.seller===key:kind==='day'?r.day===key:showKey(r)===key)).map(r=>r.order));}
 function assignment(host,eventId,client,reload){
  const data=host.itemState.production,show=data.shows.find(s=>s.event_id===eventId);if(!show)return;
  const modal=document.createElement('dialog');modal.className='wp-dialog';modal.setAttribute('aria-label','Assign show seller');
  modal.innerHTML='<form><h3>Assign show seller</h3><p>'+esc(show.title)+'</p><label>Seller<select name="seller" aria-label="Seller"><option value="">Use recorded seller / time rule</option>'+data.sellers.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join('')+'</select></label><p>Applies to this show in the weekly report. Existing order and commission assignments are preserved.</p><p role="status"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit">Save assignment</button></footer></form>';
  const select=modal.querySelector('select');select.value=show.seller_override||'';
  modal.querySelector('[data-cancel]').onclick=()=>modal.close();modal.addEventListener('close',()=>modal.remove());
  modal.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=modal.querySelector('[type=submit]'),status=modal.querySelector('[role=status]');button.disabled=true;
   try{if(!client)throw Error('Refresh the report and try again.');const {error}=await client.rpc('set_weekly_ebay_show_seller',{_event_id:eventId,_seller:select.value||null,_expected_updated_at:show.assignment_updated_at||null});if(error)throw error;modal.close();await reload();}
   catch(e){status.textContent=e.message||'Could not save the assignment.';}finally{button.disabled=false;}};
  document.body.append(modal);modal.showModal();select.focus();
 }
 window.WeeklyEbayProduction={render,filteredOrders,assignment,total};
})();
