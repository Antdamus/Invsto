/* A frozen, printable production report. Sales and streamer airtime use their own reporting dates. */
(() => {
 'use strict';
 const zone='America/New_York';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n||0);
 const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});
 const stamp=s=>s?new Date(s).toLocaleString('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Not recorded';
 const localDay=s=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
 const showDate=s=>(s.scheduled_start||s.starts_at)?localDay(s.scheduled_start||s.starts_at):null;
 const showDateLabel=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'});
 const hours=ms=>{const m=Math.round(Math.max(0,ms)/60000);return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m';};
 const airtime=seconds=>seconds==null?'Not recorded':Math.floor(seconds/3600)+'h '+String(Math.floor(seconds%3600/60)).padStart(2,'0')+'m '+String(seconds%60).padStart(2,'0')+'s';
 const sum=(a,k)=>a.reduce((n,r)=>n+Math.round(Number(r[k]||0)*100),0)/100;
 const pushInfo=s=>window.StreamerDistributions?window.StreamerDistributions.pushEdit(s):'';
 const pushValue=v=>v===true?'Yes':v===false?'No':'Not recorded';
 const groups=(rows,key)=>{const m=new Map();for(const r of rows){const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return [...m];};
 function range(data,week){
  const dates=(data.days||[]).filter(d=>!week||d.week===week).map(d=>d.day).sort();
  if(!dates.length)throw Error('No reporting dates are available. Refresh the weekly report.');
  return {from:dates[0],through:dates.at(-1)};
 }
 function sellerFor(show,rows){
  const names=[...new Set(rows.filter(r=>r.show===show.event_id).map(r=>r.seller))];
  if(names.length)return names.length===1?names[0]:'Multiple sellers — review';
  if(show.seller_name)return show.seller_name;
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).format(new Date(show.starts_at)));
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short'}).format(new Date(show.starts_at));
  return localDay(show.starts_at)<'2026-09-23'||hour>=18||hour<6?'Otello':['Sat','Sun'].includes(weekday)?'Manuella':'Sydney';
 }
 function model(data,week){
  const period=range(data,week),rows=data.orders.filter(r=>!week||r.week===week);
  const linked=new Set(rows.map(r=>r.show).filter(Boolean));
  const catalog=new Map((data.shows||[]).map(s=>[s.event_id,s]));
  for(const s of data.timing||[])catalog.set(s.event_id,{...catalog.get(s.event_id),...s});
  for(const r of rows)if(r.show&&!catalog.has(r.show))catalog.set(r.show,{event_id:r.show,title:r.show_title,starts_at:r.show_start});
  const shows=[...catalog.values()].filter(s=>linked.has(s.event_id)||(s.starts_at&&localDay(s.starts_at)>=period.from&&localDay(s.starts_at)<=period.through))
   .map(s=>({...s,seller:sellerFor(s,rows),inPeriod:Boolean(s.starts_at&&localDay(s.starts_at)>=period.from&&localDay(s.starts_at)<=period.through)}))
   .sort((a,b)=>(Date.parse(a.starts_at)||Infinity)-(Date.parse(b.starts_at)||Infinity));
  const inPeriod=shows.filter(s=>s.inPeriod),timed=inPeriod.filter(s=>s.airtime_seconds!=null);
  const analysisOptions={seller:'Otello',weekday:'6',dayMode:'night',distMetric:'rate',distRateWindow:'3',distView:'calendar',distPush:'all',distStart:'all',distMonth:'all',distPhase:'all',distOccurrence:'all'};
  return {data,week,period,rows,shows,inPeriod,timed,airtime:sum(timed,'airtime_seconds'),analysisOptions};
 }
 function table(headers,rows,cls='',caption=''){
  return '<div class="wpr-table-wrap"><table class="'+cls+'">'+(caption?'<caption>'+caption+'</caption>':'')+
   (cls==='wpr-shows'?'<colgroup><col style="width:27%"><col style="width:17%"><col style="width:14%"><col span="5" style="width:8.4%"></colgroup>':'')+
   '<thead><tr>'+headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(cells=>'<tr>'+cells.map((c,i)=>'<'+(i?'td':'th scope="row"')+'>'+c+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</tbody></table></div>';
 }
 const saleCells=a=>['booked','cancelled','refunded','held','net'].map(k=>money(sum(a,k)));
 const saleHeaders=['Original sales','Canceled','Refunded','Under review','Net sales'];
 function timingLabel(s){
  if(!s)return 'Show timing not recorded';
  let value='Scheduled: '+stamp(s.scheduled_start||s.starts_at);
  if(s.scheduled_start&&Date.parse(s.scheduled_start)!==Date.parse(s.starts_at))value+=' · Previously recorded start: '+stamp(s.starts_at);
  return value+' · Airtime: '+airtime(s.airtime_seconds)+(s.airtime_provisional?' (eBay still processing)':'');
 }
 const commercial=m=>m.history?.status==='ready'?window.StreamerCommercialAnalysis.render(m.history.data,m.period,m.analysisOptions):'<h2>07 · What drives show results</h2><p>Detailed analyses are available after historical records load.</p>';
 function render(m){
  const {period,rows,shows}=m;
  const sellerNames=[...new Set([...rows.map(r=>r.seller),...m.inPeriod.map(s=>s.seller)])];
  const sellers=sellerNames.map(name=>{const a=rows.filter(r=>r.seller===name),shows=m.inPeriod.filter(s=>s.seller===name),timed=shows.filter(s=>s.airtime_seconds!=null);return {name,a,shows,timed};}).sort((a,b)=>sum(b.a,'net')-sum(a.a,'net'));
  const daily=(m.data.days||[]).filter(d=>!m.week||d.week===m.week).map(d=>{const a=rows.filter(r=>r.day===d.day);return [day(d.day),String(a.length),...saleCells(a)];});
  const showRow=s=>{const a=rows.filter(r=>r.show===s.event_id);return [
   '<a target="_blank" rel="noopener" href="https://www.ebay.com/ebaylive/events/'+encodeURIComponent(s.event_id)+'?playback=true">'+esc(s.title||'Untitled show')+'</a><small>'+esc(s.seller)+(s.inPeriod?'':s.starts_at?' · Started outside selected dates':' · Start not recorded')+'</small>'+pushInfo(s),
   esc(stamp(s.scheduled_start||s.starts_at))+(s.scheduled_start&&Date.parse(s.scheduled_start)!==Date.parse(s.starts_at)?'<small>Previously recorded: '+esc(stamp(s.starts_at))+'</small>':''),
   esc(airtime(s.airtime_seconds))+(s.airtime_provisional?'<small>Processing</small>':'')+'<small>'+ (s.airtime_checked_at?'Checked '+esc(stamp(s.airtime_checked_at)):'')+'</small>',...saleCells(a)];};
  const showHeaders=['Show / seller','Scheduled start · Eastern','Airtime',...saleHeaders];
  let showTables=groups(shows,s=>showDate(s)||'unknown').sort(([a],[b])=>a.localeCompare(b)).map(([date,list])=>{
   const ordered=[...list].sort((a,b)=>Date.parse(a.scheduled_start||a.starts_at)-Date.parse(b.scheduled_start||b.starts_at));
   const caption='<strong>'+esc(date==='unknown'?'Show date not recorded':showDateLabel(date))+'</strong><span>'+list.length+' '+(list.length===1?'show':'shows')+' · Eastern time</span>';
   return '<div class="wpr-show-day" data-show-day="'+date+'">'+table(showHeaders,ordered.map(showRow),'wpr-shows',caption)+'</div>';
  }).join('');
  const unlinked=groups(rows.filter(r=>!r.show),r=>r.show_source).map(([key,a])=>[({multiple:'Multiple shows — review',non_live:'Regular eBay purchases',mixed:'Live and regular purchases — review'})[key]||'Show not linked','—','—',...saleCells(a)]);
  if(unlinked.length)showTables+='<div class="wpr-show-day wpr-show-unlinked">'+table(showHeaders,unlinked,'wpr-shows','<strong>Sales without one linked show</strong><span>Show date not assigned</span>')+'</div>';
  const known=rows.filter(r=>r.show_source==='captured').length,estimated=rows.filter(r=>r.show_source==='time_window').length;
  return '<article class="wpr-paper"><header class="wpr-masthead"><div><span>OG JEWELERS · OPERATIONS</span><h1>Sales, shows & streamer hours</h1><p>'+day(period.from)+' – '+day(period.through)+'</p></div><div class="wpr-stamp">Eastern time<br>Snapshot '+esc(stamp(m.data.as_of))+'</div></header>'+
   '<div class="wpr-kpis">'+[['Net item sales',money(sum(rows,'net'))],['Orders',rows.length],['Reported airtime',airtime(m.airtime)],['Average show length',m.timed.length?airtime(Math.round(m.airtime/m.timed.length)):'Not recorded']].map(([a,b])=>'<div><small>'+a+'</small><strong>'+esc(b)+'</strong></div>').join('')+'</div>'+
   '<p class="wpr-lede">Net sales are merchandise sales after cancellations, refunds and amounts under review, before fees. These sales reconcile to the selected weekly report.</p>'+
   '<section><h2>01 · Sales produced by seller</h2>'+table(['Seller',...saleHeaders,'Shows','Reported airtime'],sellers.map(s=>[esc(s.name),...saleCells(s.a),s.timed.length+' / '+s.shows.length+' timed',airtime(sum(s.timed,'airtime_seconds'))]))+'</section>'+
   '<section><h2>02 · Sales by purchase day</h2>'+table(['Purchase date','Orders',...saleHeaders],daily)+'</section>'+
   '<section><h2>03 · Show schedule & performance</h2><p>'+m.timed.length+' of '+m.inPeriod.length+' shows have recorded airtime. '+(m.timed.length?'Average recorded show length: '+airtime(Math.round(m.airtime/m.timed.length))+'. ':'')+'Shows are grouped by their scheduled start date in Eastern time. Each show is counted once in airtime totals, on its recorded start date.</p>'+showTables+
   '<p class="wpr-note">Scheduled times are not verified actual go-live times. Airtime comes from eBay Live Studio Insights; processing values may change. An end time is not inferred from a scheduled start. Sales are grouped by purchase date; a show crossing midnight can span multiple days. Airtime totals include only shows starting within these dates; missing durations are excluded.</p></section>'+
   '<section id="wpr-streamer-hours"><h2>04 · Streaming hours by streamer</h2>'+table(['Streamer','Shows','Shows timed','Total streaming hours','Average show length','Longest show'],sellers.map(s=>[esc(s.name),String(s.shows.length),s.timed.length+' / '+s.shows.length,s.timed.length?airtime(sum(s.timed,'airtime_seconds')):'Not recorded',s.timed.length?airtime(Math.round(sum(s.timed,'airtime_seconds')/s.timed.length)):'Not recorded',s.timed.length?airtime(Math.max(...s.timed.map(s=>s.airtime_seconds))):'Not recorded']))+'<p class="wpr-note">Streaming hours are the full reported airtime of distinct shows starting in these dates. Each show counts once. Shows with no duration are excluded from totals and averages; processing durations are provisional. A show with multiple sellers stays in a review group rather than crediting its full airtime to more than one person.</p></section>'+
   '<section><h2>05 · Coverage & attribution</h2><p>'+known+' orders have confirmed show links; '+estimated+' are estimated from show time; '+(rows.length-known-estimated)+' are not linked to one show. Estimated links may include off-show purchases.</p><p>Saved report assignments take priority, followed by recorded sellers. Otherwise, all shows before September 23, 2026 default to Otello. From that date, starts from 6 PM through 5:59 AM Eastern default to Otello. From 6 AM through 5:59 PM, Saturday and Sunday shows default to Manuella; Monday through Friday shows default to Sydney. The show’s Eastern start date determines the day. A show with multiple attributed sellers remains in a review group for airtime. This report does not change commission assignments.</p></section>'+
   (window.StreamerPerformance?'<section id="wpr-history">'+window.StreamerPerformance.render(m.history,period)+'</section>':'')+
   (window.StreamerCommercialAnalysis?'<section id="wpr-commercial">'+commercial(m)+'</section>':'')+
   '<footer class="wpr-footer">Prepared from Invsto order history and saved eBay Live Studio evidence. All sales are USD. Streaming hours represent reported show airtime.</footer></article>';
 }
 function csv(m){
  const rows=[['OG Jewelers production report',m.period.from,m.period.through,'America/New_York'],['Snapshot',m.data.as_of],[],['Sales by seller',...saleHeaders]];
  for(const [name,a] of groups(m.rows,r=>r.seller))rows.push([name,...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);
  rows.push([],['Sales by purchase day','Orders',...saleHeaders]);
  for(const d of m.data.days.filter(d=>!m.week||d.week===m.week)){const a=m.rows.filter(r=>r.day===d.day);rows.push([day(d.day),a.length,...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);}
  rows.push([],['Show','Seller','Scheduled start Eastern','Previously recorded start Eastern','Airtime seconds','Timing checked','Processing','Starts in period',...saleHeaders,'Manual push','eBay automatic push','Push note']);
  for(const s of m.shows){const a=m.rows.filter(r=>r.show===s.event_id);rows.push([s.title,s.seller,stamp(s.scheduled_start||s.starts_at),stamp(s.starts_at),s.airtime_seconds??'',s.airtime_checked_at||'',s.airtime_provisional?'Yes':'No',s.inPeriod?'Yes':'No',...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k)),pushValue(s.push?.manual),pushValue(s.push?.automatic),s.push?.note||'']);}
  for(const [key,a] of groups(m.rows.filter(r=>!r.show),r=>r.show_source))rows.push([key,'','','','','','','',...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);
  rows.push([],['Streamer','Shows','Shows timed','Streaming hours','Average show seconds','Longest show seconds']);
  for(const [seller,shows] of groups(m.inPeriod,s=>s.seller)){
   const timed=shows.filter(s=>s.airtime_seconds!=null),seconds=sum(timed,'airtime_seconds');
   rows.push([seller,shows.length,timed.length,timed.length?Number((seconds/3600).toFixed(4)):'',timed.length?Math.round(seconds/timed.length):'',timed.length?Math.max(...timed.map(s=>s.airtime_seconds)):'']);
  }
  rows.push([],['Show timing','Scheduled start is not verified actual go-live. Airtime is reported by eBay Insights; processing values may change. Missing durations excluded. Each show counted once on recorded start date.'],[],['Order','Purchase date','Seller','Seller evidence','Show','Show evidence',...saleHeaders]);
  for(const r of m.rows)rows.push([r.order,r.day,r.seller,r.seller_source,r.show_title||'',r.show_source,...['booked','cancelled','refunded','held','net'].map(k=>r[k]||0)]);
  if(window.StreamerPerformance)rows.push(...window.StreamerPerformance.csvRows(m.history,m.period));
  if(window.StreamerCommercialAnalysis&&m.history?.status==='ready')rows.push(...window.StreamerCommercialAnalysis.csvRows(m.history.data,m.period,m.analysisOptions));
  return '\ufeff'+rows.map(row=>row.map(v=>{let s=String(v??'');if(typeof v!=='number'&&/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
 }
 async function fetchHistory(client,period,months,isCurrent=()=>true){
  const end=new Date(period.through+'T12:00Z');end.setUTCDate(end.getUTCDate()+1);
  const until=end.toISOString().slice(0,10),recent=new Date(period.through.slice(0,7)+'-01T12:00Z');recent.setUTCMonth(recent.getUTCMonth()-2);
  let target=null;
  if(months!=='all'){const start=new Date(period.through.slice(0,7)+'-01T12:00Z');start.setUTCMonth(start.getUTCMonth()-Number(months)+1);target=start.toISOString().slice(0,10);}
  const chunks=[];
  const read=async(from,to)=>{
   const {data,error}=await client.rpc('get_streamer_performance_history_range',{_from:from,_until:to,_report_until:until});
   if(error)throw error;if(!data||!Array.isArray(data.shows))throw Error('Historical records were not returned.');
   chunks.push(data);return data;
  };
  let boundary=recent.toISOString().slice(0,10);
  const first=await read(boundary,until);if(!isCurrent())return null;
  if(target===null){const earliest=Date.parse(first.coverage?.first_show);target=Number.isFinite(earliest)?localDay(earliest):boundary;if(target>boundary)target=boundary;}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(target)||target<'2000-01-01')throw Error('Historical start date could not be verified.');
  while(boundary>target){
   const previous=new Date(boundary+'T12:00Z');previous.setUTCDate(1);previous.setUTCMonth(previous.getUTCMonth()-3);
   const from=previous.toISOString().slice(0,10)<target?target:previous.toISOString().slice(0,10);
   await read(from,boundary);if(!isCurrent())return null;boundary=from;
  }
  const coverage={...first.coverage};for(const key of ['orders','unlinked_orders','unlinked_net','non_live_orders','review_orders'])coverage[key]=sum(chunks.map(c=>c.coverage||{}),key);
  return {...first,from:boundary,until,as_of:chunks.map(c=>c.as_of).sort().at(-1),coverage,
   shows:[...new Map(chunks.flatMap(c=>c.shows).map(s=>[s.event_id,s])).values()]};
 }
 function open(data,week,client,focusHours=false){
  let m;try{m=model(JSON.parse(JSON.stringify(data)),week);}catch(e){window.alert(e.message);return;}
  const modal=document.createElement('dialog');modal.className='wpr-dialog';modal.setAttribute('aria-label','Production report');
  modal.innerHTML='<div class="wpr-toolbar"><strong>Report preview</strong>'+(window.StreamerPerformance?'<label>History <select aria-label="History months" data-spa-months><option value="all" selected>All available</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option></select></label><button type="button" data-spa-jump>Streamer analysis</button>':'')+'<button type="button" data-wpr-print>Print / Save PDF</button><button type="button" data-wpr-csv>Download CSV</button><button type="button" data-wpr-close>Close</button></div><div class="wpr-content"></div>';
  const content=modal.querySelector('.wpr-content'),print=modal.querySelector('[data-wpr-print]'),download=modal.querySelector('[data-wpr-csv]');
  content.addEventListener('click',e=>{
   const button=e.target.closest('[data-wpr-push]');if(!button)return;
   const id=button.dataset.wprPush,show=m.history?.data?.shows.find(s=>s.event_id===id)||m.shows.find(s=>s.event_id===id);
   if(!show)return;
   const p=window.StreamerDistributions.pushState(show),editor=document.createElement('dialog');editor.className='wpr-push-dialog';editor.setAttribute('aria-label','Edit show push labels');
   const values='<option value="unknown">Not recorded</option><option value="yes">Yes</option><option value="no">No</option>';
   editor.innerHTML='<form><h2>Edit show push labels</h2><p><strong>'+esc(show.title)+'</strong><br>'+esc(stamp(show.scheduled_start||show.starts_at))+'</p><label>Manual push<select name="manual" aria-label="Manual push"><option value="rule">Use date rule</option>'+values+'</select></label><label>eBay automatic push<select name="automatic" aria-label="eBay automatic push">'+values+'</select></label><p class="wpr-note">Date rule: no manual push from August 25, 2026 onward, using the Eastern calendar start date. Earlier shows remain not recorded. Choose Yes or No for an exception. Automatic push is never inferred from this rule.</p><label>Notes<textarea name="note" maxlength="2000" rows="3"></textarea></label><p data-push-status role="status" aria-live="polite"></p><div><button type="button" data-push-close>Cancel</button><button type="submit">Save labels</button></div></form>';
   const form=editor.querySelector('form'),manual=form.elements.manual,automatic=form.elements.automatic,note=form.elements.note,status=editor.querySelector('[data-push-status]'),save=editor.querySelector('[type="submit"]'),close=editor.querySelector('[data-push-close]');
   const value=v=>v===true?'yes':v===false?'no':'unknown';manual.value=p.manual_source==='recorded'?value(p.manual):'rule';automatic.value=value(p.automatic);note.value=p.note;
   let revision=p.updated_at,saving=false;
   editor.addEventListener('cancel',e=>{if(saving)e.preventDefault();});close.onclick=()=>editor.close();
   editor.addEventListener('close',()=>{editor.remove();content.querySelector('[data-wpr-push="'+CSS.escape(id)+'"]')?.focus({preventScroll:true});},{once:true});
   form.onsubmit=async e=>{
    e.preventDefault();if(saving)return;const labels={automatic:automatic.value==='unknown'?null:automatic.value==='yes',note:note.value.trim()};
    if(manual.value!=='rule')labels.manual=manual.value==='unknown'?null:manual.value==='yes';
    saving=true;save.disabled=true;close.disabled=true;manual.disabled=true;automatic.disabled=true;note.disabled=true;status.textContent='Saving labels…';
    try{
     if(!client)throw Error('Refresh the dashboard to connect before saving.');
     const {data:push,error}=await client.rpc('set_weekly_ebay_show_push_labels',{_event_id:id,_labels:labels,_expected_updated_at:revision});
     if(error)throw error;if(!push||!push.updated_at)throw Error('Saved labels could not be confirmed. Reopen the report to verify.');
     revision=push.updated_at;
     for(const list of [m.shows,m.inPeriod,m.data.shows,m.data.timing,m.history?.data?.shows])for(const s of list||[])if(s.event_id===id)s.push=push;
     draw();status.textContent='Saved. The report and charts now use these labels.';close.textContent='Done';
    }catch(error){status.textContent=error.message||'Labels could not be saved. Please try again.';}
    finally{saving=false;save.disabled=false;close.disabled=false;manual.disabled=false;automatic.disabled=false;note.disabled=false;}
   };
   document.body.append(editor);editor.showModal();manual.focus();
  });
  if(window.StreamerCommercialAnalysis){
   const jump=document.createElement('button');jump.type='button';jump.textContent='Show insights';jump.dataset.scaJump='';
   jump.onclick=()=>content.querySelector('#wpr-commercial')?.scrollIntoView({block:'start'});modal.querySelector('.wpr-toolbar').insertBefore(jump,print);
   content.addEventListener('change',e=>{
    const key=e.target.dataset.scaFilter;if(!key||m.history?.status!=='ready')return;
    const options={distRateWindow:m.analysisOptions?.distRateWindow,distPointLabels:m.analysisOptions?.distPointLabels,distCardLabels:m.analysisOptions?.distCardLabels,...Object.fromEntries([...content.querySelectorAll('[data-sca-filter]')].map(s=>[s.dataset.scaFilter,s.value]))};
    if(key==='distPointLabels')options.distCardLabels={};
    if(key==='seller'){options.format='all';options.weekday='all';options.series='all';options.distStart='all';options.distMonth='all';options.distPhase='all';options.distOccurrence='all';}
    if(key==='format'||key==='weekday')options.series='all';m.analysisOptions=options;
    content.querySelector('#wpr-commercial').innerHTML=commercial(m);
    content.querySelector('[data-sca-filter="'+key+'"]').focus({preventScroll:true});
   });
   const distributionAction=e=>{
    const button=e.target.closest('[data-sde-bin],[data-sde-show],[data-sde-clear],[data-sde-start],[data-sde-weekday],[data-sde-scale],[data-sde-label-hour]');
    if(!button||m.history?.status!=='ready')return;
    if(e.type==='keydown'&&(button.tagName.toLowerCase()==='button'||!['Enter',' '].includes(e.key)))return;
    e.preventDefault();
    const options={distRateWindow:m.analysisOptions?.distRateWindow,distPointLabels:m.analysisOptions?.distPointLabels,distCardLabels:m.analysisOptions?.distCardLabels,...Object.fromEntries([...content.querySelectorAll('[data-sca-filter]')].map(s=>[s.dataset.scaFilter,s.value]))};
    if(button.hasAttribute('data-sde-label-hour')){options.distCardLabels={...options.distCardLabels,[button.dataset.sdeLabelHour]:button.getAttribute('aria-pressed')==='true'?'off':'on'};options.distShow=m.analysisOptions?.distShow;}
    if(button.hasAttribute('data-sde-bin'))options.distBin=button.dataset.sdeBin;
    if(button.hasAttribute('data-sde-show'))options.distShow=button.dataset.sdeShow;
    if(button.hasAttribute('data-sde-start'))options.distStart=button.dataset.sdeStart;
    if(button.hasAttribute('data-sde-month'))options.distMonth=button.dataset.sdeMonth;
    if(button.hasAttribute('data-sde-scale'))options.distScale=button.dataset.sdeScale;
    if(button.hasAttribute('data-sde-weekday')){options.weekday=button.dataset.sdeWeekday;options.distStart='all';options.distMonth='all';}
    m.analysisOptions=options;content.querySelector('#wpr-commercial').innerHTML=commercial(m);
    const target=content.querySelector(button.hasAttribute('data-sde-label-hour')?'[data-sde-label-hour="'+button.dataset.sdeLabelHour+'"]':button.hasAttribute('data-sde-scale')?'[data-sde-scale]':button.hasAttribute('data-sde-weekday')?'[data-sde-weekday="'+options.weekday+'"]':button.hasAttribute('data-sde-start')&&!button.hasAttribute('data-sde-bin')?'[data-sca-filter="distStart"]':'.sde-show-detail, .sde-records summary');
    target?.focus({preventScroll:true});target?.scrollIntoView({block:'center'});
   };
   content.addEventListener('click',distributionAction);content.addEventListener('keydown',distributionAction);
   const disposeTooltip=window.StreamerDistributions?.bind(content,modal);
   modal.addEventListener('close',()=>disposeTooltip?.(),{once:true});
  }
  const draw=()=>{content.innerHTML=render(m);if(focusHours)content.querySelector('#wpr-streamer-hours').scrollIntoView({block:'start'});};
  const stopPrint=()=>document.body.classList.remove('wpr-printing');
  modal.addEventListener('close',()=>{stopPrint();window.removeEventListener('afterprint',stopPrint);modal.remove();});
  modal.querySelector('[data-wpr-close]').onclick=()=>modal.close();
  window.addEventListener('afterprint',stopPrint);
  print.onclick=()=>{document.body.classList.add('wpr-printing');window.print();};
  download.onclick=()=>{const url=URL.createObjectURL(new Blob([csv(m)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='production-'+m.period.from+'-to-'+m.period.through+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  document.body.append(modal);modal.showModal();draw();
  if(window.StreamerPerformance){
   const select=modal.querySelector('[data-spa-months]');let request=0;
   const load=async()=>{
    const token=++request;
    m.history={status:'loading'};print.disabled=true;download.disabled=true;
    const update=()=>{if(modal.isConnected){content.querySelector('#wpr-history').innerHTML=window.StreamerPerformance.render(m.history,m.period);if(window.StreamerCommercialAnalysis)content.querySelector('#wpr-commercial').innerHTML=commercial(m);}};update();
    try{
     if(!client)throw Error('Refresh the dashboard to connect to historical reports.');
     const data=await fetchHistory(client,m.period,select.value,()=>token===request&&modal.isConnected);
     if(token!==request||!modal.isConnected)return;m.history={status:'ready',data};
    }catch(e){if(token!==request||!modal.isConnected)return;m.history={status:'error',message:e.message||'Please try again.'};}
    if(token===request&&modal.isConnected){print.disabled=false;download.disabled=false;update();}
   };
   select.onchange=load;modal.querySelector('[data-spa-jump]').onclick=()=>content.querySelector('#wpr-history').scrollIntoView({block:'start'});
   content.addEventListener('click',e=>{if(e.target.closest('[data-spa-retry]'))load();});load();
  }
 }
 window.WeeklyProductionReport={open,model,render,csv,timingLabel,airtime,hours,fetchHistory};
})();
