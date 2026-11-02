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
 function comparePreset(months){
  const today=M.day(new Date()),key=months?'lastMonth':'fourWeeks',a=M.period(key,today),b=M.priorPeriod(key,a);
  for(const [prefix,r] of [['a',a],['b',b]])for(const k of ['start','end'])$(prefix+'-'+k).value=r[k];
  renderRefunds();
 }
 function renderRefunds(){
  if(!data||!idx)return;
  if(!$('a-start').value){comparePreset(false);return;}
  const periods=['a','b'].map(k=>({start:$(k+'-start').value,end:$(k+'-end').value}));
  const note=$('compare-note'),today=M.day(new Date());
  if(periods.some(p=>!p.start||!p.end||p.start>p.end||p.end>today)){note.textContent='Choose a valid start and end through today for each period.';return;}
  const coverage=data.config.coverage_start,basis=$('refund-basis').value,activity=basis==='activity';
  const warnings=[];
  if(!coverage||periods.some(p=>p.start<coverage))warnings.push('One or both periods extend before verified sales coverage. Totals for those dates are partial.');
  if((Date.parse(periods[0].end)-Date.parse(periods[0].start))!==(Date.parse(periods[1].end)-Date.parse(periods[1].start)))warnings.push('The periods contain different numbers of days. Raw totals reflect that difference.');
  if(periods[0].start<=periods[1].end&&periods[1].start<=periods[0].end)warnings.push('The periods overlap.');
  const checks=data.evidence?.requestor_checks||[];
  if(checks.some(c=>!c.checked||c.error))warnings.push('Some historical source checks are pending. Only verified refund postings and documented initiators are counted as confirmed.');
  if(checks.some(c=>c.error?.includes('429')))warnings.push('eBay has temporarily limited historical lookups. Invsto will retry automatically.');
  note.textContent=warnings.join(' ');
  const evidence=window.EbayRefundAnalysis.index(data,idx);
  const [a,b]=periods.map(p=>window.EbayRefundAnalysis.summarize(evidence,p,basis));
  const subt='<p class="kicker">A · '+dateRange(periods[0])+' &nbsp; | &nbsp; B · '+dateRange(periods[1])+'</p>';
  const moneyDelta=(a,b)=>a===b?cash(0):(a>b?'+':'−')+cash(Math.abs(a-b));
  const signed=n=>n>0?'+'+num(n):num(n);
  const change=(label,x,y,money=false)=>[label,money?cash(x):num(x),money?cash(y):num(y),money?moneyDelta(x,y):signed(x-y)];
  const comp=(rows)=>table(['Measure','Period A','Period B','Change · A minus B'],rows);
  const cancels=s=>s.refunds.filter(t=>/^Cancel ID\b/i.test(t.reference));
  const sum=ts=>ts.reduce((n,t)=>n+Number(t.gross),0);
  const metrics=[change('Posted refunds',a.refunds.length,b.refunds.length),change('Distinct orders with a refund',a.refunded.size,b.refunded.size),
   change('Gross refunded to buyers',a.gross,b.gross,true),change('Of which linked by cancellation ID',sum(cancels(a)),sum(cancels(b)),true),
   change('Other refund dollars',a.gross-sum(cancels(a)),b.gross-sum(cancels(b)),true),change('Seller debit after fee credits',a.net,b.net,true)];
  if(!activity)metrics.push(change('Sold order lines',a.soldLines,b.soldLines));
  const purchaseMonth=t=>t.purchaseLocal?.slice(0,7)||'Unknown';
  const originMonths=[...new Set([...a.refunds,...b.refunds].map(purchaseMonth))].sort().reverse();
  const origins=table(['Purchase month','A · postings / dollars','B · postings / dollars'],originMonths.map(k=>{
   const x=a.refunds.filter(t=>purchaseMonth(t)===k),y=b.refunds.filter(t=>purchaseMonth(t)===k);
   return [k==='Unknown'?k:new Date(k+'-15T12:00Z').toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'}),num(x.length)+' · '+cash(sum(x)),num(y.length)+' · '+cash(sum(y))];
  }));
  const old=activity?panel('Where the refunds came from',comp([change('Refunds on purchases before the period',a.old,b.old),
   change('Dollars from those earlier purchases',a.oldGross,b.oldGross,true),
   change('Dollars from purchases in this period',sum(a.refunds.filter(t=>t.purchaseLocal>=periods[0].start&&t.purchaseLocal<=periods[0].end)),sum(b.refunds.filter(t=>t.purchaseLocal>=periods[1].start&&t.purchaseLocal<=periods[1].end)),true),
   change('Refunds at least 30 days after purchase',a.long,b.long),change('Dollars at least 30 days after purchase',a.longGross,b.longGross,true),
   change('Purchase date unknown · postings',a.unknown,b.unknown),change('Purchase date unknown · dollars',a.unknownGross,b.unknownGross,true)])+
   '<p class="note">Age is measured in calendar days. The 30-day group can overlap the earlier-purchase group.</p><details><summary>See the original purchase months</summary>'+origins+'</details>'):'';
  const matched=(s,field,val,list)=>s[list].filter(t=>t[field]===val);
  const who=panel('Who initiated the refunds',table(['Refund issuer','A · postings / dollars','B · postings / dollars','Dollar change'],['Seller','Automatic','eBay support','Unverified'].map(k=>{
   const x=matched(a,'actor',k,'refunds'),y=matched(b,'actor',k,'refunds');
   return [k,num(x.length)+' · '+cash(sum(x)),num(y.length)+' · '+cash(sum(y)),moneyDelta(sum(x),sum(y))];
  }))+
   '<p class="note">Each posting appears once. Seller means the store account. We count a named refund action on the same return and posting date (allowing one day for time zones). A cancellation request, case ruling or charge to your balance alone does not identify the refund issuer.</p>');
  const timing=['No buyer payment recorded','Requested before payment','Requested at or after payment','Requested after payment','Same day · sequence unknown','Timing unknown'];
  const counts=(s,x)=>s.cases.filter(c=>c.timing===x).length;
  const countAge=s=>s.cases.filter(c=>c.beforeSale===true).length;
  const cancel=panel('Cancellations · request and payment',comp([change('Completed cancellation cases',a.cases.length,b.cases.length),
   ...['Seller','Buyer','Automatic','eBay support','Unverified'].map(k=>change('Initiated by '+k.toLowerCase(),matched(a,'actor',k,'cases').length,matched(b,'actor',k,'cases').length)),
   ...(activity?[change('Purchases from an earlier period',a.before,b.before),change('Original purchase date unknown',a.unknownCancel,b.unknownCancel)]:[]),
   ...timing.filter(k=>k==='Requested before payment'||counts(a,k)||counts(b,k)).map(k=>change(k,counts(a,k),counts(b,k))),change('Request recorded before original sale · review',countAge(a),countAge(b))])+
   '<p class="note">The sale date is the auction win or order creation. A buyer can win an auction and never pay. A buyer-requested reason can also appear on a seller-initiated cancellation. The final row flags conflicting chronology for review.</p>');
  const decidedWith=(s,ids)=>[...s.rulings.keys()].filter(id=>ids.has(id)).length;
  const intervention=panel('When eBay stepped in',comp([change('All eBay cases decided',a.allDecisions.length,b.allDecisions.length),
   change('With a recorded seller loss',a.allDecisions.filter(r=>r.outcome==='LOSE').length,b.allDecisions.filter(r=>r.outcome==='LOSE').length),
   change('Canceled or refunded orders with a linked escalation',a.escalations.size,b.escalations.size),
   change('Orders with a confirmed eBay ruling',a.rulings.size,b.rulings.size),
   change('With a ruling · canceled orders',decidedWith(a,a.canceled),decidedWith(b,b.canceled)),
   change('With a ruling · orders with posted refunds',decidedWith(a,a.refunded),decidedWith(b,b.refunded))])+
   '<p class="note">The first two rows count cases by '+(activity?'eBay’s decision date':'the order’s purchase date')+'. The remaining rows trace orders with a cancellation or refund in the period, even if eBay decided the case later. One order can appear in both subsets. A bank dispute or automatic refund alone does not count as a ruling.</p>');
  const reasonNames=[...new Set([...a.refunds,...b.refunds].map(t=>t.reason))];
  const drivers=reasonNames.map(reason=>{
   const x=a.refunds.filter(t=>t.reason===reason),y=b.refunds.filter(t=>t.reason===reason);
   return {reason,x,y,gap:sum(x)-sum(y)};
  }).sort((x,y)=>y.gap-x.gap);
  const driversPanel=panel('What changed by refund reason',table(['Recorded reason','A · postings / dollars','B · postings / dollars','Dollar change'],
   drivers.map(d=>[escape(d.reason),num(d.x.length)+' · '+cash(sum(d.x)),num(d.y.length)+' · '+cash(sum(d.y)),moneyDelta(sum(d.x),sum(d.y))]))+
   '<p class="note">Sorted by the largest dollar increase. A reason is shown only when the refund reference matches an eBay return or cancellation.</p>');
  const proof=(id,ref)=>{const u=orderUrl(id);return u?'<a target="_blank" rel="noopener" href="'+escape(u)+'">'+escape(id)+'</a>':escape(id||ref||'Unlinked');};
  const purchaseLabel=r=>{const d=activity?r.purchaseLocal:r.purchase;return d?date(d):'Unknown';};
  function ledger(s){
   const rows=s.refunds.map(t=>[proof(t.order_id),escape(t.reference)+'<small>'+escape(t.reason)+'</small>',date(t.day),purchaseLabel(t),t.age==null?'—':num(t.age)+' days',cash(t.gross),cash(t.net),escape(t.actor)+'<small>'+escape(t.source)+'</small>']);
   const cc=s.cases.map(c=>[proof(c.order,c.id),'<a href="https://www.ebay.com/Cancel/Details?cancelId='+encodeURIComponent(c.id)+'" target="_blank" rel="noopener">'+escape(c.id)+'</a>',date(c.date),purchaseLabel(c),escape(c.reason),escape(c.actor)+'<small>'+escape(c.source)+'</small>',escape(c.timing)]);
   const rulings=[...s.escalations].sort().map(id=>[proof(id),s.rulings.has(id)?'eBay ruling':'Escalation recorded',escape((s.rulings.get(id)||[]).join(', ')||'—')]);
   return '<details><summary>Refund postings ('+rows.length+')</summary>'+table(['Order','Reference','Posted','Purchased','Sale age','Buyer refund','Seller debit','Issuer and evidence'],rows)+'</details>'+
    '<details><summary>Cancellation records ('+cc.length+')</summary>'+table(['Order','Case','Requested','Purchased','Reason','Initiator and evidence','Payment timing'],cc)+'</details>'+
    '<details><summary>Escalated orders ('+rulings.length+')</summary>'+table(['Order','Evidence','Decided case IDs'],rulings)+'</details>'+
    '<details><summary>All decided cases ('+s.allDecisions.length+')</summary>'+table(['Order','Case ID','Purchased','eBay decision','Seller outcome'],s.allDecisions.map(r=>[proof(r.oid),escape(r.id),r.purchase?date(M.day(r.purchase)):'Unknown',r.decided_at?time(r.decided_at):'Date unverified',escape(r.outcome==='UNDEFINED'?'Not recorded':r.outcome)]))+'</details>';
  }
  $('refund-body').innerHTML=subt+panel(activity?'Refunds posted in each period':'Refunds on purchases from each period',comp(metrics)+
   '<p class="note">'+(activity?'Activity and original purchase dates in this comparison use eBay’s Pacific calendar. Cancellations use the request date.':'Later refunds and cancellations go back to the original Eastern purchase period. Recent purchases have had less time to generate a refund.')+
   ' Amounts reflect verified Refund entries. Claim debits appear separately in the claims report.</p>')+old+driversPanel+who+intervention+cancel+
   panel('Inspect the records','<h4>Period A</h4>'+ledger(a)+'<h4>Period B</h4>'+ledger(b))+
   '<p class="note">Latest order, case and refund evidence updates as Invsto syncs. Earlier purchases without a verified date stay in the unknown group.</p>';
  sources();
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
    if(which==='refunds')renderRefunds();else renderTrends();
   }
   $('print').disabled=false;$('status').textContent='Checked '+time(new Date())+' · Updates every minute while open.';
  }catch(e){if(seq===requestId)$('status').textContent=e.code==='42501'?'This report requires an active Invsto admin account.':'Could not refresh. Previously loaded figures remain visible. Invsto will retry automatically.';}
  finally{if(seq===requestId)active=false;}
 }
 function tab(which){
  visible=which;$('trends').hidden=which!=='trends';$('refunds').hidden=which!=='refunds';$('release').hidden=which!=='release';$('period-label').hidden=which!=='trends';
  $('attention').hidden=true;
  for(const k of ['trends','refunds','release'])$(k+'-tab').setAttribute('aria-pressed',String(k===which));
  history.replaceState(null,'','#'+which);load();
 }
 $('refresh').onclick=()=>load(true);$('period').onchange=()=>renderTrends();$('print').onclick=()=>window.print();
 $('refund-filters').onsubmit=e=>{e.preventDefault();renderRefunds();};
 $('refund-basis').onchange=renderRefunds;$('last-months').onclick=()=>comparePreset(true);$('last-28').onclick=()=>comparePreset(false);
 $('refunds-tab').onclick=()=>tab('refunds');$('trends-tab').onclick=()=>tab('trends');$('release-tab').onclick=()=>tab('release');
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
  tab(['#release','#refunds'].includes(location.hash)?location.hash.slice(1):'trends');
  setInterval(()=>{if(!active&&!document.hidden)load();},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
 }
 const boot=()=>start().catch(()=>{$('status').textContent='Could not connect to Invsto. Refresh this page to retry.';});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
