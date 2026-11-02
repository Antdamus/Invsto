// Only answer the extension's requests for its own signed-in Seller Hub pages.
(()=>{
 'use strict';
 const orderNumber=/^\d{2}-\d{5}-\d{5}$/;
 const months='Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
 const text=el=>(el?.innerText||'').trim();
 function dollars(value){
  const match=/^(-?)\$([\d,]+)\.(\d{2})$/.exec(value);
  if(!match)throw Error('A USD amount is missing on Seller Hub.');
  return (match[1]?-1:1)*(Number(match[2].replaceAll(',',''))*100+Number(match[3]));
 }
 function dateParts(value){
  const m=/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(value);
  if(!m||!months.includes(m[1]))throw Error('The eBay calendar date could not be read.');
  return m[3]+'-'+String(months.indexOf(m[1])+1).padStart(2,'0')+'-'+m[2].padStart(2,'0');
 }
 function soldAt(value,from,end){
  const m=/^([A-Z][a-z]{2}) (\d{1,2})\s+(\d{1,2}):(\d{2})(am|pm) (P[DS]T)$/i.exec(value);
  if(!m)throw Error('Missing Pacific purchase time.');
  for(const year of new Set([from.slice(0,4),end.slice(0,4)])){
   const day=dateParts(m[1]+' '+m[2]+', '+year);
   if(day>=from&&day<=end){
    const hour=Number(m[3])%12+(m[5].toLowerCase()==='pm'?12:0);
    return new Date(day+'T'+String(hour).padStart(2,'0')+':'+m[4]+':00'+(m[6]==='PDT'?'-07:00':'-08:00')).toISOString();
   }
  }
  throw Error('A sale is outside the requested date range.');
 }
 function range(label){
  const match=/(?:Results|Transactions):\s*([\d,]+)(?:\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+))?/.exec(label);
  if(!match)throw Error('Waiting for the Seller Hub result count.');
  const nums=match.slice(1).map(s=>Number((s||'0').replaceAll(',','')));
  if(!match[3]&&nums[0]!==0)throw Error('Incomplete result range.');
  return {start:nums[0],end:nums[1],total:nums[2]};
 }
 const isoInput=v=>{const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);return m&&m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');};
 function items(row){
  const map=new Map();
  for(const a of row.querySelectorAll('a[href*="/itm/"]')){
   const id=new URL(a.href).pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)\/?$/)?.[1];
   if(id)map.set(id,{id,title:text(a)});
  }return [...map.values()];
 }
 function orders(job){
  const dates=[...document.querySelectorAll('.app-date-picker input')].map(e=>isoInput(e.value));
  if(dates[0]!==job.from||dates[1]!==job.to)throw Error('Waiting for the selected sale dates.');
  const page=range(text(document.querySelector('.grid-summary'))),out=new Map();
  for(const row of document.querySelectorAll('table tbody tr.order-info,table tbody tr.item-info')){
   const id=row.className.match(/(?:^|\s)orderid_([0-9-]+)(?:\s|$)/)?.[1];
   if(!id)throw Error('An order reference is missing.');
   if(row.classList.contains('order-info')){
    if(out.has(id))throw Error('A sale appears twice.');
    const buyer=text(row.querySelector('.buyer-modal-trigger-wrapper button')).split('\n').map(s=>s.trim()).filter(s=>s&&!/^repeat buyer$/i.test(s)).pop();
    const [sold,paid]=[...row.querySelectorAll('.date-column')].map(text);
    const status=text(row.querySelector('.actions-cell')).split('\n')[0];
    if(!buyer||!sold||!status)throw Error('An order row is incomplete.');
    out.set(id,{id,buyer:buyer.toLowerCase(),purchased:soldAt(sold,job.from,job.to),paid:Boolean(paid&&!/^[-—]+$/.test(paid)),
     original_cents:dollars(text(row.querySelector('.price-column')).split('\n')[0]),status,items:items(row),children:[]});
   }else{
    const parent=out.get(id),line=items(row);if(!parent||line.length>1)throw Error('Could not link an item to its order.');
    parent.children.push(line[0]||{id:null,title:''});
   }
  }
  const rows=[...out.values()].map(({children,...o})=>({...o,items:children.length?children:o.items.length?o.items:[{id:/^\d{11,14}-\d{10,18}$/.test(o.id)?o.id.split('-')[0]:null,title:''}]}));
  return {...page,rows};
 }
 function cases(){
  const page=range(document.body.innerText),rows=[];
  if(!document.querySelector('button')||!document.body.innerText.match(/Status:\s*Canceled\b/i))throw Error('The completed cancellation filter is not selected.');
  for(const row of document.querySelectorAll('table tbody tr')){
   const value=text(row),id=value.match(/Cancel ID:\s*(\d+)/)?.[1],ids=items(row).map(i=>i.id);
   if(!id){if(ids.length){if(!rows.length)throw Error('A cancellation item has no case.');rows.at(-1).items.push(...ids);}continue;}
   const cells=[...row.children],description=text(cells[4]);
   const reason=description.match(/Reason:\s*([^\n]+)/)?.[1]?.trim(),day=description.match(/Requested:\s*([^\n]+)/)?.[1]?.trim();
   if(!reason||!day||text(cells[3])!=='Canceled'||!text(cells.at(-1)))throw Error('A cancellation is incomplete.');
   const amount=text(cells.at(-2));
   rows.push({id,buyer:text(cells.at(-1)).toLowerCase(),reason,requested:dateParts(day),items:ids,gross:/^[-—]+$/.test(amount)?0:dollars(amount)});
  }
  if(rows.some(r=>!r.items.length))throw Error('Missing cancellation item IDs.');
  return {...page,rows};
 }
 function payments(job){
  if(document.querySelector('input[type="search"][aria-label="search-field"]')?.value!==job.id)throw Error('Waiting for the order transaction filter.');
  const page=range(document.body.innerText),all=[...document.querySelectorAll('.transaction--content-wrapper')],rows=[];
  if(all.length!==(page.total?page.end-page.start+1:0))throw Error('Waiting for the transaction rows.');
  for(const row of all){
   const desc=text(row.querySelector('.transaction--desc')),hit=/^Refund for order number\s*(\d{2}-\d{5}-\d{5})/i.exec(desc);
   if(!hit)continue; // Claims, payment disputes, sales and holds have separate ledger types.
   const ref=desc.match(/\b(Cancel|Return|Refund) ID:?\s*(\d+)/i);
   if(hit[1]!==job.id||!ref)throw Error('Refund evidence could not be linked to this order.');
   const amounts=text(row).split('\n').map(s=>s.trim()).filter(s=>/^-?\$[\d,]+\.\d{2}$/.test(s));
   const net=text(row.querySelector('.transaction--net')).split('\n').map(s=>s.trim()).find(s=>/^-?\$[\d,]+\.\d{2}$/.test(s));
   const date=text(row).match(/\b([A-Z][a-z]{2} \d{1,2}, \d{4})\b/)?.[1];
   if(!amounts.length||!net||!date)throw Error('Refund amounts or posting date are missing.');
   const gross=-dollars(amounts[0]),netCents=-dollars(net);
   if(gross<=0||netCents<0)throw Error('A refund adjustment needs review.');
   const lines=desc.split('\n').map(s=>s.trim()).filter(Boolean);
   const title=lines.find(s=>/^#/.test(s))||'';
   rows.push({order_id:job.id,reference:ref[1][0].toUpperCase()+ref[1].slice(1).toLowerCase()+' ID '+ref[2],
    day:dateParts(date),gross,net:netCents,title});
  }
  return {...page,rows};
 }
 function detail(job){
  if(new URL(location.href).searchParams.get('cancelId')!==job.id)throw Error('Unexpected cancellation ID.');
  const lines=document.body.innerText.split('\n').map(s=>s.trim()).filter(Boolean).filter((s,i,a)=>!i||s!==a[i-1]);
  const field=label=>lines.includes(label)?lines[lines.indexOf(label)+1]:null;
  if(!/order is cancel/i.test(text(document.querySelector('#cancelDetails h1'))))throw Error('Waiting for completed cancellation.');
  const id=field('Order number'),buyer=field('Buyer');
  const items=lines.flatMap((s,i)=>s==='Item ID:'&&/^\d+$/.test(lines[i+1]||'')?[lines[i+1]]:[]);
  if(!buyer||!items.length)throw Error('Missing buyer or original item on the cancellation detail.');
  return {start:1,end:1,total:1,rows:[{id:job.id,buyer,items,purchase_day:dateParts(field('Date purchased')||''),linked_order:orderNumber.test(id||'')||/^\d{11,14}-\d{10,18}$/.test(id||'')?id:null}]};
 }
 chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(s.id!==chrome.runtime.id||m?.type!=='OG_PERFORMANCE_PAGE')return;
  try{
   // The legacy detail page has no seller-profile link. Its buyer and original item must match the store's verified register on the server.
   if(m.job.kind!=='case_detail'&&!document.querySelector('a[href="https://www.ebay.com/usr/ogjewelers"]'))throw Error('Sign in to the OG Jewelers Seller Hub account.');
   const handlers={orders:['/sh/ord',orders],cases:['/sh/ord/cancel',cases],payments:['/mes/transactionlist',payments],case_detail:['/Cancel/Details',detail]};
   const handler=handlers[m.job.kind];if(!handler||location.pathname.replace(/\/$/,'')!==handler[0])throw Error('Unexpected Seller Hub page.');
   send({ok:true,page:handler[1](m.job)});
  }catch(e){send({ok:false,message:e.message});}
 });
})();
