/* Prepare exact TikTok orders in the visible Seller Center UI. Never confirm postage. */
(function(){
 'use strict';
 if(window.top!==window||location.origin!=='https://seller-us.tiktok.com'||location.pathname!=='/order')return;
 const hash=new URLSearchParams(location.hash.slice(1)),raw=hash.get('ogLabels');if(!raw)return;
 const ids=[...new Set(raw.split(';'))];if(ids.length>50||ids.some(id=>!/^\d{10,24}$/.test(id)))return;
 try{sessionStorage.setItem('ogTikTokLabelContext',JSON.stringify({ids,at:Date.now()}));}catch{}
 let host,text,retry,choices,stopped=false,running=false;
 const visible=e=>e&&e.getClientRects().length>0;
 const pause=()=>new Promise(r=>setTimeout(r,150));
 async function until(fn,message){const end=Date.now()+20000;while(Date.now()<end){if(stopped)throw Error('Preparation cancelled.');const result=fn();if(result)return result;await pause();}throw Error(message);}
 function rows(){const map=new Map();for(const a of document.querySelectorAll('a[href*="/order/detail?order_no="]')){const row=a.closest('tr');if(!row||!visible(row))continue;const id=new URL(a.href).searchParams.get('order_no');if(!map.has(id))map.set(id,row);}return map;}
 function exactRows(requested){const map=rows();return map.size===requested.length&&requested.every(id=>map.has(id))?map:null;}
 function orderAction(row){
  if(/cancel(?:lation|ation)? requested|return requested|refund requested/i.test(row.innerText))return null;
  const cells=[...row.querySelectorAll('td')].map(c=>c.textContent.replace(/\s+/g,' ').trim());
  if(cells.includes('Awaiting shipment'))return 'create';
  if(cells.includes('Awaiting collection'))return 'existing';
  return null;
 }
 function chooseGroups(groups){
  choices.replaceChildren();
  for(const [kind,requested] of Object.entries(groups)){
   if(!requested.length)continue;
   const button=document.createElement('button');button.type='button';button.textContent=kind==='create'?`Create new labels (${requested.length})`:`Get existing labels (${requested.length})`;
   button.onclick=()=>prepare(requested);choices.append(button);
  }
 }
 async function prepare(requested=ids){
  if(running)return;running=true;stopped=false;retry.hidden=true;choices.replaceChildren();text.textContent=`Checking ${requested.length} TikTok order${requested.length===1?'':'s'}…`;
  try{
   if([...document.querySelectorAll('[role="dialog"],dialog[open],.core-drawer')].some(visible))throw Error('Close the current TikTok dialog, then retry preparation.');
   const input=await until(()=>[...document.querySelectorAll('input[placeholder]')].find(e=>visible(e)&&e.placeholder.startsWith('Search by order ID')&&e.placeholder.includes('semicolons')),'Open Manage orders → Orders, then retry preparation.');
   const ai=input.parentElement.querySelector('[role="switch"]');
   if(ai?.getAttribute('aria-checked')==='true')throw Error('Turn off AI search in TikTok, then retry preparation.');
   // React-controlled input: use its native setter, then the same Enter gesture as staff.
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,requested.join(';'));
   input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
   await pause();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
   input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
   if(requested.length>20){
    const size=await until(()=>[...document.querySelectorAll('[role="combobox"]')].find(e=>visible(e)&&/^\d+\/Page$/.test(e.textContent.trim())),'Choose 50/Page in TikTok, then retry preparation.');
    if(size.textContent.trim()!=='50/Page'){size.click();const option=await until(()=>[...document.querySelectorAll('[role="option"]')].find(e=>visible(e)&&e.textContent.trim()==='50/Page'),'Choose 50/Page in TikTok, then retry preparation.');option.click();}
   }
   await until(()=>exactRows(requested),'TikTok did not return every requested order. Check the order IDs below and clear conflicting filters before retrying.');
   // Wait for the searched table to settle before validating every order's live status.
   await pause();const matches=exactRows(requested);if(!matches||input.value!==requested.join(';'))throw Error('The search changed. Retry preparation.');
   const groups={create:[],existing:[]};
   for(const [id,row] of matches){
    const kind=orderAction(row);
    if(!kind)throw Error(`Order ${id} is no longer awaiting shipment or collection, or has a cancellation/return request. Review it in TikTok and import a fresh export in OG.`);
    groups[kind].push(id);
    const box=row.querySelector('input[type="checkbox"]');if(!box||box.disabled)throw Error('TikTok cannot select every order. Review the orders before creating labels.');
   }
   if(groups.create.length&&groups.existing.length){
    text.textContent=`${groups.create.length} order(s) need new labels; ${groups.existing.length} already have labels on TikTok. Choose which group to open. Existing labels can be sent to OG without buying postage again.`;
    chooseGroups(groups);return;
   }
   const kind=groups.existing.length?'existing':'create';
   for(const id of requested){const row=exactRows(requested)?.get(id),box=row?.querySelector('input[type="checkbox"]');if(!box)throw Error('The order list changed. Retry preparation.');if(!box.checked){box.click();await pause();}}
   const final=exactRows(requested);if(!final||requested.some(id=>!final.get(id).querySelector('input[type="checkbox"]')?.checked||orderAction(final.get(id))!==kind))throw Error('The selection or order status changed. Retry preparation.');
   const actionId=kind==='create'?'batch_arrange_shipment':'batch_print_document';
   const action=await until(()=>{const b=document.querySelector(`button[data-id="fulfillment.manage_order.${actionId}"]`);return visible(b)&&!b.disabled?b:null;},'Use TikTok’s selected-order shipment or Print documents button.');
   const summary=[...document.querySelectorAll('thead')].map(e=>e.textContent).join(' ');
   const count=kind==='create'?/\((\d+)\)/.exec(action.textContent):/All\s+(\d+)\s+orders on this page are selected/i.exec(summary);
   if(!count||Number(count[1])!==requested.length)throw Error('TikTok has extra or missing selected orders. Clear its selection, then retry preparation.');
   if(stopped)return;
   try{sessionStorage.setItem('ogTikTokLabelContext',JSON.stringify({ids:requested,at:Date.now()}));}catch{}
   text.textContent=kind==='create'?'Opening TikTok’s shipment review…':'Opening your existing TikTok labels…';
   // Only the list's initial review action. No modal, Combine, Buy, or final Arrange action is clicked.
   action.click();
   await until(()=>[...document.querySelectorAll('[role="dialog"],dialog[open],.core-drawer')].find(e=>visible(e)&&/Combine orders|Arrange shipment|Print document/i.test(e.textContent)), 'TikTok did not open the shipping panel. Click its Arrange shipment or Print documents button to continue, or retry preparation.');
   text.textContent=kind==='create'?'Review TikTok’s package combinations, weight, size and postage. After creating labels, choose Print → Print through OG, then Save labels to orders in OG.':'These labels already exist on TikTok. Choose Print → Print through OG to bring them into your orders, then Save labels to orders in OG.';
   hash.delete('ogLabels');history.replaceState(null,'',location.pathname+location.search+(hash.size?'#'+hash.toString():''));
  }catch(e){text.textContent=e.message;retry.hidden=false;}finally{running=false;}
 }
 function install(){
  host=document.createElement('aside');host.id='og-tiktok-shipping';host.style.cssText='position:fixed;left:20px;bottom:20px;z-index:100001;width:min(390px,calc(100vw - 72px));background:#fff;color:#173e32;border:1px solid #a4c5b6;padding:16px;border-radius:12px;box-shadow:0 6px 25px #0003;font:14px/1.5 system-ui';
  const root=host.attachShadow({mode:'open'});root.innerHTML='<style>button{padding:8px 10px;margin:4px 4px 4px 0;cursor:pointer;border:1px solid #a4c5b6;border-radius:6px;background:#f5faf7;color:#173e32}#choices button{background:#09675d;color:white}</style><strong>OG · TikTok shipping labels</strong><p role="status"></p><div id="choices"></div><details><summary>Requested order IDs</summary><textarea readonly aria-label="Requested TikTok order IDs" style="box-sizing:border-box;width:100%;height:85px"></textarea></details><p><button type="button" id="retry" hidden>Retry preparation</button> <button type="button" id="close">Dismiss</button></p>';
  text=root.querySelector('[role="status"]');retry=root.querySelector('#retry');choices=root.querySelector('#choices');root.querySelector('textarea').value=ids.join(';');retry.onclick=()=>prepare();root.querySelector('#close').onclick=()=>{stopped=true;host.remove();};document.body.append(host);prepare();
 }
 if(document.body)install();else document.addEventListener('DOMContentLoaded',install,{once:true});
})();
