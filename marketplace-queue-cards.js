/* Shared presentation for the two pending workspaces. Values are amounts in
   the named currency, never converted or combined across currencies. */
(function(){
 'use strict';
 const labels={all:'Open queue',overdue:'Overdue',today:'Due today',tomorrow:'Due tomorrow',unknown:'Date needed',ready:'Ready to work',waiting:'Waiting',watches:'Watches',cgl:'Pending CGL',missing_watch:'Missing watches',cancel:'Pending to cancel',missing:'Item not found',no_tracking:'No tracking'};
 const dateKeys=['all','overdue','today','tomorrow','unknown'],workKeys=['ready','waiting','cgl','missing_watch','cancel','missing','watches','no_tracking'];
 const formats=new Map();
 function money(n,c){if(!formats.has(c))formats.set(c,new Intl.NumberFormat('en-US',{style:'currency',currency:c}));return formats.get(c).format(n);}
 const counted=(n,label)=>Number(n||0)+' '+label+(Number(n)===1?'':'s');
 function figures(m,c,lines){
  const known=(n,missing)=>missing&&missing>=lines?'Unavailable':money(Number(n||0),c)+(missing?' (partial)':'');
  const partial=m.unknown_fees||m.unknown_ship||m.unknown_sales;
  return '<div class="mq-figures"><b>'+known(m.sales,m.unknown_sales)+' <small>item value</small></b><span>Shipping collected: '+known(m.shipping,m.unknown_ship)+'</span><span>'+(m.actual&&m.estimated?'Recorded + est. fees':m.actual?'Statement deductions':'Est. fees')+': '+known(m.fees,m.unknown_fees)+'</span><span>'+(m.actual&&!m.estimated?'Items + shipping after deductions':'Est. items + shipping after fees')+': '+(partial?'Unavailable':money(Number(m.sales)+Number(m.shipping)-Number(m.fees),c))+'</span></div>';
 }
 function figuresFor(s){const currencies=Object.entries(s?.amounts||{}).filter(([c])=>/^[A-Z]{3}$/.test(c));
  return currencies.map(([c,m])=>figures(m,c,m.lines??s.lines)).join('');}
 function card(type,key,s,pressed){
  const a=s||{orders:0,lines:0,buyers:0,units:0},count=Number(a.lines);
  return '<button type="button" class="mq-card mq-'+key+'" data-mq-type="'+type+'" data-mq-key="'+key+'" aria-pressed="'+pressed+'"><span class="mq-title">'+labels[key]+'</span><strong>'+count+' <small>line'+(count===1?'':'s')+'</small></strong><span class="mq-counts">'+counted(a.orders,'order')+' · '+counted(a.buyers,'buyer')+'</span>'+figuresFor(a)+'</button>';
 }
 function render(el,facets,due,work){
  el.innerHTML='<div class="mq-dates">'+dateKeys.map(k=>card('due',k,facets['due:'+k],k===due)).join('')+'</div><div class="mq-work">'+workKeys.map(k=>card('work',k,facets['work:'+k],k===work)).join('')+'</div>';
 }
 function shown(el,s){el.innerHTML='<strong>Current selection</strong> · '+[counted(s?.lines,'order line'),counted(s?.units,'item'),counted(s?.orders,'order'),counted(s?.buyers,'buyer')].join(' · ')+figuresFor(s||{});}
 window.PendingQueueCards={render,shown};
})();
