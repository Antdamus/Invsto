// Only returns the few visible Seller Hub facts needed by Invsto.
(()=>{
 'use strict';
 function statement(text){
  const heading=text.match(/Transaction summary for ([A-Z][a-z]{2} 0?1, \d{4})\s*[-–]\s*([A-Z][a-z]{2} \d{1,2}, \d{4})/);
  if(!heading)throw Error('No published financial statement found.');
  const start=new Date(heading[1]+' 12:00 GMT'),end=new Date(heading[2]+' 12:00 GMT');
  if(!Number.isFinite(+start)||!Number.isFinite(+end)||start.getUTCMonth()!==end.getUTCMonth()||start.getUTCFullYear()!==end.getUTCFullYear()||end.getUTCDate()!==new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate())throw Error('Incomplete statement period.');
  const section=text.slice(heading.index).match(/Opening funds:\s*([\s\S]*?)Closing funds:\s*([-−]?\$[\d,]+\.\d{2})/i);
  if(!section)throw Error('Statement chart has not loaded.');
  const rows=[...section[0].matchAll(/([A-Za-z][A-Za-z &/()-]*):\s*([-−]?\$[\d,]+\.\d{2})/g)]
   .map(m=>({label:m[1].trim(),cents:Number(m[2].replace(/[$,.]/g,'').replace('−','-'))}));
  const opening=rows.shift(),closing=rows.pop();
  if(opening?.label!=='Opening funds'||closing?.label!=='Closing funds'||!rows.length||new Set(rows.map(r=>r.label)).size!==rows.length||rows.reduce((n,r)=>n+r.cents,opening.cents)!==closing.cents)throw Error('Statement chart did not reconcile.');
  return {_month:start.toISOString().slice(0,10),_opening:opening.cents,_closing:closing.cents,_movements:rows};
 }
 if(typeof chrome==='undefined'){globalThis.InvstoReadStatement=statement;return;}
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 async function claims(month,mayRequest){
  if(!/^\d{4}-\d{2}-01$/.test(month)||new URL(location.href).searchParams.get('q')!=='payment-transaction-report')throw Error('Wrong claim report page.');
  const from=new Date(month+'T12:00Z'),to=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,0,12)),period=month.slice(0,7);
  const iso=s=>new Date(s+' 12:00 GMT').toISOString().slice(0,10),last=to.toISOString().slice(0,10);
  const rows=[...document.querySelectorAll('.report-row')].filter(e=>{
   const dates=e.innerText.match(/([A-Z][a-z]{2} \d{1,2}, \d{4})\s*[-–]\s*([A-Z][a-z]{2} \d{1,2}, \d{4})/);
   return dates&&iso(dates[1])<=month&&iso(dates[2])>=last;
  });
  if(rows.length){
   const link=rows.map(e=>[...e.querySelectorAll('a')].find(a=>a.innerText.trim()==='Download')).find(Boolean);
   if(!link)return {note:'Monthly transaction report is still being prepared.'};
   const nonce=crypto.randomUUID();
   return new Promise(resolve=>{
    const done=e=>{if(e.source!==window||e.origin!==location.origin||e.data?.type!=='INVSTO_CLAIM_ROWS'||e.data.nonce!==nonce||e.data.month!==period||!Array.isArray(e.data.entries))return;
     clearTimeout(timer);window.removeEventListener('message',done);resolve({entries:e.data.entries});};
    const timer=setTimeout(()=>{window.removeEventListener('message',done);resolve({note:'Could not verify the complete monthly CSV. The previous claim ledger is preserved.'});},26000);
    window.addEventListener('message',done);window.postMessage({type:'INVSTO_ARM_CLAIM_REPORT',nonce,month:period},location.origin);
    setTimeout(()=>link.click(),50);
   });
  }
  if(!mayRequest)return {note:'Waiting for the full-month transaction report.'};
  const all=[...document.querySelectorAll('button')].find(b=>/Transaction types \(all\)/i.test(b.innerText));
  if(!all)throw Error('The transaction type filter does not include all activity.');
  for(const [id,date] of [['start_date',from],['end_date',to]]){
   const input=document.getElementById(id);if(!input)throw Error('Date selector unavailable.');
   if(iso(input.value)===date.toISOString().slice(0,10))continue;
   input.click();await wait(160);
   const label=date.toLocaleDateString('en-US',{month:'long',timeZone:'UTC'})+' '+date.getUTCDate();
   let choice;
   for(let n=0;n<15;n++){
    choice=[...document.querySelectorAll('[role="option"][aria-label]')].find(el=>new RegExp('^Choose .+, '+label+'(?:st|nd|rd|th), '+date.getUTCFullYear()+'$').test(el.getAttribute('aria-label')));
    if(choice)break;
    const current=document.querySelector('.react-datepicker__current-month')?.textContent;
    if(!current)break;
    const direction=new Date(current+' 1, 12:00 GMT')<date?'Next':'Previous';
    const nav=document.querySelector('button[aria-label="'+direction+' Month"]');if(!nav||nav.disabled)break;nav.click();await wait(100);
   }
   if(!choice)throw Error('Could not verify the requested date.');choice.click();await wait(120);
  }
  if(iso(document.getElementById('start_date').value)!==month||iso(document.getElementById('end_date').value)!==last)throw Error('Monthly date range was not accepted.');
  const create=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Create report');
  if(!create||create.disabled)throw Error('Monthly report cannot be generated yet.');
  create.click();return {requested:true,note:'Requested the full-month Seller Hub transaction report. Invsto will check for the file again.'};
 }
 chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(s.id!==chrome.runtime.id||m?.type!=='OG_REPORT_READ')return;
  try{
   const account=document.querySelector('a[href="https://www.ebay.com/usr/ogjewelers"]');
   const body=document.body.innerText;
   if(!account||!(/View profile/i.test(account.innerText)||account.innerText.trim()==='ogjewelers'))throw Error('OG Jewelers seller account could not be verified.');
   if(m.claimMonth){claims(m.claimMonth,m.mayRequest).then(claim=>send({ok:true,claim}),e=>send({ok:true,claim:{note:e.message}}));return true;}
   if(m.order){
    if(!/^\d{2}-\d{5}-\d{5}$/.test(m.order)||!['/mesh/ord/details','/sh/ord/details'].includes(location.pathname)||new URL(location.href).searchParams.get('orderid')!==m.order||!body.includes(m.order))throw Error('Order identity not verified.');
    const headings=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].map(e=>e.innerText.trim());
    if(!headings.includes('Order')||!headings.includes('Payment'))throw Error('Waiting for order details.');
    const heading=headings.find(h=>/^Delivered on [A-Z][a-z]{2,8} [0-9]{1,2}(, [0-9]{4})?$/.test(h))||null;
    send({ok:true,observation:{id:m.order,heading}});
   }else if(location.pathname==='/mes/transaction-reports'&&new URL(location.href).searchParams.get('q')==='statement'){
    send({ok:true,statement:statement(body)});
   }else throw Error('Unexpected Seller Hub report.');
  }catch(e){send({ok:false,message:e.message});}
 });
})();
