(()=>{
 'use strict';
 const hub='https://www.ebay.com/sh/ovw',statements='https://www.ebay.com/mes/transaction-reports?sh=true&q=statement',claims='https://www.ebay.com/mes/transaction-reports?q=payment-transaction-report&sh=true';
 const nameMonth=m=>new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(m+'T12:00Z'));
 const time=s=>s?new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Never verified';
 const reader=()=>document.documentElement.hasAttribute('data-invsto-hold-reader');
 const id=a=>a.kind+':'+(a.month||'');
 const elem=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
 function external(label,url,primary=false){const e=elem('a',label,primary?'ws-action-control':'ws-action-link');e.href=url;e.target='_blank';e.rel='noopener';return e;}
 function describe(a){
  const period=/^\d{4}-\d\d-01$/.test(a.month||'')?nameMonth(a.month):'';
  switch(a.kind){
   case 'performance':return ['Refresh the eBay performance sources',reader()?'Check overdue order and cancellation data using this Edge session.':'Send the overdue checks to the Edge workstation. Leave Edge open there, signed in to Invsto and OG Jewelers’ Seller Hub.',reader()?'Refresh sources now':'Request workstation refresh'];
   case 'seller':return ['Sign in to OG Jewelers’ Seller Hub','On the Edge workstation, open Seller Hub and sign in as ogjewelers. The reminder clears after a successful check.'];
   case 'holds':return ['Refresh the itemized hold list',({missing:'No hold list has been verified yet.',changed:'The latest eBay balance differs from the saved transactions.',stale:'The saved list is over nine hours old.'}[a.reason]||'The hold list needs verification.')+(reader()?' Check the full list from here.':' Open this dashboard on the Edge workstation with OG eBay Order Link enabled. The workstation also retries automatically.'),'Refresh hold details'];
   case 'claims':return period&&[period+' · Import the claims CSV','Download the full-month transaction CSV from Seller Hub, then choose it here. Invsto checks it against the statement.','Choose claims CSV'];
   case 'statement':return period&&[period+(a.reason==='mismatch'?' · Resolve the statement difference':' · Import the financial statement'),(a.reason==='mismatch'?'The balances or payouts differ from the saved figures. ':'')+'Download the official statement for this month, then choose its summary PDF here.','Choose statement PDF'];
   case 'earnings':return ['Reconnect eBay Order Earnings','Authorize Invsto to read order earnings with the OG Jewelers seller account.','Connect eBay Order Earnings'];
  }
 }
 function init(el,client,getMonth,refreshReport){
  if(!el)return ()=>{};
  let sequence=0,rows=[],signature='',receipt='',watchPerformance=false,watchUntil=0;
  const busy=new Set(),messages=new Map();
  const status=el.querySelector('.ws-action-status'),list=el.querySelector('ul'),heading=el.querySelector('h3'),icon=el.querySelector('.ws-action-icon');
  const actionButton=(label,fn,disabled=false)=>{const b=elem('button',label,'ws-action-control');b.type='button';b.disabled=disabled;b.onclick=fn;return b;};
  function state(a){
   const sources=a.sources||{},overdue=Object.values(sources).filter(s=>!s.verified||Date.now()-Date.parse(s.verified)>=12*3600000);
   const inProgress=overdue.some(s=>s.checking);
   const queued=overdue.some(s=>s.requested&&(!s.attempted||Date.parse(s.requested)>Date.parse(s.attempted)));
   return {sources,inProgress,queued};
  }
  function feedback(key,text){messages.set(key,text);const slot=[...list.children].find(li=>li.dataset.key===key)?.querySelector('.ws-action-feedback');if(slot)slot.textContent=text;}
  function render(force=false){
   const visible=rows.filter(describe),fixedReader=document.documentElement.hasAttribute('data-invsto-performance-reader'),sig=JSON.stringify([visible,reader(),fixedReader,[...busy],receipt]);
   if(!force&&sig===signature)return;signature=sig;
   el.hidden=!visible.length&&!receipt;heading.textContent=visible.length?'Needs your action':'Action complete';icon.textContent=visible.length?'!':'✓';
   el.classList.toggle('ws-actions-complete',!visible.length&&!!receipt);
   if(receipt){
    const dismiss=elem('button','Dismiss','ws-action-dismiss');dismiss.type='button';dismiss.onclick=()=>{receipt='';status.replaceChildren();render(true);};
    status.replaceChildren(document.createTextNode(receipt+' '),dismiss);
   }
   const shortcut=document.getElementById('ws-action-shortcut');
   if(shortcut){shortcut.hidden=!visible.length;shortcut.textContent=visible.length===1?'1 eBay action needs your attention ↑':visible.length+' eBay actions need your attention ↑';}
   list.replaceChildren(...visible.map(a=>{
    const key=id(a),[title,body,label]=describe(a),li=elem('li'),copy=elem('div'),tools=elem('div',null,'ws-action-tools');
    li.dataset.key=key;copy.append(elem('strong',title),elem('p',body));
    const after=elem('p',messages.get(key),'ws-action-feedback');after.setAttribute('role','status');
    if(a.kind==='performance'){
     const {sources,inProgress,queued}=state(a);
     const needsReader=reader()&&!fixedReader&&Object.values(sources).some(s=>/missing cancellation item ids|outside the requested date range/i.test(s.error||''));
     if(a.sources){
      const dl=elem('dl',null,'ws-source-checks');
      for(const [k,name] of [['orders','Order history'],['cases','Cancellation register']]){
       const s=sources[k];if(!s)continue;
       const row=elem('div');row.append(elem('dt',name),elem('dd','Last verified: '+time(s.verified)));dl.append(row);
       if(s.error&&!s.checking&&(!s.requested||Date.parse(s.attempted)>=Date.parse(s.requested)))row.append(elem('small','Last check: '+s.error));
      }
      copy.append(dl);
     }
     if(needsReader){
      copy.append(elem('p','One-time Edge update: open Extensions → Manage extensions, then click Reload (↻) on OG eBay Order Link v1.0.33 or later. If your extension was installed from a ZIP, update its folder first.','ws-action-state'));
      tools.append(external('Download updated reader ↗','downloads/OG-eBay-Order-Link.zip?v=1.0.33'));
     }
     if(inProgress||queued)copy.append(elem('p',inProgress?'Checking Seller Hub now. This card updates automatically.':'Queued for the signed-in workstation’s next check.','ws-action-state'));
     tools.prepend(actionButton(inProgress?'Checking…':queued&&!reader()?'Refresh requested':needsReader?'Refresh after reloading':label,()=>run(a),busy.has(key)||inProgress||(queued&&!reader())));tools.append(external('Open Seller Hub ↗',hub));
    }else if(a.kind==='claims'||a.kind==='statement'){
     const file=elem('input');file.type='file';file.hidden=true;file.accept=a.kind==='claims'?'.csv,text/csv':'.pdf,application/pdf';file.setAttribute('aria-label',label);
     file.onchange=()=>{if(file.files[0])run(a,file.files[0]);};
     tools.append(actionButton(label,()=>file.click(),busy.has(key)),file,external(a.kind==='claims'?'Get transaction CSV ↗':'Get monthly statement ↗',a.kind==='claims'?claims:statements));
    }else if(a.kind==='seller')tools.append(external('Sign in to Seller Hub ↗',hub,true));
    else if(a.kind==='holds'&&!reader())tools.append(external('Open Seller Hub ↗',hub,true));
    else tools.append(actionButton(label,()=>run(a),busy.has(key)));
    copy.append(after);li.append(copy,tools);return li;
   }));
  }
  async function run(a,file){
   const key=id(a);if(busy.has(key))return;busy.add(key);receipt='';status.textContent='';
   let helper=null;
   if(a.kind==='performance'&&reader()){
    // Reserve a tab during the click; navigate only after the server accepts the request.
    try{helper=window.open('about:blank','_blank');if(helper){helper.opener=null;helper.document.title='Starting Seller Hub check';helper.document.body.textContent='Starting your Seller Hub check…';}}catch{/* Queuing still works without a popup. */}
   }
   feedback(key,a.kind==='performance'?'Requesting the overdue checks…':file?'Checking the file against the selected month…':a.kind==='holds'?'Checking all pages in Seller Hub…':'Starting eBay authorization…');render();
   try{
    let result;
    if(a.kind==='performance'){
     const {error}=await client.rpc('request_ebay_performance_refresh');if(error)throw Error('Could not request the refresh. Check your connection and try again.');
     watchPerformance=true;watchUntil=Date.now()+12*60000;
     if(helper&&!helper.closed){helper.location.replace('ebay-report-refresh.html?job='+Date.now()+'&performance=manual');helper=null;result='Refresh requested. Checking with the signed-in Edge workstation.';}
     else result=reader()?'Refresh queued. Allow pop-ups here to run it immediately, or leave Edge open for its next background check.':'Refresh requested. The signed-in Edge workstation checks the queue every 30 minutes.';
    }else if(file)result=await window.WeeklyEbayCash.importFile(client,a.kind,a.month.slice(0,7),file);
    else if(a.kind==='holds')result=await window.WeeklyEbayHolds.refreshNow(client);
    else if(a.kind==='earnings'){
     const {data,error}=await client.functions.invoke('ebay-weekly-earnings',{body:{action:'connect'}});
     if(error)throw Error('Could not start eBay authorization. Try again.');
     if(data?.url&&new URL(data.url).origin==='https://auth.ebay.com'){location.assign(data.url);return;}
     if(!data?.ok)throw Error('Could not start eBay authorization.');result='Connection checked.';
    }
    feedback(key,result);if(a.kind!=='performance'){receipt=result;refreshReport?.();}
    await check();
   }catch(e){feedback(key,e.message||'Could not finish. Try again.');}
   finally{helper?.close();busy.delete(key);render(true);}
  }
  async function check(){
   const n=++sequence,month=getMonth();if(!/^\d{4}-(0[1-9]|1[012])$/.test(month)||document.hidden)return;
   try{const {data,error}=await client.rpc('ebay_report_manual_actions',{_month:month+'-01'});if(error||!Array.isArray(data))throw Error();
    if(n!==sequence||month!==getMonth())return;
    if(watchPerformance&&!data.some(a=>a.kind==='performance')){receipt='Order history and the cancellation register are both up to date.';watchPerformance=false;messages.delete('performance:');}
    const p=data.find(a=>a.kind==='performance');
    if(p?.sources&&Object.values(p.sources).some(s=>s.checking||s.error&&s.attempted&&s.requested&&Date.parse(s.attempted)>=Date.parse(s.requested)))messages.delete('performance:');
    if(status.dataset.delayed){status.textContent='';delete status.dataset.delayed;}
    rows=data;render();
   }catch{if(n===sequence&&!el.hidden){status.dataset.delayed='1';status.textContent='Showing the last known reminders. Invsto will check again automatically.';}}
  }
  setInterval(()=>{if(watchPerformance&&Date.now()<watchUntil&&!document.hidden)check();},12000);
  if(typeof MutationObserver!=='undefined')new MutationObserver(()=>render()).observe(document.documentElement,{attributes:true,attributeFilter:['data-invsto-hold-reader','data-invsto-performance-reader']});
  return check;
 }
 window.WeeklyEbayActions={init};
})();
