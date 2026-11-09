/* Descriptive, within-streamer comparisons; scheduling evidence is observational. */
(() => {
 'use strict';
 const zone='America/New_York',weekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
 const count=n=>new Intl.NumberFormat('en-US').format(n);
 const pct=n=>n==null?'—':(n>0?'+':'')+(n*100).toFixed(0)+'%';
 const date=s=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
 const monthLabel=s=>new Date(s+'-01T12:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',year:'numeric'});
 const dateLabel=s=>new Date(s+'T12:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});
 const group=(a,key)=>{const m=new Map();for(const r of a){const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return [...m];};
 const sum=(a,key)=>a.reduce((n,r)=>n+Number(r[key]||0),0);
 const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;};
 const quantile=(a,p)=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b),i=(s.length-1)*p;return s.length?s[Math.floor(i)]+(s[Math.ceil(i)]-s[Math.floor(i)])*(i%1):null;};
 const hourLabel=h=>(h%12||12)+(h<12?' AM':' PM');
 const slotLabel=h=>hourLabel(h)+'–'+hourLabel((h+2)%24);
 const format=s=>/pokemon|trading card/i.test((s.insights?.category||'')+' '+s.title)?'Trading cards':/rolex|cartier|breitling|watch|frank muller|audemars/i.test(s.title||'')?'Watch-focused title':'Other jewelry title';
 function stats(a){const known=a.filter(s=>Number.isFinite(s.net)),net=sum(known,'net'),rates=a.filter(s=>s.rate!=null);return {n:a.length,net,mean:known.length?net/known.length:null,median:median(known.map(s=>s.net)),q1:quantile(known.map(s=>s.net),.25),q3:quantile(known.map(s=>s.net),.75),rate:median(rates.map(s=>s.rate)),timed:rates.length,months:new Set(a.map(s=>s.month)).size,days:new Set(a.map(s=>s.day)).size};}
 function daily(a){return group(a,s=>s.day).map(([day,shows])=>({day,weekday:shows[0].weekday,month:shows[0].month,net:sum(shows,'net'),shows:shows.length}));}
 function windows(a){
  return group(a,s=>s.slot).sort(([a],[b])=>a-b).map(([slot,shows])=>{
   const summary=stats(shows),lifts=[],matched=new Set(),controls=new Set();
   // Compare only the same streamer, weekday, calendar month and title-based format.
   for(const [,peers] of group(a,s=>[s.weekday,s.month,s.format].join('|'))){
    const target=peers.filter(s=>s.slot===slot&&s.rate!=null),other=peers.filter(s=>s.slot!==slot&&s.rate!=null);
    if(target.length<2||other.length<2)continue;
    const baseline=median(other.map(s=>s.rate));if(!(baseline>0))continue;
    lifts.push(median(target.map(s=>s.rate))/baseline-1);
    target.forEach(s=>matched.add(s.event_id));other.forEach(s=>controls.add(s.event_id));
   }
   const supported=summary.timed>=5&&summary.months>=2&&lifts.length>=3&&matched.size>=5&&controls.size>=5;
   return {slot,shows,...summary,lift:median(lifts),matchedGroups:lifts.length,matchedShows:matched.size,controlShows:controls.size,supported};
  });
 }
 function model(history,period){
  const asOf=Date.parse(history.as_of),today=date(history.as_of);
  const unique=[...new Map((history.shows||[]).map(s=>[s.event_id,s])).values()];
  const all=unique.map(s=>{
   const start=s.scheduled_start||s.starts_at,day=date(start),hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',hour:'numeric'}).format(new Date(start)));
   const weekday=(new Date(day+'T12:00Z').getUTCDay()+6)%7,paid=s.insights?.paid_items;
   const reasons=[],warnings=[];
   if(!s.seller||/unassigned|multiple|review/i.test(s.seller))warnings.push('Seller not established');
   if(day>=today||Date.parse(start)+Math.max(8*3600,s.airtime_seconds||0)*1000>asOf)warnings.push('Show date still in progress');
   if(s.airtime_provisional)warnings.push('Insights still processing');
   if(s.insights?.status==='unavailable'||(s.airtime_seconds==null&&!s.orders))warnings.push('Show completion not verified');
   if(paid>0&&Number(s.linked_lines||0)<paid*.8)warnings.push('Partial order coverage: '+Number(s.linked_lines||0)+' linked lines / '+paid+' eBay paid items');
   const financialMissing=!Number(s.orders)&&(paid>0||(s.airtime_seconds==null&&paid==null));
   if(financialMissing)warnings.push(paid>0?'Original sales reported by eBay; order totals not yet recovered':'Sales data unavailable; zero sales not verified');
   const net=financialMissing?null:Number(s.net||0),rate=net!==null&&s.airtime_seconds>0&&!s.airtime_provisional?net/(s.airtime_seconds/3600):null;
   return {...s,...(financialMissing?{booked:null,cancelled:null,refunded:null,held:null}:{}),net,financialMissing,day,month:day.slice(0,7),weekday,slot:Math.floor(hour/2)*2,phase:Number(day.slice(8))<=10?0:Number(day.slice(8))<=20?1:2,format:format(s),rate,reasons,warnings};
  }).filter(s=>s.day>=history.from&&s.day<history.until);
  const usable=all.filter(s=>!s.reasons.length),past=usable.filter(s=>s.day<period.from),current=usable.filter(s=>s.day>=period.from&&s.day<=period.through);
  const names=[...new Set(all.map(s=>s.seller).filter(s=>s&&!/unassigned|multiple|review/i.test(s)))].sort((a,b)=>({Otello:0,Sydney:1,Manuella:2}[a]??9)-({Otello:0,Sydney:1,Manuella:2}[b]??9)||a.localeCompare(b));
  const sellers=names.map(name=>{
   const previous=past.filter(s=>s.seller===name),selected=current.filter(s=>s.seller===name);
   const incompleteDays=new Set(all.filter(s=>s.seller===name&&s.financialMissing).map(s=>s.day));
   const d=daily(previous).filter(s=>!incompleteDays.has(s.day)),c=daily(selected).filter(s=>!incompleteDays.has(s.day)),slots=windows(previous);
   const comparisons=weekdays.map((weekday,i)=>{const a=d.filter(s=>s.weekday===i),b=c.filter(s=>s.weekday===i),base=median(a.map(s=>s.net)),now=median(b.map(s=>s.net));return {weekday,previous:a.length,current:b.length,base,now,lift:base>0&&now!=null?now/base-1:null};});
   const best=slots.filter(s=>s.supported&&s.lift>0).sort((a,b)=>b.lift-a.lift)[0]||null;
   return {name,previous,selected,days:d,incompleteDays:incompleteDays.size,comparisons,slots,best,stats:stats(previous),observed:slots.filter(s=>s.timed>=3).sort((a,b)=>b.rate-a.rate)[0]||null};
  });
  return {history,period,all,usable,past,current,sellers,excluded:all.filter(s=>s.reasons.length)};
 }
 function table(headers,rows,cls=''){
  return '<div class="wpr-table-wrap"><table class="spa-table '+cls+'"><thead><tr>'+headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map((v,i)=>i?'<td>'+v+'</td>':'<th scope="row">'+v+'</th>').join('')+'</tr>').join('')+'</tbody></table></div>';
 }
 function recommendation(s){
  if(s.best)return '<strong>Candidate to test: '+slotLabel(s.best.slot)+' Eastern</strong><p>Its median sales per hour was '+pct(s.best.lift)+' versus other start windows within '+s.best.matchedGroups+' comparable weekday/month/show-type groups ('+s.best.matchedShows+' shows versus '+s.best.controlShows+' comparison shows). Keep the inventory mix and planned length similar when testing.</p>';
  if(s.observed)return '<strong>No reliable start-time winner yet</strong><p>The highest observed median sales per hour is '+slotLabel(s.observed.slot)+' Eastern ('+money(s.observed.rate)+'/hour across '+s.observed.timed+' timed shows). There are not enough matched comparisons to separate start time from weekday, month and merchandise. Treat this as a test candidate, not an established optimum.</p>';
  return '<strong>More completed shows are needed</strong><p>No start window has at least three usable shows with finalized airtime. The report will build this comparison as history grows.</p>';
 }
 function sellerHtml(s,m){
  const months=[...new Set(s.previous.map(r=>r.month))].sort();
  const monthRows=months.map(month=>[monthLabel(month),...weekdays.map((_,i)=>{const a=s.days.filter(d=>d.month===month&&d.weekday===i);return a.length?money(median(a.map(d=>d.net)))+'<small>'+a.length+' active '+(a.length===1?'day':'days')+'</small>':'—';})]);
  const phaseNames=['Early · days 1–10','Middle · days 11–20','Late · days 21–end'];
  const phases=phaseNames.map((name,i)=>{const a=s.previous.filter(r=>r.phase===i),st=stats(a);return [name,count(st.n)+'<small>'+st.months+' months</small>',money(st.median),money(st.mean),money(st.rate)+'<small>'+st.timed+' timed shows</small>'];});
  const maxRate=Math.max(1,...s.slots.map(r=>r.rate||0));
  const slotRows=s.slots.map(w=>[slotLabel(w.slot)+'<small>Eastern start</small>',count(w.n)+'<small>'+w.months+' months</small>',money(w.median),money(w.q1)+'–'+money(w.q3),
   '<span class="spa-rate" style="--rate:'+Math.round((w.rate||0)/maxRate*100)+'%">'+money(w.rate)+'</span><small>'+w.timed+' timed shows</small>',w.supported?pct(w.lift)+'<small>'+w.matchedGroups+' matched groups</small>':'Limited evidence<small>'+w.matchedGroups+' matched groups</small>']);
  const attributed=s.previous.filter(r=>r.seller_source==='time_rule').length;
  return '<section class="spa-seller"><header class="spa-seller-header"><div><span>STREAMER ANALYSIS</span><h3>'+esc(s.name)+'</h3></div><div>'+s.stats.n+' usable prior shows · '+s.stats.days+' active days<br><small>'+s.stats.months+' months · '+s.stats.timed+' shows with usable airtime</small></div></header>'+
   '<div class="spa-recommendation">'+recommendation(s)+'</div>'+
   '<p class="wpr-note">'+(s.previous.length?'Observed prior shows: '+dateLabel(s.previous.map(r=>r.day).sort()[0])+' to '+dateLabel(s.previous.map(r=>r.day).sort().at(-1))+'. ':'No usable earlier shows. ')+attributed+' shows use an estimated host assignment. '+sum(s.previous,'estimated_orders')+' of '+sum(s.previous,'orders')+' orders use estimated show links. '+(s.name==='Sydney'?'Sydney started September 23, 2026. Earlier shows default to Otello. Saved assignments take priority.':'')+'</p>'+
   '<div class="spa-block"><h4>Same weekday · selected report versus earlier months</h4><p class="wpr-note">Median net sales per active show date. A day’s total combines this streamer’s shows that start that day, including their overnight sales. Dates with unrecovered order totals are omitted from daily comparisons. Started shows remain included, including zero-sales and fully canceled or refunded shows.</p>'+table(['Weekday','Selected median / day','Selected days','Prior median / day','Prior days','Change'],s.comparisons.map(r=>[r.weekday,money(r.now),String(r.current),money(r.base),String(r.previous),pct(r.lift)+(r.previous<3?'<small>Limited history</small>':'')]))+'</div>'+
   '<div class="spa-block"><h4>'+esc(s.name)+' · Same weekdays across months</h4><p class="wpr-note">Typical net sales per active show date, with sample counts. Partial months are compared per active date, never as full-month totals. A dash means no usable shows.</p>'+(monthRows.length?table(['Prior month',...weekdays.map(w=>w.slice(0,3))],monthRows,'spa-months'):'<p>No earlier month has usable show data.</p>')+'</div>'+
   '<div class="spa-block"><h4>'+esc(s.name)+' · Time of month</h4>'+table(['Part of month','Shows / months','Median net / show','Mean net / show','Median net / hour'],phases)+'<p class="wpr-note">These are descriptive patterns. Weekday and merchandise mixes can differ between parts of the month.</p></div>'+
   '<div class="spa-block"><h4>'+esc(s.name)+' · Show start windows</h4><p class="wpr-note">Two-hour Eastern start windows. Median reduces the influence of unusually expensive sales; the middle 50% shows normal variation. All show lengths are included. Hourly rates require a positive, finalized airtime.</p>'+(slotRows.length?table(['Start window','Shows / months','Median net / show','Middle 50% / show','Median net / hour','Matched hourly change'],slotRows):'<p>No usable earlier start windows.</p>')+'</div></section>';
 }
 function render(state,period){
  if(!state||state.status==='loading')return '<h2>06 · Historical streamer analysis</h2><p role="status">Loading historical shows and comparisons…</p>';
  if(state.status==='error')return '<h2>06 · Historical streamer analysis</h2><p class="wpr-warning">Historical analysis could not load. '+esc(state.message||'Try again.')+'</p><button type="button" data-spa-retry>Retry historical analysis</button>';
  const m=model(state.data,period),h=m.history,reasonCounts=group(m.excluded.flatMap(s=>s.reasons),s=>s).map(([reason,a])=>count(a.length)+' '+reason.toLowerCase()).join('; ');
  const lastDate=new Date(h.until+'T12:00Z');lastDate.setUTCDate(lastDate.getUTCDate()-1);
  return '<h2>06 · Historical streamer analysis</h2><p class="wpr-lede">'+dateLabel(h.from)+' through '+dateLabel(lastDate.toISOString().slice(0,10))+' · Eastern time · Checked '+esc(new Date(h.as_of).toLocaleString('en-US',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}))+'</p>'+
   '<div class="spa-summary"><div><strong>'+m.all.length+'</strong><span>known shows</span></div><div><strong>'+m.past.length+'</strong><span>usable prior shows</span></div><div><strong>'+m.current.length+'</strong><span>selected-period shows</span></div><div><strong>'+m.excluded.length+'</strong><span>excluded from comparisons</span></div></div>'+
   '<p>Each streamer is compared with their own earlier shows. The baseline ends before '+esc(period.from)+', so this report’s results never enter their own historical benchmark. Net sales use the same merchandise, cancellation, refund and review rules as the weekly report.</p><p><strong>Overnight shows stay together.</strong> A show starting Monday night and ending Tuesday morning counts once under Monday, with all linked sales and its full airtime. Estimated links can extend beyond eight hours for a longer recorded stream, stopping at the next show. Purchase-day totals elsewhere in the report remain separate.</p>'+
   (reasonCounts?'<p class="wpr-note">Excluded-show reasons (a show may have more than one): '+esc(reasonCounts)+'.</p>':'')+
   (m.all.some(s=>s.warnings.length)?'<details class="spa-coverage"><summary>Review '+m.all.filter(s=>s.warnings.length).length+' shows with data-quality notes</summary><p>Started shows remain included, including shows with no sales. Amounts reflect recovered orders; unavailable totals are not zero. Linked lines and eBay paid items are different measures, so a count difference needs review.</p>'+table(['Show / Eastern start','Streamer','Original sales','Current net','Data-quality notes'],m.all.filter(s=>s.warnings.length).map(s=>[esc(s.title)+'<small>'+esc(new Date(s.scheduled_start||s.starts_at).toLocaleString('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}))+'</small>',esc(s.seller),money(s.booked),money(s.net),esc(s.warnings.join(' · '))]))+'</details>':'')+
   '<p class="wpr-note">History coverage: '+count(h.coverage?.unlinked_orders||0)+' orders ('+money(h.coverage?.unlinked_net||0)+') purchased within these dates are outside individual show comparisons.'+(h.coverage?.non_live_orders!=null?' '+count(h.coverage.non_live_orders)+' are regular eBay purchases; '+count(h.coverage.review_orders||0)+' need review for mixed, multiple or missing show evidence.':'')+' They remain in financial reports. Regular and mixed-source orders do not receive a streamer from the time rule. Confirmed links use recorded show evidence or eBay Live event IDs; time-window links remain estimates.</p>'+
   m.sellers.map(s=>sellerHtml(s,m)).join('')+
   '<div class="spa-method"><h3>How to use these findings</h3><p>A suggested window needs at least five timed shows across two months and three matched groups, with at least five shows on each side. Matching holds streamer, weekday, calendar month and title-based show type constant. These thresholds are evidence checks, not statistical significance or proof that start time causes higher sales.</p><p>Titles only approximate merchandise mix. Inventory value, promotions, holidays, repeat buyers and changes in audience can still explain differences. Try alternating comparable shows between two start windows before adopting a permanent schedule. A lack of comparable windows means the best start time is not yet known.</p><p>Start windows use the observed scheduled start, not a verified actual go-live timestamp. Sales are current net amounts, so newer shows have had less time for returns. Shows with original sales remain included regardless of duration, cancellations, refunds, or payout holds. Started shows with no recorded sales remain included at zero when sales data is available. Partial order coverage stays visible with a warning; unrecovered totals are unavailable, never zero. Line and paid-item counts are not identical measures. All records and data-quality notes are included in the CSV.</p></div>';
 }
 function csvRows(state,period){
  if(state?.status!=='ready')return [[],['Historical streamer analysis',state?.status==='loading'?'Still loading':'Not available']];
  const m=model(state.data,period),rows=[[],['Historical streamer analysis','Prior baseline ends before',period.from],['History from',m.history.from,'Until (exclusive)',m.history.until,'Snapshot',m.history.as_of],[],['Streamer','Weekday','Selected median per active day','Selected days','Prior median per active day','Prior days','Fractional change']];
  for(const s of m.sellers)for(const r of s.comparisons)rows.push([s.name,r.weekday,r.now,r.current,r.base,r.previous,r.lift]);
  rows.push([],['Streamer','Prior month','Weekday','Active days','Median net per active day']);
  for(const s of m.sellers)for(const [key,a] of group(s.days,d=>d.month+'|'+d.weekday)){const [month,w]=key.split('|');rows.push([s.name,month,weekdays[Number(w)],a.length,median(a.map(d=>d.net))]);}
  rows.push([],['Streamer','Month phase','Shows','Median net per show','Mean net per show','Median net per hour','Timed shows']);
  for(const s of m.sellers)for(const [phase,a] of group(s.previous,r=>r.phase)){const v=stats(a);rows.push([s.name,['1–10','11–20','21–end'][phase],v.n,v.median,v.mean,v.rate,v.timed]);}
  rows.push([],['Streamer','Start window Eastern','Shows','Months','Median net per show','25th percentile','75th percentile','Median net per hour','Timed shows','Matched fractional change','Matched groups','Evidence threshold met']);
  for(const s of m.sellers)for(const w of s.slots)rows.push([s.name,slotLabel(w.slot),w.n,w.months,w.median,w.q1,w.q3,w.rate,w.timed,w.lift,w.matchedGroups,w.supported?'Yes':'No']);
  rows.push([],['Historical show','Event ID','Streamer','Host evidence','Scheduled start','Show date Eastern','Title-based show type','Net merchandise sales','Airtime seconds','Processing','Linked orders','Confirmed orders','Estimated orders','Linked lines','eBay paid items','Exclusions / data-quality notes','Studio sales including tax and shipping','Studio in-stream sales','Studio average sale price','Total viewers','Peak viewers','Purchasers','New followers','Returning viewers percent','Conversion percent','Source checked','Source URL']);
  for(const s of m.all){const i=s.insights||{};rows.push([s.title,s.event_id,s.seller,s.seller_source,s.scheduled_start||s.starts_at,s.day,s.format,s.net,s.airtime_seconds,s.airtime_provisional?'Yes':'No',s.orders,s.confirmed_orders,s.estimated_orders,s.linked_lines,i.paid_items,[...s.reasons,...s.warnings].join('; '),i.studio_gross_including_tax_shipping,i.studio_in_stream_sales,i.studio_average_sales_price,i.total_viewers,i.peak_viewers,i.purchasers,i.new_followers,i.returning_viewers_percent,i.conversion_percent,i.checked_at,i.source_url]);}
  return rows;
 }
 window.StreamerPerformance={model,render,csvRows,stats,median,windows,slotLabel};
})();
