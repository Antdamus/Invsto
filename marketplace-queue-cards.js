/* Shared pending-queue summary. Amounts stay in their original currency. */
(function(){
 'use strict';
 const labels={all:'All dates',overdue:'Overdue',today:'Due today',tomorrow:'Due tomorrow',unknown:'Date needed',ready:'Ready to work',waiting:'Waiting',watches:'Watches',cgl:'Pending CGL',missing_watch:'Missing watches',cancel:'Pending to cancel',missing:'Item not found',no_tracking:'No tracking',no_screenshot:'Needs screenshot'};
 const dateKeys=['all','overdue','today','tomorrow'];
 const workKeys=['missing','no_screenshot','missing_watch','cgl','cancel','watches','no_tracking','ready','waiting'];
 const formats=new Map();
 function money(value,currency){
  if(!formats.has(currency))formats.set(currency,new Intl.NumberFormat('en-US',{style:'currency',currency,currencyDisplay:'symbol'}));
  return formats.get(currency).format(value);
 }
 const counted=(n,label)=>Number(n||0)+' '+label+(Number(n)===1?'':'s');
 const amounts=s=>Object.entries(s?.amounts||{}).filter(([currency])=>/^[A-Z]{3}$/.test(currency));
 function known(value,missing,lines,currency){
  if(missing&&missing>=lines)return 'Unavailable';
  return money(Number(value||0),currency)+(missing?' (partial)':'');
 }
 function metric(label,value){return '<div><dt>'+label+'</dt><dd>'+value+'</dd></div>';}
 function figures(summary){
  const entries=amounts(summary);
  return entries.map(([currency,m])=>{
   const amount=(value,missing)=>known(value,missing,m.lines??summary.lines,currency);
   const recorded=m.actual&&!m.estimated, incomplete=m.unknown_fees||m.unknown_ship||m.unknown_sales;
   const feeLabel=recorded?'Statement deductions':m.actual?'Recorded + est. fees':'Est. fees';
   const net=incomplete?'Unavailable':money(Number(m.sales)+Number(m.shipping)-Number(m.fees),currency);
   return (entries.length>1?'<strong class="mq-currency">'+currency+'</strong>':'')+
    '<dl class="mq-metrics">'+metric('Item value',amount(m.sales,m.unknown_sales))+metric('Shipping collected',amount(m.shipping,m.unknown_ship))+
    metric(feeLabel,amount(m.fees,m.unknown_fees))+metric(recorded?'Items + shipping after fees':'Est. items + shipping after fees',net)+'</dl>';
  }).join('');
 }
 function chip(type,key,stats,pressed){
  const count=Number(stats?.lines||0), currencyAmounts=amounts(stats);
  const value=currencyAmounts.filter(([,m])=>Number(m.unknown_sales||0)<Number(m.lines??count))
   .map(([currency,m])=>(currencyAmounts.length>1?currency+' ':'')+known(m.sales,m.unknown_sales,m.lines??count,currency)).join(' / ');
  const name=type==='work'&&key==='all'?'All work':labels[key];
  if(type==='due'&&key!=='unknown'){
   return '<button type="button" class="mq-deadline mq-'+key+'" data-mq-type="due" data-mq-key="'+key+'" aria-pressed="'+pressed+'"><span class="mq-chip-name">'+name+'</span>'+
    '<span class="mq-deadline-stats"><span class="mq-chip-count">'+count+'</span> '+(count===1?'item line':'item lines')+'</span>'+
    (value?'<small class="mq-chip-value" aria-label="Item value '+value+'">'+value+'</small>':'')+'</button>';
  }
  return '<button type="button" class="mq-chip mq-'+key+'" data-mq-type="'+type+'" data-mq-key="'+key+'" aria-pressed="'+pressed+'"><span class="mq-chip-name">'+name+'</span>'+
   (key==='all'?'':'<span class="mq-chip-count" aria-label="'+counted(count,'order line')+'">'+count+'</span>')+
   (value?'<small class="mq-chip-value" aria-label="Item value '+value+'">'+value+'</small>':'')+'</button>';
 }
 function render(el,facets,due,work){
  const focused=el.contains(document.activeElement)?document.activeElement.dataset:null;
  function group(type,title,keys,active){
   return '<fieldset class="mq-filter-group"><legend>'+title+'</legend><div>'+keys.map(k=>chip(type,k,facets[type+':'+k],k===active)).join('')+'</div></fieldset>';
  }
  el.innerHTML='<section class="mq-deadlines" aria-label="Shipping deadlines"><header><h2>Shipping deadlines</h2>'+
   chip('due','unknown',facets['due:unknown'],due==='unknown')+'</header><div class="mq-deadline-grid">'+
   dateKeys.map(key=>chip('due',key,facets['due:'+key],key===due)).join('')+'</div></section>'+
   group('work','Work status',['all',...workKeys],work);
  if(focused?.mqKey)el.querySelector('[data-mq-type="'+focused.mqType+'"][data-mq-key="'+focused.mqKey+'"]')?.focus({preventScroll:true});
 }
 function shown(el,s,{title='Queue overview',target}={}){
  const items=s?.units===s?.lines?counted(s?.lines,'item line'):counted(s?.units,'item')+' on '+counted(s?.lines,'line');
  const counts=[counted(s?.orders,'order'),items,counted(s?.buyers,'buyer')].join(' · ');
  el.innerHTML='<header class="mq-overview-head"><div><h2>'+title+'</h2><p>'+counts+'</p></div>'+
   (target&&s?.lines?'<a href="#'+target+'">View orders <span aria-hidden="true">↓</span></a>':'')+'</header>'+figures(s);
 }
 function screenshotBadge(missing){
  const message=missing?counted(missing,'line')+(missing===1?' needs':' need')+' a screenshot':'All lines have screenshots';
  return '<span class="mq-coverage '+(missing?'needs-photo':'has-photo')+'">'+message+'</span>';
 }
 function linePhoto(count){
  return '<span class="mq-coverage '+(count?'has-photo':'needs-photo')+'">'+(count?counted(count,'screenshot')+' saved':'Needs screenshot')+'</span>';
 }
 function orderCounts(lines,units,shownLines){
  return counted(lines,'order line')+' · '+counted(units,'item')+(shownLines<lines?' · Showing '+shownLines+' of '+lines:'');
 }
 window.PendingQueueCards={render,shown,screenshotBadge,linePhoto,orderCounts};
})();
