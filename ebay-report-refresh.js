(()=>{
 'use strict';
 function request(type,args={},timeout=230000){
  return new Promise((resolve,reject)=>{
   const id=crypto.randomUUID(),listener=e=>{
    if(e.origin!==location.origin||e.source!==window||e.data?.channel!=='invstoReportResult'||e.data.id!==id)return;
    clearTimeout(timer);window.removeEventListener('message',listener);
    if(e.data.reply?.ok)resolve(e.data.reply);else reject(Error(e.data.reply?.message||'Browser check did not finish.'));
   };
   const timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(Error('Seller Hub timed out.'));},timeout);
   window.addEventListener('message',listener);window.postMessage({channel:'invstoReportRequest',type,id,...args},location.origin);
  });
 }
 // Verify a new reader on this browser even if another browser recently saved
 // a list. Store only a reader revision and an attempt time, never account data.
 const readerCheckKey='invsto-ogjewelers-holds-offset30-v1';
 function firstReaderCheckDue(){
  try{const previous=JSON.parse(localStorage.getItem(readerCheckKey)||'{}');
   return !previous.verified&&(!previous.at||Date.now()-previous.at>=3600000);
  }catch{return false;}
 }
 function markReaderCheck(verified){
  try{localStorage.setItem(readerCheckKey,JSON.stringify({verified,at:Date.now()}));}catch{}
 }
 async function updatePerformance(db,started,manual=false){
   // Edge can inject its document-idle bridge just after the window load event.
   if(document.documentElement&&!document.documentElement.dataset.invstoPerformanceWorker){
    await new Promise(resolve=>{
     const finish=()=>{observer.disconnect();clearTimeout(timer);resolve();};
     const observer=new MutationObserver(()=>{if(document.documentElement.dataset.invstoPerformanceWorker)finish();});
     const timer=setTimeout(finish,3500);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-invsto-performance-worker']});
    });
   }
   if(document.documentElement?.dataset?.invstoPerformanceWorker&&Date.now()-started<5*60000){
    const batch=await db.rpc(manual?'claim_requested_ebay_performance_checks':'claim_ebay_health_jobs');
    if(batch.error)throw Error('Could not check the performance report schedule.');
    for(const job of batch.data||[]){
     if(Date.now()-started>8*60000)break;
     let rows=[],error=null;
     try{const result=await request('OG_PERFORMANCE_READ',{job:{kind:job.kind,id:job.id}},185000);rows=result.rows;}
     catch(e){error=e.message;}
     const result=await db.rpc('finish_ebay_health_job',{_ticket:job.ticket,_rows:rows,_count:rows.length,_error:error});
     if(result.error&&!error)await db.rpc('finish_ebay_health_job',{_ticket:job.ticket,_rows:[],_count:0,_error:'The source did not reconcile. The previous figures are preserved.'});
    }
   }else if(manual)throw Error('Refresh queued. Enable OG eBay Order Link v1.0.32 or later on the Edge workstation. The next signed-in check will pick it up.');
 }
 async function run(){
  if(!new URL(location.href).searchParams.has('job')||window.top!==window)return;
  const started=Date.now();
  const manual=new URL(location.href).searchParams.get('performance')==='manual';
  let pause=false,performanceCheck;
  try{
   const db=window.supabaseClient;if(!db||!(await db.auth.getSession()).data?.session){pause=!manual;if(manual)document.querySelector('#status').textContent='Sign in to Invsto on the Edge workstation, then retry from Needs your action.';return;}
   if(manual){document.querySelector('#status').textContent='Checking the overdue sources in Seller Hub. You can return to the dashboard; the result will appear on the action card.';await updatePerformance(db,started,true);return;}
   performanceCheck=updatePerformance(db,started).catch(()=>{});
   if(new URL(location.href).searchParams.has('performance'))return;
   const job=await db.rpc('claim_ebay_browser_reports');if(job.error){pause=true;return;}if(!job.data)return;
   const work=job.data,notes=[];let observations=[],statementNote=null;
   if(work.ledger||firstReaderCheckDue()){
    markReaderCheck(false);
    try{const started=Date.now();let packet;
     try{packet=(await request('OG_READ_ACCOUNT_HOLDS',{},330000)).packet;}
     catch(e){if(Date.now()-started>100000||!/Waiting for (the )?Seller Hub|Seller Hub changed during the check|Could not read the Seller Hub On hold list/i.test(e.message))throw e;
      packet=(await request('OG_READ_ACCOUNT_HOLDS',{},330000)).packet;}
     const p=packet;
     const saved=await db.rpc('refresh_ebay_hold_ledger',{_at:p.at,_total:p.total,_count:p.count,_rows:p.rows});
     if(saved.error)throw Error('Held list did not reconcile.');
     markReaderCheck(true);
     notes.push(p.count+(p.count===1?' hold entry verified.':' hold entries verified.'));
    }catch(e){notes.push(e.message);}
   }
   if(work.orders.length||work.statement||work.claim_month){
    try{
     const result=await request('OG_REPORT_BATCH',{orders:work.orders,statement:work.statement,claimMonth:work.claim_month,mayRequest:work.may_request});
     observations=result.observations;notes.push(observations.length+' order pages checked.');notes.push(...result.errors);
     if(result.claim&&work.claim_month){
      let note=result.claim.note;
      if(Array.isArray(result.claim.entries)){
       const r=await db.rpc('save_ebay_claim_export',{_month:work.claim_month,_entries:result.claim.entries});
       note=r.error?'Claim entries did not match the statement; prior verified details kept.':result.claim.entries.length+' claim entries verified against the monthly statement.';
      }
      await db.rpc('report_ebay_claim_check',{_ticket:work.ticket,_month:work.claim_month,_note:note,_requested:!!result.claim.requested});
     }
     if(result.statement){
      const saved=await db.rpc('refresh_ebay_verified_statement',result.statement);
      statementNote=saved.error?'Could not verify the official statement; previous figures kept.':saved.data;
     }else if(work.statement)statementNote='Published statement unavailable; will check again.';
    }catch(e){notes.push(e.message);}
   }
   const saved=await db.rpc('finish_ebay_browser_reports',{_ticket:work.ticket,_observations:observations,_note:notes.join(' '),_statement_note:statementNote});
   if(saved.error)throw Error('The refresh expired; last verified records are preserved.');

  }catch(e){document.querySelector('#status').textContent=manual?e.message:'The next check will retry. Previously verified records are preserved.';}
  finally{
   await performanceCheck;
   window.postMessage({channel:'invstoReportRequest',id:crypto.randomUUID(),type:'OG_REPORT_FINISH',pause},location.origin);
   if(manual&&document.documentElement?.dataset?.invstoPerformanceWorker)window.close();
  }
 }
 window.addEventListener('load',run,{once:true});
})();
