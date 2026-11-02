(function(root){
 'use strict';
 const M=root.EbayPerformance;
 const pacific=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
 const inPeriod=(d,p)=>!!d&&d>=p.start&&d<=p.end;
 const days=(a,b)=>Math.round((Date.parse(b)-Date.parse(a))/86400000);
 const roles={SELLER:'Seller',BUYER:'Buyer',EBAY:'eBay support',SYSTEM:'Automatic'};
 function index(data,orderIndex){
  const evidence=data.evidence||{},requests=new Map(),linked=new Map(),returnMap=new Map();
  for(const r of evidence.requests||[]){
   const xs=requests.get(r.id)||[];xs.push(r);requests.set(r.id,xs);
  }
  for(const o of orderIndex.orders.values())for(const l of o.lines)if(l.case){
   const ids=linked.get(l.case.id)||new Set();ids.add(o.id);linked.set(l.case.id,ids);
  }
  for(const r of evidence.returns||[])returnMap.set(r.oid+'/'+r.id,r);
  const reasons=new Map((evidence.return_reasons||[]).map(r=>[r.oid+'/'+r.id,r.reason]));
  const cases=[],refunds=[];
  for(const c of orderIndex.cases.values()){
   const matches=requests.get(c.id)||[],ids=linked.get(c.id);
   const order=c.linked_order||(ids?.size===1?[...ids][0]:null);
   const compatible=matches.filter(r=>!r.oid||r.oid===order),actorSet=new Set(compatible.map(r=>roles[r.actor]).filter(Boolean));
   const o=orderIndex.orders.get(order),purchase=o?.day||c.purchase_day;
   const req=compatible.map(r=>r.requested_at).filter(Boolean).sort()[0];
   const paid=evidence.payment_times?.[order];
   const date=req?M.day(req):c.requested;
   const purchaseLocal=o?pacific.format(new Date(o.purchased)):c.purchase_day;
   const beforeSale=req&&o?Date.parse(req)<Date.parse(o.purchased):c.requested&&purchaseLocal?c.requested<purchaseLocal:null;
   let timing='Timing unknown';
   if(o&&!o.paid&&!paid)timing='No buyer payment recorded';
   else if(paid&&req)timing=Date.parse(req)<Date.parse(paid)?'Requested before payment':'Requested at or after payment';
   else if(paid&&c.requested){const paymentDay=pacific.format(new Date(paid));timing=c.requested===paymentDay?'Same day · sequence unknown':c.requested<paymentDay?'Requested before payment':'Requested after payment';}
   const actor=actorSet.size===1?[...actorSet][0]:'Unverified';
   cases.push({id:c.id,order,purchase,date,actor,timing,beforeSale,reason:c.reason,source:compatible.length?compatible.map(r=>r.src).filter((s,i,a)=>a.indexOf(s)===i).join(' + '):'No requestor recorded',paid,requestedAt:req});
  }
  const allPayments=[...data.payments||[],...evidence.older_refunds||[]],seen=new Set();
  for(const t of allPayments){
   const key=[t.order_id,t.reference,t.day,t.gross,t.net].join('|');if(seen.has(key))continue;seen.add(key);
   const cancelRef=/^Cancel ID\s+(\d+)$/i.exec(t.reference),cancel=cancelRef&&orderIndex.cases.get(cancelRef[1]);
   const o=orderIndex.orders.get(t.order_id),purchase=o?.day||(t.purchased&&M.day(t.purchased))||
    (cancel?.linked_order===t.order_id?cancel.purchase_day:null)||null;
   const r=/^Return ID\s+(\d+)$/i.exec(t.reference),ret=r&&returnMap.get(t.order_id+'/'+r[1]);
   const labels=new Set(),sources=[];
   if(ret){
    const history=(ret.history||[]).filter(h=>h.action==='SELLER_ISSUE_REFUND'&&['SELLER','EBAY'].includes(h.actor)||h.action==='SYSTEM_INITIATED_REFUND'&&['SYSTEM','EBAY'].includes(h.actor));
    const add=(actor,why)=>{labels.add(actor);sources.push(why);};
    const dateMatch=d=>d&&Math.abs(days(pacific.format(new Date(d)),t.day))<=1;
    if(dateMatch(ret.issued)&&['SELLER_INITIATED','AUTO_REFUND'].includes(ret.initiator))add(ret.initiator==='SELLER_INITIATED'?'Seller':'Automatic','Return refund initiator');
    for(const h of history.filter(h=>dateMatch(h.date)))add(h.action==='SYSTEM_INITIATED_REFUND'?'Automatic':roles[h.actor],h.action.replaceAll('_',' ').toLowerCase());
   }
   const actor=labels.size===1?[...labels][0]:'Unverified';
   const reason=cancelRef?'Cancellation · '+(cancel?.reason||'Reason unavailable'):r?'Return · '+(reasons.get(t.order_id+'/'+r[1])||'Reason unavailable'):'Direct refund · reason unavailable';
   refunds.push({...t,purchase,reason,age:purchase?days(purchase,t.day):null,actor,source:sources.length?[...new Set(sources)].join(' + '):'No matched refund-issuer record'});
  }
  return {cases,refunds,orders:orderIndex.orders,decisions:evidence.cases||[],allDecisions:evidence.all_decisions||[],returns:evidence.returns||[],checks:evidence.requestor_checks||[]};
 }
 function summarize(idx,p,basis){
  const select=(row,activity)=>inPeriod(basis==='purchase'?row.purchase:activity,p);
  const refunds=idx.refunds.filter(t=>select(t,t.day)),cases=idx.cases.filter(c=>select(c,c.date));
  const refunded=new Set(refunds.map(t=>t.order_id)),canceled=new Set(cases.map(c=>c.order).filter(Boolean));
  const affected=new Set([...refunded,...canceled]);
  const rulings=new Map(),escalations=new Set();
  for(const c of idx.decisions)if(affected.has(c.oid)){
   escalations.add(c.oid);if(c.decided)rulings.set(c.oid,[...(rulings.get(c.oid)||[]),c.id]);
  }
  for(const r of idx.returns)if(affected.has(r.oid)&&r.history?.some(h=>['SELLER_ESCALATE','BUYER_ESCALATE'].includes(h.action)))escalations.add(r.oid);
  const gross=ts=>ts.reduce((v,t)=>v+Number(t.gross),0),net=refunds.reduce((v,t)=>v+Number(t.net),0);
  const old=refunds.filter(t=>t.purchase&&t.purchase<p.start),unknown=refunds.filter(t=>!t.purchase),long=refunds.filter(t=>t.age!=null&&t.age>=30);
  const before=cases.filter(c=>c.purchase&&c.purchase<p.start),unknownCancel=cases.filter(c=>!c.purchase);
  const allDecisions=idx.allDecisions.filter(r=>{const d=basis==='purchase'?r.purchase:r.decided_at;return d&&inPeriod(M.day(d),p);});
  return {refunds,cases,refunded,canceled,affected,rulings,escalations,allDecisions,gross:gross(refunds),net,old:old.length,oldGross:gross(old),unknown:unknown.length,unknownGross:gross(unknown),
   long:long.length,longGross:gross(long),before:before.length,unknownCancel:unknownCancel.length,
   soldLines:[...idx.orders.values()].filter(o=>inPeriod(o.day,p)).reduce((n,o)=>n+o.lines.length,0)};
 }
 root.EbayRefundAnalysis={index,summarize};
})(typeof window==='undefined'?globalThis:window);
