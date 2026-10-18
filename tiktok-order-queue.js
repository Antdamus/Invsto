/* Calendar deadlines and buyer grouping for the TikTok workspace only. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TikTokOrderQueue=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const TIME_ZONE='America/New_York';
 const lineCompleted=l=>Boolean(l.fulfilled_at);
 const lost=l=>l.work?.item_search==='not_found'||Boolean(l.work?.watch_missing);
 const lineHeld=l=>!lineCompleted(l)&&(lost(l)||Boolean(l.work?.cgl_required&&!l.work?.certificate_id));
 const closed=o=>['dispatched','completed'].includes(o.stage)||['Canceled','Cancelled'].includes(o.marketplace_status)||(!o.reopened_at&&!o.lines?.some(lineCompleted)&&['Shipped','Completed'].includes(o.marketplace_status)&&!o.lines?.some(l=>l.inventory?.quantity>l.inventory?.consumed_quantity));
 function calendarDate(now=new Date()){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;}
 function day(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return null;const n=Date.parse(value+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value?n/86400000:null;}
 function urgency(value,now=new Date()){const due=day(value);if(due===null)return {level:'unknown',label:'Date needed',days:null};const delta=due-day(calendarDate(now));return delta<0?{level:'overdue',label:`Overdue ${-delta}d`,days:delta}:delta===0?{level:'today',label:'Due today',days:0}:delta===1?{level:'tomorrow',label:'Due tomorrow',days:1}:{level:'upcoming',label:`Due in ${delta}d`,days:delta};}
 function shortDate(value){return day(value)===null?'Date needed':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));}
 function sourceTime(value){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM))?/i.exec(value||'');if(!m)return 0;const h=m[4]?(+m[4]%12)+(m[7]?.toUpperCase()==='PM'?12:0):0;return Date.UTC(+m[3],+m[1]-1,+m[2],h,+(m[5]||0),+(m[6]||0));}
 const held=o=>Boolean(o.cancellation?.pending||o.lines?.some(lineHeld));
 function group(orders,now=new Date()){
  const groups=new Map();for(const o of orders){const key=o.buyer_username.toLowerCase();if(!groups.has(key))groups.set(key,{key,buyer:o.buyer_username,orders:[]});groups.get(key).orders.push(o);}
  return [...groups.values()].map(g=>{const dates=g.orders.map(o=>o.ship_by_date).filter(d=>day(d)!==null).sort();const lines=g.orders.flatMap(o=>o.lines||[]);return {...g,lines,quantity:lines.reduce((n,l)=>n+l.quantity,0),total:g.orders.reduce((n,o)=>n+Number(o.order_amount||0),0),shipBy:dates[0]||null,unknown:g.orders.filter(o=>day(o.ship_by_date)===null).length,urgency:urgency(dates[0],now),created:Math.min(...g.orders.map(o=>sourceTime(o.created_time))),waiting:g.orders.filter(o=>o.stage==='waiting'||held(o)).length,labelCount:g.orders.filter(o=>o.documents?.some(d=>d.kind==='label')).length};});
 }
 function select(orders,{history=false,term='',stage='',work='',due='all',sort='oldest',now=new Date()}={}){
  const needle=term.trim().toLowerCase();const groups=group(orders.filter(o=>closed(o)===history),now).filter(g=>(!work||(work==='waiting'?g.waiting>0:work==='ready'?g.waiting===0:work==='cancel'?g.orders.some(o=>o.cancellation?.pending):g.lines.some(l=>work==='not_found'?l.work?.item_search==='not_found':work==='missing'?l.work?.watch_missing:work==='cgl'?l.work?.cgl_required&&!l.work?.certificate_id:false)))&&(!stage||g.orders.some(o=>o.stage===stage))&&(!needle||g.orders.some(o=>JSON.stringify([o.order_number,o.buyer_username,o.buyer_nickname,o.lines?.map(l=>[l.title,l.seller_sku,l.sku_id,l.tracking_number])]).toLowerCase().includes(needle)))&&(history||due==='all'||(due==='unknown'?g.unknown>0:g.urgency.level===due)));
  const compare=sort==='due'?(a,b)=>(a.shipBy||'9999').localeCompare(b.shipBy||'9999'):sort==='newest'?(a,b)=>b.created-a.created:sort==='value'?(a,b)=>b.total-a.total:sort==='buyer'?(a,b)=>a.buyer.localeCompare(b.buyer):(a,b)=>a.created-b.created;
  return groups.sort((a,b)=>compare(a,b)||a.buyer.localeCompare(b.buyer));
 }
 return {TIME_ZONE,closed,held,lineCompleted,lost,lineHeld,calendarDate,day,urgency,shortDate,group,select};
});
