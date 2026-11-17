(function(){
 'use strict';
 const inflight=new Map();
 async function launch(m,sender){
  if(sender.frameId!==0||!sender.tab?.id||!/^\d{10,24}$/.test(m.orderNumber||'')||(m.skuId&&!/^\d{10,24}$/.test(m.skuId))||!/^[a-f0-9-]{36}$/i.test(m.requestId||''))throw Error('Invalid receipt request. Open it again from Invsto.');
  const stored=await chrome.storage.sync.get('ogPendingOrdersUrl');let workspace,launcher;
  try{workspace=new URL('pending-tiktok-orders.html',stored.ogPendingOrdersUrl);launcher=new URL('tiktok-receipt-launch.html',workspace);}catch{throw Error('Set the OG Pending Orders URL in the extension settings first.');}
  if(workspace.protocol!=='https:'&&!(workspace.protocol==='http:'&&['localhost','127.0.0.1'].includes(workspace.hostname)))throw Error('Set an HTTPS OG Pending Orders URL.');
  const source=new URL(sender.url||'about:blank');
  if(source.origin!==launcher.origin||source.pathname!==launcher.pathname||source.searchParams.get('order')!==m.orderNumber||(source.searchParams.get('sku')||'')!==(m.skuId||''))throw Error('Use the matching Invsto receipt launcher.');
  const tabs=await chrome.tabs.query({});
  const candidates=tabs.filter(tab=>{try{const u=new URL(tab.url);return u.origin===workspace.origin&&u.pathname===workspace.pathname;}catch{return false;}});
  let receiver;
  for(const tab of candidates){try{const state=await chrome.tabs.sendMessage(tab.id,{type:'OG_TIKTOK_RECEIPT_PING'});if(state?.ready&&!state.busy){receiver=tab;break;}}catch{}}
  if(!receiver){
   receiver=candidates[0]||await chrome.tabs.create({url:workspace.href,active:true});
   for(let attempt=0;attempt<40;attempt++){
    try{const state=await chrome.tabs.sendMessage(receiver.id,{type:'OG_TIKTOK_RECEIPT_PING'});if(state?.ready&&!state.busy)break;}catch{}
    if(attempt===39){await chrome.tabs.update(receiver.id,{active:true});throw Error('Sign in to Invsto in this browser, wait for TikTok orders to load, then return here and try again.');}
    await new Promise(resolve=>setTimeout(resolve,750));
   }
  }
  const receipt=new URL('https://seller-us.tiktok.com/order/detail');receipt.searchParams.set('order_no',m.orderNumber);receipt.searchParams.set('shop_region','US');receipt.searchParams.set('ogReceipt','1');if(m.skuId)receipt.searchParams.set('ogSku',m.skuId);
  // The opener identifies the correct workspace when several Invsto tabs exist.
  await chrome.tabs.create({url:receipt.href,active:true,windowId:receiver.windowId,openerTabId:receiver.id});
  return {ok:true};
 }
 chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m?.type!=='OG_TIKTOK_OPEN_RECEIPT')return;
  const key=sender.tab?.id+':'+m.requestId;
  if(!inflight.has(key))inflight.set(key,launch(m,sender).finally(()=>inflight.delete(key)));
  inflight.get(key).then(reply,e=>reply({ok:false,error:e.message}));return true;
 });
})();
