/* Prepare exact TikTok orders in the visible Seller Center UI. Never confirm postage. */
(function(){
 'use strict';
 if(window.top!==window||location.origin!=='https://seller-us.tiktok.com'||location.pathname!=='/order')return;
 const hash=new URLSearchParams(location.hash.slice(1)),raw=hash.get('ogLabels');if(!raw)return;
 const ids=[...new Set(raw.split(';'))];if(ids.length>50||ids.some(id=>!/^\d{10,24}$/.test(id)))return;
 try{sessionStorage.setItem('ogTikTokLabelContext',JSON.stringify({ids,at:Date.now()}));}catch{}
 let host,text,retry,stopped=false,running=false;
 const visible=e=>e&&e.getClientRects().length>0;
 const pause=()=>new Promise(r=>setTimeout(r,150));
 async function until(fn,message){const end=Date.now()+20000;while(Date.now()<end){if(stopped)throw Error('Preparation cancelled.');const result=fn();if(result)return result;await pause();}throw Error(message);}
 function rows(){const map=new Map();for(const a of document.querySelectorAll('a[href*="/order/detail?order_no="]')){const row=a.closest('tr');if(!row||!visible(row))continue;const id=new URL(a.href).searchParams.get('order_no');if(!map.has(id))map.set(id,row);}return map;}
 function exactRows(){const map=rows();return map.size===ids.length&&ids.every(id=>map.has(id))?map:null;}
 async function prepare(){
  if(running)return;running=true;stopped=false;retry.hidden=true;text.textContent=`Finding ${ids.length} TikTok order${ids.length===1?'':'s'}…`;
  try{
   if(document.querySelector('[role="dialog"]'))throw Error('Close the current TikTok dialog, then retry preparation.');
   const input=await until(()=>[...document.querySelectorAll('input[placeholder]')].find(e=>visible(e)&&e.placeholder.startsWith('Search by order ID')&&e.placeholder.includes('semicolons')),'Open Manage orders → Orders, then retry preparation.');
   const ai=input.parentElement.querySelector('[role="switch"]');
   if(ai?.getAttribute('aria-checked')==='true')throw Error('Turn off AI search in TikTok, then retry preparation.');
   // React-controlled input: use its native setter, then the same Enter gesture as staff.
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,ids.join(';'));
   input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
   await pause();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
   input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
   if(ids.length>20){
    const size=await until(()=>[...document.querySelectorAll('[role="combobox"]')].find(e=>visible(e)&&/^\d+\/Page$/.test(e.textContent.trim())),'Choose 50/Page in TikTok, then retry preparation.');
    if(size.textContent.trim()!=='50/Page'){size.click();const option=await until(()=>[...document.querySelectorAll('[role="option"]')].find(e=>visible(e)&&e.textContent.trim()==='50/Page'),'Choose 50/Page in TikTok, then retry preparation.');option.click();}
   }
   await until(exactRows,'TikTok did not return every requested order. Check the order IDs below and clear conflicting filters before retrying.');
   // Wait for the searched table to settle before validating every order's live status.
   await pause();const matches=exactRows();if(!matches||input.value!==ids.join(';'))throw Error('The search changed. Retry preparation.');
   for(const row of matches.values()){
    const cells=[...row.querySelectorAll('td')];
    if(!cells.some(c=>c.textContent.trim()==='Awaiting shipment')||/cancel(?:lation|ation)? requested|return requested|refund requested/i.test(row.innerText))throw Error('An order is no longer ready for a new label. Review its status in TikTok and import a fresh export in OG.');
    const box=row.querySelector('input[type="checkbox"]');if(!box||box.disabled)throw Error('TikTok cannot select every order. Review the orders before creating labels.');
   }
   for(const id of ids){const row=exactRows()?.get(id),box=row?.querySelector('input[type="checkbox"]');if(!box)throw Error('The order list changed. Retry preparation.');if(!box.checked){box.click();await pause();}}
   const final=exactRows();if(!final||ids.some(id=>!final.get(id).querySelector('input[type="checkbox"]')?.checked))throw Error('TikTok did not select every order. Retry preparation.');
   const action=await until(()=>{const b=document.querySelector('button[data-id="fulfillment.manage_order.batch_arrange_shipment"]');return visible(b)&&!b.disabled?b:null;},'Use TikTok’s Arrange shipment button for the selected orders.');
   const count=/\((\d+)\)/.exec(action.textContent);if(!count||Number(count[1])!==ids.length)throw Error('TikTok has extra or missing selected orders. Clear its selection, then retry preparation.');
   if(stopped)return;
   text.textContent='Review TikTok’s package combinations, weight, size and postage. After creating labels, choose Print → Print through OG.';
   // Only the list's initial review action. No modal, Combine, Buy, or final Arrange action is clicked.
   action.click();hash.delete('ogLabels');history.replaceState(null,'',location.pathname+location.search+(hash.size?'#'+hash.toString():''));
  }catch(e){text.textContent=e.message;retry.hidden=false;}finally{running=false;}
 }
 function install(){
  host=document.createElement('aside');host.id='og-tiktok-shipping';host.style.cssText='position:fixed;left:20px;bottom:20px;z-index:100001;max-width:430px;background:#fff;color:#173e32;border:1px solid #a4c5b6;padding:16px;border-radius:12px;box-shadow:0 6px 25px #0003;font:14px/1.5 system-ui';
  const root=host.attachShadow({mode:'open'});root.innerHTML='<strong>OG · Create TikTok shipping labels</strong><p role="status"></p><details><summary>Requested order IDs</summary><textarea readonly aria-label="Requested TikTok order IDs" style="box-sizing:border-box;width:100%;height:85px"></textarea></details><p><button type="button" id="retry" hidden>Retry preparation</button> <button type="button" id="close">Dismiss</button></p>';
  text=root.querySelector('[role="status"]');retry=root.querySelector('#retry');root.querySelector('textarea').value=ids.join(';');retry.onclick=prepare;root.querySelector('#close').onclick=()=>{stopped=true;host.remove();};document.body.append(host);prepare();
 }
 if(document.body)install();else document.addEventListener('DOMContentLoaded',install,{once:true});
})();
