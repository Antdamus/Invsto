/* Drives TikTok's native export UI and hands the exact new CSV to OG's review page. */
(() => {
 'use strict';
 let current;
 const text=el=>(el?.textContent||'').trim(),visible=el=>el&&el.getClientRects().length>0;
 const buttons=(root,label)=>[...root.querySelectorAll('button')].filter(b=>visible(b)&&text(b)===label);
 const drawer=()=>[...document.querySelectorAll('.core-drawer-content,[role="dialog"]')].find(el=>visible(el)&&/Export orders range/.test(text(el)));
 function choice(root,label){return [...root.querySelectorAll('label')].find(el=>visible(el)&&text(el)===label&&el.querySelector('input[type=radio]'));}
 function rows(root){return [...root.querySelectorAll('button')].filter(b=>/^(Download|Exporting)$/.test(text(b))).map(button=>({button,name:text(button.parentElement?.firstElementChild)})).filter(r=>/^All order-.*\.csv$/i.test(r.name));}
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function check(job){if(current!==job||job.cancelled)throw Error('Export cancelled. No orders were imported.');}
 async function until(job,fn,ms,message){const end=Date.now()+ms;do{check(job);const value=fn();if(value)return value;await sleep(200);}while(Date.now()<end);throw Error(message);}
 async function message(payload){const result=await chrome.runtime.sendMessage(payload);if(!result?.ok)throw Error(result?.error||'The extension could not contact OG. Reload the extension and TikTok.');return result;}
 async function capture(job,row,deadlines){
  await message({type:'OG_TIKTOK_REPORT_BEGIN',transferId:job.id,filename:row.name,modifiedAt:job.started,deadlines});check(job);
  return new Promise((resolve,reject)=>{
   let downloading=false,sending=false,lastError='';
   const cleanup=()=>{clearTimeout(timer);clearTimeout(armTimer);window.removeEventListener('message',receive);job.stopCapture=null;window.postMessage({type:'OG_TIKTOK_REPORT_DISARM',transferId:job.id},location.origin);};
   const finish=(error)=>{cleanup();error?reject(error):resolve();};job.stopCapture=()=>finish(Error('Export cancelled. No orders were imported.'));
   const armTimer=setTimeout(()=>{if(!downloading)finish(Error('CSV capture is unavailable. Reload the extension and this TikTok tab, then try again.'));},3000);
   const timer=setTimeout(()=>finish(Error(lastError||'TikTok did not deliver the CSV. Use Download in its export history, then Send downloaded CSV.')),60000);
   async function receive(e){if(e.source!==window||e.origin!==location.origin||e.data?.transferId!==job.id||current!==job||job.cancelled)return;
    if(e.data.type==='OG_TIKTOK_REPORT_ARMED'&&!downloading){downloading=true;clearTimeout(armTimer);job.status('Downloading the new CSV and opening OG…');row.button.click();return;}
    if(sending||!['OG_TIKTOK_REPORT_URL','OG_TIKTOK_REPORT_CAPTURED'].includes(e.data.type))return;sending=true;
    try{await message({type:e.data.type==='OG_TIKTOK_REPORT_URL'?'OG_TIKTOK_REPORT_FETCH':'OG_TIKTOK_REPORT_CAPTURE',transferId:job.id,url:e.data.url,text:e.data.text});finish();}
    catch(error){lastError=error.message;job.status(lastError+' Waiting for TikTok’s downloaded CSV…');sending=false;}
   }
   window.addEventListener('message',receive);window.postMessage({type:'OG_TIKTOK_REPORT_ARM',transferId:job.id},location.origin);
  });
 }
 async function run({status,deadlines={}}){
  if(current)throw Error('An export is already in progress.');
  const job={id:crypto.randomUUID(),started:Date.now(),status,cancelled:false};current=job;
  try{
   if(location.pathname!=='/order')throw Error('Open TikTok Manage orders, then use Export all → OG.');
   if(drawer()){buttons(drawer(),'Close')[0]?.click();await until(job,()=>!drawer(),5000,'Close TikTok’s export drawer and try again.');}
   status('Selecting All orders, including cancellations…');
   const all=document.querySelector('[data-log_click_for="all"][data-log_module_name="order_list_tab"]');if(!all)throw Error('Select the Orders tab in TikTok, then try Export all → OG.');all.click();
   await until(job,()=>all.closest('[role="tab"]')?.getAttribute('aria-selected')==='true',10000,'TikTok did not switch to All orders. Select All and try again.');
   const entry=document.querySelector('button[data-log_click_for="export_entry"]');if(!entry)throw Error('TikTok’s Export control was not found. Reload TikTok and try again.');entry.click();
   const panel=await until(job,()=>drawer(),10000,'TikTok did not open its export drawer.');
   const scope=choice(panel,'All orders under current tab'),csv=choice(panel,'CSV');if(!scope||!csv)throw Error('TikTok’s export options changed. Use the manual CSV option.');scope.click();csv.click();
   await until(job,()=>scope.querySelector('input').checked&&csv.querySelector('input').checked,5000,'Could not select the complete CSV report.');
   const before=new Map();for(const r of rows(panel))before.set(r.name,(before.get(r.name)||0)+1);
   const generate=buttons(panel,'Export')[0];if(!generate||generate.disabled)throw Error('TikTok’s Export button is unavailable.');status('Creating an All-orders CSV. Waiting for TikTok…');generate.click();
   const fresh=await until(job,()=>{const list=rows(drawer()||panel),counts=new Map();for(const r of list)counts.set(r.name,(counts.get(r.name)||0)+1);const seen=new Map();return list.filter(r=>{const index=seen.get(r.name)||0;seen.set(r.name,index+1);return index<counts.get(r.name)-(before.get(r.name)||0);}).find(r=>text(r.button)==='Download'&&!r.button.disabled);},120000,'TikTok is still creating the report. Open export history and use Download, then Send downloaded CSV.');
   check(job);status('Connecting the new CSV to OG…');await capture(job,fresh,deadlines);status('Downloaded and opened TikTok orders in OG. Review the preview and confirm the import there.');
  }finally{if(current===job)current=null;job.stopCapture?.();window.postMessage({type:'OG_TIKTOK_REPORT_DISARM',transferId:job.id},location.origin);void chrome.runtime.sendMessage({type:'OG_TIKTOK_REPORT_CANCEL',transferId:job.id}).catch(()=>{});}
 }
 function cancel(){if(!current)return;current.cancelled=true;current.stopCapture?.();void chrome.runtime.sendMessage({type:'OG_TIKTOK_REPORT_CANCEL',transferId:current.id}).catch(()=>{});}
 window.OGTikTokExport={run,cancel};
})();
