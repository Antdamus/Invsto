(() => {
 'use strict';
 const kinds={sale:'Original sale credits',return:'Return holds',dispute:'Payment disputes',retro:'Sale funds held again',other:'Other eBay holds'};
 const usd=n=>(n/100).toLocaleString('en-US',{style:'currency',currency:'USD'}),sum=a=>a.reduce((n,r)=>n+r.cents,0);
 const date=d=>d?new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'Purchase date unknown';
 const monthLabel=m=>m==='unknown'?'Purchase month unknown':new Date(m+'-01T12:00Z').toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
 const stamp=s=>new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const url='https://www.ebay.com/mes/transactionlist?sh=true&filter=transactionStatus:%7BFUNDS_ON_HOLD%7D&pillFilterId=FUNDS_ON_HOLD_FILTER';
 const link=(href,label)=>'<a target="_blank" rel="noopener" href="'+h(href)+'">'+h(label)+' ↗</a>';
 const month=r=>r.date?.slice(0,7)||'unknown';
 function holdInfo(r,checked){
  const api=window.OGEbayHoldDetails;if(!api)return null;
  if(r.kind==='sale')return {...api.model(r.oid,r.hold_detail||{},true),snapshot:checked};
  const category=r.kind==='return'?'return':r.kind==='dispute'?'dispute':'unknown';
  return {id:'',memos:category==='return'?['eBay reserved these funds for return '+r.ref+'.']:category==='dispute'?['eBay reserved these funds for payment dispute '+r.ref+'.']:[],
   categories:[category],codes:[],estimates:[],actions:[],checked,source:'Seller Hub hold record'};
 }
 function proof(r){
  if(r.kind==='sale')return r.oid?'https://www.ebay.com/sh/ord/details?orderid='+encodeURIComponent(r.oid):url;
  const u=new URL('https://www.ebay.com/mes/transactiondetails');u.searchParams.set('sh','true');u.searchParams.set('type','RESERVE');
  u.searchParams.set('uuid',r.kind==='other'?r.ref:(r.kind==='retro'?'RETRO_FUNDS_DISPLAY__RETRO_DISPLAY-':'DISPUTE_DISPLAY__DISPUTE_DISPLAY-')+r.ref);
  if(r.kind==='retro'&&r.oid){u.searchParams.set('relatedTransactionId',r.oid);u.searchParams.set('relatedTransactionType','ORDER');}return u.href;
 }
 function week(d){if(!d)return 'unknown';const v=new Date(d+'T12:00Z');v.setUTCDate(v.getUTCDate()-(v.getUTCDay()+6)%7);return v.toISOString().slice(0,10);}
 const review=()=>window.WeeklyReturnHoldReview;
 const option=(k,n)=>'<option value="'+h(k)+'">'+h(n)+'</option>';
 let active=false,nextAttempt=0;
 async function refresh(el,s,automatic=false){
  if(active||!s)return;
  if(!document.documentElement.hasAttribute('data-invsto-hold-reader')){
   if(!automatic)el.querySelector('.wh-msg').textContent='To refresh the order breakdown, reload the latest OG eBay Order Link in Edge, then refresh this dashboard. The latest verified breakdown stays available.';
   return;
  }
  active=true;nextAttempt=Date.now()+3600000;
  const msg=el.querySelector('.wh-msg'),button=el.querySelector('.wh-sync');button.disabled=true;msg.textContent='Checking all pages of Seller Hub’s On hold list…';
  const id=crypto.randomUUID();let listener,timer;
  try{
   const packet=await new Promise((resolve,reject)=>{
    listener=e=>{if(e.source!==window||e.origin!==location.origin||e.data?.type!=='INVSTO_HOLD_RESULT'||e.data.id!==id)return;
     e.data.ok?resolve(e.data.packet):reject(Error(e.data.message||'Seller Hub check did not finish.'));};
    window.addEventListener('message',listener);timer=setTimeout(()=>reject(Error('Seller Hub took too long to respond.')),330000);
    window.postMessage({type:'INVSTO_HOLD_REFRESH',id},location.origin);
   });
   const {error}=await s.client.rpc('refresh_ebay_hold_ledger',{_at:packet.at,_total:packet.total,_count:packet.count,_rows:packet.rows});
   if(error)throw Error('The entries did not pass the account checks or your admin session expired.');
   msg.textContent='Verified: all '+packet.count+' entries matched Seller Hub.';await s.load();
  }catch(e){msg.textContent=(e?.message||'Could not check Seller Hub.')+' The previous verified breakdown is preserved.';}
  finally{clearTimeout(timer);window.removeEventListener('message',listener);button.disabled=false;active=false;}
 }
 function browse(el){
  const {entries}=el.wh,sel=key=>el.querySelector('.wh-'+key),mo=sel('month').value,kind=sel('kind').value,w=sel('week').value,find=sel('find').value.trim().toLowerCase();
  const scope=entries.filter(r=>(!mo||month(r)===mo)&&(!w||week(r.date)===w)&&(!kind||(kind==='reserves'?r.kind!=='sale':r.kind===kind))&&(!find||[r.oid,r.ref,r.item_context?.name,r.item_context?.user,r.item_context?.ship_name,...(r.item_context?.items||[]).flatMap(i=>[i.title,i.number])].some(x=>x?.toLowerCase().includes(find))));
  const reason=sel('reason').value||'all';
  if(window.OGEbayHoldDetails){sel('reason').innerHTML=window.OGEbayHoldDetails.options(scope.map(r=>r.holdInfo),reason,'hold entries');sel('reason').value=reason;}
  const byReason=scope.filter(r=>!window.OGEbayHoldDetails||window.OGEbayHoldDetails.matches(r.holdInfo,reason));
  const releaseDate=sel('date').value||'all';
  if(window.OGEbayHoldDetails){sel('date').innerHTML=window.OGEbayHoldDetails.dateOptions(byReason.map(r=>r.holdInfo),releaseDate);sel('date').value=releaseDate;}
  const dated=byReason.filter(r=>!window.OGEbayHoldDetails||window.OGEbayHoldDetails.matchesDate(r.holdInfo,releaseDate));
  const rows=review()?.filter(el,dated,kind)??dated;
  const pages=Math.max(1,Math.ceil(rows.length/25));el.wh.page=Math.min(pages-1,Math.max(0,el.wh.page));const page=el.wh.page;
  sel('list').innerHTML='<p><b>'+rows.length+(rows.length===1?' entry':' entries')+' · '+usd(sum(rows))+'</b></p>'+rows.slice(page*25,page*25+25).map(r=>'<article><div><b>'+h(kinds[r.kind])+'</b><strong>'+usd(r.cents)+'</strong></div><p>'+(r.oid?link('https://www.ebay.com/sh/ord/details?orderid='+encodeURIComponent(r.oid),'Order '+r.oid):'Order not yet matched')+' · '+(r.date?'Purchased '+date(r.date):'Purchase date unknown')+'</p>'+(review()?.identity(r)||'')+'<small>'+(r.kind==='sale'?'Sale posted ':'Hold placed ')+date(r.placed)+(r.kind==='sale'?'':' · '+link(proof(r),'eBay hold '+r.ref))+'</small>'+(window.OGEbayHoldDetails?.render(r.holdInfo)||'')+(review()?.card(el,r)||'')+'</article>').join('');
  sel('nav').hidden=pages===1;sel('position').textContent='Page '+(page+1)+' of '+pages;sel('prev').disabled=!page;sel('next').disabled=page>=pages-1;
 }
 function update(el,data,client,load){
  if(!el)return;
  const snap=data?.ebay_account_holds;
  if(!snap){el.hidden=true;el.wh=null;el.replaceChildren();return;}
  const selected=data.month.slice(0,7),fresh=!el.wh,entries=(Array.isArray(snap.entries)?snap.entries:[]).map(r=>({...r,holdInfo:holdInfo(r,snap.verified_at)}));
  if(fresh){
   el.innerHTML='<header><small>EBAY PAYMENTS · ALL PURCHASE MONTHS</small><h3>Where the money on hold comes from</h3></header><div class="wh-account"></div><div class="wh-why"></div><div class="wh-cohorts"></div>'+
   '<details class="wh-browser"><summary>Inspect held orders and eBay evidence</summary><div class="ws-controls"><label>Purchase month<select class="wh-month"></select></label><label>Week of purchase<select class="wh-week"></select></label><label>Hold type<select class="wh-kind">'+option('','All hold types')+option('reserves','All separate holds')+Object.entries(kinds).map(([k,v])=>option(k,v)).join('')+'</select></label><label>Hold reason<select class="wh-reason"><option value="all">All hold entries</option></select></label><label>Estimated release date<select class="wh-date"><option value="all">All estimated dates</option></select></label><label>Find an entry<input class="wh-find" type="search" placeholder="Order, return, buyer or item"></label></div>'+(review()?.controls||'')+'<div class="wh-list"></div><div class="wh-nav"><button class="wh-prev" type="button">Previous</button> <span class="wh-position"></span> <button class="wh-next" type="button">Next</button></div></details>'+
   '<footer><button type="button" class="wh-sync">Refresh hold details from eBay</button> '+link(url,'View live holds in Seller Hub')+'<p class="wh-msg" role="status"></p></footer>'+(review()?.dialogHTML||'');
   el.wh={page:0};el.onclick=e=>{
    const b=e.target.closest('button');if(!b)return;
    if(review()?.click(el,b,browse))return;
    if(b.matches('.wh-sync')){refresh(el,el.wh);return;}
    if(b.hasAttribute('data-wh-kind')||b.hasAttribute('data-wh-month')){
     el.querySelector('.wh-kind').value=b.dataset.whKind||'';el.querySelector('.wh-month').value=b.dataset.whMonth||'';
     el.querySelector('.wh-week').value='';el.querySelector('.wh-reason').value='all';el.querySelector('.wh-date').value='all';el.querySelector('.wh-find').value='';el.querySelector('.wh-browser').open=true;el.wh.page=0;el.querySelector('.wh-browser').scrollIntoView({block:'nearest'});
    }else if(b.matches('.wh-prev,.wh-next'))el.wh.page+=b.matches('.wh-next')?1:-1;else return;
    browse(el);
   };el.onchange=e=>{if(e.target.matches('.ws-controls select')){el.wh.page=0;if(e.target.matches('.wh-month'))el.querySelector('.wh-week').value='';if(e.target.matches('.wh-reason'))el.querySelector('.wh-date').value='all';browse(el);}};el.oninput=e=>{if(e.target.matches('.wh-find')){el.wh.page=0;browse(el);}};
  }
  el.hidden=false;Object.assign(el.wh,{entries,client,load,reviews:data.ebay_return_hold_reviews});
  const has=!!snap.verified_at&&Array.isArray(snap.entries),apiNew=snap.api_at&&(!has||Date.parse(snap.api_at)>Date.parse(snap.verified_at)),control=apiNew?snap.api_cents:snap.ledger_cents;
  const gap=has&&control!=null?control-snap.ledger_cents:null,stale=has&&Date.now()-Date.parse(snap.verified_at)>6*3600000;
  const headline=has?snap.ledger_cents:control;
  el.querySelector('.wh-account').innerHTML='<strong>'+(headline==null?'Not yet verified':usd(headline))+'</strong><p>Account-wide funds on hold'+(headline!=null?' · '+(has?'Seller Hub':'eBay Finances')+' · '+stamp(has?snap.verified_at:snap.api_at):'')+'</p>'+
   (has?'<p class="'+(gap||stale?'wh-attention':'wh-reconciled')+'">'+(gap?('eBay Finances reported '+usd(control)+' at '+stamp(snap.api_at)+', '+usd(Math.abs(gap))+' '+(gap>0?'higher':'lower')+' than the itemized Seller Hub list. Refresh hold details before assigning this difference to any order.'):('All '+entries.length+' entries add up to '+usd(snap.ledger_cents)+' in the verified list.'))+' Breakdown checked '+stamp(snap.verified_at)+'.'+(stale?' This breakdown is more than six hours old.':'')+'</p>':'<p>Order-level evidence has not been collected yet.</p>')+(snap.api_error?'<small>'+h(snap.api_error)+'</small>':'');
  const credits=entries.filter(r=>r.kind==='sale'),separate=entries.filter(r=>r.kind!=='sale');
  if(has)el.querySelector('.wh-account').insertAdjacentHTML('beforeend','<p>Of the itemized balance, <b>'+usd(sum(credits))+'</b> comes from original sales. The remaining <b>'+usd(sum(separate))+'</b> comes from '+separate.length+' separate '+(separate.length===1?'hold':'holds')+'.</p>');
  el.querySelector('.wh-why').innerHTML=has?Object.entries(kinds).filter(([k])=>k!=='other'||entries.some(r=>r.kind===k)).map(([k,v])=>{const a=entries.filter(r=>r.kind===k);return '<button type="button" data-wh-kind="'+k+'"><span>'+v+'</span><b>'+usd(sum(a))+'</b><small>'+a.length+' '+(a.length===1?'entry':'entries')+'</small></button>';}).join(''):'';
  const months=[...new Set(entries.map(month))].sort().reverse(),thisMonth=entries.filter(r=>month(r)===selected),sales=thisMonth.filter(r=>r.kind==='sale');
  el.querySelector('.wh-cohorts').innerHTML=has?'<p><b>'+monthLabel(selected)+' purchases: '+usd(sum(thisMonth))+'</b> ('+usd(sum(sales))+' in original sale credits and '+usd(sum(thisMonth)-sum(sales))+' in separate holds). '+usd(sum(entries.filter(r=>month(r)!=='unknown'&&month(r)<selected)))+' belongs to earlier purchases.'+(entries.some(r=>month(r)!=='unknown'&&month(r)>selected)?' Later purchases: '+usd(sum(entries.filter(r=>month(r)!=='unknown'&&month(r)>selected)))+'.':'')+(months.includes('unknown')?' Purchase date unknown: '+usd(sum(entries.filter(r=>month(r)==='unknown')))+'.':'')+'</p><div>'+months.map(m=>'<button type="button" data-wh-month="'+h(m)+'">'+monthLabel(m)+' · '+usd(sum(entries.filter(r=>month(r)===m)))+'</button>').join('')+'</div><small>Holds restrict funds temporarily. They are not an additional deduction from weekly sales.</small>':'';
  for(const [key,values,first,name] of [['month',months,'All months',monthLabel],['week',[...new Set(entries.map(r=>week(r.date)))].sort().reverse(),'All weeks',d=>d==='unknown'?'Purchase week unknown':'Week of '+date(d)]]){
   const sel=el.querySelector('.wh-'+key),old=sel.value;sel.innerHTML=option('',first)+values.map(v=>option(v,name(v))).join('');sel.value=values.includes(old)?old:'';
  }
  if(fresh&&new URLSearchParams(location.search).get('holds')==='return'){
   el.querySelector('.wh-kind').value='return';el.querySelector('.wh-browser').open=true;el.querySelector('.wh-browser').scrollIntoView({block:'start'});
  }
  browse(el);
  if((!has||stale||gap)&&Date.now()>nextAttempt&&!document.hidden)refresh(el,el.wh,true);
 }
 window.WeeklyEbayHolds={update};
})();
