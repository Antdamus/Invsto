(function(root){
  'use strict';
  const keys=['gold_10','gold_14','silver','gold_8','gold_9','gold_18','gold_21','gold_22','gold_24'];
  const label=key=>key==='silver'?'Sterling silver · 925':key.replace('gold_','')+'K gold';
  function itemKey(item){
    if(item.watch_details||item.coin_details||/\b(plated|filled|vermeil|tone|gp|gf|hge|overlay)\b/i.test(item.title||''))return null;
    const metal=String(item.metal||'').toLowerCase(),bp=Number(item.purity_basis_points)||null;
    if(metal==='silver')return bp==null||bp===9250?'silver':null;
    if(metal!=='gold')return null;
    if(bp==null)return 'gold_10';
    return keys.find(k=>k.startsWith('gold_')&&Math.abs(Number(k.slice(5))/24*10000-bp)<=1)||null;
  }
  const estimate=(item,rates)=>{const key=itemKey(item),weight=Number(item.weight),rate=rates?.[key];return key&&weight>0&&Number.isFinite(weight)&&rate!=null?{key,rate:Number(rate),cost:Math.round((weight*Number(rate)+Number.EPSILON)*100)/100}:null;};
  const api={keys,label,itemKey,estimate};root.MaterialCosts=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
