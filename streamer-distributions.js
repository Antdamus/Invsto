/* Show-level empirical distributions. No fitted distribution or causal timing claim. */
(() => {
 'use strict';
 const zone='America/New_York';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
 const amount=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2}).format(n);
 const hour=n=>(n%12||12)+(n<12?' AM':' PM');
 const hourLabel=n=>hour(n)+'–'+(n%12||12)+':59'+(n<12?' AM':' PM');
 const stamp=s=>new Date(s).toLocaleString('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const monthLabel=s=>new Date(s+'-01T12:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',year:'numeric'});
 const phaseNames=['Early · days 1–10','Middle · days 11–20','Late · days 21–end'];
 const weekdayNames=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
 const weekdayColors=['#356d52','#456d9c','#947127','#855a87','#a65b3f','#4a7e80','#696242'];
 const count=n=>n+' '+(n===1?'show':'shows');
 const weekdayCounts=rows=>weekdayNames.map((name,i)=>({name,n:rows.filter(s=>s.weekday===i).length}));
 const weekdaySummary=rows=>weekdayCounts(rows).filter(w=>w.n).map(w=>w.name+' '+w.n).join(' · ');
 const ordinal=n=>['','1st','2nd','3rd','4th','5th'][n];
 const weekday=s=>new Date(s.day+'T12:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long'});
 const occurrence=s=>ordinal(s.occurrence)+' '+weekday(s);
 const dateLabel=day=>new Date(day+'T12:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});
 function dayCaption(s){
  if(s.day_mode!=='night')return dateLabel(s.day);
  const next=new Date(s.day+'T12:00Z');next.setUTCDate(next.getUTCDate()+1);
  return dateLabel(s.day)+' 6 PM → '+dateLabel(next.toISOString().slice(0,10))+' 6 AM';
 }
 const quantile=(a,p)=>{const v=a.filter(Number.isFinite).sort((a,b)=>a-b),i=(v.length-1)*p;return v.length?v[Math.floor(i)]+(v[Math.ceil(i)]-v[Math.floor(i)])*(i%1):null;};
 function stats(rows){const a=rows.map(r=>r.value).filter(Number.isFinite);return {n:a.length,min:a.length?Math.min(...a):null,max:a.length?Math.max(...a):null,median:quantile(a,.5),mean:a.length?a.reduce((x,y)=>x+y,0)/a.length:null,q1:quantile(a,.25),q3:quantile(a,.75)};}
 function edges(values,target=8){
  const a=values.filter(Number.isFinite);if(!a.length)return [];
  const min=Math.min(...a),max=Math.max(...a),raw=(max-min||Math.max(Math.abs(max)*.2,1))/target;
  const power=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].find(n=>n*power>=raw)*power;
  const width=Math.max(.01,step),low=Math.floor(min/width)*width,count=Math.max(1,Math.ceil((max-low)/width));
  return Array.from({length:count+1},(_,i)=>Number((low+i*width).toFixed(8)));
 }
 function binIndex(value,bounds){
  if(!Number.isFinite(value)||bounds.length<2||value<bounds[0]||value>bounds.at(-1))return -1;
  return Math.min(bounds.length-2,Math.floor((value-bounds[0])/(bounds[1]-bounds[0])+1e-10));
 }
 function bins(rows,bounds){return bounds.slice(0,-1).map((low,i)=>{const a=rows.filter(r=>binIndex(r.value,bounds)===i);return {index:i,low,high:bounds[i+1],last:i===bounds.length-2,rows:a,weekdays:weekdayCounts(a)};});}
 const metricAmount=(n,metric,short=false)=>n==null?'—':metric?.startsWith('audience:')?metric==='audience:conversion'?n.toFixed(2)+'%':metric==='audience:average_viewing_seconds'?Math.floor(Math.round(n)/60)+'m '+Math.round(n)%60+'s':new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(n):short?money(n):amount(n);
 const range=(b,metric)=>metricAmount(b.low,metric)+' to '+(b.last?'':'under ')+metricAmount(b.high,metric);
 const duration=n=>n==null?'Not recorded':Math.floor(n/3600)+'h '+String(Math.floor(n%3600/60)).padStart(2,'0')+'m '+String(Math.floor(n%60)).padStart(2,'0')+'s';
 const finite=n=>n!=null&&Number.isFinite(Number(n));
 function audienceMetrics(s){
  const i=s.insights||{},ready=i.status==='ready'||(i.status==null&&i.sales_status==='ready');
  const result=Object.fromEntries(['total_viewers','peak_viewers','average_viewing_seconds','purchasers','new_followers'].map(k=>[k,ready&&finite(i[k])?Number(i[k]):null]));
  return {...result,conversion:result.total_viewers>0&&result.purchasers!=null?result.purchasers/result.total_viewers*100:null};
 }
 function audienceSummary(s){const a=audienceMetrics(s);return '<div class="sde-audience">'+[['Total viewers',a.total_viewers,'total_viewers'],['Peak concurrent',a.peak_viewers,'peak_viewers'],['Avg viewing time',a.average_viewing_seconds,'average_viewing_seconds'],['Purchasers',a.purchasers,'purchasers'],['Buyer conversion',a.conversion,'conversion'],['New followers',a.new_followers,'new_followers']].map(([label,value,key])=>'<span>'+label+' <b>'+metricAmount(value,'audience:'+key)+'</b></span>').join('')+'</div>';}
 function finance(s){
  const keys=['booked','cancelled','refunded','held','net'],complete=keys.every(k=>finite(s[k]));
  const values=Object.fromEntries(keys.map(k=>[k,finite(s[k])?Number(s[k]):null]));
  return {...values,complete,reconciled:complete&&Math.abs(values.booked-values.cancelled-values.refunded-values.held-values.net)<.011};
 }
 function elapsedHours(s){
  const c=s.commercial,seconds=Number(s.airtime_seconds);
  const available=c?.version===1&&Number(c.orders)===Number(s.orders)&&Number(c.precise_orders??0)===Number(s.orders)&&seconds>=900&&!s.airtime_provisional;
  if(!available)return {available:false,rows:[],outsideNet:null};
  const rows=Array.from({length:Math.ceil(seconds/3600)},(_,index)=>{
   const exposure=Math.min(3600,seconds-index*3600),halves=(c.halves||[]).filter(b=>Number(b.bin)>=index*2&&Number(b.bin)<(index+1)*2);
   const net=halves.reduce((n,b)=>n+Number(b.net||0),0),orders=halves.reduce((n,b)=>n+Number(b.orders||0),0);
   const booked=halves.every(b=>finite(b.booked))?halves.reduce((n,b)=>n+Number(b.booked),0):null;
   return {index,exposure,complete:exposure===3600,net,booked,orders,rate:net/(exposure/3600)};
  });
  return {available:true,rows,outsideNet:Number(s.net)-rows.reduce((n,r)=>n+r.net,0)};
 }
 function monthly(rows){
  if(!rows.length)return [];
  const months=rows.map(s=>s.month).sort(),result=[],end=months.at(-1);
  for(let month=months[0];month<=end;){
   result.push({month,rows:rows.filter(s=>s.month===month)});
   const date=new Date(month+'-01T12:00Z');date.setUTCMonth(date.getUTCMonth()+1);month=date.toISOString().slice(0,7);
  }
  return result;
 }
 function build(m,options={}){
  const completeHours=Math.floor(Math.max(0,...m.timed.map(s=>Number(s.airtime_seconds)))/3600);
  const metrics=[['net','Net sales per show'],['rate','Net sales per streaming hour'],['booked','Original sales per show'],['cancelled','Canceled sales per show'],['refunded','Refunded sales per show'],['held','Under review per show'],['audience:total_viewers','Total viewers per show'],['audience:peak_viewers','Peak concurrent viewers'],['audience:average_viewing_seconds','Average viewing time'],['audience:purchasers','Purchasers per show'],['audience:conversion','Buyer conversion'],['audience:new_followers','New followers per show'],...Array.from({length:completeHours},(_,i)=>['elapsed:'+i,'Net sales · hour '+(i+1)+' ('+i+'–'+(i+1)+'h)']),...Array.from({length:m.minHours*2},(_,i)=>['half:'+i,'Minutes '+(i*30)+'–'+((i+1)*30)+' after start'])];
  const metric=metrics.some(([v])=>v===options.distMetric)?options.distMetric:'net',label=metrics.find(([v])=>v===metric)[1];
  const cohort=new Set(m.cohort.map(s=>s.event_id));
  const eligible=m.rows.map(s=>{
   const start=s.scheduled_start||s.starts_at;
   let value=['net','rate','booked','cancelled','refunded','held'].includes(metric)&&finite(s[metric])?Number(s[metric]):null;
   if(metric.startsWith('audience:'))value=audienceMetrics(s)[metric.slice(9)];
   if(metric.startsWith('elapsed:')){const h=elapsedHours(s).rows[Number(metric.slice(8))];value=h?.complete?h.net:null;}
   if(metric.startsWith('half:')&&cohort.has(s.event_id))value=(s.commercial.halves||[]).filter(r=>Number(r.bin)===Number(metric.slice(5))).reduce((n,r)=>n+Number(r.net||0),0);
   return {...s,start,startHour:Number(new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).format(new Date(start))),occurrence:Math.ceil(Number(s.day.slice(8))/7),value};
  }).filter(s=>Number.isFinite(s.value));
  const months=[...new Set(eligible.map(s=>s.month))].sort();
  const month=months.includes(options.distMonth)?options.distMonth:'all';
  const phase=['0','1','2'].includes(options.distPhase)?options.distPhase:'all';
  const nth=['1','2','3','4','5'].includes(options.distOccurrence)?options.distOccurrence:'all';
  const calendar=eligible.filter(s=>(phase==='all'||s.phase===Number(phase))&&(nth==='all'||s.occurrence===Number(nth)));
  const population=calendar.filter(s=>month==='all'||s.month===month);
  const sortHour=(a,b)=>m.dayMode==='night'?(a+6)%24-(b+6)%24:a-b;
  const monthStarts=[...new Set(calendar.map(s=>s.startHour))].sort(sortHour);
  const monthGroups=monthly(calendar).map(g=>({...g,cells:monthStarts.map(h=>{const rows=g.rows.filter(s=>s.startHour===h);return {hour:h,rows,stats:stats(rows)};})}));
  const starts=[...new Set(population.map(s=>s.startHour))].sort(sortHour);
  const start=starts.some(h=>String(h)===options.distStart)?options.distStart:'all';
  const rows=population.filter(s=>start==='all'||s.startHour===Number(start)).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.event_id.localeCompare(b.event_id));
  const target=[5,8,12].includes(Number(options.distBins))?Number(options.distBins):8;
  const scale=options.distScale==='shared'?'shared':'fit',sharedBounds=edges(population.map(s=>s.value),target);
  const bounds=scale==='shared'?sharedBounds:edges(rows.map(s=>s.value),target),histogram=bins(rows,bounds);
  const sharedMax=Math.max(1,...bins(population,sharedBounds).map(b=>b.rows.length));
  const maxCount=scale==='shared'?sharedMax:Math.max(1,...histogram.map(b=>b.rows.length));
  const groups=starts.map(h=>{const a=population.filter(s=>s.startHour===h),bounds=scale==='shared'?sharedBounds:edges(a.map(s=>s.value),target),hist=bins(a,bounds);return {hour:h,rows:a,stats:stats(a),bounds,bins:hist,maxCount:scale==='shared'?sharedMax:Math.max(1,...hist.map(b=>b.rows.length))};});
  const selectedBin=options.distBin!=null&&histogram[Number(options.distBin)]?.rows.length?histogram[Number(options.distBin)]:null;
  const selectedShow=rows.find(s=>s.event_id===options.distShow)||null;
  const selectedRows=selectedShow?[selectedShow]:selectedBin?selectedBin.rows:rows;
  const daily=[...new Set(rows.map(s=>s.day))].sort().map(day=>{const shows=rows.filter(s=>s.day===day),total=k=>shows.every(s=>finite(s[k]))?shows.reduce((n,s)=>n+Number(s[k]),0):null,airtime=shows.every(s=>s.airtime_seconds>=900&&!s.airtime_provisional)?total('airtime_seconds'):null;return {day,caption:dayCaption(shows[0]),shows,airtime,rate:airtime?total('net')/(airtime/3600):null,...Object.fromEntries(['booked','cancelled','refunded','held','net'].map(k=>[k,total(k)]))};});
  return {metric,label,metrics,eligible,months,month,phase,nth,starts,start,target,scale,population,rows,bounds,histogram,groups,maxCount,stats:stats(rows),excluded:m.rows.length-eligible.length,selectedBin,selectedShow,selectedRows,minHours:m.minHours,monthGroups,monthStarts,dayMode:m.dayMode,daily};
 }
 const select=(label,key,value,values)=>'<label>'+label+'<select data-sca-filter="'+key+'" aria-label="'+label+'">'+values.map(([v,t])=>'<option value="'+esc(v)+'"'+(String(v)===String(value)?' selected':'')+'>'+esc(t)+'</option>').join('')+'</select></label>';
 const miniStats=(s,metric)=>'<span><b>'+s.n+'</b> shows</span><span>Median <b>'+metricAmount(s.median,metric,true)+'</b></span><span>Mean <b>'+metricAmount(s.mean,metric,true)+'</b></span><span>Middle 50% <b>'+metricAmount(s.q1,metric,true)+'–'+metricAmount(s.q3,metric,true)+'</b></span>';
 const weekdayChips=rows=>'<div class="sde-weekdays" aria-label="Show counts by weekday">'+weekdayCounts(rows).map((w,i)=>'<span><i style="background:'+weekdayColors[i]+'"></i>'+w.name+' <b>'+w.n+'</b></span>').join('')+'</div>';
 function financialSummary(s){const f=finance(s);return '<div class="sde-finance">'+[['Original sales',f.booked],['Canceled',f.cancelled],['Refunded',f.refunded],['Under review',f.held],['Current net sales',f.net]].map(([label,value])=>'<span>'+label+' <b>'+amount(value)+'</b></span>').join('')+'</div>'+(!f.reconciled?'<p class="wpr-warning">Financial breakdown needs verification.</p>':'');}
 function hourlyTable(s,compact=false){
  const h=elapsedHours(s);if(!h.available)return '<p class="wpr-note">Hourly sales unavailable: complete purchase timestamps and finalized airtime are required.</p>';
  return '<div class="wpr-table-wrap"><table class="sde-hourly"><thead><tr>'+['Hours after start','Live time',...(!compact?['Orders','Original sales']:[]),'Net sales','Net / live hour'].map(t=>'<th scope="col">'+t+'</th>').join('')+'</tr></thead><tbody>'+h.rows.map(r=>'<tr><th scope="row">'+r.index+'–'+(r.index+1)+'h'+(!r.complete?' · partial':'')+'</th><td>'+duration(r.exposure)+'</td>'+(!compact?'<td>'+r.orders+'</td><td>'+amount(r.booked)+'</td>':'')+'<td>'+amount(r.net)+'</td><td>'+amount(r.rate)+'</td></tr>').join('')+'</tbody></table></div>'+(Math.abs(h.outsideNet)>.01?'<p class="wpr-note">'+amount(h.outsideNet)+' of show net is outside the recorded timing window; it remains in the show total.</p>':'');
 }
 function showDetail(s){return '<section class="sde-show-detail" tabindex="-1"><h4>'+esc(s.title)+'</h4><p>'+esc(stamp(s.start))+' · '+esc(s.seller)+(s.day_mode==='night'?'<br>Selling night: '+esc(dayCaption(s)):'')+'</p><div class="sde-stats"><span>Recorded airtime <b>'+duration(s.airtime_seconds)+'</b></span><span>Average net / live hour <b>'+amount(s.rate)+'</b></span></div>'+financialSummary(s)+'<p class="wpr-note">Original sales − canceled − refunded − under review = current net sales. Under review is an excluded sales amount, not an eBay payout hold. Net sales are before fees and costs. Later refunds can change this snapshot.</p><h4>Audience and traffic</h4>'+audienceSummary(s)+'<p class="wpr-note">eBay reports these whole-show audience totals. Peak concurrent is the maximum watching at once; total viewers is not a simultaneous audience count. An hourly viewer curve is unavailable in the saved Insights and eBay CSV export. Missing metrics remain unavailable.</p><h4>Sales hour by hour</h4><p class="wpr-note">Elapsed from the scheduled start, including overnight hours. Zero-sale intervals are included when timestamp coverage is complete. The partial final hour uses its actual live time for the hourly rate. Cancellations and refunds reduce the original purchase interval, not the date of the adjustment.</p>'+hourlyTable(s)+'</section>';}
 function tooltip(rows,label,metric,key){return '<strong>'+esc(label)+'</strong><p>'+count(rows.length)+' · '+esc(metric)+'</p>'+weekdayChips(rows)+'<ol>'+rows.map(s=>'<li><b>'+esc(stamp(s.start))+' · '+esc(metricAmount(s.value,key))+'</b><span>'+esc(s.title)+'</span><small>'+esc(occurrence(s))+(s.day_mode==='night'?' night':'')+' · '+esc(phaseNames[s.phase])+'</small><span>Live '+duration(s.airtime_seconds)+' · Average net/hour '+amount(s.rate)+'</span>'+financialSummary(s)+audienceSummary(s)+'</li>').join('')+'</ol>'+(rows.length===1?hourlyTable(rows[0],true):'')+'<p class="sde-tip-hint">Select the bar or dot to open these records and hour-by-hour details.</p>';}
 function tooltipTemplates(d){
  let html=d.histogram.map(b=>'<template id="sde-tip-main-'+b.index+'">'+tooltip(b.rows,range(b,d.metric),d.label,d.metric)+'</template>').join('');
  for(const g of d.groups)html+=g.bins.map(b=>'<template id="sde-tip-'+g.hour+'-'+b.index+'">'+tooltip(b.rows,hourLabel(g.hour)+' · '+range(b,d.metric),d.label,d.metric)+'</template>').join('');
  html+=d.rows.map((s,i)=>'<template id="sde-tip-show-'+i+'">'+tooltip([s],s.title,d.label,d.metric)+'</template>').join('');
  return html;
 }
 function histogram(d){
  return '<div class="sde-hist-scroll"><div class="sde-hist" style="--bins:'+d.histogram.length+'">'+d.histogram.map(b=>'<button type="button" class="sde-bin" data-sde-bin="'+b.index+'" data-sde-tooltip="sde-tip-main-'+b.index+'" aria-pressed="'+(d.selectedBin?.index===b.index)+'" aria-label="'+esc(range(b,d.metric))+': '+count(b.rows.length)+'. '+esc(weekdaySummary(b.rows))+'. Show underlying dates."'+(b.rows.length?'':' disabled')+'><span class="sde-count">'+b.rows.length+'</span><span class="sde-bar-space"><span class="sde-bar" style="height:'+(b.rows.length/d.maxCount*100)+'%">'+b.weekdays.map((w,i)=>w.n?'<span style="height:'+(w.n/b.rows.length*100)+'%;background:'+weekdayColors[i]+'"></span>':'').join('')+'</span></span><span class="sde-range">'+esc(metricAmount(b.low,d.metric))+'<br>– '+(b.last?'':'&lt; ')+esc(metricAmount(b.high,d.metric))+'</span></button>').join('')+'</div></div>';
 }
 function miniHistogram(g,d){
  const w=280,h=80,bw=w/g.bins.length;
  return '<svg viewBox="0 0 280 84" role="group" aria-label="'+esc(hourLabel(g.hour))+': '+count(g.stats.n)+', median '+esc(metricAmount(g.stats.median,d.metric,true))+'">'+g.bins.map((b,i)=>{let used=0;return '<g'+(b.rows.length?' role="button" tabindex="0" data-sde-bin="'+b.index+'" data-sde-start="'+g.hour+'" data-sde-tooltip="sde-tip-'+g.hour+'-'+b.index+'" aria-label="'+esc(hourLabel(g.hour)+' · '+range(b,d.metric)+': '+count(b.rows.length)+'. '+weekdaySummary(b.rows))+'"':'')+'><rect x="'+i*bw+'" y="0" width="'+bw+'" height="82" fill="transparent"/>'+b.weekdays.map((day,j)=>{const height=day.n/g.maxCount*h;used+=height;return day.n?'<rect x="'+(i*bw+1)+'" y="'+(h-used)+'" width="'+Math.max(1,bw-2)+'" height="'+height+'" fill="'+weekdayColors[j]+'"/>':'';}).join('')+'</g>';}).join('')+'<line x1="0" y1="81" x2="280" y2="81" stroke="#8da697" pointer-events="none"/></svg><div class="sde-card-axis"><span>'+metricAmount(g.bounds[0],d.metric)+'</span><span>'+metricAmount(g.bounds.at(-1),d.metric)+'</span></div><small>0–'+g.maxCount+' shows per bar</small>';
 }
 function timeline(d){
  const left=78,right=872,top=20,bottom=205;
  const dates=d.rows.map(s=>Date.parse(s.start)),min=Math.min(...dates),max=Math.max(...dates);
  const low=Math.min(0,d.stats.min),high=Math.max(1,d.stats.max),x=t=>left+(max===min?.5:(t-min)/(max-min))*(right-left),y=v=>bottom-(v-low)/(high-low)*(bottom-top);
  const ticks=Array.from({length:5},(_,i)=>low+(high-low)*i/4);
  const dateTick=t=>new Date(t).toLocaleDateString('en-US',{timeZone:zone,month:'short',day:'numeric',year:'2-digit'});
  return '<div class="sde-timeline-scroll"><svg class="sde-timeline" viewBox="0 0 900 250" role="group" aria-label="Individual shows by scheduled start date and '+esc(d.label)+'"><title>Each dot is one show. Select it to inspect its date, start time and sales.</title>'+ticks.map(v=>'<line x1="'+left+'" x2="'+right+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#dce5de"/><text x="68" y="'+(y(v)+4)+'" text-anchor="end">'+esc(metricAmount(v,d.metric,true))+'</text>').join('')+[0,.25,.5,.75,1].filter((v,i)=>max!==min||i===2).map(p=>{const t=min+(max-min)*p;return '<text x="'+x(t)+'" y="230" text-anchor="middle">'+esc(dateTick(t))+'</text>';}).join('')+d.rows.map((s,i)=>'<circle cx="'+x(Date.parse(s.start))+'" cy="'+y(s.value)+'" r="5" fill="'+['#b07b22','#347657','#647a9a'][s.phase]+'" stroke="#fff" stroke-width="1" tabindex="0" role="button" data-sde-show="'+esc(s.event_id)+'" data-sde-tooltip="sde-tip-show-'+i+'" aria-label="'+esc(stamp(s.start)+' · '+occurrence(s)+' · '+d.label+' '+metricAmount(s.value,d.metric))+'"><title>'+esc(stamp(s.start)+'\n'+s.title+'\n'+occurrence(s)+' · '+phaseNames[s.phase]+'\n'+d.label+': '+metricAmount(s.value,d.metric))+'</title></circle>').join('')+'</svg></div><p class="sde-legend"><span>● Early · days 1–10</span><span>● Middle · days 11–20</span><span>● Late · days 21–end</span></p>';
 }
 function rowsTable(d){return '<div class="wpr-table-wrap"><table class="sde-shows"><thead><tr>'+['Show / scheduled start · Eastern','Month position','Airtime / net per hour','Sales / audience','Selected metric','Attribution'].map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+d.selectedRows.map(s=>'<tr><th scope="row"><a href="https://www.ebay.com/ebaylive/events/'+encodeURIComponent(s.event_id)+'?playback=true" target="_blank" rel="noopener">'+esc(s.title)+'</a><small>'+esc(stamp(s.start))+'</small><button type="button" data-sde-show="'+esc(s.event_id)+'">Hour-by-hour details</button></th><td>'+esc(occurrence(s))+(s.day_mode==='night'?' night':'')+'<small>'+esc(phaseNames[s.phase])+'</small></td><td>'+duration(s.airtime_seconds)+'<small>'+amount(s.rate)+' / hour</small></td><td>'+financialSummary(s)+'<small>Viewers '+metricAmount(audienceMetrics(s).total_viewers,'audience:total_viewers')+' · Peak '+metricAmount(audienceMetrics(s).peak_viewers,'audience:peak_viewers')+'</small></td><td>'+metricAmount(s.value,d.metric)+'</td><td>'+(s.seller_source==='time_rule'?'Estimated host':'Recorded / assigned host')+'<small>'+Number(s.estimated_orders||0)+' / '+Number(s.orders||0)+' order links estimated</small></td></tr>').join('')+'</tbody></table></div>';}
 function monthTable(d){
  const max=Math.max(1,...d.monthGroups.flatMap(g=>g.cells.map(c=>c.stats.median||0)));
  let html='<section class="sde-monthly"><h4>Month by month, at each start hour</h4><p class="wpr-note">'+esc(d.label)+': each cell shows the median and number of shows. Darker green means a higher median on this table’s shared scale. Streamer, show, weekday, month-part and occurrence filters apply; all months and start hours stay visible here. Select a cell to inspect its distribution and dates. Missing cells have no observations. Small samples, inventory differences and the time available for returns can create apparent seasonal changes.</p>';
  for(let offset=0;offset<d.monthStarts.length;offset+=6){const hours=d.monthStarts.slice(offset,offset+6);
   html+='<div class="wpr-table-wrap"><table class="sde-month-table"><thead><tr><th scope="col">Month</th>'+hours.map(h=>'<th scope="col">'+hour(h)+'</th>').join('')+'</tr></thead><tbody>'+d.monthGroups.map(g=>'<tr><th scope="row">'+monthLabel(g.month)+'</th>'+g.cells.slice(offset,offset+6).map(c=>'<td>'+(c.stats.n?'<button type="button" data-sde-month="'+g.month+'" data-sde-start="'+c.hour+'" aria-label="'+esc(monthLabel(g.month)+' · '+hourLabel(c.hour)+' · '+count(c.stats.n)+' · median '+metricAmount(c.stats.median,d.metric))+'" style="--shade:'+Math.max(.06,Math.min(.65,.06+(c.stats.median||0)/max*.59)).toFixed(2)+'"><b>'+metricAmount(c.stats.median,d.metric,true)+'</b><small>'+count(c.stats.n)+'</small></button>':'<span aria-label="No observations">—</span>')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  }
  return html+'</section>';
 }
 function dailyTable(d){return '<details class="sde-days"><summary>Compare '+d.daily.length+' '+(d.dayMode==='night'?'selling nights':'calendar dates')+'</summary><p class="wpr-note">Totals for the displayed shows only, after all filters. Each show counts once with its full linked sales and airtime. Missing or excluded shows are not zero sales. The hourly rate requires recorded airtime for every displayed show in the row. Expand this table to include it in print; CSV always includes these rows.</p><div class="wpr-table-wrap"><table><thead><tr>'+['Date / start window · Eastern','Shows','Live time','Original','Canceled','Refunded','Under review','Current net','Net / live hour'].map(t=>'<th scope="col">'+t+'</th>').join('')+'</tr></thead><tbody>'+d.daily.map(g=>'<tr><th scope="row">'+esc(g.caption)+'</th><td>'+g.shows.length+'</td><td>'+duration(g.airtime)+'</td>'+[g.booked,g.cancelled,g.refunded,g.held,g.net,g.rate].map(n=>'<td>'+amount(n)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></details>';}
 function render(m,options){
  const d=build(m,options);
  const controls=select('Distribution metric','distMetric',d.metric,d.metrics)+select('Start hour · Eastern','distStart',d.start,[['all','All start hours'],...d.starts.map(h=>[String(h),hourLabel(h)])])+select('Calendar month','distMonth',d.month,[['all','All available months'],...d.months.map(s=>[s,monthLabel(s)])])+select('Part of month','distPhase',d.phase,[['all','All parts of month'],...phaseNames.map((s,i)=>[String(i),s])])+select('Weekday occurrence in month','distOccurrence',d.nth,[['all','Any occurrence'],...[1,2,3,4,5].map(n=>[String(n),ordinal(n)+' occurrence'])])+select('Histogram detail','distBins',d.target,[[5,'About 5 bars'],[8,'About 8 bars'],[12,'About 12 bars']])+select('Histogram scale','distScale',d.scale,[['fit','Fit each selected range'],['shared','Shared for comparison']]);
  const scope=d.label+' · '+(d.start==='all'?'All start hours':hourLabel(Number(d.start)))+' · '+(d.month==='all'?'All months':monthLabel(d.month))+' · '+(d.phase==='all'?'All month parts':phaseNames[Number(d.phase)])+' · '+(d.nth==='all'?'Any weekday occurrence':ordinal(Number(d.nth))+' weekday occurrence');
  let html='<section class="sde-explorer" aria-label="Historical show distributions"><h3>See the distribution behind the median</h3><p class="wpr-note">One observation is one show. Net amounts are current merchandise sales after cancellations, refunds and excluded review amounts, before fees and costs.</p><div class="sde-weekday-focus" role="group" aria-label="Focus on a start weekday">'+[['all','All weekdays'],...weekdayNames.map((w,i)=>[String(i),w])].map(([v,t])=>'<button type="button" data-sde-weekday="'+v+'" aria-pressed="'+(m.weekday===v)+'">'+t+(m.dayMode==='night'&&v!=='all'?' → '+weekdayNames[(Number(v)+1)%7]:'')+'</button>').join('')+'</div><div class="sca-controls sde-controls">'+controls+'</div><p class="sde-scope"><strong>'+esc(m.seller+' · '+(m.weekday==='all'?'All weekdays':weekdayNames[Number(m.weekday)])+' · '+(m.dayMode==='night'?'Selling nights · 6 PM–6 AM':'Calendar dates')+' · '+scope)+'</strong><br>'+d.rows.length+' eligible shows displayed; '+d.excluded+' excluded for this metric before calendar filters. '+(d.metric.startsWith('half:')?'Uses the same complete '+d.minHours+'-hour cohort as the 30-minute table.':d.metric.startsWith('elapsed:')?'Only shows covering this entire elapsed hour with complete timestamps qualify. Later hours can contain different shows.':'Whole-show totals include all linked overnight sales.')+'</p>';
  if(!d.rows.length)return html+'<p class="wpr-warning">No usable shows match this distribution. Broaden the month or occurrence filters, or choose another metric.</p></section>';
  html+='<div class="sde-chart-panel"><div class="sde-stats">'+miniStats(d.stats,d.metric)+'<span>Full range <b>'+metricAmount(d.stats.min,d.metric,true)+'–'+metricAmount(d.stats.max,d.metric,true)+'</b></span></div><h4>How often each result range occurred</h4><p class="wpr-note">Vertical axis: number of shows. Horizontal axis: '+esc(d.label.toLowerCase())+' '+(d.metric.startsWith('audience:')?'':'(USD)')+'. Hover or focus a bar for its shows and weekday counts; select it to open the records. Colors show the weekday mix. Equal-width bins include all observations, including zeros and unusually large shows. The mean is the average; the median is the middle value.</p>'+weekdayChips(d.rows)+histogram(d)+'<p class="wpr-note">'+(d.rows.length<5?'Only '+d.rows.length+' shows: too few to judge the shape reliably. ':'')+'This is an observed distribution, not a fitted normal curve. '+(d.scale==='fit'?'Bins and count scales automatically fit the selected shows, including each start-hour card. Each chart labels its own range; bar heights across charts are not directly comparable.':'Result bins and count scales are shared across start hours for direct comparison.')+' Changing filters or bar detail can change the apparent shape.</p></div>';
  html+='<div class="sde-chart-panel"><h4>Which dates produced these results?</h4><p class="wpr-note">Each dot is one show; color marks its part of the month. Hover or focus for details, or select a dot to inspect that show. The timeline keeps actual scheduled timestamps. Weekday and month-position colors follow the selected calendar / selling-night mode. Starts are scheduled times, not verified actual go-live times.</p>'+timeline(d)+'</div>';
  const selection=d.selectedShow?'Selected show: '+stamp(d.selectedShow.start):d.selectedBin?'Selected sales range: '+range(d.selectedBin,d.metric):'All displayed shows';
  html+='<div class="sde-selection" role="status">'+esc(selection)+' · '+count(d.selectedRows.length)+(d.selectedBin||d.selectedShow?' <button type="button" data-sde-clear>Clear selection</button>':'')+'</div>'+weekdayChips(d.selectedRows)+((d.selectedShow||d.selectedBin)&&d.selectedRows.length===1?showDetail(d.selectedRows[0]):'')+'<details class="sde-records"'+(d.selectedBin||d.selectedShow?' open':'')+'><summary>Show the '+d.selectedRows.length+' underlying records</summary><p class="wpr-note">Selected metric: '+esc(d.label)+'. Selecting a bar or dot narrows this list only; chart statistics still describe all '+d.rows.length+' displayed shows. Expand this list to include it when printing. CSV includes financial breakdowns and hourly records. Original − canceled − refunded − under review = current net sales, before fees and costs.</p>'+rowsTable(d)+'</details>';
  html+='<div class="sde-chart-panel"><h4>Compare the spread at each start hour</h4><p class="wpr-note">'+(d.scale==='fit'?'Each card fits its own result range and show counts. Read the labeled axes; switch Histogram scale to Shared for comparison to align them.':'Every card uses the same result bins and count scale ('+metricAmount(d.bounds[0],d.metric)+'–'+metricAmount(d.bounds.at(-1),d.metric)+', 0–'+d.maxCount+' shows per bar).')+' Hover or focus any bar for individual show details and weekday counts. Calendar and metric filters apply; all start hours remain visible. Counts are not percentages.</p><div class="sde-small-multiples">'+d.groups.map(g=>'<section class="sde-card"><button type="button" data-sde-start="'+g.hour+'" aria-pressed="'+(d.start===String(g.hour))+'">'+hourLabel(g.hour)+' · '+count(g.stats.n)+'</button>'+miniHistogram(g,d)+'<p class="sde-card-weekdays">'+esc(weekdaySummary(g.rows))+'</p><p>Median <b>'+metricAmount(g.stats.median,d.metric,true)+'</b> · Mean '+metricAmount(g.stats.mean,d.metric,true)+'<br>Middle 50% '+metricAmount(g.stats.q1,d.metric,true)+'–'+metricAmount(g.stats.q3,d.metric,true)+'</p></section>').join('')+'</div></div>'+dailyTable(d)+monthTable(d)+tooltipTemplates(d)+'</section>';
  return html;
 }
 function csvRows(m,options){
  const d=build(m,options),r=[[],['Historical show distribution','Metric',d.label,'Start hour Eastern',d.start==='all'?'All':hourLabel(Number(d.start)),'Calendar month',d.month,'Month phase',d.phase,'Weekday occurrence',d.nth,'Target bins',d.target,'Scale',d.scale],['Population','Usable prior shows only; one show per observation; current net amounts before fees and costs','Day grouping',d.dayMode],['Distribution shows','Median','Mean','25th percentile','75th percentile','Minimum','Maximum'],[d.stats.n,d.stats.median,d.stats.mean,d.stats.q1,d.stats.q3,d.stats.min,d.stats.max],[],['Histogram lower bound inclusive','Upper bound','Upper bound inclusive','Shows',...weekdayNames]];
  for(const b of d.histogram)r.push([b.low,b.high,b.last?'Yes':'No',b.rows.length,...b.weekdays.map(w=>w.n)]);
  r.push([],['Start-hour distribution','Shows','Median','Mean','25th percentile','75th percentile',...weekdayNames]);for(const g of d.groups)r.push([hourLabel(g.hour),g.stats.n,g.stats.median,g.stats.mean,g.stats.q1,g.stats.q3,...weekdayCounts(g.rows).map(w=>w.n)]);
  r.push([],['Start-hour histogram','Lower bound inclusive','Upper bound','Upper bound inclusive','Shows',...weekdayNames]);for(const g of d.groups)for(const b of g.bins)r.push([hourLabel(g.hour),b.low,b.high,b.last?'Yes':'No',b.rows.length,...b.weekdays.map(w=>w.n)]);
  r.push([],['Weekday counts','Scope',...weekdayNames],['Shows','Displayed',...weekdayCounts(d.rows).map(w=>w.n)],['Shows','Selected records',...weekdayCounts(d.selectedRows).map(w=>w.n)]);
  r.push([],['Selected observations',d.selectedShow?'Event '+d.selectedShow.event_id:d.selectedBin?range(d.selectedBin,d.metric):'All displayed shows'],['Event ID','Title','Streamer','Scheduled start (source timestamp)','Scheduled start Eastern','Month','Part of month','Weekday occurrence','Airtime seconds','Current net sales','Metric','Value','Host evidence','Estimated order links','Linked orders']);
  r[r.length-1].push('Original sales','Canceled','Refunded','Under review','Average net per live hour','Financial breakdown reconciles','Grouped date','Day grouping','Total viewers','Peak concurrent viewers','Average viewing seconds','Purchasers','Buyer conversion percent','New followers');
  for(const s of d.selectedRows){const f=finance(s);r.push([s.event_id,s.title,s.seller,s.start,stamp(s.start),s.month,phaseNames[s.phase],occurrence(s),s.airtime_seconds,s.net,d.label,s.value,s.seller_source,s.estimated_orders,s.orders,f.booked,f.cancelled,f.refunded,f.held,s.rate,f.reconciled?'Yes':'Needs verification',s.day,s.day_mode,...['total_viewers','peak_viewers','average_viewing_seconds','purchasers','conversion','new_followers'].map(k=>audienceMetrics(s)[k])]);}
  r.push([],['Hourly method','Current net attributed to original purchase interval; elapsed from scheduled start; partial-hour rates use actual exposure; before fees and costs'],['Hourly show records','Event ID','Title','Hours after start','Live seconds','Complete hour','Orders','Original sales','Current net sales','Net per live hour']);
  for(const s of d.selectedRows){const h=elapsedHours(s);if(!h.available)r.push(['Unavailable',s.event_id,s.title]);else{for(const x of h.rows)r.push(['Elapsed hour',s.event_id,s.title,x.index+'–'+(x.index+1),x.exposure,x.complete?'Yes':'No',x.orders,x.booked,x.net,x.rate]);r.push(['Net outside timing window',s.event_id,s.title,'','','','','',h.outsideNet]);}}
  r.push([],['Month / start-hour comparison','All months and hours; selected streamer, weekday, series, month phase and occurrence'],['Month','Start hour Eastern','Shows','Metric','Median','25th percentile','75th percentile']);
  for(const g of d.monthGroups)for(const c of g.cells)r.push([g.month,hourLabel(c.hour),c.stats.n,d.label,c.stats.median,c.stats.q1,c.stats.q3]);
  r.push([],['Daily totals for displayed shows','Grouped date','Window','Shows','Live seconds','Original sales','Canceled','Refunded','Under review','Current net','Net per live hour']);
  for(const g of d.daily)r.push([d.dayMode,g.day,g.caption,g.shows.length,g.airtime,g.booked,g.cancelled,g.refunded,g.held,g.net,g.rate]);
  return r;
 }
 let tooltipId=0;
 function bind(root,modal){
  const tip=document.createElement('div');tip.className='sde-tooltip';tip.id='sde-tooltip-'+(++tooltipId);tip.hidden=true;tip.setAttribute('role','tooltip');tip.tabIndex=0;modal.append(tip);
  let trigger=null,timer=null,dismissed=null;
  const clearTimer=()=>{if(timer!=null)clearTimeout(timer);timer=null;};
  const hide=()=>{clearTimer();trigger?.removeAttribute('aria-describedby');trigger=null;tip.hidden=true;};
  const scheduleHide=()=>{clearTimer();timer=setTimeout(hide,180);};
  const position=target=>{
   const box=target.getBoundingClientRect(),frame=modal.getBoundingClientRect(),margin=10;
   const minX=Math.max(margin,frame.left+margin),maxX=Math.min(innerWidth-margin,frame.right-margin);
   tip.style.width=Math.max(120,Math.min(470,maxX-minX))+'px';
   tip.style.maxHeight=Math.max(120,Math.min(420,innerHeight-40,frame.height-30))+'px';
   const size=tip.getBoundingClientRect(),left=Math.min(maxX-size.width,Math.max(minX,box.left));
   const maxY=Math.min(innerHeight-margin,frame.bottom-margin),minY=Math.max(margin,frame.top+margin);
   const top=box.bottom+8+size.height<=maxY?box.bottom+8:box.top-8-size.height>=minY?box.top-8-size.height:Math.max(minY,Math.min(box.top,maxY-size.height));
   tip.style.left=left+'px';tip.style.top=top+'px';
  };
  const show=target=>{
   if(!target||target===dismissed)return;
   const template=root.querySelector('template[id="'+target.dataset.sdeTooltip+'"]');if(!template)return;
   clearTimer();if(trigger===target&&!tip.hidden)return;hide();trigger=target;
   tip.replaceChildren(template.content.cloneNode(true));tip.hidden=false;target.setAttribute('aria-describedby',tip.id);position(target);
  };
  const over=e=>{if(tip.contains(e.target)){clearTimer();return;}const target=e.target.closest('[data-sde-tooltip]');if(target!==dismissed)dismissed=null;if(target&&root.contains(target))show(target);};
  const out=e=>{const next=e.relatedTarget;if(next&&(tip.contains(next)||trigger?.contains(next)))return;dismissed=null;scheduleHide();};
  const escape=e=>{if(e.key==='Escape'&&!tip.hidden){e.preventDefault();e.stopPropagation();dismissed=trigger;hide();}};
  const scroll=e=>{
   if(tip.contains(e.target))return;
   if(!trigger)return;
   const box=trigger.getBoundingClientRect(),frame=modal.getBoundingClientRect();
   // Keep the panel anchored during automatic focus/hover scrolling.
   if(trigger.isConnected&&box.bottom>frame.top&&box.top<frame.bottom)position(trigger);else hide();
  };
  root.addEventListener('pointerover',over);root.addEventListener('pointerout',out);root.addEventListener('focusin',over);root.addEventListener('focusout',out);
  root.addEventListener('change',hide);root.addEventListener('click',hide);
  tip.addEventListener('pointerover',over);tip.addEventListener('pointerout',out);tip.addEventListener('focusin',clearTimer);tip.addEventListener('focusout',out);
  modal.addEventListener('keydown',escape);modal.addEventListener('scroll',scroll,true);window.addEventListener('resize',hide);
  return ()=>{hide();window.removeEventListener('resize',hide);tip.remove();};
 }
 window.StreamerDistributions={build,render,csvRows,stats,edges,bins,binIndex,weekdayCounts,elapsedHours,finance,audienceMetrics,bind};
})();
