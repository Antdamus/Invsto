(()=>{
 if(window.top!==window||location.origin!=='https://antdamus.github.io'||location.pathname!=='/Invsto/dashboard.html')return;
 document.documentElement.setAttribute('data-invsto-hold-reader','1');
 document.documentElement.setAttribute('data-invsto-performance-reader',chrome.runtime.getManifest().version);
 window.addEventListener('message',async e=>{
  if(e.origin!==location.origin||e.source!==window||e.data?.type!=='INVSTO_HOLD_REFRESH'||typeof e.data.id!=='string')return;
  const result=await chrome.runtime.sendMessage({type:'OG_READ_ACCOUNT_HOLDS'}).catch(()=>({ok:false,message:'Reload OG eBay Order Link and the dashboard.'}));
  window.postMessage({type:'INVSTO_HOLD_RESULT',id:e.data.id,...result},location.origin);
 });
})();
