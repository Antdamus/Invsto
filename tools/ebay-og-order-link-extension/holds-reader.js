// Runs only on the Seller Hub transaction list. Reads a page only when Invsto's
// background worker requests it on the tab it opened for a reconciliation.
(()=>{
 'use strict';
 const cents=t=>{const m=/^\$([\d,]+)\.(\d{2})$/.exec((t||'').trim());if(!m)throw Error('Missing USD amount on Seller Hub.');return Number(m[1].replaceAll(',',''))*100+Number(m[2]);};
 const fullOrder=/^\d{2}-\d{5}-\d{5}$/;
 function read(){
  const seller=document.querySelector('a[href="https://www.ebay.com/usr/ogjewelers"]');
  if(!seller?.textContent?.includes('View profile'))throw Error('Sign in to the ogjewelers Seller Hub account.');
  const chip=[...document.querySelectorAll('button[aria-pressed="true"]')].map(b=>/^On hold\s*\(([\d,]+)\)$/i.exec(b.innerText.trim())).find(Boolean);
  const box=document.querySelector('.funds-details-container--fund-details');
  if(!chip||!/^On hold\b/i.test(box?.innerText||''))throw Error('Waiting for the Seller Hub On hold list.');
  const count=Number(chip[1].replaceAll(',','')),total=cents(box.querySelector('.funds-details-container--fund-details-amount')?.textContent);
  const range=[...document.querySelectorAll('span.each-as-row')].map(s=>/^Transactions:\s*([\d,]+)\s*[-–]\s*([\d,]+)\s*of\s*([\d,]+)$/i.exec(s.textContent.trim())).find(Boolean);
  const items=[...document.querySelectorAll('.transaction--content-wrapper')];
  if(!count&&!total&&!items.length)return {start:0,end:0,count,total,rows:[]};
  if(!range||Number(range[3].replaceAll(',',''))!==count)throw Error('Waiting for a complete page.');
  const start=Number(range[1].replaceAll(',','')),end=Number(range[2].replaceAll(',',''));
  if(items.length!==end-start+1)throw Error('Waiting for held transactions to load.');
  const rows=items.map(row=>{
   const text=row.querySelector('.transaction--desc')?.innerText||'';
   const amounts=[...new Set((row.querySelector('.transaction--net')?.innerText||'').trim().split(/\s+/).filter(Boolean))];
   if(amounts.length!==1)throw Error('Seller Hub did not show a single net amount for this entry.');
   const net=cents(amounts[0]);
   const posted=row.querySelector('.transactions-date')?.innerText?.trim().split('\n')[0],dt=new Date(posted+' 12:00 UTC');
   if(!Number.isFinite(dt.getTime()))throw Error('A hold date could not be read.');
   const placed=dt.toISOString().slice(0,10),orderA=row.querySelector('.transaction--desc a[href*="/sh/ord/details"]');
   const tx=row.querySelector('.transaction--details a[href*="/mes/transactiondetails"]');
   const u=tx?new URL(tx.href):null,type=u?.searchParams.get('type'),uid=u?.searchParams.get('uuid');
   let oid=orderA?new URL(orderA.href).searchParams.get('orderid'):u?.searchParams.get('relatedTransactionId');
   if(oid&&!fullOrder.test(oid))oid=null;
   if((type==='ORDER'||!u)&&oid&&/^\s*Order\b/.test(text))return {kind:'sale',ref:oid,oid,cents:net,placed};
   if(type!=='RESERVE'||!uid)throw Error('A Seller Hub transaction could not be identified.');
   let kind='other',ref=uid;
   if(/^RETRO_FUNDS_DISPLAY__RETRO_DISPLAY-\d+$/.test(uid)){kind='retro';ref=uid.split('-').pop();}
   else if(/^DISPUTE_DISPLAY__DISPUTE_DISPLAY-\d+$/.test(uid)){
    const id=uid.split('-').pop();if(new RegExp('return ID\\s*'+id+'\\b','i').test(text))kind='return';
    else if(new RegExp('payment dispute ID\\s*'+id+'\\b','i').test(text))kind='dispute';
    if(kind!=='other')ref=id;
   }
   return {kind,ref,oid,cents:net,placed};
  });
  return {start,end,count,total,rows};
 }
 chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(s.id!==chrome.runtime.id||m?.type!=='OG_HOLDS_PAGE')return;
  try{
   const page=read();
   if(m.advance){if(page.end!==m.end)throw Error('Page changed before advancing.');
    const next=document.querySelector('button[aria-label="Next page"]');if(!next||next.disabled)throw Error('Seller Hub did not offer the next page.');next.click();send({ok:true});}
   else send({ok:true,page});
  }catch(e){send({ok:false,message:e.message});}
 });
})();
