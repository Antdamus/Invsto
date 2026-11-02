(()=>{
 if(window!==window.top||location.origin!=='https://antdamus.github.io'||location.pathname!=='/Invsto/ebay-report-refresh.html')return;
 document.documentElement.dataset.invstoReportWorker='1';
 document.documentElement.dataset.invstoPerformanceWorker='1';
 // A blocked CDN or expired page must not leave an unattended helper tab behind.
 if(new URL(location.href).searchParams.has('job'))setTimeout(()=>chrome.runtime.sendMessage({type:'OG_REPORT_FINISH'}).catch(()=>{}),11*60000);
 window.addEventListener('message',async e=>{
  if(e.source!==window||e.origin!==location.origin||e.data?.channel!=='invstoReportRequest'||typeof e.data.id!=='string')return;
  const {type,orders,statement,pause,id,claimMonth,mayRequest}=e.data;
  if(!['OG_REPORT_FINISH','OG_REPORT_BATCH','OG_READ_ACCOUNT_HOLDS','OG_PERFORMANCE_READ'].includes(type))return;
  try{const reply=await chrome.runtime.sendMessage({type,orders,statement,pause,claimMonth,mayRequest,job:e.data.job});
   window.postMessage({channel:'invstoReportResult',id,reply},location.origin);
  }catch{window.postMessage({channel:'invstoReportResult',id,reply:{ok:false}},location.origin);}
 });
})();
