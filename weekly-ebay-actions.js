(()=>{
 'use strict';
 const sellerHub='https://www.ebay.com/sh/ovw';
 const nameMonth=m=>new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(m+'T12:00Z'));
 function describe(a,reader){
  const period=/^\d{4}-\d\d-01$/.test(a.month||'')?nameMonth(a.month):'';
  switch(a.kind){
   case 'performance':return ['Refresh the eBay performance sources','The signed-in Seller Hub checks are overdue. Open the report for the last verified times and instructions for the Edge workstation.','Open performance reports','ebay-performance.html'];
   case 'seller':return ['Check the OG Jewelers sign-in','The background check could not verify the seller account. In the Edge profile that runs Invsto, open Seller Hub and sign in as ogjewelers. The next successful check clears this reminder.','Open Seller Hub ↗',sellerHub];
   case 'holds':return ['Refresh the itemized hold list',({missing:'Invsto has no verified list of held transactions yet.',changed:'eBay’s latest balance differs from the saved list of held transactions.',stale:'The itemized hold list is more than nine hours old.'}[a.reason]||'The itemized hold list needs a check.')+
     (reader?' Press the button to check every page in Seller Hub.':' On the Edge computer running OG eBay Order Link, sign in to Invsto and Seller Hub, then press “Refresh hold details from eBay.”'),reader?'Refresh hold details':'Show refresh controls'];
   case 'claims':return period&&[period+' · Import the claims CSV','Invsto could not verify the full-month export automatically. Download the transaction CSV for this month from Seller Hub and choose it in the importer.','Open claims importer'];
   case 'statement':return period&&(a.reason==='mismatch'?[period+' · Review the statement','The opening balance, closing balance or payouts on eBay’s official statement differ from the saved overview. Compare them in Sources and monthly statements.','Review statement sources']:[period+' · Import the financial statement','This month has eBay orders but no verified statement. Download its monthly statement PDF from Seller Hub and choose it in the importer.','Open statement importer']);
   case 'earnings':return ['Reconnect eBay Order Earnings','The previously connected earnings feed now requires seller authorization. Open the connection controls and select “Connect eBay Order Earnings.”','Review connection'];
  }
 }
 function init(el,client,getMonth,open){
  if(!el)return ()=>{};
  let sequence=0,key='',latest=[];
  const status=el.querySelector('[role="status"]'),list=el.querySelector('ul');
  function render(rows){
   const reader=document.documentElement.hasAttribute('data-invsto-hold-reader');
   const visible=rows.map(a=>[a,describe(a,reader)]).filter(([,d])=>d);
   const next=JSON.stringify(visible);if(key===next)return;key=next;latest=visible.map(([a])=>a);
   el.hidden=!visible.length;
   const shortcut=document.getElementById('ws-action-shortcut');
   if(shortcut){shortcut.hidden=!visible.length;shortcut.textContent=visible.length===1?'1 eBay action needs your attention ↑':visible.length+' eBay actions need your attention ↑';}
   const nodes=visible.map(([,d],i)=>{
    const li=document.createElement('li'),copy=document.createElement('div'),title=document.createElement('strong'),body=document.createElement('p');
    title.textContent=d[0];body.textContent=d[1];copy.append(title,body);
    const control=document.createElement(d[3]?'a':'button');control.textContent=d[2];control.className='ws-action-control';
    if(d[3]){control.href=d[3];control.target='_blank';control.rel='noopener';}
    else{control.type='button';control.dataset.actionIndex=String(i);}
    li.append(copy,control);return li;
   });
   list.replaceChildren(...nodes);status.textContent='';
  }
  el.addEventListener('click',e=>{
   const button=e.target.closest('button[data-action-index]');if(!button)return;const action=latest[Number(button.dataset.actionIndex)];if(!action)return;
   status.textContent='Opening the report controls…';open(action);
  });
  async function check(){
   const n=++sequence,month=getMonth();
   if(!/^\d{4}-(0[1-9]|1[012])$/.test(month)||document.hidden)return;
   try{const {data,error}=await client.rpc('ebay_report_manual_actions',{_month:month+'-01'});
    if(error||!Array.isArray(data))throw Error();
    if(n===sequence&&month===getMonth()){render(data);if(status.dataset.delayed){status.textContent='';delete status.dataset.delayed;}}
   }catch{if(n===sequence&&!el.hidden){status.dataset.delayed='1';status.textContent='Showing the last known reminders. Invsto will check again automatically.';}}
  }
  return check;
 }
 window.WeeklyEbayActions={init};
})();
