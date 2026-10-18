(function(){
 'use strict';
 if(window.top!==window||location.origin!=='https://seller-us.tiktok.com')return;
 let host,exporting=false;
 function deadlines(){const result={};for(const a of document.querySelectorAll('a[href*="/order/detail?order_no="]')){try{const id=new URL(a.href).searchParams.get('order_no'),match=/Ship by\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(a.closest('tr')?.innerText||'');if(id&&match)result[id]=`${match[3]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`;}catch{}}return result;}
 function install(){
  if(!/^\/order(?:\/|$)/.test(location.pathname)){host?.remove();host=null;return;}
  if(host?.isConnected)return;
  host=document.createElement('div');host.id='og-tiktok-order-tools';host.style.cssText='position:fixed;right:18px;bottom:18px;z-index:100000';
  const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>:host{font:14px system-ui;color:#173e32}details{width:320px;max-width:85vw;background:white;border:1px solid #a4c5b6;border-radius:12px;box-shadow:0 6px 25px #0002;padding:14px}summary{font-weight:750;cursor:pointer}p{line-height:1.5}button{padding:10px 12px;margin:3px 0;border:1px solid #bfd1c6;background:#edf5ef;color:#153e32;border-radius:7px;cursor:pointer;font:inherit}button:disabled{opacity:.55;cursor:wait}#all{display:block;background:#09675d;color:white;font-weight:700;width:100%}small{font-size:12px}input{max-width:100%}</style><details><summary>OG · TikTok orders</summary><p>Export all orders, including cancellations, download the CSV and open your OG import preview in one click.</p><button id="all" type="button">Export all → OG</button><button id="cancel" type="button" hidden>Cancel export</button><p id="status" role="status" aria-live="polite"></p><button id="export" type="button">Open export manually</button><button id="send" type="button">Send downloaded CSV</button><input id="file" type="file" accept=".csv,text/csv" hidden><p><small>TikTok exports orders from the last 12 months. Review and confirm in OG before records change. Missing rows never imply cancellation. Only visible ship-by dates are included.</small></p></details>`;
  root.getElementById('all').onclick=async()=>{
   if(exporting)return;exporting=true;const status=root.getElementById('status');root.querySelectorAll('#all,#export,#send').forEach(b=>b.disabled=true);root.getElementById('cancel').hidden=false;
   try{if(!window.OGTikTokExport)throw Error('Reload this TikTok tab after updating the extension.');await window.OGTikTokExport.run({status:text=>{status.textContent=text;},deadlines:deadlines()});}
   catch(e){status.textContent=e.message||'Export failed. Try again or use the manual CSV option.';}
   finally{exporting=false;root.querySelectorAll('#all,#export,#send').forEach(b=>b.disabled=false);root.getElementById('cancel').hidden=true;}
  };
  root.getElementById('cancel').onclick=()=>window.OGTikTokExport?.cancel();
  root.getElementById('export').onclick=()=>{const button=document.querySelector('button[data-log_click_for="export_entry"]');if(button)button.click();else root.getElementById('status').textContent='Select Orders (not Package shipments), then All or Canceled, and try again.';};
  root.getElementById('send').onclick=()=>root.getElementById('file').click();
  root.getElementById('file').onchange=async()=>{const file=root.getElementById('file').files[0],button=root.getElementById('send'),status=root.getElementById('status');if(!file)return;button.disabled=true;try{if(file.size>10*1024*1024)throw Error('Choose a CSV smaller than 10 MB.');status.textContent='Sending export to your TikTok workspace…';const r=await chrome.runtime.sendMessage({type:'OG_TIKTOK_REPORT_SEND',transferId:crypto.randomUUID(),text:await file.text(),filename:file.name,modifiedAt:file.lastModified,deadlines:deadlines()});if(!r?.ok)throw Error(r?.error||'Could not send the export.');status.textContent='Opened TikTok orders in OG. Review the preview and confirm the import there.';}catch(e){status.textContent=e.message;}finally{button.disabled=false;root.getElementById('file').value='';}};
  document.body.append(host);
 }
 let receiptOpened=false;
 function receipt(){
  if(receiptOpened||location.pathname!=='/order/detail'||new URLSearchParams(location.search).get('ogReceipt')!=='1')return;
  const sku=new URLSearchParams(location.search).get('ogSku');
  const matches=[...document.querySelectorAll('button,span,div')].filter(e=>{
   if(e.textContent.trim()!=='Video receipt'||e.querySelector('button,span,div')||!e.getClientRects().length)return false;
   if(!sku)return true;
   for(let node=e.parentElement;node&&node!==document.body;node=node.parentElement){const ids=[...new Set([...node.innerText.matchAll(/SKU\s*ID\s*:\s*(\d{10,24})(?!\d)/gi)].map(m=>m[1]))];if(ids.length)return ids.length===1&&ids[0]===sku;}
   return false;
  });
  // A multi-item order can have multiple receipts. Let staff choose in TikTok.
  if(matches.length===1){receiptOpened=true;matches[0].click();}
 }
 function run(){install();receipt();if(host){const open=[...document.querySelectorAll('.core-drawer-content')].some(el=>el.getClientRects().length&&/Export orders range/.test(el.textContent));host.style.left=open?'18px':'';host.style.right=open?'':'18px';}}
 if(document.body)run();else document.addEventListener('DOMContentLoaded',run,{once:true});
 let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;run();},400);}).observe(document.documentElement,{childList:true,subtree:true});
})();
