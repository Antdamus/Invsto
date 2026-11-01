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
 async function run(){
  if(!new URL(location.href).searchParams.has('job')||window.top!==window)return;
  let pause=false;
  try{
   const db=window.supabaseClient;if(!db||!(await db.auth.getSession()).data?.session){pause=true;return;}
   const job=await db.rpc('claim_ebay_browser_reports');if(job.error){pause=true;return;}if(!job.data)return;
   const work=job.data,notes=[];let observations=[],statementNote=null;
   if(work.ledger){
    try{const {packet:p}=await request('OG_READ_ACCOUNT_HOLDS');
     const saved=await db.rpc('refresh_ebay_hold_ledger',{_at:p.at,_total:p.total,_count:p.count,_rows:p.rows});
     if(saved.error)throw Error('Held list did not reconcile.');
     notes.push(p.count+' hold entries verified.');
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
  }catch{document.querySelector('#status').textContent='The next check will retry. Previously verified records are preserved.';}
  finally{
   window.postMessage({channel:'invstoReportRequest',id:crypto.randomUUID(),type:'OG_REPORT_FINISH',pause},location.origin);
  }
 }
 window.addEventListener('load',run,{once:true});
})();
