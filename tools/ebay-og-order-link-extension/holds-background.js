(()=>{
 'use strict';
 const dash='https://antdamus.github.io/Invsto/dashboard.html',hub='https://www.ebay.com/mes/transactionlist?sh=true&filter=transactionStatus:%7BFUNDS_ON_HOLD%7D&pillFilterId=FUNDS_ON_HOLD_FILTER';
 let inFlight;
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function collect(){
  let tab;const at=new Date().toISOString(),rows=[],seen=new Set();let count,total;
  try{
   tab=await chrome.tabs.create({url:hub,active:false});
   for(let i=0;i<670;i++){
    let p,last;
    for(let t=0;t<95;t++){
     if(Date.now()-Date.parse(at)>205000)throw Error('The Seller Hub list timed out.');
     try{const result=await chrome.tabs.sendMessage(tab.id,{type:'OG_HOLDS_PAGE'});
      if(result?.ok&&(result.page.start===rows.length+1||result.page.count===0&&!rows.length)){p=result.page;break;}
      if(result?.message)last=result.message;else if(result?.ok)last='Waiting for Seller Hub entries starting at '+(rows.length+1)+'.';
     }catch{/* A newly opened page may not have loaded its content script. */}
     await wait(350);
    }
    if(!p)throw Error(last||'Could not read the Seller Hub On hold list. Check that ogjewelers is signed in.');
    if(i===0){count=p.count;total=p.total;if(count>20000)throw Error('The ledger exceeds the supported page limit.');}
    if(p.count!==count||p.total!==total)throw Error('Seller Hub changed during the check. Refresh again.');
    for(const r of p.rows){const key=(r.kind==='sale'?'sale:':'reserve:')+r.ref;if(seen.has(key))throw Error('Seller Hub returned a duplicate transaction.');seen.add(key);rows.push(r);}
    if(rows.length===count&&rows.reduce((n,r)=>n+r.cents,0)===total)return {at,count,total,rows};
    if(p.end>=count)throw Error('The on-hold entries did not add up to the account total.');
    const moved=await chrome.tabs.sendMessage(tab.id,{type:'OG_HOLDS_PAGE',advance:true,end:p.end});if(!moved?.ok)throw Error('Seller Hub could not advance to the next page.');
   }
   throw Error('The full ledger could not be checked.');
  }finally{if(tab?.id!=null)await chrome.tabs.remove(tab.id).catch(()=>{});}
 }
 chrome.runtime.onMessage.addListener((m,s,send)=>{
  if(m?.type!=='OG_READ_ACCOUNT_HOLDS'||!s.tab||s.frameId!==0||s.url?.split(/[?#]/)[0]!==dash)return;
  inFlight??=collect().finally(()=>{inFlight=null;});
  inFlight.then(packet=>send({ok:true,packet}),e=>send({ok:false,message:e.message}));return true;
 });
})();
