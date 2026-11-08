/* A frozen, printable production report. Sales and streamer airtime use their own reporting dates. */
(() => {
 'use strict';
 const zone='America/New_York';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n||0);
 const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'});
 const stamp=s=>s?new Date(s).toLocaleString('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Not recorded';
 const localDay=s=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
 const hours=ms=>{const m=Math.round(Math.max(0,ms)/60000);return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m';};
 const airtime=seconds=>seconds==null?'Not recorded':Math.floor(seconds/3600)+'h '+String(Math.floor(seconds%3600/60)).padStart(2,'0')+'m '+String(seconds%60).padStart(2,'0')+'s';
 const sum=(a,k)=>a.reduce((n,r)=>n+Math.round(Number(r[k]||0)*100),0)/100;
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
  return hour>=18||hour<8?'Otello':['Sat','Sun'].includes(weekday)?'Manuella':'Sydney';
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
  return {data,week,period,rows,shows,inPeriod,timed,airtime:sum(timed,'airtime_seconds')};
 }
 function table(headers,rows,cls=''){
  return '<div class="wpr-table-wrap"><table class="'+cls+'"><thead><tr>'+headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(cells=>'<tr>'+cells.map((c,i)=>'<'+(i?'td':'th scope="row"')+'>'+c+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</tbody></table></div>';
 }
 const saleCells=a=>['booked','cancelled','refunded','held','net'].map(k=>money(sum(a,k)));
 const saleHeaders=['Original sales','Canceled','Refunded','Under review','Net sales'];
 function timingLabel(s){
  if(!s)return 'Show timing not recorded';
  let value='Scheduled: '+stamp(s.scheduled_start||s.starts_at);
  if(s.scheduled_start&&Date.parse(s.scheduled_start)!==Date.parse(s.starts_at))value+=' · Previously recorded start: '+stamp(s.starts_at);
  return value+' · Airtime: '+airtime(s.airtime_seconds)+(s.airtime_provisional?' (eBay still processing)':'');
 }
 function render(m){
  const {period,rows,shows}=m;
  const sellerNames=[...new Set([...rows.map(r=>r.seller),...m.inPeriod.map(s=>s.seller)])];
  const sellers=sellerNames.map(name=>{const a=rows.filter(r=>r.seller===name),shows=m.inPeriod.filter(s=>s.seller===name),timed=shows.filter(s=>s.airtime_seconds!=null);return {name,a,shows,timed};}).sort((a,b)=>sum(b.a,'net')-sum(a.a,'net'));
  const daily=(m.data.days||[]).filter(d=>!m.week||d.week===m.week).map(d=>{const a=rows.filter(r=>r.day===d.day);return [day(d.day),String(a.length),...saleCells(a)];});
  const showRows=shows.map(s=>{const a=rows.filter(r=>r.show===s.event_id);return [
   '<a target="_blank" rel="noopener" href="https://www.ebay.com/ebaylive/events/'+encodeURIComponent(s.event_id)+'?playback=true">'+esc(s.title||'Untitled show')+'</a><small>'+esc(s.seller)+(s.inPeriod?'':s.starts_at?' · Started outside selected dates':' · Start not recorded')+'</small>',
   esc(stamp(s.scheduled_start||s.starts_at))+(s.scheduled_start&&Date.parse(s.scheduled_start)!==Date.parse(s.starts_at)?'<small>Previously recorded: '+esc(stamp(s.starts_at))+'</small>':''),
   esc(airtime(s.airtime_seconds))+(s.airtime_provisional?'<small>Processing</small>':'')+'<small>'+ (s.airtime_checked_at?'Checked '+esc(stamp(s.airtime_checked_at)):'')+'</small>',...saleCells(a)];});
  for(const [key,a] of groups(rows.filter(r=>!r.show),r=>r.show_source))showRows.push([key==='multiple'?'Multiple shows — review':'Show not linked','—','—',...saleCells(a)]);
  const known=rows.filter(r=>r.show_source==='captured').length,estimated=rows.filter(r=>r.show_source==='time_window').length;
  return '<article class="wpr-paper"><header class="wpr-masthead"><div><span>OG JEWELERS · OPERATIONS</span><h1>Sales, shows & streamer hours</h1><p>'+day(period.from)+' – '+day(period.through)+'</p></div><div class="wpr-stamp">Eastern time<br>Snapshot '+esc(stamp(m.data.as_of))+'</div></header>'+
   '<div class="wpr-kpis">'+[['Net item sales',money(sum(rows,'net'))],['Orders',rows.length],['Reported airtime',airtime(m.airtime)],['Average show length',m.timed.length?airtime(Math.round(m.airtime/m.timed.length)):'Not recorded']].map(([a,b])=>'<div><small>'+a+'</small><strong>'+esc(b)+'</strong></div>').join('')+'</div>'+
   '<p class="wpr-lede">Net sales are merchandise sales after cancellations, refunds and amounts under review, before fees. These sales reconcile to the selected weekly report.</p>'+
   '<section><h2>01 · Sales produced by seller</h2>'+table(['Seller',...saleHeaders,'Shows','Reported airtime'],sellers.map(s=>[esc(s.name),...saleCells(s.a),s.timed.length+' / '+s.shows.length+' timed',airtime(sum(s.timed,'airtime_seconds'))]))+'</section>'+
   '<section><h2>02 · Sales by purchase day</h2>'+table(['Purchase date','Orders',...saleHeaders],daily)+'</section>'+
   '<section><h2>03 · Show schedule & performance</h2><p>'+m.timed.length+' of '+m.inPeriod.length+' shows have recorded airtime. '+(m.timed.length?'Average recorded show length: '+airtime(Math.round(m.airtime/m.timed.length))+'. ':'')+'Each show is counted once in airtime totals, on its recorded start date.</p>'+table(['Show / seller','Scheduled start · Eastern','Airtime',...saleHeaders],showRows,'wpr-shows')+
   '<p class="wpr-note">Scheduled times are not verified actual go-live times. Airtime comes from eBay Live Studio Insights; processing values may change. An end time is not inferred from a scheduled start. Sales are grouped by purchase date; a show crossing midnight can span multiple days. Airtime totals include only shows starting within these dates; missing durations are excluded.</p></section>'+
   '<section id="wpr-streamer-hours"><h2>04 · Streaming hours by streamer</h2>'+table(['Streamer','Shows','Shows timed','Total streaming hours','Average show length','Longest show'],sellers.map(s=>[esc(s.name),String(s.shows.length),s.timed.length+' / '+s.shows.length,s.timed.length?airtime(sum(s.timed,'airtime_seconds')):'Not recorded',s.timed.length?airtime(Math.round(sum(s.timed,'airtime_seconds')/s.timed.length)):'Not recorded',s.timed.length?airtime(Math.max(...s.timed.map(s=>s.airtime_seconds))):'Not recorded']))+'<p class="wpr-note">Streaming hours are the full reported airtime of distinct shows starting in these dates. Each show counts once. Shows with no duration are excluded from totals and averages; processing durations are provisional. A show with multiple sellers stays in a review group rather than crediting its full airtime to more than one person.</p></section>'+
   '<section><h2>05 · Coverage & attribution</h2><p>'+known+' orders have confirmed show links; '+estimated+' are estimated from show time; '+(rows.length-known-estimated)+' are not linked to one show. Estimated links may include off-show purchases.</p><p>Saved report assignments take priority, followed by recorded sellers. Otherwise, shows starting from 6 PM through 7:59 AM Eastern are assigned to Otello. From 8 AM through 5:59 PM, Saturday and Sunday shows default to Manuella; Monday through Friday shows default to Sydney. The show’s Eastern start date determines the day. A show with multiple attributed sellers remains in a review group for airtime. This report does not change commission assignments.</p></section>'+
   '<footer class="wpr-footer">Prepared from Invsto order history and saved eBay Live Studio evidence. All sales are USD. Streaming hours represent reported show airtime.</footer></article>';
 }
 function csv(m){
  const rows=[['OG Jewelers production report',m.period.from,m.period.through,'America/New_York'],['Snapshot',m.data.as_of],[],['Sales by seller',...saleHeaders]];
  for(const [name,a] of groups(m.rows,r=>r.seller))rows.push([name,...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);
  rows.push([],['Sales by purchase day','Orders',...saleHeaders]);
  for(const d of m.data.days.filter(d=>!m.week||d.week===m.week)){const a=m.rows.filter(r=>r.day===d.day);rows.push([day(d.day),a.length,...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);}
  rows.push([],['Show','Seller','Scheduled start Eastern','Previously recorded start Eastern','Airtime seconds','Timing checked','Processing','Starts in period',...saleHeaders]);
  for(const s of m.shows){const a=m.rows.filter(r=>r.show===s.event_id);rows.push([s.title,s.seller,stamp(s.scheduled_start||s.starts_at),stamp(s.starts_at),s.airtime_seconds??'',s.airtime_checked_at||'',s.airtime_provisional?'Yes':'No',s.inPeriod?'Yes':'No',...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);}
  for(const [key,a] of groups(m.rows.filter(r=>!r.show),r=>r.show_source))rows.push([key,'','','','','','','',...['booked','cancelled','refunded','held','net'].map(k=>sum(a,k))]);
  rows.push([],['Streamer','Shows','Shows timed','Streaming hours','Average show seconds','Longest show seconds']);
  for(const [seller,shows] of groups(m.inPeriod,s=>s.seller)){
   const timed=shows.filter(s=>s.airtime_seconds!=null),seconds=sum(timed,'airtime_seconds');
   rows.push([seller,shows.length,timed.length,timed.length?Number((seconds/3600).toFixed(4)):'',timed.length?Math.round(seconds/timed.length):'',timed.length?Math.max(...timed.map(s=>s.airtime_seconds)):'']);
  }
  rows.push([],['Show timing','Scheduled start is not verified actual go-live. Airtime is reported by eBay Insights; processing values may change. Missing durations excluded. Each show counted once on recorded start date.'],[],['Order','Purchase date','Seller','Seller evidence','Show','Show evidence',...saleHeaders]);
  for(const r of m.rows)rows.push([r.order,r.day,r.seller,r.seller_source,r.show_title||'',r.show_source,...['booked','cancelled','refunded','held','net'].map(k=>r[k]||0)]);
  return '\ufeff'+rows.map(row=>row.map(v=>{let s=String(v??'');if(typeof v!=='number'&&/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
 }
 function open(data,week,client,focusHours=false){
  let m;try{m=model(JSON.parse(JSON.stringify(data)),week);}catch(e){window.alert(e.message);return;}
  const modal=document.createElement('dialog');modal.className='wpr-dialog';modal.setAttribute('aria-label','Production report');
  modal.innerHTML='<div class="wpr-toolbar"><strong>Report preview</strong><button type="button" data-wpr-print>Print / Save PDF</button><button type="button" data-wpr-csv>Download CSV</button><button type="button" data-wpr-close>Close</button></div><div class="wpr-content"></div>';
  const content=modal.querySelector('.wpr-content'),print=modal.querySelector('[data-wpr-print]'),download=modal.querySelector('[data-wpr-csv]');
  const draw=()=>{content.innerHTML=render(m);if(focusHours)content.querySelector('#wpr-streamer-hours').scrollIntoView({block:'start'});};
  const stopPrint=()=>document.body.classList.remove('wpr-printing');
  modal.addEventListener('close',()=>{stopPrint();window.removeEventListener('afterprint',stopPrint);modal.remove();});
  modal.querySelector('[data-wpr-close]').onclick=()=>modal.close();
  window.addEventListener('afterprint',stopPrint);
  print.onclick=()=>{document.body.classList.add('wpr-printing');window.print();};
  download.onclick=()=>{const url=URL.createObjectURL(new Blob([csv(m)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='production-'+m.period.from+'-to-'+m.period.through+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  document.body.append(modal);modal.showModal();draw();
 }
 window.WeeklyProductionReport={open,model,render,csv,timingLabel,airtime,hours};
})();
