(function(root){
  'use strict';
  const buyer=root.OGBuyerReport||(typeof require==='function'?require('./ebay-buyer-report.js'):null);
  const refunds=root.OGBuyerRefundReport||(typeof require==='function'?require('./buyer-report-refunds.js'):null);
  const html=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const open=line=>['pending','partially_fulfilled'].includes(String(line.line_status||'').toLowerCase());
  const key=v=>String(v||'').trim().toLowerCase();
  const unique=rows=>[...new Map(rows.map(row=>[row.id,row])).values()];
  const POLICY_URL='https://pages.ebay.com/payment/2.0/terms.html';
  const NOTICE='Resolve missing items promptly so orders can ship. Late deliveries and increased buyer claims can lead to eBay payout holds. This is a risk reminder, not confirmation that the seller account is on hold.';
  const NOTES='Customer statistics cover all saved purchases for each exact eBay username, including closed orders. Confirmed refunds are counted once per order; partial refunds are included in total refunds, not added again. Requests and pending refunds are not deducted. Missing or inconsistent amounts leave net spending unconfirmed. Order totals include recorded shipping and tax; missing-item values use original item amounts. Deadlines show Eastern time first and the equivalent eBay Pacific time, including the date in each zone. Due-today and due-tomorrow labels follow the eBay Pacific shipping calendar. Purchases and report preparation use Eastern time. This is a saved-record snapshot; regenerate after updates.';
  const money=(value,currency='USD')=>value==null?'Not recorded':new Intl.NumberFormat('en-US',{style:'currency',currency}).format(value);
  const date=(value,zone='America/New_York')=>value!=null&&value!==''&&Number.isFinite(new Date(value).getTime())?new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)):'Not recorded';
  const day=(value,zone='America/Los_Angeles')=>{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
    return ['year','month','day'].map(t=>parts.find(p=>p.type===t).value).join('-');
  };
  function importedDay(value){
    const s=String(value||'').trim(),m=s.match(/^([A-Za-z]{3})-(\d{1,2})-(\d{2,4})$/),n=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    let y,mo,d;
    if(m){y=Number(m[3]);if(y<100)y+=2000;mo=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase());d=Number(m[2]);}
    else if(n){y=Number(n[3]);mo=Number(n[1])-1;d=Number(n[2]);}
    else if(/^\d{4}-\d{2}-\d{2}$/.test(s)){[y,mo,d]=s.split('-').map(Number);mo--;}
    else return '';
    const parsed=new Date(Date.UTC(y,mo,d,12));
    return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===mo&&parsed.getUTCDate()===d?parsed.toISOString():'';
  }
  function pacificMidnight(isoDay){
    const target=Date.parse(`${isoDay}T00:00:00Z`);let time=target+8*3600000;
    for(let i=0;i<3;i++){
      const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time));
      const v=t=>Number(p.find(x=>x.type===t).value);
      time+=target-Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'),v('second'));
    }
    return time;
  }
  function elapsed(ms){
    const minutes=Math.max(0,Math.floor(ms/60000)),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
    if(days)return `${days} day${days===1?'':'s'}${hours?` ${hours} hour${hours===1?'':'s'}`:''}`;
    if(hours)return `${hours} hour${hours===1?'':'s'}${minutes%60?` ${minutes%60} min`:''}`;
    return minutes?`${minutes} min`:'less than a minute';
  }
  function deadline(order,now=new Date()){
    const value=order.ship_by_date,instant=Date.parse(value);
    if(!value||!Number.isFinite(instant))return {level:'unknown',label:'Deadline not recorded',sort:Infinity,due:'Not recorded',since:'',age:''};
    const raw=order.raw_payload||{},precision=raw.date_precision?.ship_by_date;
    const csv=Object.entries(raw.first_row||{}).find(([k])=>k.trim().toLowerCase()==='ship by date')?.[1];
    const dateOnly=precision==='day'||precision!=='timestamp'&&(!!importedDay(value)||importedDay(csv)===new Date(instant).toISOString());
    const shipDay=day(instant,dateOnly?'UTC':'America/Los_Angeles'),today=day(now),tomorrow=new Date(`${today}T12:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
    const nextDay=new Date(`${shipDay}T12:00:00Z`);nextDay.setUTCDate(nextDay.getUTCDate()+1);
    const cutoff=dateOnly?pacificMidnight(nextDay.toISOString().slice(0,10)):instant;
    const overdue=dateOnly?Number(now)>=cutoff:Number(now)>cutoff;
    const level=overdue?'overdue':shipDay===today?'today':shipDay===tomorrow.toISOString().slice(0,10)?'tomorrow':'upcoming';
    const dueEastern=dateOnly?`Before ${date(cutoff)}`:date(instant);
    const duePacific=dateOnly?`${new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(`${shipDay}T12:00:00Z`))} - end of eBay Pacific day`:date(instant,'America/Los_Angeles');
    const bothZones=(eastern,pacific)=>`Eastern (your time): ${eastern}\nPacific (eBay): ${pacific}`;
    return {level,label:{overdue:'Overdue',today:'Due today',tomorrow:'Due tomorrow',upcoming:'Upcoming'}[level],sort:cutoff,
      dueEastern,duePacific,due:bothZones(dueEastern,duePacific),
      since:overdue?bothZones(date(cutoff),date(cutoff,'America/Los_Angeles')):'',age:overdue?elapsed(Number(now)-cutoff):'',dateOnly};
  }
  async function loadQueue(client){
    const rows=[];
    for(let offset=0;;offset+=1000){
      const {data,error}=await client.rpc('list_pending_ebay_order_queue_v2',{_status:'pending',_include_admin_fields:false,_limit:1000,_offset:offset});
      if(error)throw new Error(error.message||'Could not load the pending queue.');
      rows.push(...(data||[]));if(!data||data.length<1000)break;
    }
    const pending=unique(rows).filter(open),holds=[];
    for(let i=0;i<pending.length;i+=250){
      for(let offset=0;;offset+=500){
        const {data,error}=await client.rpc('list_pending_order_work',{_line_ids:pending.slice(i,i+250).map(r=>r.id)}).range(offset,offset+499);
        if(error)throw new Error(error.message||'Could not verify missing-watch markers.');
        holds.push(...(data||[]));if(!data||data.length<500)break;
      }
    }
    const missing=new Map();
    for(const hold of unique(holds).filter(h=>h.active&&h.kind==='watch_missing'))for(const id of hold.line_ids||[])missing.set(id,hold);
    return pending.map(row=>({...row,missingWatch:missing.get(row.id)}));
  }
  function selectMissing(queue,scope='all'){
    return unique(queue).filter(open).filter(r=>scope==='not-found'?r.item_search?.is_missing===true:scope==='watches'?!!r.missingWatch:r.item_search?.is_missing===true||r.missingWatch);
  }
  function breakdown(financial,label){
    const orders=financial.orders.filter(o=>!o.unknown&&o.label===label),totals=new Map();
    for(const o of orders)totals.set(o.gross.currency,(totals.get(o.gross.currency)||0)+o.refundCents);
    return {count:orders.length,amount:[...totals].map(([c,v])=>money(v/100,c)).join(' + ')||'None recorded'};
  }
  function missingAge(markedAt,now){
    const timestamp=Date.parse(markedAt);
    if(!Number.isFinite(timestamp))return 'Not recorded';
    return timestamp>Number(now)?'Date needs verification':elapsed(Number(now)-timestamp);
  }
  function timeline(order,markedAt,due,now,markedBy='Not recorded'){
    return [
      {label:'Purchased',text:buyer.purchaseDate(order),at:Date.parse(order.sale_date),tone:'normal'},
      {label:'Marked missing',text:`${date(markedAt)}\nMarked by: ${markedBy}`,at:Date.parse(markedAt),tone:'missing'},
      {label:'Shipping deadline',text:due.due,at:due.sort,tone:due.level},
      {label:due.level==='overdue'?`Still missing / ${due.age} overdue`:'Report snapshot / still missing',text:date(now),at:Number(now),tone:due.level==='overdue'?'overdue':'normal'},
    ].filter(e=>Number.isFinite(e.at)).sort((a,b)=>a.at-b.at);
  }
  function itemNotes(records,lineId){
    return (records.events||[]).filter(e=>{
      const p=e.payload||{},ids=[...(Array.isArray(p.order_line_ids)?p.order_line_ids:[]),p.order_line_id].filter(Boolean);
      if(!(ids.length?ids:e.order_line_ids||[]).includes(lineId)||e.task_metadata?.history_removed_at)return false;
      if((p.source||e.task_metadata?.source)!=='pending_order_line_note'||e.action&&e.action!=='commented'||!e.notes?.trim())return false;
      if(e.photo_attachments?.length)return e.photo_attachments.every(p=>p.metadata?.source==='pending_order_line_note'||p.source_path==='manual-line-note'||String(p.path||'').startsWith('line-notes/'));
      return !/^(?:Video receipt screenshot uploaded for eBay item [^\n]+\.\n|(?:Video|Photo) evidence added manually for (?:eBay item [^\n]+|the full order)\.\n)/.test(e.notes);
    }).sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0)||String(b.id||'').localeCompare(String(a.id||'')))
      .filter((e,i,all)=>!e.id||all.findIndex(n=>n.id===e.id)===i)
      .map(e=>({id:e.id,text:e.notes,author:String(e.signed_by_email||'').trim()||'Author not recorded',createdAt:e.created_at||null,date:date(e.created_at)}));
  }
  const latestNote=(records,lineId)=>itemNotes(records,lineId)[0]?.text||'';
  function directoryUrgency(c){
    const oldest=c.rows.filter(r=>r.deadline.level==='overdue').sort((a,b)=>a.deadline.sort-b.deadline.sort)[0];
    return oldest?{level:'overdue',label:'Oldest overdue',value:oldest.deadline.age}:
      {level:c.rows[0]?.deadline.level||'unknown',label:'Next shipping deadline',value:c.rows[0]?.deadline.label||'Deadline not recorded'};
  }
  function makeCustomer(username,records,queue,baseUrl,now){
    const financial=refunds.model(records),missing=new Map(queue.map(q=>[q.id,q]));
    const customerName=[...queue,...records.orders].map(q=>String(q.buyer_name||'').trim()).find(Boolean)||'';
    const all=buyer.buildRows(records,baseUrl),lineMap=new Map(records.lines.map(l=>[l.id,l]));
    const orderMap=new Map(records.orders.map(o=>[o.id,o]));
    for(const q of queue)if(!lineMap.has(q.id)||!orderMap.has(q.order_id))throw new Error(`Order ${q.order_number}: item details could not be loaded. Refresh the report.`);
    const rows=all.filter(r=>missing.has(r.id)&&open(lineMap.get(r.id))).map(row=>{
      const q=missing.get(row.id),order=orderMap.get(row.orderId),marker=q.item_search?.is_missing?q.item_search:null;
      const pendingUrl=new URL('pending-orders.html',baseUrl);pendingUrl.searchParams.set('orderId',row.orderNumber);
      const due=deadline(order,now),markedAt=marker?marker.updated_at:q.missingWatch?.created_at;
      const markedBy=String((marker?marker.updated_by_email:q.missingWatch?.created_by_email)||'').trim()||'Not recorded';
      const notes=itemNotes(records,row.id),savedNote=q.latest_line_note;
      const fallbackNote=(typeof savedNote==='string'?savedNote:savedNote?.notes||savedNote?.note)||q.missingWatch?.reason||'';
      if(!notes.length&&fallbackNote)notes.push({text:fallbackNote,author:savedNote?.signed_by_email||'Author not recorded',createdAt:savedNote?.created_at||null,date:date(savedNote?.created_at)});
      return {...row,customerName:String(order.buyer_name||q.buyer_name||'').trim()||customerName,deadline:due,timeline:timeline(order,markedAt,due,now,markedBy),pendingUrl:pendingUrl.href,
        missingReason:[marker?'Item marked not found':'',q.missingWatch?'Watch marked missing':''].filter(Boolean).join(' / '),
        markedAt:date(markedAt),markedBy,missingAge:missingAge(markedAt,now),
        notes,note:notes[0]?.text||'',
        ebayStatus:[q.ebay_payment_status&&`Payment: ${q.ebay_payment_status}`,q.ebay_fulfillment_status&&`Fulfillment: ${q.ebay_fulfillment_status}`,q.ebay_cancel_status&&q.ebay_cancel_status!=='NONE'&&`Cancellation: ${q.ebay_cancel_status}`].filter(Boolean).join(' | ')||'Not recorded'};
    }).sort((a,b)=>a.deadline.sort-b.deadline.sort||a.orderNumber.localeCompare(b.orderNumber));
    const historyUrl=new URL('ebay-buyer-report.html',baseUrl);historyUrl.searchParams.set('buyer',username);
    const dates=records.orders.filter(o=>o.sale_date).sort((a,b)=>a.sale_date.localeCompare(b.sale_date));
    return {username,name:customerName,rows,financial,
      orderCount:records.orders.length,itemCount:records.lines.length,openOrders:new Set(records.lines.filter(open).map(l=>l.order_id)).size,
      full:breakdown(financial,'Full refund completed'),partial:breakdown(financial,'Partial refund completed'),
      firstPurchase:dates.length?buyer.purchaseDate(dates[0]):'Not recorded',lastPurchase:dates.length?buyer.purchaseDate(dates.at(-1)):'Not recorded',
      historyUrl:historyUrl.href,missingValue:buyer.totalsFor(rows)||'Not recorded'};
  }
  function makeReport(customers,scope,preparedAt){
    customers=customers.filter(c=>c.rows.length).sort((a,b)=>a.rows[0].deadline.sort-b.rows[0].deadline.sort||a.username.localeCompare(b.username));
    const rows=customers.flatMap(c=>c.rows),count=level=>rows.filter(r=>r.deadline.level===level).length;
    return {customers,rows,scope,preparedAt,date:date(preparedAt),count:rows.length,orders:new Set(rows.map(r=>r.orderId)).size,
      overdue:count('overdue'),today:count('today'),tomorrow:count('tomorrow'),unknown:count('unknown'),missingValue:buyer.totalsFor(rows)||'Not recorded'};
  }
  async function load(client,scope,baseUrl,progress=()=>{}){
    progress('Checking current missing items and shipping deadlines...');
    const queue=selectMissing(await loadQueue(client),scope),preparedAt=new Date().toISOString(),names=[...new Set(queue.map(q=>key(q.buyer_username)))];
    if(names.includes(''))throw new Error('A missing item has no saved eBay username. Add the buyer to the order before generating customer statistics.');
    const customers=[];
    for(const name of names){
      const lines=queue.filter(q=>key(q.buyer_username)===name);
      progress(`Preparing customer ${customers.length+1} of ${names.length}: ${name}...`);
      const records=await buyer.loadRecords(client,name,()=>{},{evidenceLineIds:lines.map(l=>l.id)});
      const customer=makeCustomer(name,records,lines,baseUrl,new Date(preparedAt));
      await buyer.loadImages(client,customer.rows,progress,{allImages:true});customers.push(customer);
    }
    return makeReport(customers,scope,preparedAt);
  }
  function stats(c){return [
    ['Total purchases',refunds.totalText(c.financial,'gross'),`${c.orderCount} orders / ${c.itemCount} item lines`],
    ['Total refunds',refunds.totalText(c.financial,'refunds'),`${c.financial.refundedOrders} orders with confirmed refunds`],
    ['Net spent',refunds.totalText(c.financial,'net'),'After confirmed refunds'],
    ['Full refunds',c.full.amount,`${c.full.count} fully refunded orders`],
    ['Partial refunds',c.partial.amount,`${c.partial.count} orders / included in total refunds`],
    ['Requests / pending',String(c.financial.requestedOrders),'Orders / not deducted from spending'],
  ];}
  function screenshots(row){
    return Array.isArray(row.screenshots)?row.screenshots:row.image?[{image:row.image,review:row.review||'',createdAt:''}]:[];
  }
  function screenshotFigure(row,shot,index,total){
    return `<figure class="evidence-shot${shot.image?'':' evidence-unavailable'}">${shot.image?`<img src="${html(shot.image.crop)}" alt="Screenshot ${index+1} of ${total}: ${html(row.title)}" loading="lazy">`:`<div class="image-placeholder"><span>SCREENSHOT UNAVAILABLE</span><p>${html(shot.status)}</p><a href="${html(row.historyUrl)}" target="_blank" rel="noopener">Open system record ↗</a></div>`}<figcaption><strong>Screenshot ${index+1} of ${total}</strong><span>${shot.createdAt?`Saved ${html(date(shot.createdAt))}`:'Saved item evidence · verify against the title'}</span>${shot.review?`<p class="evidence-review">${html(shot.review)}</p>`:''}</figcaption></figure>`;
  }
  function primaryEvidence(row){
    const shots=screenshots(row);
    return shots.length?screenshotFigure(row,shots[0],0,shots.length):`<div class="image-placeholder"><span>ITEM EVIDENCE</span><p>${html(row.imageStatus)}</p><a data-report-receipt="${html(row.id)}" href="${html(buyer.receiptAction(row).href)}" target="_blank" rel="noopener">${html(buyer.receiptAction(row).label)} ↗</a></div>`;
  }
  function additionalEvidence(row){
    const shots=screenshots(row);
    return shots.length>1?`<section class="evidence-gallery" aria-label="Additional screenshots for ${html(row.title)}"><header><div class="eyebrow">ITEM EVIDENCE / ${shots.length} SAVED SCREENSHOTS</div><h4>More views of this item</h4><p>All saved screenshots matched to this order line, newest first.</p></header><div class="evidence-grid">${shots.slice(1).map((shot,i)=>screenshotFigure(row,shot,i+1,shots.length)).join('')}</div></section>`:'';
  }
  function render(model){
    return `<header class="report-hero"><div class="eyebrow">OG JEWELERS / FULFILLMENT PRIORITIES</div><h1>Missing items.<br><em>Every detail, in one place.</em></h1><p>Customer history, item evidence and shipping deadlines.</p><div class="edition">Prepared ${html(model.date)}<br>Scope: ${html({all:'All marked missing items',watches:'Missing watches','not-found':'Items marked not found'}[model.scope])}</div></header>
      <div class="missing-total"><div><span>Total value of missing items</span><strong>${html(model.missingValue)}</strong></div><p>Original item prices for the missing lines in this report.<br>Excludes shipping and tax.</p></div>
      <div class="overview"><div><strong>${model.count}</strong><span>Missing item lines</span></div><div><strong>${model.customers.length}</strong><span>Customers</span></div><div class="is-overdue"><strong>${model.overdue}</strong><span>Overdue lines</span></div><div class="is-today"><strong>${model.today}</strong><span>Due today</span></div></div>
      <aside class="urgency-notice"><strong>Shipping needs attention</strong><p>${NOTICE}</p><a href="${POLICY_URL}" target="_blank" rel="noopener">eBay payment-hold policy</a></aside>
      <div class="section-title"><span>01 / AT A GLANCE</span><h2>The missing-item queue</h2><p>${model.orders} orders affected · Original missing-item value: ${html(model.missingValue)}${model.unknown?` · ${model.unknown} deadlines need verification`:''}</p></div>
      <nav class="customer-index" id="customer-directory" aria-label="Customers in this report">${model.customers.map((c,i)=>{const urgency=directoryUrgency(c);return `<a href="#customer-${i}"><span class="index-number">${String(i+1).padStart(2,'0')}</span><span class="index-customer"><strong>${html(c.name||'Customer name not recorded')}</strong><small>eBay: ${html(c.username)}</small><small>${c.rows.length} missing ${c.rows.length===1?'line':'lines'}</small></span><span class="index-value"><small>Missing-item value</small><strong>${html(c.missingValue)}</strong></span><span class="index-urgency ${urgency.level}"><small>${html(urgency.label)}</small><strong>${html(urgency.value)}</strong></span></a>`;}).join('')}</nav>
      ${model.customers.map((c,i)=>`<section class="customer-section" id="customer-${i}"><header class="customer-heading"><div><div class="eyebrow">CUSTOMER ${String(i+1).padStart(2,'0')} / ${model.customers.length}</div><h2>${html(c.name||'Customer name not recorded')}</h2><p>eBay: ${html(c.username)} · ${c.rows.length} missing ${c.rows.length===1?'line':'lines'} · ${c.openOrders} open orders</p></div><a class="outline-link" href="${html(c.historyUrl)}" target="_blank" rel="noopener">Full buyer report ↗</a></header>
        <div class="customer-stats">${stats(c).map(([label,value,note])=>`<div><small>${label}</small><strong>${html(value)}</strong><span>${html(note)}</span></div>`).join('')}</div>
        <div class="customer-history"><span><b>First purchase</b> ${html(c.firstPurchase)}</span><span><b>Most recent purchase</b> ${html(c.lastPurchase)}</span></div>
        ${c.financial.unverifiedOrders||c.financial.unmatched.length?`<p class="verification">Financial verification needed: ${c.financial.unverifiedOrders} orders with uncertain refund amounts; ${c.financial.unmatched.length} unmatched cases. Net spent may be unconfirmed.</p>`:''}
        <p class="timing-note">${html(refunds.timingText(c.financial))}</p>
        <h3 class="item-index-heading">Missing item index</h3><nav class="missing-item-index" aria-label="Missing items for ${html(c.name||c.username)}">${c.rows.map((r,j)=>`<a href="#missing-item-${html(r.id)}" class="${r.deadline.level}"><span><strong>${j+1}. ${html(r.title)}</strong><small>Order ${html(r.orderNumber)}</small></span><span><small>Original item amount</small><strong class="index-item-price">${html(money(r.price.total,r.price.currency))}</strong><small>Qty ${r.price.quantity}</small></span><span class="index-shipping"><small>${r.deadline.level==='overdue'?'Overdue for':'Shipping status'}</small><strong class="index-item-deadline">${html(r.deadline.level==='overdue'?r.deadline.age:r.deadline.label)}</strong></span></a>`).join('')}</nav>
        ${c.rows.map((r,j)=>`<article class="missing-item ${r.deadline.level}" id="missing-item-${html(r.id)}"><div class="item-heading"><div><strong class="item-customer">${html(r.customerName||c.name||'Customer name not recorded')}</strong><span class="item-owner">eBay: ${html(c.username)}</span><span>ITEM ${j+1} / ORDER ${html(r.orderNumber)}</span></div><span class="pill ${r.deadline.level}">${html(r.deadline.label)}</span></div>
          <div class="deadline-banner"><strong>${r.deadline.level==='overdue'?`Overdue for ${html(r.deadline.age)}`:html(r.deadline.label)}</strong><span>${r.deadline.since?`Overdue since ${html(r.deadline.since)}`:`Ship by ${html(r.deadline.due)}`}</span></div>
          <div class="item-body"><div class="item-image">${primaryEvidence(r)}</div>
          <div class="item-details"><div class="eyebrow">ORIGINAL PURCHASE</div><h3>${html(r.title)}</h3><p class="item-price">${html(money(r.price.total,r.price.currency))}<small>Qty ${r.price.quantity} · original item amount</small></p><ol class="item-timeline" aria-label="Item timeline">${r.timeline.map(e=>`<li class="${e.tone}"><b>${html(e.label)}</b><span>${html(e.text)}</span></li>`).join('')}</ol><dl><dt>Missing marker</dt><dd>${html(r.markedBy)}<small>${html(r.markedAt)}</small></dd><dt>eBay item</dt><dd>${html(r.item||'Not recorded')}</dd><dt>Saved eBay status</dt><dd>${html(r.ebayStatus)}</dd></dl></div></div>
          ${additionalEvidence(r)}
          ${r.groups.length?`<div class="item-note"><b>Grouped order context</b>${r.groups.map(g=>`<p>${html(g)}</p>`).join('')}</div>`:''}
          ${r.notes.length?`<div class="item-note"><b>Item notes · newest first</b>${r.notes.map(n=>`<div class="item-note-entry"><strong>${html(n.author)}</strong><small>${html(n.date)}${n.date!=='Not recorded'?' · Eastern time':' · Date/time not recorded'}</small><p>${html(n.text)}</p></div>`).join('')}</div>`:''}
          <details class="refund-context"${r.refund?.refundSignal||r.refund?.requests.length?' open':''}><summary>${html(r.refund?.label||'Refund status not recorded')}</summary>${refunds.detailLines(r.refund).map(s=>`<p>${html(s)}</p>`).join('')}${(r.refund?.requests||[]).map(q=>`<a href="${html(q.url)}" target="_blank" rel="noopener">Review case ${html(q.caseNumber)}</a>`).join(' ')}</details>
          <nav class="item-navigation" aria-label="Report navigation"><a href="#customer-directory">↑ Customer directory</a><a href="#customer-${i}">↑ Customer profile</a></nav>
          <div class="item-links"><a href="${html(r.orderUrl)}" target="_blank" rel="noopener">eBay order ↗</a><a href="${html(r.pendingUrl)}" target="_blank" rel="noopener">Pending order ↗</a><a href="${html(r.historyUrl)}" target="_blank" rel="noopener">System record ↗</a><a data-report-receipt="${html(r.id)}" href="${html(buyer.receiptAction(r).href)}" target="_blank" rel="noopener">${html(buyer.receiptAction(r).label)} ↗</a></div>
          ${!r.videoUrl?'<p class="fallback-note">No direct video link is saved. The receipt action opens the eBay order so the item’s Live receipt can be found.</p>':''}</article>`).join('')}</section>`).join('')}
      <footer class="report-notes"><div class="eyebrow">HOW TO READ THIS REPORT</div><p>${NOTES}</p><p>Missing means explicitly marked not found or an active missing-watch hold. Unreviewed items are not treated as missing. Overdue duration runs from the shipping deadline and is measured at report preparation time. Missing-marker dates and staff attribution appear in the timeline.</p></footer>`;
  }
  let pdfUrl='',busy=false;
  async function start(){
    if(busy)return;busy=true;const $=id=>document.getElementById(id),progress=s=>$('progress').textContent=s;
    $('refresh-report').disabled=true;$('report-scope').disabled=true;$('download').hidden=true;$('error').hidden=true;$('sign-in').hidden=true;$('report').innerHTML='';
    if(pdfUrl){URL.revokeObjectURL(pdfUrl);pdfUrl='';}
    try{
      const client=root.supabase;if(!client?.auth)throw Error('The connection did not load. Refresh this page.');
      const {data,error}=await client.auth.getSession();if(error)throw error;
      if(!data.session){$('sign-in').hidden=false;throw Error('Sign in to generate the missing items report.');}
      const model=await load(client,$('report-scope').value,location.href,progress);
      if(!model.count){progress('No pending items are marked missing in this scope.');return;}
      $('report').innerHTML=render(model);buyer.bindReceiptLinks($('report'),model.rows);
      const bytes=await root.OGMissingReportPdf.build(model,progress);
      pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      $('download').href=pdfUrl;$('download').download=`missing-items-${model.preparedAt.slice(0,10)}.pdf`;$('download').hidden=false;
      progress(`Report ready: ${model.count} missing item lines / ${model.customers.length} customers / ${model.overdue} overdue / ${model.today} due today.`);
    }catch(error){progress('Report could not be completed.');$('error').textContent=error.message||'Please try again.';$('error').hidden=false;}
    finally{busy=false;$('refresh-report').disabled=false;$('report-scope').disabled=false;}
  }
  const api={loadQueue,selectMissing,deadline,elapsed,missingAge,timeline,itemNotes,latestNote,directoryUrgency,makeCustomer,makeReport,load,stats,screenshots,render,start,money,date,NOTICE,NOTES,POLICY_URL};
  root.OGMissingReport=api;if(typeof module!=='undefined')module.exports=api;
  if(typeof document!=='undefined'&&document.body?.dataset.page==='ebay-missing-report'){
    const boot=()=>{document.getElementById('refresh-report').addEventListener('click',start);document.getElementById('report-scope').addEventListener('change',start);start();};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
  }
})(typeof window!=='undefined'?window:globalThis);
