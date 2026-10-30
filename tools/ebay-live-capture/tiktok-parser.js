/* Read only the auction Sold items panel, never chat or aggregate sales counters. */
((root)=>{
 'use strict';
 const text=n=>(n?.textContent||'').replace(/\s+/g,' ').trim();
 const payment=s=>/^Payment complete$/i.test(s)?'paid':/^Payment failed$/i.test(s)?'failed':/^(Payment pending|Awaiting payment|Pending payment|Waiting for payment|Processing payment)$/i.test(s)?'waiting':/^(Cancelled|Canceled|Order cancelled|Order canceled)$/i.test(s)?'cancelled':'review';
 function metadata(doc,url){
  const link=[...doc.querySelectorAll('a[href]')].find(a=>a.href.includes('/workbench/live/overview?room_id='));
  const room=link&&new URL(link.href).searchParams.get('room_id');
  if(!/^[0-9]{10,25}$/.test(room||''))return null;
  const event=[...doc.querySelectorAll('button')].map(text).find(t=>t.startsWith('Event:'));
  const start=[...doc.querySelectorAll('div,span,p')].map(text).filter(t=>/^Start time\s*:.*\d/.test(t)).sort((a,b)=>a.length-b.length)[0]||'';
  const date=start.replace(/^Start time\s*:\s*/,'');const parsed=Date.parse(date);
  const safe=new URL(url);for(const key of [...safe.searchParams.keys()])if(!['event','session_id','tool_tab'].includes(key))safe.searchParams.delete(key);
  return {event_id:'tiktok-'+room,room_id:room,title:(event||'TikTok Live').replace(/^Event:\s*/,''),start_label:start,
   started_at:Number.isFinite(parsed)?new Date(parsed).toISOString():null,url:safe.href};
 }
 function parse(doc,now=new Date()){
  const list=doc.querySelector('.sold-items-latest-list'),events=[],errors=[];
  if(!list)return {events,errors:['Open LIVE auctions → Sold items → Sort by latest.'],list:null,supported:false};
  const seen=new Set();
  for(const skuNode of [...list.querySelectorAll('span')].filter(n=>/^SKU:\s*#?[A-Za-z0-9_-]+$/.test(text(n)))){
   let row=skuNode.parentElement;
   while(row&&row!==list&&!(row.querySelector('button')&&/ has won: \$/.test(text(row))))row=row.parentElement;
   if(!row||row===list){errors.push('A sold row has no buyer identity.');continue;}
   const win=[...row.querySelectorAll('p')].map(text).find(t=>/ has won: \$/.test(t));
   const match=win?.match(/^(.*?) has won: \$([\d,]+\.\d{2})$/);
   const buyer=text(row.querySelector('button')).replace(/^@/,'');
   const sku=text(skuNode).replace(/^SKU:\s*#?/,'');
   const title=text(skuNode.parentElement).replace(/\s*\|\s*SKU:.*$/,'').trim();
   const label=text(row.querySelector('[data-tid="m4b_tag"]'))||'Payment status unavailable';
   const amount=match?Number(match[2].replace(/,/g,'')):NaN;
   if(!match||!Number.isFinite(amount)||!/^[A-Za-z0-9._]{1,100}$/.test(buyer)||!title){errors.push('An auction row could not be verified.');continue;}
   const key=[sku,buyer.toLowerCase(),amount.toFixed(2)].map(encodeURIComponent).join('|');
   if(seen.has(key)){errors.push('Duplicate auction identity needs review.');continue;}seen.add(key);
   const time=[...row.querySelectorAll('p')].map(text).find(t=>/^·/.test(t))?.replace(/^·\s*/,'')||'';
   const age=time.match(/^(\d+)\s*(s|m|h|d)$/i),seconds=age?Number(age[1])*({s:1,m:60,h:3600,d:86400}[age[2].toLowerCase()]):/^(just now|now)$/i.test(time)?0:null;
   events.push({key,sku,buyer,buyer_name:match[1],title:'#'+sku+' - '+title,amount,currency:'USD',payment_state:payment(label),payment_label:label,
    observed_at:now.toISOString(),sold_at:seconds===null?null:new Date(now.getTime()-seconds*1000).toISOString(),time_estimated:true});
  }
  if(!events.length&&text(list)&&!/^(No sold items|No orders|No auction orders|No data|Nothing here yet)$/i.test(text(list)))errors.push('TikTok’s sold-item layout is not recognized. Check the list before continuing.');
  return {events,errors,list,supported:!errors.length};
 }
 root.InvstoTikTokParser={parse,metadata,payment};
})(typeof window==='undefined'?globalThis:window);
