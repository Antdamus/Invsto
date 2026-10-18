(function(){
 'use strict';
 if(window.top!==window||location.origin!=='https://seller-us.tiktok.com')return;
 let host;
 function deadlines(){const result={};for(const a of document.querySelectorAll('a[href*="/order/detail?order_no="]')){try{const id=new URL(a.href).searchParams.get('order_no'),match=/Ship by\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(a.closest('tr')?.innerText||'');if(id&&match)result[id]=`${match[3]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`;}catch{}}return result;}
 function install(){
  if(!/^\/order(?:\/|$)/.test(location.pathname)){host?.remove();host=null;return;}
  if(host?.isConnected)return;
  host=document.createElement('div');host.id='og-tiktok-order-tools';host.style.cssText='position:fixed;right:18px;bottom:18px;z-index:100000';
  const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>:host{font:14px system-ui;color:#173e32}details{width:320px;max-width:90vw;background:white;border:1px solid #a4c5b6;border-radius:12px;box-shadow:0 6px 25px #0002;padding:14px}summary{font-weight:750;cursor:pointer}p{line-height:1.5}button{padding:10px 12px;margin:3px 0;border:1px solid #bfd1c6;background:#edf5ef;color:#153e32;border-radius:7px;cursor:pointer;font:inherit}small{font-size:12px}input{max-width:100%}</style><details><summary>OG · TikTok orders</summary><p>Export <b>To ship → All orders under current tab → CSV</b>, download it, then send the file to OG.</p><button id="export" type="button">1. Open export</button><button id="send" type="button">2. Send orders to OG</button><input id="file" type="file" accept=".csv,text/csv" hidden><p id="status" role="status"></p><small>OG shows an import preview first. Only visible ship-by dates are included; other deadlines stay unknown.</small></details>`;
  root.getElementById('export').onclick=()=>{const button=document.querySelector('button[data-log_click_for="export_entry"]');if(button)button.click();else root.getElementById('status').textContent='Select Orders (not Package shipments), then To ship, and try again.';};
  root.getElementById('send').onclick=()=>root.getElementById('file').click();
  root.getElementById('file').onchange=async()=>{const file=root.getElementById('file').files[0],button=root.getElementById('send'),status=root.getElementById('status');if(!file)return;button.disabled=true;try{if(file.size>10*1024*1024)throw Error('Choose a CSV smaller than 10 MB.');status.textContent='Sending export to your TikTok workspace…';const r=await chrome.runtime.sendMessage({type:'OG_TIKTOK_REPORT_SEND',transferId:crypto.randomUUID(),text:await file.text(),filename:file.name,modifiedAt:file.lastModified,deadlines:deadlines()});if(!r?.ok)throw Error(r?.error||'Could not send the export.');status.textContent='Opened TikTok orders in OG. Review the preview and confirm the import there.';}catch(e){status.textContent=e.message;}finally{button.disabled=false;root.getElementById('file').value='';}};
  document.body.append(host);
 }
 let receiptOpened=false;
 function receipt(){
  if(receiptOpened||location.pathname!=='/order/detail'||new URLSearchParams(location.search).get('ogReceipt')!=='1')return;
  const matches=[...document.querySelectorAll('button,span,div')].filter(e=>e.textContent.trim()==='Video receipt'&&!e.querySelector('button,span,div')&&e.getClientRects().length);
  // A multi-item order can have multiple receipts. Let staff choose in TikTok.
  if(matches.length===1){receiptOpened=true;matches[0].click();}
 }
 function run(){install();receipt();}
 if(document.body)run();else document.addEventListener('DOMContentLoaded',run,{once:true});
 let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;run();},400);}).observe(document.documentElement,{childList:true,subtree:true});
})();
