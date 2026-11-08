/* Show-level empirical distributions. No fitted distribution or causal timing claim. */
(() => {
 'use strict';
 const zone='America/New_York';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
 const amount=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2}).format(n);
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
 const range=b=>amount(b.low)+' to '+(b.last?'':'under ')+amount(b.high);
 function build(m,options={}){
  const metrics=[['net','Net sales per show'],['rate','Net sales per streaming hour'],...Array.from({length:m.minHours*2},(_,i)=>['half:'+i,'Minutes '+(i*30)+'–'+((i+1)*30)+' after start'])];
  const metric=metrics.some(([v])=>v===options.distMetric)?options.distMetric:'net',label=metrics.find(([v])=>v===metric)[1];
  const cohort=new Set(m.cohort.map(s=>s.event_id));
  const eligible=m.rows.map(s=>{
   const start=s.scheduled_start||s.starts_at;
   let value=metric==='net'?s.net:metric==='rate'?s.rate:null;
   if(metric.startsWith('half:')&&cohort.has(s.event_id))value=(s.commercial.halves||[]).filter(r=>Number(r.bin)===Number(metric.slice(5))).reduce((n,r)=>n+Number(r.net||0),0);
   return {...s,start,startHour:Number(new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).format(new Date(start))),occurrence:Math.ceil(Number(s.day.slice(8))/7),value};
  }).filter(s=>Number.isFinite(s.value));
  const months=[...new Set(eligible.map(s=>s.month))].sort();
  const month=months.includes(options.distMonth)?options.distMonth:'all';
  const phase=['0','1','2'].includes(options.distPhase)?options.distPhase:'all';
  const nth=['1','2','3','4','5'].includes(options.distOccurrence)?options.distOccurrence:'all';
  const population=eligible.filter(s=>(month==='all'||s.month===month)&&(phase==='all'||s.phase===Number(phase))&&(nth==='all'||s.occurrence===Number(nth)));
  const starts=[...new Set(population.map(s=>s.startHour))].sort((a,b)=>a-b);
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
  return {metric,label,metrics,eligible,months,month,phase,nth,starts,start,target,scale,population,rows,bounds,histogram,groups,maxCount,stats:stats(rows),excluded:m.rows.length-eligible.length,selectedBin,selectedShow,selectedRows,minHours:m.minHours};
 }
 const select=(label,key,value,values)=>'<label>'+label+'<select data-sca-filter="'+key+'" aria-label="'+label+'">'+values.map(([v,t])=>'<option value="'+esc(v)+'"'+(String(v)===String(value)?' selected':'')+'>'+esc(t)+'</option>').join('')+'</select></label>';
 const miniStats=s=>'<span><b>'+s.n+'</b> shows</span><span>Median <b>'+money(s.median)+'</b></span><span>Mean <b>'+money(s.mean)+'</b></span><span>Middle 50% <b>'+money(s.q1)+'–'+money(s.q3)+'</b></span>';
 const weekdayChips=rows=>'<div class="sde-weekdays" aria-label="Show counts by weekday">'+weekdayCounts(rows).map((w,i)=>'<span><i style="background:'+weekdayColors[i]+'"></i>'+w.name+' <b>'+w.n+'</b></span>').join('')+'</div>';
 function tooltip(rows,label,metric){return '<strong>'+esc(label)+'</strong><p>'+count(rows.length)+' · '+esc(metric)+'</p>'+weekdayChips(rows)+'<ol>'+rows.map(s=>'<li><b>'+esc(stamp(s.start))+' · '+esc(amount(s.value))+'</b><span>'+esc(s.title)+'</span><small>'+esc(occurrence(s))+' · '+esc(phaseNames[s.phase])+'</small></li>').join('')+'</ol><p class="sde-tip-hint">Select the bar or dot to open these records and show links.</p>';}
 function tooltipTemplates(d){
  let html=d.histogram.map(b=>'<template id="sde-tip-main-'+b.index+'">'+tooltip(b.rows,range(b),d.label)+'</template>').join('');
  for(const g of d.groups)html+=g.bins.map(b=>'<template id="sde-tip-'+g.hour+'-'+b.index+'">'+tooltip(b.rows,hourLabel(g.hour)+' · '+range(b),d.label)+'</template>').join('');
  html+=d.rows.map((s,i)=>'<template id="sde-tip-show-'+i+'">'+tooltip([s],s.title,d.label)+'</template>').join('');
  return html;
 }
 function histogram(d){
  return '<div class="sde-hist-scroll"><div class="sde-hist" style="--bins:'+d.histogram.length+'">'+d.histogram.map(b=>'<button type="button" class="sde-bin" data-sde-bin="'+b.index+'" data-sde-tooltip="sde-tip-main-'+b.index+'" aria-pressed="'+(d.selectedBin?.index===b.index)+'" aria-label="'+esc(range(b))+': '+count(b.rows.length)+'. '+esc(weekdaySummary(b.rows))+'. Show underlying dates."'+(b.rows.length?'':' disabled')+'><span class="sde-count">'+b.rows.length+'</span><span class="sde-bar-space"><span class="sde-bar" style="height:'+(b.rows.length/d.maxCount*100)+'%">'+b.weekdays.map((w,i)=>w.n?'<span style="height:'+(w.n/b.rows.length*100)+'%;background:'+weekdayColors[i]+'"></span>':'').join('')+'</span></span><span class="sde-range">'+esc(amount(b.low))+'<br>– '+(b.last?'':'&lt; ')+esc(amount(b.high))+'</span></button>').join('')+'</div></div>';
 }
 function miniHistogram(g,d){
  const w=280,h=80,bw=w/g.bins.length;
  return '<svg viewBox="0 0 280 84" role="group" aria-label="'+esc(hourLabel(g.hour))+': '+count(g.stats.n)+', median '+esc(money(g.stats.median))+'">'+g.bins.map((b,i)=>{let used=0;return '<g'+(b.rows.length?' role="button" tabindex="0" data-sde-bin="'+b.index+'" data-sde-start="'+g.hour+'" data-sde-tooltip="sde-tip-'+g.hour+'-'+b.index+'" aria-label="'+esc(hourLabel(g.hour)+' · '+range(b)+': '+count(b.rows.length)+'. '+weekdaySummary(b.rows))+'"':'')+'><rect x="'+i*bw+'" y="0" width="'+bw+'" height="82" fill="transparent"/>'+b.weekdays.map((day,j)=>{const height=day.n/g.maxCount*h;used+=height;return day.n?'<rect x="'+(i*bw+1)+'" y="'+(h-used)+'" width="'+Math.max(1,bw-2)+'" height="'+height+'" fill="'+weekdayColors[j]+'"/>':'';}).join('')+'</g>';}).join('')+'<line x1="0" y1="81" x2="280" y2="81" stroke="#8da697" pointer-events="none"/></svg><div class="sde-card-axis"><span>'+amount(g.bounds[0])+'</span><span>'+amount(g.bounds.at(-1))+'</span></div><small>0–'+g.maxCount+' shows per bar</small>';
 }
 function timeline(d){
  const left=78,right=872,top=20,bottom=205;
  const dates=d.rows.map(s=>Date.parse(s.start)),min=Math.min(...dates),max=Math.max(...dates);
  const low=Math.min(0,d.stats.min),high=Math.max(1,d.stats.max),x=t=>left+(max===min?.5:(t-min)/(max-min))*(right-left),y=v=>bottom-(v-low)/(high-low)*(bottom-top);
  const ticks=Array.from({length:5},(_,i)=>low+(high-low)*i/4);
  const dateTick=t=>new Date(t).toLocaleDateString('en-US',{timeZone:zone,month:'short',day:'numeric',year:'2-digit'});
  return '<div class="sde-timeline-scroll"><svg class="sde-timeline" viewBox="0 0 900 250" role="group" aria-label="Individual shows by scheduled start date and '+esc(d.label)+'"><title>Each dot is one show. Select it to inspect its date, start time and sales.</title>'+ticks.map(v=>'<line x1="'+left+'" x2="'+right+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#dce5de"/><text x="68" y="'+(y(v)+4)+'" text-anchor="end">'+esc(money(v))+'</text>').join('')+[0,.25,.5,.75,1].filter((v,i)=>max!==min||i===2).map(p=>{const t=min+(max-min)*p;return '<text x="'+x(t)+'" y="230" text-anchor="middle">'+esc(dateTick(t))+'</text>';}).join('')+d.rows.map((s,i)=>'<circle cx="'+x(Date.parse(s.start))+'" cy="'+y(s.value)+'" r="5" fill="'+['#b07b22','#347657','#647a9a'][s.phase]+'" stroke="#fff" stroke-width="1" tabindex="0" role="button" data-sde-show="'+esc(s.event_id)+'" data-sde-tooltip="sde-tip-show-'+i+'" aria-label="'+esc(stamp(s.start)+' · '+occurrence(s)+' · '+d.label+' '+amount(s.value))+'"><title>'+esc(stamp(s.start)+'\n'+s.title+'\n'+occurrence(s)+' · '+phaseNames[s.phase]+'\n'+d.label+': '+amount(s.value))+'</title></circle>').join('')+'</svg></div><p class="sde-legend"><span>● Early · days 1–10</span><span>● Middle · days 11–20</span><span>● Late · days 21–end</span></p>';
 }
 function rowsTable(d){return '<div class="wpr-table-wrap"><table class="sde-shows"><thead><tr>'+['Show / scheduled start · Eastern','Month position','Airtime','Net sales','Selected metric','Attribution'].map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+d.selectedRows.map(s=>'<tr><th scope="row"><a href="https://www.ebay.com/ebaylive/events/'+encodeURIComponent(s.event_id)+'?playback=true" target="_blank" rel="noopener">'+esc(s.title)+'</a><small>'+esc(stamp(s.start))+'</small></th><td>'+esc(occurrence(s))+'<small>'+esc(phaseNames[s.phase])+'</small></td><td>'+(s.airtime_seconds==null?'Not recorded':Math.floor(s.airtime_seconds/3600)+'h '+String(Math.floor(s.airtime_seconds%3600/60)).padStart(2,'0')+'m')+'</td><td>'+amount(s.net)+'</td><td>'+amount(s.value)+'</td><td>'+(s.seller_source==='time_rule'?'Estimated host':'Recorded / assigned host')+'<small>'+Number(s.estimated_orders||0)+' / '+Number(s.orders||0)+' order links estimated</small></td></tr>').join('')+'</tbody></table></div>';}
 function render(m,options){
  const d=build(m,options);
  const controls=select('Distribution metric','distMetric',d.metric,d.metrics)+select('Start hour · Eastern','distStart',d.start,[['all','All start hours'],...d.starts.map(h=>[String(h),hourLabel(h)])])+select('Calendar month','distMonth',d.month,[['all','All available months'],...d.months.map(s=>[s,monthLabel(s)])])+select('Part of month','distPhase',d.phase,[['all','All parts of month'],...phaseNames.map((s,i)=>[String(i),s])])+select('Weekday occurrence in month','distOccurrence',d.nth,[['all','Any occurrence'],...[1,2,3,4,5].map(n=>[String(n),ordinal(n)+' occurrence'])])+select('Histogram detail','distBins',d.target,[[5,'About 5 bars'],[8,'About 8 bars'],[12,'About 12 bars']])+select('Histogram scale','distScale',d.scale,[['fit','Fit each selected range'],['shared','Shared for comparison']]);
  const scope=d.label+' · '+(d.start==='all'?'All start hours':hourLabel(Number(d.start)))+' · '+(d.month==='all'?'All months':monthLabel(d.month))+' · '+(d.phase==='all'?'All month parts':phaseNames[Number(d.phase)])+' · '+(d.nth==='all'?'Any weekday occurrence':ordinal(Number(d.nth))+' weekday occurrence');
  let html='<section class="sde-explorer" aria-label="Historical show distributions"><h3>See the distribution behind the median</h3><p class="wpr-note">One observation is one show. Use the streamer, show group and weekday filters above, then narrow these charts below. Net amounts are current merchandise sales after reversals and review amounts, before fees and costs.</p><div class="sca-controls sde-controls">'+controls+'</div><p class="sde-scope"><strong>'+esc(scope)+'</strong><br>'+d.rows.length+' eligible shows displayed; '+d.excluded+' excluded for this metric before calendar filters. '+(d.metric.startsWith('half:')?'Uses the same complete '+d.minHours+'-hour cohort as the 30-minute table.':'Whole-show totals include all linked overnight sales.')+'</p>';
  if(!d.rows.length)return html+'<p class="wpr-warning">No usable shows match this distribution. Broaden the month or occurrence filters, or choose another metric.</p></section>';
  html+='<div class="sde-chart-panel"><div class="sde-stats">'+miniStats(d.stats)+'<span>Full range <b>'+money(d.stats.min)+'–'+money(d.stats.max)+'</b></span></div><h4>How often each sales range occurred</h4><p class="wpr-note">Vertical axis: number of shows. Horizontal axis: '+esc(d.label.toLowerCase())+' (USD). Hover or focus a bar for its shows and weekday counts; select it to open the records. Colors show the weekday mix. Equal-width bins include all observations, including zeros and unusually large shows. The mean is the average; the median is the middle value.</p>'+weekdayChips(d.rows)+histogram(d)+'<p class="wpr-note">'+(d.rows.length<5?'Only '+d.rows.length+' shows: too few to judge the shape reliably. ':'')+'This is an observed distribution, not a fitted normal curve. '+(d.scale==='fit'?'Bins and count scales automatically fit the selected shows, including each start-hour card. Each chart labels its own range; bar heights across charts are not directly comparable.':'Sales bins and count scales are shared across start hours for direct comparison.')+' Changing filters or bar detail can change the apparent shape.</p></div>';
  html+='<div class="sde-chart-panel"><h4>Which dates produced these results?</h4><p class="wpr-note">Each dot is one show; color marks its part of the month. Hover or focus for details, or select a dot to inspect that show. Overnight shows stay on their Eastern start date. Starts are scheduled times, not verified actual go-live times.</p>'+timeline(d)+'</div>';
  const selection=d.selectedShow?'Selected show: '+stamp(d.selectedShow.start):d.selectedBin?'Selected sales range: '+range(d.selectedBin):'All displayed shows';
  html+='<div class="sde-selection" role="status">'+esc(selection)+' · '+count(d.selectedRows.length)+(d.selectedBin||d.selectedShow?' <button type="button" data-sde-clear>Clear selection</button>':'')+'</div>'+weekdayChips(d.selectedRows)+'<details class="sde-records"'+(d.selectedBin||d.selectedShow?' open':'')+'><summary>Show the '+d.selectedRows.length+' underlying records</summary><p class="wpr-note">Selected metric: '+esc(d.label)+'. Selecting a bar or dot narrows this list only; chart statistics still describe all '+d.rows.length+' displayed shows. Expand this list to include it when printing. CSV includes these records.</p>'+rowsTable(d)+'</details>';
  html+='<div class="sde-chart-panel"><h4>Compare the spread at each start hour</h4><p class="wpr-note">'+(d.scale==='fit'?'Each card fits its own sales range and show counts. Read the labeled axes; switch Histogram scale to Shared for comparison to align them.':'Every card uses the same sales bins and count scale ('+amount(d.bounds[0])+'–'+amount(d.bounds.at(-1))+', 0–'+d.maxCount+' shows per bar).')+' Hover or focus any bar for individual show details and weekday counts. Calendar and metric filters apply; all start hours remain visible. Counts are not percentages.</p><div class="sde-small-multiples">'+d.groups.map(g=>'<section class="sde-card"><button type="button" data-sde-start="'+g.hour+'" aria-pressed="'+(d.start===String(g.hour))+'">'+hourLabel(g.hour)+' · '+count(g.stats.n)+'</button>'+miniHistogram(g,d)+'<p class="sde-card-weekdays">'+esc(weekdaySummary(g.rows))+'</p><p>Median <b>'+money(g.stats.median)+'</b> · Mean '+money(g.stats.mean)+'<br>Middle 50% '+money(g.stats.q1)+'–'+money(g.stats.q3)+'</p></section>').join('')+'</div></div>'+tooltipTemplates(d)+'</section>';
  return html;
 }
 function csvRows(m,options){
  const d=build(m,options),r=[[],['Historical show distribution','Metric',d.label,'Start hour Eastern',d.start==='all'?'All':hourLabel(Number(d.start)),'Calendar month',d.month,'Month phase',d.phase,'Weekday occurrence',d.nth,'Target bins',d.target,'Scale',d.scale],['Population','Usable prior shows only; one show per observation; current net amounts before fees and costs; overnight shows use Eastern start date'],['Distribution shows','Median','Mean','25th percentile','75th percentile','Minimum','Maximum'],[d.stats.n,d.stats.median,d.stats.mean,d.stats.q1,d.stats.q3,d.stats.min,d.stats.max],[],['Histogram lower bound inclusive','Upper bound','Upper bound inclusive','Shows',...weekdayNames]];
  for(const b of d.histogram)r.push([b.low,b.high,b.last?'Yes':'No',b.rows.length,...b.weekdays.map(w=>w.n)]);
  r.push([],['Start-hour distribution','Shows','Median','Mean','25th percentile','75th percentile',...weekdayNames]);for(const g of d.groups)r.push([hourLabel(g.hour),g.stats.n,g.stats.median,g.stats.mean,g.stats.q1,g.stats.q3,...weekdayCounts(g.rows).map(w=>w.n)]);
  r.push([],['Start-hour histogram','Lower bound inclusive','Upper bound','Upper bound inclusive','Shows',...weekdayNames]);for(const g of d.groups)for(const b of g.bins)r.push([hourLabel(g.hour),b.low,b.high,b.last?'Yes':'No',b.rows.length,...b.weekdays.map(w=>w.n)]);
  r.push([],['Weekday counts','Scope',...weekdayNames],['Shows','Displayed',...weekdayCounts(d.rows).map(w=>w.n)],['Shows','Selected records',...weekdayCounts(d.selectedRows).map(w=>w.n)]);
  r.push([],['Selected observations',d.selectedShow?'Event '+d.selectedShow.event_id:d.selectedBin?range(d.selectedBin):'All displayed shows'],['Event ID','Title','Streamer','Scheduled start (source timestamp)','Scheduled start Eastern','Month','Part of month','Weekday occurrence','Airtime seconds','Current net sales','Metric','Value','Host evidence','Estimated order links','Linked orders']);
  for(const s of d.selectedRows)r.push([s.event_id,s.title,s.seller,s.start,stamp(s.start),s.month,phaseNames[s.phase],occurrence(s),s.airtime_seconds,s.net,d.label,s.value,s.seller_source,s.estimated_orders,s.orders]);
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
 window.StreamerDistributions={build,render,csvRows,stats,edges,bins,binIndex,weekdayCounts,bind};
})();
