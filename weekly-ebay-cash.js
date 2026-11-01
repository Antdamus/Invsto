(() => {
  'use strict';
  const usd = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'});
  const money = cents => cents == null ? 'Unconfirmed' : usd.format(cents / 100);
  const cents = n => n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n)*100);
  const signed = n => n > 0 ? '+' + money(n) : money(n);
  const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const monthName = day => new Date(day.slice(0,7)+'-01T12:00Z').toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
  const card = (label,value,info) => '<div><span>'+label+'</span><strong>'+value+'</strong><small>'+info+'</small></div>';
  const row = (label,value,bold=false) => '<div'+(bold?' class="wc-subtotal"':'')+'><dt>'+escape(label)+'</dt><dd>'+value+'</dd></div>';

  function orderTotals(data) {
    const rows = data.rows.filter(r => r.market==='ebay');
    const net = rows.every(r=>cents(r.net)!=null) ? rows.reduce((n,r)=>n+cents(r.net),0) : null;
    const statusNet={released:0,held:0,other:0};
    let released=0, held=0, releaseMissing=false, holdMissing=false, netMissing=false;
    for (const order of data.ebay_item_orders) {
      const normalized=window.WeeklyEbayItems.fundsForReport(order);
      const {state,credit,onHold}=normalized;
      if(state==='released'){released+=cents(credit)??0;releaseMissing ||= credit==null;}
      if(state==='held'){held+=cents(onHold)??0;holdMissing ||= onHold==null;}
      const value=cents(order.net_item);
      if(value!=null) statusNet[state==='released'||state==='held'?state:'other']+=value;
      else if(order.booked!=null||!Object.hasOwn(order,'net_item')) netMissing=true;
    }
    return {net,released:releaseMissing?null:released,held:holdMissing?null:held,statusNet,
      split:!netMissing&&net!=null&&Object.values(statusNet).reduce((a,b)=>a+b,0)===net};
  }

  const easternTime=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  function postingComparison(data,sales){
    const proof=data.ebay_posted_orders;
    const lines=data.ebay_cash_statement?.movements;
    if(!Array.isArray(proof)||!Array.isArray(lines)||sales.released==null||sales.held==null)return '';
    const item=lines.find(m=>m.label==='Item sales posted'),shipping=lines.find(m=>m.label==='Shipping paid by buyers');
    if(!item||!shipping)return '';
    const period=data.month.slice(0,7),byId=new Map(proof.map(p=>[p.id,p])),orders=new Map(data.ebay_item_orders.map(o=>[o.id,o]));
    const included=proof.filter(p=>p.day.slice(0,7)===period),netSum=(rows,key)=>rows.reduce((n,p)=>n+p[key],0);
    // Both published posting controls and every purchase-side original credit must match independently.
    if(byId.size!==proof.length||netSum(included,'item')!==item.cents||netSum(included,'shipping')!==shipping.cents||
      proof.some(p=>!['item','shipping','fees','other','credit'].every(k=>Number.isSafeInteger(p[k]))||p.item+p.shipping+p.fees+p.other!==p.credit))return '';
    const bought=[];
    for(const o of orders.values()){
      const p=byId.get(o.id);
      if(!p){if(o.credit==null&&(o.buyer==='unpaid'||o.buyer==='failed'))continue;return '';}
      if(cents(o.credit)!==p.credit)return '';
      bought.push(p);
    }
    const excluded=bought.filter(p=>p.day.slice(0,7)!==period),added=included.filter(p=>!orders.has(p.id));
    const gross=list=>netSum(list,'item')+netSum(list,'shipping'),otherCredits=netSum(bought,'credit')-sales.released-sales.held;
    const fee=-netSum(bought,'fees'),other=-netSum(bought,'other'),posted=item.cents+shipping.cents;
    if(sales.released+sales.held+otherCredits+fee+other-gross(excluded)+gross(added)!==posted)return '';
    function listEvidence(caption,rows){
      if(!rows.length)return '';
      return '<details class="wc-orders-proof"><summary>'+caption+' ('+rows.length+')</summary><ul>'+rows.map(p=>{
        const order=orders.get(p.id);
        const boughtOn=order?'Purchased '+escape(easternTime.format(new Date(order.date))):p.sold?'Seller Hub sale date '+escape(p.sold):'Purchase date unverified';
        return '<li><a href="https://www.ebay.com/mesh/ord/details?orderid='+encodeURIComponent(p.id)+'" target="_blank" rel="noopener">'+escape(p.id)+' ↗</a> · '+money(p.item+p.shipping)+'<small>'+boughtOn+' · Posted '+escape(p.day)+' (Pacific)'+(p.refunded?' · Fully refunded':'')+'</small></li>';
      }).join('')+'</ul></details>';
    }
    return '<details class="wc-postings"><summary>Compare released credits with gross sales posted by eBay</summary>'+
      '<p>Both totals describe original sales. The purchase list uses Eastern dates. Seller Hub uses Pacific posting dates and reports item sales and shipping before fees.</p><dl>'+
      row('Released original credits on the purchase list',money(sales.released),true)+
      row('Include original credits still on hold',signed(sales.held))+(otherCredits?row('Include original credits in other funds statuses',signed(otherCredits)):'')+
      row('Add back fees already deducted from original credits',signed(fee))+(other?row('Remove other net charges or credits to isolate items and shipping',signed(other)):'')+
      (excluded.length?row('Remove '+excluded.length+' purchase-list orders posted outside the month',signed(-gross(excluded))):'')+
      (added.length?row('Include '+added.length+' posted '+(added.length===1?'order':'orders')+' outside the purchase list',signed(gross(added))):'')+
      row('Seller Hub · posted item sales and buyer shipping',money(posted),true)+'</dl>'+
      listEvidence('Purchase-list orders posted outside the month',excluded)+listEvidence('Posted orders outside the purchase list',added)+
      '<small>Checked against '+included.length+' order transactions and both Seller Hub totals: '+money(item.cents)+' in items and '+money(shipping.cents)+' in shipping. <a href="https://www.ebay.com/mes/report-landing" target="_blank" rel="noopener">Open Financial overview ↗</a></small></details>';
  }

  function cashActivity(statement, bank, count) {
    if(!statement) return '<p class="wc-note">A verified financial statement for this month will show the opening balance, refunds, claims, fees, financing repayments, and the funds carried forward.</p>';
    const lines=statement.movements;
    const opening=Number(statement.opening), closing=Number(statement.closing);
    if(!Array.isArray(lines)||!lines.every(m=>Number.isSafeInteger(m.cents))||
       opening+lines.reduce((a,m)=>a+m.cents,0)!==closing) return '<p>Statement amounts need verification.</p>';
    const financing=lines.find(m=>/financing repayments|secondary payouts/i.test(m.label));
    const payout=lines.find(m=>m.label==='Payouts');
    const fee=statement.bank_fee==null?null:Number(statement.bank_fee);
    const canSplit=payout&&bank!=null&&fee!=null&&-payout.cents===bank+fee;
    const source=statement.source==='eBay monthly financial statement'?'eBay monthly financial statement':'eBay Financial overview and the prior month’s closing statement';
    const groups=lines.filter(m=>/refund|claim|dispute/i.test(m.label)).reduce((n,m)=>n+m.cents,0);
    const verifiedBalance=statement.observed_at&&statement.observed_held!=null&&statement.observed_available!=null&&
      Number(statement.observed_held)+Number(statement.observed_available)===closing;
    const observation=verifiedBalance?'<p class="wc-balance-proof">Seller Hub showed <b>'+money(statement.observed_held)+'</b> on hold across all purchase months and <b>'+money(statement.observed_available)+'</b> available on '+escape(new Date(statement.observed_at).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'}))+'. Together they equal the closing funds.</p>':'';
    const trace=row('Opening eBay funds carried from the prior month',money(opening),true)+lines.filter(m=>m.cents||m.label==='Payouts').map(m=>{
        if(m===payout&&canSplit)return row('Sent to your bank · '+count+' payouts',signed(-bank))+(fee?row('Express payout fees',signed(-fee)):'');
        if(window.WeeklyEbayClaims&&/^(gross claims|claims)$/i.test(m.label))return row(m.label,'<button type="button" class="wcl-jump" data-show-claims>'+signed(m.cents)+' · View claims ↑</button>');
        return row(m.label,signed(m.cents));
      }).join('')+row('Closing eBay funds',money(closing),true);
    return '<p class="wc-note">The account opened with <b>'+money(opening)+'</b>. Refunds, claims and disputes totaled <b>'+money(groups)+'</b>. '+
      (financing&&financing.cents<0?'eBay also sent <b>'+money(-financing.cents)+'</b> in '+(statement.source==='eBay Seller Hub financial overview'?'financing repayments':'secondary payouts')+(/Liberis/i.test(financing.label)?' to Liberis':'')+'. ':'')+
      'After payouts and other activity, <b>'+money(closing)+'</b> carried forward.</p>'+observation+
      '<details class="wc-ledger"><summary>Account statement · from '+money(opening)+' opening funds to '+money(closing)+' closing funds</summary>'+
      '<dl>'+trace+'</dl><small>'+escape(source)+'. All account activity posted during this calendar month, Pacific time.</small></details>';
  }

  function update(host,data,client,refresh) {
    if(!host)return;
    if(!Array.isArray(data?.ebay_item_orders)){host.hidden=true;host.replaceChildren();return;}
    const period=data.month.slice(0,7), name=monthName(period), sales=orderTotals(data), batches=data.ebay_account_payouts;
    const bank=Array.isArray(batches)&&batches.length&&batches.every(p=>cents(p.amount)!=null)?batches.reduce((n,p)=>n+cents(p.amount),0):null;
    const batchIds=new Set((batches||[]).map(p=>p.id));
    const matched=new Set();
    for(const order of data.ebay_item_orders)for(const receipt of order.payouts||[])if(receipt.status==='SUCCEEDED'&&batchIds.has(receipt.id))matched.add(receipt.id);
    if(host.dataset.month!==period||!host.querySelector('.wc-body')){
      host.innerHTML='<header><span class="wi-eyebrow">EBAY · MONTHLY CASH</span><h3>From item sales to your bank</h3></header><div class="wc-body"></div>'+
        '<details class="wc-sources"><summary>Sources and monthly statements</summary><p><a href="https://www.ebay.com/mes/report-landing" target="_blank" rel="noopener">Financial overview ↗</a> · <a href="https://www.ebay.com/mes/payouts" target="_blank" rel="noopener">Bank payouts ↗</a> · <a href="https://www.ebay.com/mes/transaction-reports?sh=true&amp;q=statement" target="_blank" rel="noopener">Monthly statements ↗</a></p>'+
        '<label>Import the eBay financial statement for this month <input type="file" accept="application/pdf,.pdf"></label><small>Invsto saves the reconciled monthly totals from OG Jewelers’ statement.</small><p class="wc-message" role="status"></p>'+
        '<label>Import itemized claims for this month <input class="wcl-file" type="file" accept=".csv,text/csv"></label><small>Use OG Jewelers’ <a href="https://www.ebay.com/mes/transaction-reports?q=payment-transaction-report&amp;sh=true" target="_blank" rel="noopener">Seller Hub transaction CSV ↗</a> covering the full month. Only Claim entries are saved, after they match the statement.</small><p class="wcl-message" role="status"></p></details>';
      host.dataset.month=period;
      delete host.dataset.claimFilter;delete host.dataset.claimDeepLink;
      host.onclick=e=>{
        const filter=e.target.closest('[data-filter]'),section=host.querySelector('.wcl-panel');
        if(filter&&section){host.dataset.claimFilter=filter.dataset.filter;window.WeeklyEbayClaims.choose(section,filter.dataset.filter);section.querySelector('.wcl-list').open=true;}
        if(e.target.closest('[data-show-claims]')&&section){const list=section.querySelector('.wcl-list');if(list)list.open=true;section.focus({preventScroll:true});section.scrollIntoView({block:'start'});}
      };
      host.querySelector('.wcl-file').onchange=async event=>{
        const input=event.target,file=input.files[0],msg=host.querySelector('.wcl-message');
        if(!file)return;input.disabled=true;msg.textContent='Checking claim postings against the monthly statement…';
        try{
          if(file.size>40*1024*1024)throw Error('Choose a transaction export under 40 MB.');
          const entries=window.WeeklyEbayClaims.parseExport(await file.text(),period);
          const {error}=await client.rpc('save_ebay_claim_export',{_month:period+'-01',_entries:entries});
          if(error)throw Error(error.message||'Could not verify this export.');
          msg.textContent=entries.length+' claim postings saved and reconciled.';await refresh();
        }catch(e){msg.textContent=e.message||'Could not read the claim export.';}finally{input.disabled=false;input.value='';}
      };
      host.querySelector('input').onchange=async event=>{
        const input=event.target,file=input.files[0],msg=host.querySelector('.wc-message');
        if(!file)return;
        input.disabled=true;msg.textContent='Checking statement amounts…';
        try{
          const result=await readStatement(file,period);
          const {error}=await client.rpc('save_ebay_cash_statement',result);
          if(error)throw Error('Invsto could not save this statement. Check your admin access and try again.');
          msg.textContent='Statement saved. Its entries reconcile to the closing balance.';await refresh();
        }catch(e){msg.textContent=e.message||'Could not verify the statement.';}
        finally{input.disabled=false;input.value='';}
      };
    }
    const body=host.querySelector('.wc-body'),expanded=new Set([...body.querySelectorAll('details[open]')].map(d=>d.dataset.state||d.querySelector('summary').textContent));
    host.hidden=false;
    const split=sales.split?'Of these net item sales, <b>'+money(sales.statusNet.held)+'</b> belongs to orders with held credits and <b>'+money(sales.statusNet.released)+'</b> to orders with released credits.'+(sales.statusNet.other?' Another <b>'+money(sales.statusNet.other)+'</b> is on orders with other or mixed statuses.':''):'The order-level split of net sales by funds status is still under verification.';
    body.innerHTML='<p>Orders purchased in '+name+' and cash transferred in '+name+' follow different dates.</p><div class="wc-cards">'+
      card('Net item sales',money(sales.net),'Merchandise kept after reversals, before fees.')+
      card('Original credits released',money(sales.released),'For these purchases. Includes buyer shipping and sale fees, before later debits.')+
      card('Original credits on hold',money(sales.held),'For orders classified on hold. Mixed orders appear under other funds statuses.')+
      card('Sent to your bank',bank==null?'No verified total':money(bank),Array.isArray(batches)&&batches.length?batches.length+' recorded transfers by payout date, from the whole account.':'No successful transfers recorded for this period.')+'</div>'+
      (window.WeeklyEbayClaims?.render(data)||'')+
      '<p class="wc-explain">'+split+' eBay pays from the shared seller balance, which can include earlier sales. Refunds, expenses and financing repayments also affect how much reaches the bank.</p>'+
      cashActivity(data.ebay_cash_statement,bank,batches?.length||0)+postingComparison(data,sales)+
      '<small class="wc-matching">'+(batchIds.size?(matched.size?matched.size+' of '+batchIds.size+' bank transfers have a saved payout ID linked to an order purchased this month.':'The saved payout records for these '+batchIds.size+' transfers do not identify any of this month’s orders by payout ID.'):'')+'</small>';
    for(const detail of body.querySelectorAll('details'))detail.open=expanded.has(detail.dataset.state||detail.querySelector('summary').textContent)||(detail.classList.contains('wcl-list')&&detail.open&&!host.dataset.claimDeepLink);
    const claims=body.querySelector('.wcl-panel');
    if(claims){if(claims.querySelector('.wcl-list')&&!host.dataset.claimDeepLink&&new URLSearchParams(location.search).get('view')==='claims')claims.scrollIntoView({block:'start'});
      host.dataset.claimDeepLink='1';window.WeeklyEbayClaims.choose(claims,host.dataset.claimFilter||'all');}
  }

  let loadingPdf;
  async function readStatement(file,period) {
    if(file.size>12*1024*1024)throw Error('Choose the monthly statement summary PDF.');
    if(!window.pdfjsLib){
      loadingPdf??=new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='pdf.min.js';script.onload=resolve;
        script.onerror=()=>{loadingPdf=null;reject(Error('Could not load the statement reader. Try again.'));};document.head.append(script);
      });
      await loadingPdf;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc='pdf.worker.min.js';
    const doc=await window.pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false}).promise;
    try{
      const page=await doc.getPage(1),content=await page.getTextContent();
      return parseStatement(content.items.map(i=>i.str).join(' '),period);
    }finally{await doc.destroy();}
  }
  function parseStatement(text,period){
    const s=text.replace(/[\s\u00a0]+/g,' ').trim();
    const dates=s.match(/date range:\s*(\d{1,2})\/1\/(\d{2,4})\s+12:00 AM\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+11:59 PM/i);
    if(!/financial statement/i.test(s)||!/eBay username\s+ogjewelers\b/i.test(s)||!dates)throw Error('Choose OG Jewelers’ eBay monthly financial statement summary.');
    const year=Number(dates[2].length===2?'20'+dates[2]:dates[2]),month=Number(dates[1]);
    if(period!==year+'-'+String(month).padStart(2,'0')||month!==Number(dates[3])||dates[2]!==dates[5]||Number(dates[4])!==new Date(Date.UTC(year,month,0)).getUTCDate())throw Error('The statement dates do not match the selected month.');
    const summary=s.split(/Transactions summary/i).pop(), pattern=/([^$]*?)\s*([-−]?\s*\$[\d,]+\.\d{2})/g,entries=[];
    let opening=null,closing=null;
    for(const match of summary.matchAll(pattern)){
      const label=match[1].replace(/\s*\([^)]*\)\s*/g,' ').trim(),value=Number(match[2].replace(/[$,\s]/g,'').replace('−','-').replace('.',''));
      if(/^Opening funds$/i.test(label)){opening=value;continue;}
      if(/^Closing funds$/i.test(label)){closing=value;break;}
      if(opening!=null&&label)entries.push({label,cents:value});
    }
    if(opening==null||closing==null||entries.length===0||opening+entries.reduce((n,m)=>n+m.cents,0)!==closing)throw Error('The statement totals could not be reconciled.');
    return {_month:period+'-01',_opening:opening,_closing:closing,_movements:entries};
  }
  window.WeeklyEbayCash={update,parseStatement};
})();
