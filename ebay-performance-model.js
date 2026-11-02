(function(root){
 'use strict';
 const et=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/New_York'});
 const day=value=>et.format(new Date(value));
 const offset=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
 function monthsBefore(d,n){
  const [y,m,v]=d.split('-').map(Number),last=new Date(Date.UTC(y,m-n,0)).getUTCDate();
  return new Date(Date.UTC(y,m-1-n,Math.min(last,v),12)).toISOString().slice(0,10);
 }
 function period(key,today){
  if(key==='four')return {start:monthsBefore(today,4),end:today};
  if(key==='month')return {start:today.slice(0,7)+'-01',end:today};
  if(key==='lastMonth'){const end=offset(today.slice(0,7)+'-01',-1);return {start:end.slice(0,7)+'-01',end};}
  return {start:offset(today,-27),end:today};
 }
 function priorPeriod(key,p){
  if(key==='month'||key==='lastMonth'){
   const start=monthsBefore(p.start,1),last=offset(p.start,-1);
   return {start,end:key==='lastMonth'?last:[offset(start,Number(p.end.slice(-2))-1),last].sort()[0]};
  }
  const days=Math.round((Date.parse(p.end)-Date.parse(p.start))/86400000)+1;
  return {start:offset(p.start,-days),end:offset(p.start,-1)};
 }
 const norm=s=>String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
 const buyers=new Set(['buyer requested','buyer initiated']);
 function index(data){
  const orders=new Map(),byItem=new Map(),cases=new Map();
  for(const o of data.orders||[]){
   const order={...o,day:day(o.purchased),lines:o.items.map((item,i)=>({item,index:i,case:null,post:false})),posts:[]};
   orders.set(o.id,order);
   for(const l of order.lines)if(l.item.id){
    const key=norm(o.buyer)+'/'+l.item.id, matches=byItem.get(key)||[];matches.push(l);byItem.set(key,matches);
   }
  }
  for(const c of data.cases||[]){
   cases.set(c.id,c);const linked=orders.get(c.linked_order);
   for(const id of c.items){
    let matches=linked?.lines.filter(l=>l.item.id===id)||[];
    if(!matches.length&&linked?.lines.length===1)matches=linked.lines;
    if(!matches.length)matches=byItem.get(norm(c.buyer)+'/'+id)||[];
    if(matches.length===1){const l=matches[0];if(!l.case||l.case.id===c.id)l.case=c;else l.conflict=true;}
   }
  }
  for(const p of data.payments||[]){
   const o=orders.get(p.order_id);if(!o)continue;
   const cancelRef=/^cancel id\b/i.test(p.reference);
   const matches=o.lines.length===1?o.lines:o.lines.filter(l=>norm(p.title)&&norm(l.item.title)===norm(p.title));
   const cancellation=cancelRef||o.status==='Canceled'||(matches.length===1&&!!matches[0].case);
   o.posts.push({...p,cancellation,unallocated:!cancellation&&matches.length!==1});
   if(!cancellation&&matches.length===1)matches[0].post=true;
  }
  return {orders,cases};
 }
 const rate=(n,d)=>d?n*100/d:null;
 function summarize(idx,p){
  const s={orders:0,lines:0,paid:0,original:0,canceled:0,buyer:0,other:0,outcomes:0,unassigned:0,unassignedPartial:0,
   cancelGross:0,cancelNet:0,otherGross:0,otherNet:0,reasons:new Map(),details:[],payments:[]};
  for(const o of idx.orders.values()){
   if(o.day<p.start||o.day>p.end)continue;
   s.orders++;s.lines+=o.lines.length;s.original+=Number(o.original_cents);
   if(o.paid)s.paid+=o.lines.length;
   for(const l of o.lines){
    const canceled=!!l.case||o.status==='Canceled';
    const reason=l.conflict?'Conflicting cases':l.case?.reason||'Reason not verified';
    const outcome=!canceled&&(o.status==='Refunded'||l.post||(o.status==='Partially refunded'&&o.lines.length===1));
    if(canceled){
     s.canceled++;if(buyers.has(norm(reason)))s.buyer++;
     let g=s.reasons.get(reason);if(!g){g={lines:0,gross:0,caseIds:new Set()};s.reasons.set(reason,g);}
     g.lines++;if(l.case&&!g.caseIds.has(l.case.id)){g.caseIds.add(l.case.id);g.gross+=Number(l.case.gross);}
    }
    if(outcome)s.outcomes++;if(!canceled&&l.post)s.other++;
    if(canceled||outcome||o.status==='Partially refunded')s.details.push({id:o.id,day:o.day,item:l.item.title||l.item.id||'Item '+(l.index+1),
     buyer:o.buyer,kind:canceled?'Canceled':l.post?'Refund transaction':outcome?'Refund outcome':'Line allocation unverified',reason:canceled?reason:'',caseId:l.case?.id||''});
   }
   if(o.status==='Partially refunded'&&o.lines.length>1&&!o.lines.some(l=>l.post))s.unassignedPartial++;
   for(const t of o.posts){
    const group=t.cancellation?'cancel':'other';s[group+'Gross']+=Number(t.gross);s[group+'Net']+=Number(t.net);
    if(t.unallocated)s.unassigned++;s.payments.push(t);
   }
  }
  s.rates={cancellation:rate(s.canceled,s.lines),buyer:rate(s.buyer,s.lines),refund:rate(s.other,s.lines)};
  return s;
 }
 function releaseRows(packet,today,details){
  const groups=new Map(),orders=new Map();let undated=0;
  for(const x of packet.entries||[]){
   if(!x.id)continue;
   if(orders.has(x.id)){orders.get(x.id).cents+=Number(x.cents);continue;}
   orders.set(x.id,{...x,cents:Number(x.cents)});
  }
  for(const x of orders.values()){
   const model=details.model(x.id,x.evidence||{},true);
   const found=details.releaseDates({...model,snapshot:packet.verified_at});
   const candidates=new Set();
   for(const d of found){if(d.key.startsWith('day:'))candidates.add(d.key.slice(4));else{
    // Yearless eBay memos are shown only when the month/day matches this upcoming window.
    for(let n=0;n<14;n++){const key=offset(today,n);if(key.slice(5)===d.key.slice(10))candidates.add(key);}
   }}
   if(!found.length){undated++;continue;}
   const saleLines=(x.lines||[]).filter(l=>!['skipped','cancelled'].includes(l.status));
   const closed=saleLines.length&&saleLines.every(l=>l.status==='fulfilled'&&l.closed&&l.signed&&l.full)
    ?saleLines.map(l=>l.closed).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]:null;
   for(const date of candidates){
    if(date<today||date>offset(today,13))continue;
    const g=groups.get(date)||{date,rows:[],cents:0};g.rows.push({id:x.id,cents:x.cents,closed,
     wait:closed?(Date.parse(date)-Date.parse(day(closed)))/86400000:null});g.cents+=x.cents;groups.set(date,g);
   }
  }
  return {groups:[...groups.values()].sort((a,b)=>a.date.localeCompare(b.date)),undated};
 }
 root.EbayPerformance={day,offset,period,priorPeriod,index,summarize,releaseRows};
})(typeof window==='undefined'?globalThis:window);
