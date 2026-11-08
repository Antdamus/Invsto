/* Aggregate show evidence; observational comparisons, never profit estimates. */
(() => {
 'use strict';
 const zone='America/New_York',weekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const sum=(a,k)=>a.reduce((n,r)=>n+(Number(typeof k==='function'?k(r):r[k])||0),0);
 const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;};
 const group=(a,key)=>[...a.reduce((m,r)=>{const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);return m;},new Map())];
 const money=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
 const num=n=>n==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(n);
 const pct=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'percent',maximumFractionDigits:1}).format(n);
 const ratio=(a,b)=>b>0?a/b:null;
 const hour=n=>(n%12||12)+(n<12?' AM':' PM');
 const hourFormatter=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23'});
 const etHour=t=>Number(hourFormatter.format(new Date(t)));
 const countLabel=n=>n+' '+(n===1?'show':'shows');
 const table=(head,rows,cls='')=>'<div class="wpr-table-wrap"><table class="sca-table '+cls+'"><thead><tr>'+head.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map((v,i)=>i?'<td>'+v+'</td>':'<th scope="row">'+v+'</th>').join('')+'</tr>').join('')+'</tbody></table></div>';
 const block=(title,note,body,cls='')=>'<section class="sca-block '+cls+'"><h3>'+title+'</h3><p class="wpr-note">'+note+'</p>'+body+'</section>';
 const season=month=>{const y=Number(month.slice(0,4)),n=Number(month.slice(5));return n===12?'Winter '+y+'–'+(y+1):n<=2?'Winter '+(y-1)+'–'+y:n<=5?'Spring '+y:n<=8?'Summer '+y:'Fall '+y;};
 const valid=s=>s.commercial?.version===1&&Number(s.commercial.orders)===Number(s.orders);
 const seconds=s=>Number(s.airtime_seconds||0);
 const halfAmount=(s,b,key='net')=>sum((s.commercial?.halves||[]).filter(r=>Number(r.bin)===b),key);
 const interval=(s,from,to,key='net')=>sum((s.commercial?.halves||[]).filter(r=>r.bin>=from&&r.bin<to),key);
 function showDay(s,mode){
  if(mode!=='night')return {...s,calendar_day:s.day,day_mode:'calendar'};
  const hour=etHour(s.scheduled_start||s.starts_at);if(hour>=6&&hour<18)return null;
  const date=new Date(s.day+'T12:00Z');if(hour<6)date.setUTCDate(date.getUTCDate()-1);
  const day=date.toISOString().slice(0,10),dateNumber=Number(day.slice(8));
  return {...s,calendar_day:s.day,day_mode:'night',day,month:day.slice(0,7),weekday:(date.getUTCDay()+6)%7,phase:dateNumber<=10?0:dateNumber<=20?1:2};
 }
 function exposure(s,h){
  let value=0;const start=Date.parse(s.scheduled_start||s.starts_at),end=start+seconds(s)*1000;
  // Walk UTC hour boundaries so overnight and DST transitions retain elapsed time.
  for(let t=start;t<end;){const next=Math.min(end,(Math.floor(t/3600000)+1)*3600000);if(etHour(t)===h)value+=(next-t)/3600000;t=next;}
  return value;
 }
 function timing(a,step,count){return Array.from({length:count},(_,i)=>{
  const eligible=a.filter(s=>seconds(s)>=(i+1)*step*1800),values=eligible.map(s=>interval(s,i*step,(i+1)*step));
  return {index:i,n:eligible.length,net:median(values),orders:median(eligible.map(s=>interval(s,i*step,(i+1)*step,'orders')))};
 });}
 function build(history,period,options={}){
  const base=window.StreamerPerformance.model(history,period),names=base.sellers.map(s=>s.name);
  const seller=names.includes(options.seller)?options.seller:names[0]||'';
  const format=options.format??(seller==='Otello'?'Watch-focused title':'all');
  const weekday=options.weekday??(seller==='Otello'?'6':'all');
  const dayMode=options.dayMode==='night'?'night':'calendar';
  const usable=base.usable.map(s=>showDay(s,dayMode)).filter(Boolean);
  let rows=usable.filter(s=>s.day<period.from&&s.seller===seller&&(format==='all'||s.format===format)&&(weekday==='all'||s.weekday===Number(weekday)));
  const titles=[...new Set(rows.map(s=>s.title))].sort();
  const series=titles.includes(options.series)?options.series:'all';
  if(series!=='all')rows=rows.filter(s=>s.title===series);
  const minHours=[3,5,8].includes(Number(options.minHours))?Number(options.minHours):5;
  const enriched=rows.filter(valid),timed=enriched.filter(s=>seconds(s)>=900&&!s.airtime_provisional&&Number(s.commercial.precise_orders??0)===Number(s.orders));
  const cohort=timed.filter(s=>seconds(s)>=minHours*3600),starts=group(cohort,s=>etHour(s.scheduled_start||s.starts_at)).sort(([a],[b])=>dayMode==='night'?(a+6)%24-(b+6)%24:a-b);
  const clock=Array.from({length:24},(_,h)=>{
   const entries=timed.map(s=>({s,hours:exposure(s,h)})).filter(r=>r.hours>=1-1e-9);
   return {hour:h,n:entries.length,net:median(entries.map(({s,hours})=>sum((s.commercial.clocks||[]).filter(c=>c.hour===h),'net')/hours))};
  }).filter(r=>r.n);
  const merchandise=enriched.flatMap(s=>(s.commercial.merchandise||[]).map(r=>({...r,event:s.event_id})));
  const priceOrder=['Under $100','$100-$499','$500-$999','$1,000-$4,999','$5,000+','Price unavailable'];
  const mix=key=>group(merchandise,key).map(([name,a])=>({name,shows:new Set(a.map(s=>s.event)).size,lines:sum(a,'lines'),units:sum(a,'units'),pricedUnits:sum(a,'priced_units'),sales:sum(a,'priced_lines')?sum(a,'original_sales'):null,identifiedLines:sum(a.filter(r=>r.evidence!=='Not identified'),'lines')}));
  const brands=mix(r=>r.category+' · '+r.brand).sort((a,b)=>(b.sales||0)-(a.sales||0));
  const prices=mix(r=>r.price_band).sort((a,b)=>priceOrder.indexOf(a.name)-priceOrder.indexOf(b.name));
  const asOf=Date.parse(history.as_of),age=s=>Math.max(0,Math.floor((asOf-Date.parse(s.scheduled_start||s.starts_at))/86400000));
  const retention=[['Under 30 days',0,30],['30–59 days',30,60],['60–89 days',60,90],['90–179 days',90,180],['180–364 days',180,365],['365+ days',365,Infinity]].map(([name,low,high])=>{
   const a=rows.filter(s=>age(s)>=low&&age(s)<high),booked=sum(a,'booked'),net=sum(a,'net');return {name,n:a.length,booked,cancelled:sum(a,'cancelled'),refunded:sum(a,'refunded'),held:sum(a,'held'),net,retained:ratio(net,booked)};
  }).filter(r=>r.n);
  const buckets=group(rows,s=>etHour(s.scheduled_start||s.starts_at)).sort(([a],[b])=>dayMode==='night'?(a+6)%24-(b+6)%24:a-b);
  const audience=buckets.map(([start,a])=>{const complete=a.filter(s=>s.insights?.sales_status==='ready'&&Number.isFinite(s.insights?.total_viewers)&&Number.isFinite(s.insights?.purchasers));return {start,n:complete.length,total:a.length,viewers:median(complete.map(s=>s.insights.total_viewers)),buyers:median(complete.map(s=>s.insights.purchasers)),conversion:median(complete.map(s=>ratio(s.insights.purchasers,s.insights.total_viewers))),returning:median(complete.map(s=>Number.isFinite(s.insights.returning_viewers_percent)?s.insights.returning_viewers_percent/100:null)),followers:median(complete.map(s=>s.insights.new_followers))};});
  const concentration=buckets.map(([start,a])=>{const orders=a.filter(valid).filter(s=>s.net>0),buyers=orders.filter(s=>s.commercial.missing_buyer_orders===0&&s.commercial.largest_buyer_net!=null),rates=orders.filter(s=>s.rate!=null);return {start,n:orders.length,buyerN:buyers.length,largestOrder:median(orders.map(s=>ratio(s.commercial.largest_order_net,s.net))),largestBuyer:median(buyers.map(s=>ratio(s.commercial.largest_buyer_net,s.net))),topThree:median(orders.map(s=>ratio(s.commercial.top_three_orders_net,s.net))),rate:median(rates.map(s=>s.rate)),withoutOrder:median(rates.map(s=>(s.net-s.commercial.largest_order_net)/(seconds(s)/3600))),withoutBuyer:median(buyers.filter(s=>s.rate!=null).map(s=>(s.net-s.commercial.largest_buyer_net)/(seconds(s)/3600)))};});
  const calendar=key=>group(rows,key).map(([name,a])=>({name,n:a.length,months:new Set(a.map(s=>s.month)).size,net:median(a.map(s=>s.net)),rate:median(a.map(s=>s.rate)),starts:group(a,s=>etHour(s.scheduled_start||s.starts_at)).sort(([a],[b])=>a-b).map(([h,r])=>hour(h)+': '+r.length).join(' · ')}));
  const sunday=calendar(s=>s.weekday===6?String(Math.ceil(Number(s.day.slice(8))/7)):'Other weekdays').sort((a,b)=>a.name.localeCompare(b.name));
  const matched=[];
  for(const [start,a] of buckets){const lifts=[];let targets=0,controls=0;
   for(const [,peers] of group(rows,s=>[s.month,s.weekday,s.weekday===6?Math.ceil(Number(s.day.slice(8))/7):s.phase,s.title].join('|'))){
    const yes=peers.filter(s=>etHour(s.scheduled_start||s.starts_at)===start&&s.rate!=null),no=peers.filter(s=>etHour(s.scheduled_start||s.starts_at)!==start&&s.rate!=null);
    if(yes.length<2||no.length<2)continue;const baseline=median(no.map(s=>s.rate));if(!(baseline>0))continue;
    lifts.push(median(yes.map(s=>s.rate))/baseline-1);targets+=yes.length;controls+=no.length;
   }
   matched.push({start,n:a.length,groups:lifts.length,targets,controls,lift:lifts.length>=3?median(lifts):null});
  }
  return {history,period,names,seller,format,weekday,dayMode,series,titles,minHours,rows,enriched,timed,cohort,starts,clock,brands,prices,retention,audience,concentration,sunday,seasons:calendar(s=>season(s.month)),matched,
   halves:timing(cohort,1,minHours*2),hours:timing(timed,2,Math.min(14,Math.floor(Math.max(0,...timed.map(seconds))/3600))),
   selected:usable.filter(s=>s.day>=period.from&&s.day<=period.through&&s.seller===seller).length,missingDetails:rows.length-enriched.length,identifiedLines:sum(merchandise.filter(r=>r.evidence!=='Not identified'),'lines'),lines:sum(merchandise,'lines')};
 }
 function select(label,key,value,values){return '<label>'+label+'<select data-sca-filter="'+key+'" aria-label="'+label+'">'+values.map(([v,t])=>'<option value="'+esc(v)+'"'+(String(v)===String(value)?' selected':'')+'>'+esc(t)+'</option>').join('')+'</select></label>';}
 function render(history,period,options){
  const m=build(history,period,options);
  const controls='<div class="sca-controls">'+select('Analysis streamer','seller',m.seller,m.names.map(n=>[n,n]))+select('Show group','format',m.format,[['all','All show titles'],['Watch-focused title','Watch-focused titles'],['Other jewelry title','Other jewelry titles'],['Trading cards','Trading cards']])+select('Start weekday','weekday',m.weekday,[['all','All weekdays'],...weekdays.map((w,i)=>[String(i),w])])+select('Show series','series',m.series,[['all','All matching titles'],...m.titles.map(t=>[t,t])])+select('Timing comparison length','minHours',m.minHours,[[3,'First 3 hours'],[5,'First 5 hours'],[8,'First 8 hours']])+'</div>';
  const scope=esc(m.seller)+' · '+esc(m.format==='all'?'All show titles':m.format)+' · '+esc(m.weekday==='all'?'All weekdays':weekdays[Number(m.weekday)])+' · '+esc(m.series==='all'?'All matching titles':m.series)+' · '+(m.dayMode==='night'?'Selling nights · 6 PM–6 AM':'Calendar start dates');
  const mode=select('Show day grouping','dayMode',m.dayMode,[['calendar','Calendar start date'],['night','Selling night · 6 PM–6 AM']]);
  const head='<h2>07 · What drives show results</h2>'+controls.replace('</div>','<div class="sca-day-mode">'+mode+'</div></div>')+'<p class="sca-scope"><strong>'+scope+'</strong><br>Prior shows only, before '+esc(period.from)+'. '+countLabel(m.rows.length)+'; '+countLabel(m.timed.length)+' with complete timestamp coverage and finalized airtime.</p><p class="wpr-note">'+(m.dayMode==='night'?'Selling nights use Eastern start times from 6 PM inclusive to 6 AM exclusive the following morning. Tuesday at 2 AM belongs to Monday night. Weekday, month and month-position filters use the evening date. Daytime starts are excluded; each qualifying show keeps all of its sales and airtime, even after 6 AM. Actual scheduled timestamps stay visible. This mode applies to Show insights; earlier report sections retain calendar dates.':'Calendar mode assigns every show to its Eastern start date, including all overnight sales.')+'</p>';
  if(!m.rows.length)return head+'<p class="wpr-warning">No usable prior shows match these filters. Choose another show group, weekday or streamer.</p>';
  const max=Math.max(1,...m.halves.map(h=>h.net||0));
  let heat='';
  for(let offset=0;offset<m.minHours*2;offset+=8){const count=Math.min(8,m.minHours*2-offset);
   heat+=table(['Start hour · Eastern','Shows',...Array.from({length:count},(_,i)=>{const b=i+offset;return b*30+'–'+(b+1)*30+' min';})],m.starts.map(([h,rows])=>[hour(h),String(rows.length),...Array.from({length:count},(_,i)=>{const value=median(rows.map(s=>halfAmount(s,i+offset)));return '<span class="sca-heat" style="--shade:'+Math.min(.85,.08+(value||0)/max*.55).toFixed(2)+'">'+money(value)+'</span>';})]),'sca-heatmap');
  }
  const rhythm=block('Sales throughout the show','Each cell is median net sales in a 30-minute block after the scheduled start. Every row uses only shows lasting at least '+m.minHours+' hours ('+countLabel(m.cohort.length)+'), including zero-sale blocks. Scheduled starts are not verified actual go-live times. Show links may be estimated.',m.cohort.length?heat:'<p>No shows have the complete airtime needed for this comparison. Try a shorter timing comparison.</p>');
  const clock=block('Clock time across midnight','Median net revenue per hour among shows covering the entire clock hour. These are different show samples across hours; merchandise sequence and season can explain differences. Eastern time; repeated DST hours use their actual exposure.',table(['Clock hour','Shows covering full hour','Median net / hour'],m.clock.map(r=>[hour(r.hour)+'–'+hour((r.hour+1)%24),String(r.n),money(r.net)])));
  const mixRows=a=>a.map(r=>[esc(r.name),String(r.shows),num(r.units),money(r.sales),money(ratio(r.sales,r.pricedUnits))]);
  const mix=block('Merchandise mix and selling price',num(m.identifiedLines)+' of '+num(m.lines)+' item lines have staff or linked-inventory identification. Brand is never guessed from the show title. Amounts below are original item sales; order-level returns are not allocated to brands. These describe sold inventory, not everything offered.',table(['Item / brand','Shows','Units','Original sales','Mean price / priced unit'],mixRows(m.brands))+table(['Sold unit price band','Shows','Units','Original sales','Mean price / priced unit'],mixRows(m.prices))+'<p class="wpr-note">Condition, reference, offered value and unsold stock are not consistently recorded. A higher selling price does not establish better performance on comparable watches.</p>');
  const retention=block('Sales retained after cancellations and returns','Current balances grouped by show age at this snapshot. Younger shows remain separate. These are not exact day-30 outcomes: complete dated cancellation and review history is unavailable, so historical balances at equal follow-up ages cannot be reconstructed reliably.',table(['Age at snapshot','Shows','Original','Canceled','Refunded','Under review','Current net','Retained'],m.retention.map(r=>[r.name,String(r.n),money(r.booked),money(r.cancelled),money(r.refunded),money(r.held),money(r.net),pct(r.retained)])));
  const duration=block('What later hours contribute','Median net sales and order count for each complete elapsed hour. Only shows still running for the whole hour qualify; later rows can represent a different mix of shows. These amounts are revenue before fees, inventory cost and streaming costs, not profit or a recommendation to stop.',table(['Elapsed hour','Eligible shows','Median net in hour','Median orders'],m.hours.map(r=>[String(r.index+1),String(r.n),money(r.net),num(r.orders)]))+'<p class="wpr-note">A consistent show-cost record is not available. Contribution after streaming costs and profit cannot yet be calculated.</p>');
  const audience=block('Audience and buyer conversion','Finalized eBay Studio metrics from the same shows within each start-hour group. Conversion is purchasers divided by viewers per show, then the median; missing values remain unavailable. Viewers across shows are not unique people. Returning viewers are not the same as repeat buyers.',table(['Start hour','Shows with metrics','Median viewers','Median buyers','Buyer conversion','Returning viewers','New followers'],m.audience.map(r=>[hour(r.start),r.n+' / '+r.total,num(r.viewers),num(r.buyers),pct(r.conversion),pct(r.returning),num(r.followers)])));
  const concentration=block('Dependence on large purchases','Per-show median shares of current net sales. The sensitivity columns remove each show’s largest order or largest known buyer and recompute sales per hour. Buyer results require complete buyer identification. An order can contain several items.',table(['Start hour','Shows / buyer-complete','Largest order share','Top 3 orders share','Largest buyer share','Net / hour','Without largest order','Without largest buyer'],m.concentration.map(r=>[hour(r.start),r.n+' / '+r.buyerN,pct(r.largestOrder),pct(r.topThree),pct(r.largestBuyer),money(r.rate),money(r.withoutOrder),money(r.withoutBuyer)])));
  const calendarRows=a=>a.map(r=>[esc(r.name),String(r.n),String(r.months),money(r.net),money(r.rate),esc(r.starts)]);
  const calendar=block('Season and Sunday position','Descriptive comparisons within the selected streamer and show filters. Season groups use winter (Dec–Feb), spring, summer and fall. Dates follow the selected calendar / selling-night mode. Sunday position means first, second, third, fourth or fifth Sunday of that grouping month.',table(['Season','Shows','Months','Median net / show','Median net / hour','Start-hour samples'],calendarRows(m.seasons))+table(['Sunday position','Shows','Months','Median net / show','Median net / hour','Start-hour samples'],calendarRows(m.sunday.map(r=>({...r,name:r.name==='Other weekdays'?r.name:['','First Sunday','Second Sunday','Third Sunday','Fourth Sunday','Fifth Sunday'][Number(r.name)]})))));
  const adjusted=block('Calendar-matched timing evidence','Matching requires the same calendar month and year, weekday, Sunday position (or month phase on other days), and exact show title. Each comparison needs two shows per start group and at least three repeated groups. One Sunday per month usually leaves no within-month comparison at the same Sunday position. A missing result is not a zero effect.',table(['Start hour','Shows','Comparable groups','Matched shows / controls','Median hourly difference'],m.matched.map(r=>[hour(r.start),String(r.n),String(r.groups),r.targets+' / '+r.controls,r.lift==null?'Insufficient evidence':pct(r.lift)]))+'<p class="wpr-note">These controls do not remove differences in inventory, promotions or audience. Use a balanced prospective test across Sunday positions; a year-round optimum has not been established.</p>');
  return head+'<p class="wpr-note">'+sum(m.rows,'estimated_orders')+' of '+sum(m.rows,'orders')+' order-to-show links are estimated. '+m.rows.filter(s=>s.seller_source==='time_rule').length+' host assignments are estimated. '+m.missingDetails+' shows lack detailed evidence. '+sum(m.enriched,s=>s.commercial.before_start_orders||0)+' orders precede the listed start; '+sum(m.enriched,s=>s.commercial.after_duration_orders||0)+' fall beyond the duration. Both are excluded from timing tables.</p>'+(window.StreamerDistributions?window.StreamerDistributions.render(m,options):'')+rhythm+mix+retention+duration+clock+audience+concentration+calendar+adjusted;
 }
 function csvRows(history,period,options){
  const m=build(history,period,options),r=[[],['What drives show results','Streamer',m.seller,'Show group',m.format,'Weekday',m.weekday,'Series',m.series,'Day grouping',m.dayMode],['Prior baseline ends before',period.from,'Snapshot',history.as_of,'Usable shows',m.rows.length,'Timing cohort hours',m.minHours],['Timing method','Scheduled starts; estimated links possible; only complete intervals; current net before fees and costs'],[],['Elapsed 30-minute block','Common cohort shows','Median net sales','Median orders']];
  for(const x of m.halves)r.push([x.index*30+'–'+(x.index+1)*30+' minutes',x.n,x.net,x.orders]);
  r.push([],['Start hour Eastern','Elapsed minutes','Common cohort shows','Median net sales']);
  for(const [h,a] of m.starts)for(let b=0;b<m.minHours*2;b++)r.push([hour(h),b*30,a.length,median(a.map(s=>halfAmount(s,b)))]);
  r.push([],['Clock hour Eastern','Full-hour shows','Median net per hour']);for(const x of m.clock)r.push([hour(x.hour),x.n,x.net]);
  r.push([],['Elapsed hour','Eligible shows','Median net sales','Median orders']);for(const x of m.hours)r.push([x.index+1,x.n,x.net,x.orders]);
  r.push([],['Merchandise / sold-price group','Shows','Units','Priced units','Original sales','Identified lines']);for(const x of [...m.brands,...m.prices])r.push([x.name,x.shows,x.units,x.pricedUnits,x.sales,x.identifiedLines]);
  r.push([],['Retention method','Current balances by age; exact fixed-day historical outcomes unavailable'],['Age at snapshot','Shows','Original','Canceled','Refunded','Under review','Current net','Retained fraction']);for(const x of m.retention)r.push([x.name,x.n,x.booked,x.cancelled,x.refunded,x.held,x.net,x.retained]);
  r.push([],['Audience start hour','Complete shows','All shows','Median viewers','Median purchasers','Median conversion fraction','Median returning viewer fraction','Median new followers']);for(const x of m.audience)r.push([hour(x.start),x.n,x.total,x.viewers,x.buyers,x.conversion,x.returning,x.followers]);
  r.push([],['Concentration start hour','Shows','Buyer-complete shows','Median largest order share','Median top-three orders share','Median largest buyer share','Median net per hour','Without largest order per hour','Without largest buyer per hour']);for(const x of m.concentration)r.push([hour(x.start),x.n,x.buyerN,x.largestOrder,x.topThree,x.largestBuyer,x.rate,x.withoutOrder,x.withoutBuyer]);
  r.push([],['Calendar group','Shows','Months','Median net per show','Median net per hour','Start-hour samples']);for(const x of [...m.seasons,...m.sunday.map(s=>({...s,name:'Sunday position: '+s.name}))])r.push([x.name,x.n,x.months,x.net,x.rate,x.starts]);
  r.push([],['Matched start hour','Shows','Comparable groups','Matched shows','Control shows','Median fractional difference']);for(const x of m.matched)r.push([hour(x.start),x.n,x.groups,x.targets,x.controls,x.lift]);
  r.push([],['Show detail','Event ID','Title','Scheduled start','Item category','Brand','Identification evidence','Unit price band','Lines','Units','Priced units','Original sales']);for(const s of m.rows)for(const x of s.commercial?.merchandise||[])r.push(['Merchandise',s.event_id,s.title,s.scheduled_start,x.category,x.brand,x.evidence,x.price_band,x.lines,x.units,x.priced_units,x.original_sales]);
  if(window.StreamerDistributions)r.push(...window.StreamerDistributions.csvRows(m,options));
  return r;
 }
 window.StreamerCommercialAnalysis={build,render,csvRows,timing,exposure,season,showDay};
})();
