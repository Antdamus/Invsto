/* Calendar deadlines and buyer grouping for the TikTok workspace only. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TikTokOrderQueue=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const TIME_ZONE='America/New_York';
 const customerName=o=>[o.recipient_name,o.buyer_nickname,o.buyer_name,o.buyer_username].map(v=>String(v||'').trim()).find(v=>v&&!/^name not provided$/i.test(v))||'Customer';
 const lineCancelled=(l,o)=>Boolean(l.cancelled_at)||['Canceled','Cancelled'].includes(o?.marketplace_status);
 const cancelled=o=>['Canceled','Cancelled'].includes(o.marketplace_status)||Boolean(o.lines?.length&&o.lines.every(l=>lineCancelled(l)));
 const hasCancellation=o=>cancelled(o)||Boolean(o.lines?.some(l=>lineCancelled(l)));
 const cancellationReview=o=>!cancelled(o)&&Boolean(o.cancellation?.pending||o.cancel_return);
 const needsCancellation=o=>cancellationReview(o)||(cancelled(o)&&!o.cancellation_signed_at&&o.lines.some(l=>!l.cancellation_signed_at))||o.lines.some(l=>lineCancelled(l,o)&&!l.cancellation_signed_at);
 const inView=(o,{history=false,cancelledOnly=false}={})=>cancelledOnly?needsCancellation(o):history?(!needsCancellation(o)&&closed(o))||o.lines.some(l=>lineCancelled(l,o)&&l.cancellation_signed_at):!closed(o)&&!cancellationReview(o);
 const visibleLines=(o,{history=false,cancelledOnly=false}={})=>(o.lines||[]).filter(l=>cancelledOnly?cancellationReview(o)||(lineCancelled(l,o)&&!l.cancellation_signed_at):history?(lineCancelled(l,o)?Boolean(l.cancellation_signed_at):closed(o)):!lineCancelled(l,o));
 const lineCompleted=l=>Boolean(l.fulfilled_at);
 const lost=l=>l.work?.item_search==='not_found'||Boolean(l.work?.watch_missing);
 const lineHeld=l=>!lineCancelled(l)&&!lineCompleted(l)&&(lost(l)||Boolean(l.work?.cgl_required&&!l.work?.certificate_id));
 const closed=o=>cancelled(o)||Boolean(o.lines?.some(l=>lineCancelled(l))&&o.lines.every(l=>lineCancelled(l)||lineCompleted(l)))||['dispatched','completed'].includes(o.stage)||['Canceled','Cancelled'].includes(o.marketplace_status)||(!o.reopened_at&&!o.lines?.some(lineCompleted)&&['Shipped','Completed'].includes(o.marketplace_status)&&!o.lines?.some(l=>l.inventory?.quantity>l.inventory?.consumed_quantity));
 const calendarFormat=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
 function calendarDate(now=new Date()){const p=Object.fromEntries(calendarFormat.formatToParts(now).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;}
 function day(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return null;const n=Date.parse(value+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value?n/86400000:null;}
 function urgency(value,now=new Date()){const due=day(value);if(due===null)return {level:'unknown',label:'Date needed',days:null};const delta=due-day(calendarDate(now));return delta<0?{level:'overdue',label:`Overdue ${-delta}d`,days:delta}:delta===0?{level:'today',label:'Due today',days:0}:delta===1?{level:'tomorrow',label:'Due tomorrow',days:1}:{level:'upcoming',label:`Due in ${delta}d`,days:delta};}
 function shortDate(value){return day(value)===null?'Date needed':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));}
 function purchaseDate(value){const raw=String(value||'').trim(),m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(raw);const date=m?`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`:/^\d{4}-\d{2}-\d{2}(?:T|\s|$)/.test(raw)?raw.slice(0,10):'';return day(date)===null?'':date;}
 function sourceTime(value){
  const raw=String(value||'').trim();
  // API timestamps are already Eastern wall-clock values, just like the CSV.
  // Keep their calendar components rather than parsing in the viewer's zone.
  const api=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if(api){if(day(raw.slice(0,10))===null||+(api[4]||0)>23||+(api[5]||0)>59||+(api[6]||0)>59)return 0;return Date.UTC(+api[1],+api[2]-1,+api[3],+(api[4]||0),+(api[5]||0),+(api[6]||0));}
  const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM))?/i.exec(raw);if(!m)return 0;const h=m[4]?(+m[4]%12)+(m[7]?.toUpperCase()==='PM'?12:0):0;return Date.UTC(+m[3],+m[1]-1,+m[2],h,+(m[5]||0),+(m[6]||0));
 }
 const held=o=>Boolean(cancellationReview(o)||o.lines?.some(lineHeld));
 function group(orders,now=new Date()){
  const groups=new Map();for(const o of orders){const key=o.buyer_username.toLowerCase();if(!groups.has(key))groups.set(key,{key,buyer:o.buyer_username,orders:[]});groups.get(key).orders.push(o);}
  return [...groups.values()].map(g=>{const dates=g.orders.map(o=>o.ship_by_date).filter(d=>day(d)!==null).sort();const lines=g.orders.flatMap(o=>o.lines||[]);return {...g,lines,quantity:lines.reduce((n,l)=>n+l.quantity,0),total:g.orders.reduce((n,o)=>n+Number(o.order_amount||0),0),shipBy:dates[0]||null,unknown:g.orders.filter(o=>day(o.ship_by_date)===null).length,urgency:urgency(dates[0],now),created:Math.min(...g.orders.map(o=>sourceTime(o.created_time))),waiting:g.orders.filter(o=>o.stage==='waiting'||held(o)).length,labelCount:g.orders.filter(o=>o.documents?.some(d=>d.kind==='label')).length};});
 }
 function select(orders,{history=false,cancelledOnly=false,term='',stage='',work='',due='all',purchase='',sort='oldest',now=new Date()}={}){
  const needle=term.trim().toLowerCase();const groups=group(orders.filter(o=>inView(o,{history,cancelledOnly})),now).map(g=>{const lines=g.orders.flatMap(o=>visibleLines(o,{history,cancelledOnly}));return {...g,lines,quantity:lines.reduce((n,l)=>n+l.quantity,0)};}).filter(g=>(!purchase||g.orders.some(o=>purchaseDate(o.created_time)===purchase))&&(!work||(work==='waiting'?g.waiting>0:work==='ready'?g.waiting===0:work==='cancel'?g.orders.some(o=>o.cancellation?.pending):g.lines.some(l=>work==='not_found'?l.work?.item_search==='not_found':work==='missing'?l.work?.watch_missing:work==='cgl'?l.work?.cgl_required&&!l.work?.certificate_id:false)))&&(!stage||g.orders.some(o=>o.stage===stage))&&(!needle||g.orders.some(o=>JSON.stringify([o.order_number,o.buyer_username,o.buyer_nickname,o.recipient_name,o.lines?.map(l=>[l.title,l.seller_sku,l.sku_id,l.tracking_number])]).toLowerCase().includes(needle)))&&(history||due==='all'||(due==='unknown'?g.unknown>0:g.urgency.level===due)));
  const compare=sort==='due'?(a,b)=>(a.shipBy||'9999').localeCompare(b.shipBy||'9999'):sort==='latest'?(a,b)=>(b.shipBy||'').localeCompare(a.shipBy||''):sort==='newest'?(a,b)=>b.created-a.created:sort==='value'?(a,b)=>b.total-a.total:sort==='low'?(a,b)=>a.total-b.total:sort==='buyer_desc'?(a,b)=>b.buyer.localeCompare(a.buyer):sort==='buyer'?(a,b)=>a.buyer.localeCompare(b.buyer):(a,b)=>a.created-b.created;
  return groups.sort((a,b)=>compare(a,b)||a.buyer.localeCompare(b.buyer));
 }
 const watch=l=>Boolean(l.work?.is_watch||l.work?.watch_missing||/\b(?:wrist|smart)?watch(?:es)?\b/i.test(l.title||''));
 const matchWork=(l,key)=>key==='no_screenshot'?!l.screenshot_count:key==='watches'?watch(l):key==='missing'?Boolean(l.work?.watch_missing||watch(l)&&l.work?.item_search==='not_found'):key==='not_found'?l.work?.item_search==='not_found':key==='cgl'?Boolean(l.work?.cgl_required&&!l.work?.certificate_id):key==='no_tracking'?!String(l.tracking_number||'').trim():true;
 const lineWork=k=>['watches','missing','not_found','cgl','no_tracking','no_screenshot'].includes(k);
 function pendingGroups(orders,opts={}){
  const history=new Set(orders.filter(o=>hasCancellation(o)||cancellationReview(o)).map(o=>o.buyer_username.toLowerCase()));
  const cancel=opts.work==='cancel';
  const base=select(orders,{...opts,history:false,cancelledOnly:cancel,work:'',due:'all'});
  const result=[];
  for(const g of base){
   if(opts.buyerHistory&&opts.buyerHistory!=='all'&&history.has(g.key)!==(opts.buyerHistory==='cancellations'))continue;
   const open=g.orders.filter(o=>!cancel||cancellationReview(o)).map(o=>({...o,sourceLines:o.lines,lines:o.lines.filter(l=>!lineCompleted(l)&&!lineCancelled(l,o))})).filter(o=>o.lines.length);
   if(!open.length)continue;
   const whole=group(open,opts.now)[0],due=opts.due||'all';
   if(due!=='all'&&(due==='unknown'?!whole.unknown:whole.urgency.level!==due))continue;
   if(opts.work==='ready'&&whole.waiting||opts.work==='waiting'&&!whole.waiting)continue;
   const narrow=open.map(o=>({...o,lines:o.lines.filter(l=>matchWork(l,opts.work))})).filter(o=>o.lines.length);
   if(!narrow.length)continue;
   const shown=group(narrow,opts.now)[0];
   result.push({...shown,urgency:whole.urgency,shipBy:whole.shipBy,whole});
  }
  return result;
 }
 const cents=v=>v==null||v===''||!Number.isFinite(Number(v))?null:Math.round(Number(v)*100);
 function financials(groups){
  const out={sales:0,shipping:0,fees:0,actual:0,est:0,missingPrice:0,missingShip:0,missingFee:0,lines:0,orders:0,buyers:groups.length,units:0};
  for(const g of groups)for(const o of g.orders){
   out.orders++;
   const originals=[...(o.sourceLines||o.lines)].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
   const selected=new Set(o.lines),values=originals.map(l=>cents(l.line_amount));
   const hasWeights=values.every(v=>v!==null)&&values.some(v=>v>0);
   const weights=hasWeights?values:originals.map(l=>Number(l.quantity)||1),denom=weights.reduce((a,b)=>a+b,0);
   const unpaid=o.marketplace_status==='Unpaid';
   const shipping=unpaid?null:cents(o.buyer_shipping),actual=cents(o.statement_deductions),basis=cents(o.referral_basis);
   const fees=actual??(unpaid?null:cents(o.unsettled_fee)??(basis==null?null:Math.round(basis*.06)));
   let prev=0;
   for(let i=0;i<originals.length;i++){const l=originals[i],next=prev+weights[i],share=v=>Math.round(v*next/denom)-Math.round(v*prev/denom);
    if(selected.has(l)){out.lines++;out.units+=Number(l.quantity)||0;
     if(values[i]==null)out.missingPrice++;else out.sales+=values[i];
     if(shipping==null)out.missingShip++;else out.shipping+=share(shipping);
     if(fees==null)out.missingFee++;else{out.fees+=share(fees);if(actual!=null)out.actual++;else out.est++;}
    }prev=next;
   }
  }return out;
 }
 return {TIME_ZONE,customerName,inView,visibleLines,cancellationReview,needsCancellation,closed,held,cancelled,hasCancellation,lineCancelled,lineCompleted,lost,lineHeld,calendarDate,day,urgency,shortDate,purchaseDate,group,select,pendingGroups,financials,lineWork};
});
