(function(){
 'use strict';
 const KEY='invsto.tiktok.receiptBrowser',choices=['current','edge','firefox'];
 const windows=/Windows/i.test(navigator.userAgent),firefox=/Firefox\//i.test(navigator.userAgent),edge=/Edg\//i.test(navigator.userAgent);
 function preference(){try{const value=localStorage.getItem(KEY);return choices.includes(value)?value:'current';}catch{return 'current';}}
 function receipt(value){
  try{
   const url=new URL(value,location.href),order=url.searchParams.get('order_no'),sku=url.searchParams.get('ogSku')||'';
   if(url.origin!=='https://seller-us.tiktok.com'||url.pathname!=='/order/detail'||url.searchParams.get('ogReceipt')!=='1'||!/^\d{10,24}$/.test(order||'')||(sku&&!/^\d{10,24}$/.test(sku)))return null;
   const canonical=new URL('https://seller-us.tiktok.com/order/detail');canonical.searchParams.set('order_no',order);canonical.searchParams.set('shop_region','US');canonical.searchParams.set('ogReceipt','1');if(sku)canonical.searchParams.set('ogSku',sku);
   return {order,sku,url:canonical.href};
  }catch{return null;}
 }
 function route(value,choice=preference()){
  const item=receipt(value);if(!item)return null;
  if(!windows||choice==='current'||choice==='edge'&&edge||choice==='firefox'&&firefox)return item.url;
  if(choice==='edge')return 'microsoft-edge:'+item.url;
  if(choice==='firefox'){const params=new URLSearchParams({order:item.order});if(item.sku)params.set('sku',item.sku);return 'invsto-receipt://tiktok/?'+params;}
  return item.url;
 }
 function setup(){
  const dialog=document.createElement('dialog');dialog.className='tk-receipt-settings';dialog.setAttribute('aria-labelledby','tk-receipt-settings-title');
  dialog.innerHTML='<form method="dialog"><button class="tk-receipt-close" aria-label="Close receipt settings">×</button><p class="tk-receipt-eyebrow">TIKTOK RECEIPTS</p><h2 id="tk-receipt-settings-title">Choose your receipt browser</h2><p>Choose where video receipts open. This preference is saved in this browser on this computer.</p><label for="tk-receipt-browser-choice">Open video receipts with</label><select id="tk-receipt-browser-choice"><option value="current">Current browser</option><option value="edge">Microsoft Edge</option><option value="firefox">Firefox</option></select><p id="tk-receipt-browser-help" class="tk-receipt-help"></p><section id="tk-firefox-setup" hidden><strong>Set up Firefox once</strong><ol><li>Install the Invsto receipt opener on this Windows computer.</li><li>Install the signed OG Order Link extension in Firefox.</li><li>Sign in to TikTok and Invsto in Firefox.</li></ol><a class="tk-receipt-download" href="downloads/Invsto-Receipt-Opener.zip" download>Download Windows receipt opener</a><a class="tk-receipt-download" href="downloads/OG-Order-Link-Firefox.xpi" download>Download signed Firefox extension</a><p class="tk-receipt-help">In Firefox, open Add-ons Manager, choose the gear menu → Install Add-on From File, and select the downloaded XPI. Review the permissions to finish. The signed extension stays installed after restarting Firefox.</p></section><p id="tk-receipt-browser-status" role="status"></p><button type="submit" class="tk-receipt-done">Done</button></form>';
  document.body.append(dialog);
  const select=dialog.querySelector('select'),help=dialog.querySelector('#tk-receipt-browser-help'),panel=dialog.querySelector('#tk-firefox-setup'),status=dialog.querySelector('[role=status]');
  function refresh(){select.value=preference();select.disabled=!windows;panel.hidden=select.value!=='firefox'||!windows;help.textContent=!windows?'On this device, receipts open in the current browser.':select.value==='firefox'?'Firefox uses the same order and item details. Keep the OG extension enabled to save receipt photos.':select.value==='edge'?'TikTok video receipts will open in Microsoft Edge.':'Receipts open in the browser you are using now.';}
  select.addEventListener('change',()=>{try{localStorage.setItem(KEY,select.value);status.textContent='Saved for this computer.';refresh();}catch{status.textContent='Could not save the preference. Allow this site to store settings and try again.';}});
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  document.querySelectorAll('[data-tk-receipt-settings]').forEach(button=>button.addEventListener('click',()=>{refresh();status.textContent='';dialog.showModal();}));
  return {dialog,refresh};
 }
 function start(){
  const mobileMenu=document.querySelector('.mobile-nav-links');
  if(mobileMenu&&!mobileMenu.querySelector('[data-tk-receipt-settings]')){const button=document.createElement('button');button.type='button';button.className='tk-mobile-receipt-settings';button.dataset.tkReceiptSettings='';button.textContent='Receipt settings';mobileMenu.append(button);}
  const settings=setup();
  document.addEventListener('click',event=>{
   const link=event.target.closest?.('a[href]');if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
   const target=route(link.href);if(!target||target===receipt(link.href)?.url)return;
   event.preventDefault();
   if(target.startsWith('invsto-receipt:')){
    const toast=document.createElement('section');toast.className='tk-receipt-launch-notice';toast.setAttribute('role','status');
    const text=document.createElement('span');text.textContent='Opening Firefox. If it does not open, finish the one-time setup.';
    const button=document.createElement('button');button.type='button';button.textContent='Receipt settings';button.onclick=()=>{settings.refresh();settings.dialog.showModal();};
    const close=document.createElement('button');close.type='button';close.textContent='Dismiss';close.onclick=()=>toast.remove();toast.append(text,button,close);
    document.querySelector('.tk-receipt-launch-notice')?.remove();document.body.append(toast);
   }
   // Keep the queue and unsaved work in place while Windows handles the request.
   let frame=document.getElementById('tk-receipt-opener');if(!frame){frame=document.createElement('iframe');frame.id='tk-receipt-opener';frame.hidden=true;frame.title='Receipt browser opener';document.body.append(frame);}frame.src=target;
  });
 }
 window.TikTokReceiptBrowser={preference,receipt,route};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
