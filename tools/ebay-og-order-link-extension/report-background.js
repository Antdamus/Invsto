(()=>{
 'use strict';
 const receiver='https://antdamus.github.io/Invsto/ebay-report-refresh.html',name='invsto-report-refresh',wait=ms=>new Promise(r=>setTimeout(r,ms));
 const orderId=/^\d{2}-\d{5}-\d{5}$/;
 async function schedule(){if(!await chrome.alarms.get(name))await chrome.alarms.create(name,{periodInMinutes:30,delayInMinutes:1});}
 chrome.runtime.onInstalled.addListener(schedule);chrome.runtime.onStartup.addListener(schedule);schedule().catch(()=>{});
 let running=false;
 chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name!==name||running)return;running=true;
  try{
   if(!await chrome.windows.getLastFocused({windowTypes:['normal']}).catch(()=>null))return;
   if((await chrome.storage.local.get('reportPauseUntil')).reportPauseUntil>Date.now())return;
   // Remove only obsolete job tabs from interrupted runs; never touch a report someone opened.
   for(const tab of await chrome.tabs.query({url:receiver+'*'})){
    if(!tab.url?.startsWith(receiver+'?job='))continue;
    const started=Number(new URL(tab.url).searchParams.get('job'));
    if(started>Date.now()-12*60000)return;
    if(!tab.active&&started>0)await chrome.tabs.remove(tab.id).catch(()=>{});
   }
   await chrome.tabs.create({url:receiver+'?job='+Date.now(),active:false});
  }finally{running=false;}
 });
 async function read(url,order,claimMonth,mayRequest){
  let tab;
  try{
   tab=await chrome.tabs.create({url,active:false});let message;
   for(let n=0;n<22;n++){
    try{const r=await chrome.tabs.sendMessage(tab.id,{type:'OG_REPORT_READ',order,claimMonth,mayRequest});if(r?.ok)return r;message=r?.message;}
    catch{/* While Seller Hub is loading. */}
    await wait(350);
   }
   throw Error(message||'Seller Hub is unavailable. Check the signed-in eBay account.');
  }finally{if(tab?.id!=null)await chrome.tabs.remove(tab.id).catch(()=>{});}
 }
 chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(!s.tab?.id||s.frameId!==0||s.url?.split('?')[0]!==receiver||!s.url.startsWith(receiver+'?job='))return;
  if(m?.type==='OG_REPORT_FINISH'){
   if(m.pause)chrome.storage.local.set({reportPauseUntil:Date.now()+4*3600000});
   send({ok:true});chrome.tabs.remove(s.tab.id).catch(()=>{});return;
  }
  if(m?.type!=='OG_REPORT_BATCH'||!Array.isArray(m.orders)||m.orders.length>18||!m.orders.every(id=>orderId.test(id)))return;
  (async()=>{
   const observations=[],errors=[];let statement=null,claim=null;
   if(m.claimMonth&&/^\d{4}-\d\d-01$/.test(m.claimMonth)){try{claim=(await read('https://www.ebay.com/mes/transaction-reports?q=payment-transaction-report&sh=true',null,m.claimMonth,m.mayRequest)).claim;}catch(e){claim={note:e.message};}}
   if(m.statement){try{statement=(await read('https://www.ebay.com/mes/transaction-reports?sh=true&q=statement')).statement;}catch(e){errors.push('Statement: '+e.message);}}
   // Serial single-tab checks keep the store usable. Stop after a failed account check.
   for(const id of m.orders){try{observations.push((await read('https://www.ebay.com/mesh/ord/details?orderid='+id,id)).observation);}
    catch(e){errors.push('Order check: '+e.message);break;}}
   return {ok:true,observations,statement,claim,errors};
  })().then(send,()=>send({ok:false,message:'Seller Hub checks did not finish.'}));return true;
 });
})();
