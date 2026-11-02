(()=>{
 'use strict';
 const M=window.EbayPerformance,$=id=>document.getElementById(id);
 const currency=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
 const cash=cents=>currency.format(Number(cents)/100),num=n=>Number(n).toLocaleString('en-US');
 const percent=n=>n==null?'—':n.toFixed(2)+'%';
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=d=>new Date(d+'T12:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
 const time=s=>s?new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Not yet verified';
 const card=(title,value,note)=>'<article class="card"><span>'+escape(title)+'</span><b>'+escape(value)+'</b><small>'+escape(note)+'</small></article>';
 const panel=(title,body)=>'<section class="panel"><h3>'+escape(title)+'</h3>'+body+'</section>';
 const table=(labels,rows,total)=>'<div class="table-wrap"><table class="mobile"><thead><tr>'+labels.map(l=>'<th scope="col">'+escape(l)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>tableRow(labels,row)).join('')+'</tbody>'+
  (total?'<tfoot>'+tableRow(labels,total)+'</tfoot>':'')+'</table></div>';
 const tableRow=(labels,row)=>'<tr>'+row.map((v,i)=>'<td'+(i?' data-label="'+escape(labels[i])+'"':'')+'>'+v+'</td>').join('')+'</tr>';
 let db,data,idx,releaseData,visible='trends',requestId=0,lastReleaseLoad=0,lastLoaded=0,active=false;
 const metrics=[['cancellation','All canceled lines','canceled'],['buyer','Buyer-requested lines','buyer'],['refund','Other refund lines','other']];
 function csvFile(name,rows){
  const quote=x=>{let s=String(x??'');if(/^[=+@\t\r-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
 }
 function sources(){
  const s=data.sources.sources||{},config=data.config;
  const warnings=[];
  if(!config.coverage_start)warnings.push('The first verified report has not been imported yet.');
  const old=(at,hours)=>!at||Date.now()-Date.parse(at)>hours*3600000;
  if(old(s.cases?.last,12)||old(s.orders?.last,12))warnings.push('The signed-in Seller Hub check is overdue. On the Edge workstation, enable OG eBay Order Link v1.0.32 or later and sign in to Invsto and OG Jewelers’ Seller Hub.');
  for(const [kind,src] of Object.entries(s))if(src.errors)warnings.push(kind+' · '+src.note);
  if(s.payments?.waiting)warnings.push(num(s.payments.waiting)+' order transaction checks are queued. Refund totals show the postings verified so far.');
  const el=$('attention');el.hidden=!warnings.length;el.textContent=warnings.join(' ');
  return '<p class="note">Order pages last checked '+escape(time(s.orders?.last))+' · Cancellation register '+escape(time(s.cases?.last))+
   ' · Refund postings '+escape(time(s.payments?.last))+'.</p><p class="note">The Edge workstation checks Seller Hub in the background. Changes apply to the original purchase period. Recent sales have had less time to develop a refund.</p>';
 }
 function dateRange(p){return date(p.start)+' – '+date(p.end);}
 function renderTrends(){
  if(!idx)return;
  const today=M.day(new Date()),key=$('period').value,p=M.period(key,today),previous=M.priorPeriod(key,p);
  const current=M.summarize(idx,p);
  const coverage=data.config.coverage_start,currentComplete=!!coverage&&p.start>=coverage;
  // A new store may have the verified four-month baseline but not eight months for comparison.
  // Use an explicitly labeled 28-day comparison until both full periods are covered.
  const useRecent=key==='four'&&(!coverage||previous.start<coverage);
  const checkPeriod=useRecent?M.period('fourWeeks',today):p;
  const comparePeriod=useRecent?M.priorPeriod('fourWeeks',checkPeriod):previous;
  const measured=useRecent?M.summarize(idx,checkPeriod):current,prev=M.summarize(idx,comparePeriod);
  const prevComplete=!!coverage&&comparePeriod.start>=coverage;
  const fresh=data.sources.sources||{};
  const outOfDate=['orders','cases','payments'].some(k=>!fresh[k]?.last||Date.now()-Date.parse(fresh[k].last)>24*3600000||fresh[k].errors);
  const cards='<div class="cards">'+card('Original sold lines',num(current.lines),num(current.orders)+' orders · '+num(current.paid)+' paid lines')+
   card('Canceled',percent(current.rates.cancellation),num(current.canceled)+' lines, including unpaid sales')+
   card('Buyer requests',percent(current.rates.buyer),num(current.buyer)+' lines within cancellations')+
   card('Other refunds',percent(current.rates.refund),num(current.other)+' lines with a separate Refund debit')+'</div>';
  function progress([key,name]){
   const rate=measured.rates[key],target=data.config[key],diff=prevComplete&&rate!=null&&prev.rates[key]!=null?rate-prev.rates[key]:null;
   let label='No target set',style='neutral';
   if(target!=null){
    if(!coverage||checkPeriod.start<coverage||rate==null||outOfDate||fresh.orders?.waiting||fresh.cases?.waiting||
      (key==='refund'&&(measured.unassigned||measured.unassignedPartial||fresh.payments?.waiting))||
      (key==='buyer'&&(fresh.case_detail?.waiting||measured.reasons.has('Reason not verified')||measured.reasons.has('Conflicting cases'))))label='Awaiting verification';
    else if(rate<=target){label='On track';style='good';}else{label='Above target';style='bad';}
   }
   return [name,percent(rate),diff==null?'Comparison unavailable':(diff>0?'↑ ':diff<0?'↓ ':'')+Math.abs(diff).toFixed(2)+' pp',target==null?'—':'≤ '+percent(Number(target)),
    '<span class="'+style+'">'+label+'</span>'];
  }
  const track=panel('Are we on track?','<p><b>'+escape(dateRange(checkPeriod))+'</b> · '+num(measured.lines)+' sold lines</p>'+table(['Measure','Current','Change','Maximum','Status'],metrics.map(progress))+
   '<p class="note">Compared with '+escape(dateRange(comparePeriod))+' ('+num(prev.lines)+' saved lines). Change is in percentage points. Lower rates are better. '+(useRecent?'Showing the last 28 days because a full prior four-month history is not available. ':'')+(!prevComplete?'That entire comparison period is not covered by the verified history.':'')+'</p>');
  function monthRow(label,s){return [label,num(s.lines),...metrics.map(([k,,field])=>num(s[field])+' · '+percent(s.rates[k]))];}
  const monthRows=[];
  for(let first=p.start;first<=p.end;){
   const last=M.offset(new Date(Date.UTC(Number(first.slice(0,4)),Number(first.slice(5,7)),1,12)).toISOString().slice(0,10),-1);
   const end=last<p.end?last:p.end;
   monthRows.push(monthRow(dateRange({start:first,end}),M.summarize(idx,{start:first,end})));first=M.offset(end,1);
  }
  const monthly=panel('Purchase months',table(['Purchase dates','Sold lines','Canceled','Buyer request','Other refund'],monthRows,monthRow('Period total',current)));
  const reasons=[...current.reasons].sort((a,b)=>b[1].lines-a[1].lines).map(([k,v])=>[escape(k),num(v.lines),percent(v.lines*100/current.lines),cash(v.gross)]);
  const reasonPanel=panel('Why sales were canceled',table(['eBay reason','Lines','Share of sold lines','Buyer refunds on matched cases'],reasons)+
   '<p class="note">Buyer requests combine “Buyer requested” and “Buyer initiated”. Mistakes, unpaid wins and address issues have their own rows. One case can cover several lines.</p>');
  const money=panel('What buyers received',table(['Refund type','Buyer received','Seller debit after fee credits'],[
   ['From canceled orders',cash(current.cancelGross),cash(current.cancelNet)],['Other Refund transactions',cash(current.otherGross),cash(current.otherNet)]],
   ['Total posted as Refund',cash(current.cancelGross+current.otherGross),cash(current.cancelNet+current.otherNet)])+
   '<p class="note">Amounts may include shipping and tax. Claims and payment disputes are separate. '+num(current.outcomes)+' non-canceled lines have a refund outcome or refund posting; '+num(current.other)+' have an attributed Refund debit.'+
   (current.unassigned||current.unassignedPartial?' '+num(current.unassigned)+' postings or '+num(current.unassignedPartial)+' partially refunded orders lack a verified item allocation.':'')+'</p>');
  const activity=[...idx.cases.values()].filter(c=>c.requested>=p.start&&c.requested<=p.end);
  const upper=panel('Sources & definitions','<p>'+num(activity.length)+' completed cancellation cases were requested during this period. The tables above group by the original sale date. A July cancellation for a June purchase belongs to June’s sales.</p>'+sources());
  $('trend-body').innerHTML='<p class="kicker">'+escape(dateRange(p))+' · EASTERN</p>'+(!currentComplete?'<p class="attention">Verified coverage starts '+escape(coverage?date(coverage):'when the first check finishes')+'. Some of this period is missing.</p>':'')+
   cards+track+monthly+reasonPanel+money+
   '<div class="tools"><button id="lines-csv">Download affected lines (CSV)</button><button id="payments-csv">Download refund postings (CSV)</button></div>'+upper;
  $('lines-csv').onclick=()=>csvFile('ebay-affected-lines-'+p.end+'.csv',[['Order / sales reference','Purchase date (ET)','Buyer','Title','Outcome','Reason','Case','eBay order or case'],...current.details.map(l=>[l.id,l.day,l.buyer,l.item,l.kind,l.reason,l.caseId,l.caseId?'https://www.ebay.com/Cancel/Details?cancelId='+l.caseId:orderUrl(l.id)])]);
  $('payments-csv').onclick=()=>csvFile('ebay-refund-postings-'+p.end+'.csv',[['Order','Posting day','Reference','Refund type','Buyer received (USD)','Seller debit (USD)','eBay order'],...current.payments.map(t=>[t.order_id,t.day,t.reference,t.cancellation?'Cancellation':'Other refund',(t.gross/100).toFixed(2),(t.net/100).toFixed(2),orderUrl(t.order_id)])]);
  if(!$('targets').open)for(const [k] of metrics)$('goal-'+k).value=data.config[k]??'';
 }
 const orderUrl=id=>/^\d{2}-\d{5}-\d{5}$/.test(id)?'https://www.ebay.com/mesh/ord/details?orderid='+id:'';
 function renderRelease(){
  if(!releaseData)return;
  const today=M.day(new Date()),report=M.releaseRows(releaseData,today,window.OGEbayHoldDetails);
  const rows=report.groups.map(g=>{
   const waits=g.rows.map(r=>r.wait).filter(n=>n!=null).sort((a,b)=>a-b);
   const median=waits.length?(waits[Math.floor((waits.length-1)/2)]+waits[Math.floor(waits.length/2)])/2:null;
   return [date(g.date),num(g.rows.length),cash(g.cents),waits.length?median+' days':'No signed close',waits.length?waits[0]+'–'+waits.at(-1)+' days':'—',waits.length+' / '+g.rows.length];
  });
  const stale=!releaseData.verified_at||Date.now()-Date.parse(releaseData.verified_at)>9*3600000;
  $('release-body').innerHTML='<p class="kicker">NEXT 14 DAYS · EASTERN</p>'+
   (stale?'<p class="attention">The itemized hold list is out of date. Check the Seller Hub connection in Weekly marketplace sales.</p>':'')+
   panel('Upcoming estimated releases',rows.length?table(['Estimated release','Orders','Held credit','Median wait','Range','Signed closures'],rows):'<p>No currently held sale credits have a verified release estimate in this window.</p>')+
   '<p>Wait is measured from the last signed item-line closure in Invsto to eBay’s estimated release day. An order without a complete signed closure is excluded from the timing statistics.</p><p class="note">'+num(report.undated)+' held orders have no usable date. Some payment messages supply only the month and day; these are matched within the displayed 14 days. Verified Seller Hub list: '+escape(time(releaseData.verified_at))+'. Bank transfers follow a separate schedule.</p>'+
   (rows.length?'<button id="release-csv" class="screen-only">Download order-level timing (CSV)</button>':'');
  if(rows.length)$('release-csv').onclick=()=>csvFile('ebay-release-timing-'+today+'.csv',[['Estimated release','Order','Credit (USD)','Final signed close (ET)','Days','Order link'],...report.groups.flatMap(g=>g.rows.map(r=>[g.date,r.id,(r.cents/100).toFixed(2),r.closed?time(r.closed):'',r.wait,orderUrl(r.id)]))]);
 }
 async function load(force=false){
  if(!db||document.hidden)return;
  const seq=++requestId,which=visible;active=true;
  try{
   if(which==='release'){
    if(force||!releaseData||Date.now()-lastReleaseLoad>=60000){const r=await db.rpc('ebay_health_release_evidence');if(r.error)throw r.error;if(seq!==requestId)return;releaseData=r.data;lastReleaseLoad=Date.now();}
    renderRelease();
   }else{
    if(!force&&data&&Date.now()-lastLoaded<15*60000){const check=await db.rpc('ebay_health_badge');if(check.error)throw check.error;
     if(seq!==requestId)return;if(check.data.version!==data.sources.version)force=true;else data.sources=check.data;}
    if(force||!data||Date.now()-lastLoaded>=15*60000){const r=await db.rpc('ebay_health_report');if(r.error)throw r.error;if(seq!==requestId)return;data=r.data;idx=M.index(data);lastLoaded=Date.now();}
    renderTrends();
   }
   $('print').disabled=false;$('status').textContent='Checked '+time(new Date())+' · Updates every minute while open.';
  }catch(e){if(seq===requestId)$('status').textContent=e.code==='42501'?'This report requires an active Invsto admin account.':'Could not refresh. Previously loaded figures remain visible. Invsto will retry automatically.';}
  finally{if(seq===requestId)active=false;}
 }
 function tab(which){
  visible=which;$('trends').hidden=which!=='trends';$('release').hidden=which!=='release';$('period-label').hidden=which!=='trends';
  $('attention').hidden=true;
  for(const k of ['trends','release'])$(k+'-tab').setAttribute('aria-pressed',String(k===which));
  history.replaceState(null,'',which==='release'?'#release':'#trends');load();
 }
 $('refresh').onclick=()=>load(true);$('period').onchange=()=>renderTrends();$('print').onclick=()=>window.print();
 $('trends-tab').onclick=()=>tab('trends');$('release-tab').onclick=()=>tab('release');
 $('goal-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget;if(!db||!data||!form.reportValidity())return;
  const v=k=>$('goal-'+k).value===''?null:Number($('goal-'+k).value);const btn=form.querySelector('button');btn.disabled=true;
  try{const r=await db.rpc('set_ebay_health_targets',{_cancel:v('cancellation'),_buyer:v('buyer'),_refund:v('refund')});if(r.error)throw r.error;
   await load(true);$('goal-note').textContent='Targets saved for this store.';
  }catch{$('goal-note').textContent='Targets could not be saved. Try again.';}finally{btn.disabled=false;}
 };
 async function start(){
  db=window.supabaseClient;if(!db){$('status').textContent='Could not connect to Invsto.';return;}
  const {data:session}=await db.auth.getSession();if(!session?.session){$('status').innerHTML='Sign in to your Invsto admin account to view the report. <a href="index.html">Sign in</a>';return;}
  tab(location.hash==='#release'?'release':'trends');
  setInterval(()=>{if(!active&&!document.hidden)load();},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
 }
 const boot=()=>start().catch(()=>{$('status').textContent='Could not connect to Invsto. Refresh this page to retry.';});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
