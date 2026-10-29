/* Read-only reporting. Case closure and seller ledger debits are not buyer refunds. */
(function(root) {
  'use strict';
  const array = value => Array.isArray(value) ? value : [];
  const upper = value => String(value || '').trim().toUpperCase();
  const numeric = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)*100);
  const money = value => ({cents:numeric(value?.value),currency:upper(value?.currency)});
  const completed = value => ['REFUNDED','SUCCESS','SUCCEEDED','COMPLETED'].includes(upper(value));
  const nice = value => String(value || 'Not recorded').replace(/_/g,' ').toLowerCase();
  const date = value => {
    const text = value?.value || value;
    if (!text || !Number.isFinite(Date.parse(text))) return 'Not recorded';
    return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'short',day:'numeric'}).format(new Date(text));
  };
  const formatted = (cents,currency='USD') => cents == null ? 'Amount not confirmed' : new Intl.NumberFormat('en-US',{style:'currency',currency}).format(cents/100);
  const timingLabels = {after_shipment:'After shipment',before_shipment:'Before shipment',
    after_completion:'After system completion; shipment timing unconfirmed',timing_unknown:'Timing needs verification',none:'No refund or cancellation recorded'};
  function instant(value) {
    const text=String(value?.value || value || '');
    return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text) && Number.isFinite(Date.parse(text)) ? Date.parse(text) : null;
  }
  function dateRange(value,day=false) {
    const text=String(value?.value || value || ''), time=instant(text);
    if(time!=null && !day)return {min:time,max:time,value:text};
    if(day || /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const parsed=Date.parse(text);if(!Number.isFinite(parsed))return null;
      const midnight=Date.parse(new Date(parsed).toISOString().slice(0,10));
      // An export's calendar day has no clock/zone. Overlapping days cannot prove sequence.
      return {min:midnight-14*3600000,max:midnight+38*3600000-1,value:new Date(parsed).toISOString().slice(0,10)};
    }
    return null;
  }
  function timingDate(value) {
    if(/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')))return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(value))+' (time not recorded)';
    const time=instant(value);
    return time==null?'Date not recorded':new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(time));
  }
  function shipmentDates(order,lines) {
    const raw=order.raw_payload || {}, api=raw.order || {}, source=String(raw.source || '');
    const values=[api.shippedDate,api.fulfillmentSummary?.shippedDate,api.fulfillmentStatus?.shippedDate,api.shippingFulfillment?.shippedDate,
      ...array(api.fulfillments).map(f=>f.shippedDate),...array(api.shippingFulfillments).map(f=>f.shippedDate),
      ...[...array(api.lineItems),...lines.map(l=>l.raw_payload?.line)].filter(Boolean).flatMap(l=>[l.shippedDate,l.lineItemFulfillmentInstructions?.shippedDate,l.fulfillmentInstructions?.shippedDate])];
    const dates=values.map(value=>dateRange(value)).filter(Boolean);
    const csv=raw.first_row?.['Shipped On Date'];
    // Legacy API archive imports used lastModifiedDate as shipped_on_date. They are not shipment evidence.
    if(order.shipped_on_date && (!/ebay_(account|buyer)_history_sync/.test(source) || raw.date_precision?.shipped_on_date==='timestamp')) {
      const day=raw.date_precision?.shipped_on_date==='day' || Boolean(csv && /^(?:[A-Za-z]{3}-\d{1,2}-\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/.test(csv));
      const saved=dateRange(order.shipped_on_date,day);if(saved)dates.push(saved);
    }
    return dates;
  }
  function refundTiming(order,lines,requests,refundEntries,finance,hasRefund,identityConflict) {
    const raw=order.raw_payload || {}, signals=[raw,...lines.map(l=>l.raw_payload || {})];
    const cancellations=signals.flatMap(p=>[p.api_cancellation_case,p.cancellation_page_case,p.order?.cancelStatus]).filter(Boolean);
    const normal=new Set(['','NONE_REQUESTED','NOT_REQUESTED','NO_CANCEL','NOT_CANCELLED','CANCEL_REJECTED','CANCEL_CLOSED_WITHOUT_REFUND']);
    const cancelStates=signals.flatMap(p=>[p.orderCancelStatus,p.api_order_status?.cancel_status,p.order?.cancelStatus?.cancelState])
      .concat(cancellations.map(c=>c.cancelStatus || c.cancelState || c.cancellationStatus)).map(upper);
    const cancelled=upper(order.status)==='CANCELLED' || (lines.length>0 && lines.every(l=>upper(l.line_status)==='CANCELLED')) || cancelStates.some(s=>['CANCELED','CANCELLED','CANCEL_CLOSED_WITH_REFUND','CANCEL_COMPLETE','CANCEL_COMPLETED'].includes(s));
    const hasCancellation=cancelled || cancelStates.some(s=>!normal.has(s));
    const relevant=requests.filter(r=>r.state!=='closed' || hasRefund);
    const activity=hasRefund || relevant.length>0 || hasCancellation;
    if(!activity)return {flags:[],label:timingLabels.none,events:[],cancelled:false};
    const ships=shipmentDates(order,lines), shippedAt=[...new Set(ships.map(d=>d.value))];
    const states=signals.flatMap(p=>[p.orderFulfillmentStatus,p.order?.orderFulfillmentStatus,p.api_order_status?.fulfillment_status]).map(upper).filter(Boolean);
    const unshipped=states.includes('NOT_STARTED') && states.every(s=>s==='NOT_STARTED');
    const completionDates=lines.map(l=>{
      const p=l.raw_payload || {}, history=/ebay_(account|buyer)_history_sync/.test(String(p.source || raw.source || ''));
      return upper(l.line_status)==='FULFILLED' && !history && !p.history_date_corrected_at ? instant(l.fulfilled_at) : null;
    });
    const closedAt=completionDates.length && completionDates.every(t=>t!=null) ? Math.max(...completionDates) : null;
    const events=relevant.map(r=>{
      const p=r.case.raw_payload || {};
      // opened_at can be the import time. Only use an original provider request date or actual refund date.
      const requested=p.requestedAt || p.apiExtractedDetails?.requestedAt || p.ebayDetail?.creationInfo?.creationDate;
      return {kind:instant(requested)!=null?'Request opened':r.state==='completed'?'Refund issued':'Request date unavailable',
        at:instant(requested)!=null?(requested.value || requested):r.refundedAt || '',caseNumber:r.caseNumber};
    });
    if(hasCancellation) {
      const candidates=cancellations.flatMap(c=>[c.requestedAt,c.cancelRequestDate,...array(c.cancelRequests).map(r=>r.cancelRequestDate),c.completedAt,c.cancelCompletedDate,c.cancelCloseDate]);
      const times=candidates.map(instant).filter(t=>t!=null);
      events.push({kind:'Cancellation',at:times.length?new Date(Math.min(...times)).toISOString():''});
    }
    // A request made before shipping stays in that category even if its refund was paid later.
    if(!events.length) {
      const dated=refundEntries.filter(r=>instant(r.at)!=null);
      const fallback=finance.filter(t=>upper(t.transactionStatus)!=='FAILED' && instant(t.transactionDate)!=null);
      for(const r of dated)events.push({kind:'Refund issued',at:r.at});
      if(!dated.length)for(const t of fallback)events.push({kind:'Refund transaction recorded',at:t.transactionDate});
      if(!events.length)events.push({kind:'Refund date unavailable',at:''});
    }
    const preCancellation=cancelled && unshipped && !ships.length && !lines.some(l=>upper(l.line_status)==='FULFILLED');
    for(const event of events) {
      const time=instant(event.at);let category='timing_unknown',basis='The saved dates do not establish whether this happened before or after shipment.';
      if(!identityConflict && ships.length && time!=null && !states.includes('IN_PROGRESS')) {
        if(time>Math.max(...ships.map(d=>d.max))){category='after_shipment';basis='The event occurred after the recorded shipment date.';}
        else if(time<Math.min(...ships.map(d=>d.min))){category='before_shipment';basis='The event occurred before the recorded shipment date.';}
      } else if(!identityConflict && preCancellation) {
        category='before_shipment';basis='Cancellation recorded while eBay shows fulfillment not started, with no shipment or completed packing recorded.';
      } else if(!identityConflict && !ships.length && time!=null && closedAt!=null && time>closedAt) {
        category='after_completion';basis='The event occurred after all saved item lines were completed in the system. An actual shipment date is not confirmed.';
      }
      if(identityConflict)basis='The case and order buyer identities disagree; verify their association.';
      event.category=category;event.basis=basis;
    }
    const flags=[...new Set(events.map(e=>e.category))];
    return {flags,label:flags.map(k=>timingLabels[k]).join(' / '),events,shippedAt,
      completedAt:closedAt!=null?new Date(closedAt).toISOString():'',cancelled};
  }
  function timingCounts(financial) {
    return Object.fromEntries(['after_shipment','before_shipment','after_completion','timing_unknown'].map(key=>[key,financial.orders.filter(o=>o.timing?.flags.includes(key)).length]));
  }
  function timingText(financial) {
    const count=timingCounts(financial);
    return `Refund / cancellation timing (orders): ${count.after_shipment} after shipment; ${count.before_shipment} before shipment; ${count.after_completion} after system completion with shipment unconfirmed; ${count.timing_unknown} timing to verify. An order can appear in more than one category.`;
  }
  function orderAmount(order) {
    const raw=order.raw_payload || {}, value=raw.order?.pricingSummary?.total;
    return {cents:numeric(value?.value ?? order.total_price),currency:upper(value?.currency || raw.first_row?.Currency || 'USD')};
  }
  function caseMatchesOrder(c,order) {
    return c.order_id ? c.order_id===order.id : Boolean(c.order_number && c.order_number===order.order_number);
  }
  function caseLineIds(c,lines) {
    const raw=c.raw_payload || {}, manual=raw.manualOrderMatch;
    const explicit=manual ? array(manual.line_ids) : [
      ...array(raw.automaticOrderMatch?.line_ids),
      ...array(c.ebay_return_items).map(i=>i.order_line_id),
      ...array(c.ebay_return_tasks).flatMap(t=>array(t.order_line_ids)),
    ];
    if (explicit.length || manual) return [...new Set(explicit)].filter(id=>lines.some(l=>l.id===id));
    const item=raw.ebayDetail?.itemDetail || raw.ebayDetail?.creationInfo?.item || {};
    const itemId=item.itemId || raw.itemNumber || raw.apiExtractedDetails?.itemNumber;
    const transaction=item.transactionId || raw.transactionId || raw.apiExtractedDetails?.transactionId;
    const matched=lines.filter(l=>itemId && String(l.item_number)===String(itemId)
      && (!transaction || !l.transaction_id || String(l.transaction_id)===String(transaction)));
    return matched.map(l=>l.id);
  }
  function caseRefund(c) {
    const raw=c.raw_payload || {}, detail=raw.ebayDetail || {}, id=c.ebay_return_id;
    const ids=[raw.ebayReturnId,detail.returnId,raw.ebaySummary?.returnId].filter(Boolean).map(String);
    const valid=c.source_lane==='return' && id && ids.length && ids.every(value=>value===String(id));
    const actual=valid ? detail.refundInfo?.actualRefundDetail || {} : {};
    const state=upper(c.ebay_status), returnState=valid?upper(raw.returnState || raw.ebaySummary?.state):'';
    const status=upper(actual.refundStatus), value=money(actual.actualRefund?.totalAmount);
    const failed=status==='FAILED' || [state,returnState].some(s=>/^(PARTIAL_)?REFUND_FAILED$|^REFUND_TIMEOUT$/.test(s));
    const pending=!failed && (status==='PENDING' || [state,returnState].some(s=>/REFUND.*INITIATED|REFUND_SENT_PENDING_CONFIRMATION/.test(s)));
    const partial=[state,returnState].some(s=>['PARTIAL_REFUNDED','LESS_THAN_A_FULL_REFUND_ISSUED'].includes(s)) || Number(actual.outstandingAmount?.value)>0;
    const paid=!failed && !pending && (completed(status) || (!status && value.cents>0) || partial && ['PARTIAL_REFUNDED','LESS_THAN_A_FULL_REFUND_ISSUED'].includes(state));
    const closed=['closed','cancelled'].includes(c.status) || /^(CLOSED|CANCELLED|CANCELED|RESOLVED|DECLINED)$/.test(state);
    return {id:c.id,caseNumber:id || 'Internal case',kind:c.issue_kind || c.source_lane || 'request',
      state:failed?'failed':pending?'pending':paid?'completed':closed?'closed':'requested',
      label:failed?'Refund failed':pending?'Refund pending':paid?(partial?'Partial refund completed':'Refund completed'):closed?'Case closed - no refund confirmation in this case':c.source_lane==='return'?'Return / refund requested':'Request open - refund not confirmed',
      cents:paid?value.cents:null,currency:value.currency,partial,
      requestedAt:raw.requestedAt || raw.apiExtractedDetails?.requestedAt || c.opened_at,
      refundedAt:paid ? actual.refundIssuedDate?.value || '' : '',
      closedAt:c.closed_at,systemStatus:c.status,ebayStatus:c.ebay_status,
      receivedAt:c.received_at,reason:c.return_reason || '',
      requestedAmount:raw.apiExtractedDetails?.requestAmount || raw.requestAmount || '',
      syncedAt:c.synced_at,case:c};
  }
  function model(records) {
    const cases=[...new Map(array(records.returnCases).map(c=>[`${c.source_lane}:${c.ebay_return_id || c.id}`,c])).values()];
    const orders=records.orders.map(order=>{
      const lines=records.lines.filter(l=>l.order_id===order.id), gross=orderAmount(order), raw=order.raw_payload || {};
      const linked=cases.filter(c=>caseMatchesOrder(c,order));
      const identityConflict=linked.some(c=>c.buyer_username && order.buyer_username && c.buyer_username.trim().toLowerCase()!==order.buyer_username.trim().toLowerCase());
      const requests=linked.map(c=>({...caseRefund(c),lineIds:caseLineIds(c,lines)}));
      const refunds=[...new Map(array(raw.order?.paymentSummary?.refunds).map((r,i)=>[r.refundReferenceId || r.refundId || `row:${i}`,r])).values()];
      const paid=refunds.filter(r=>completed(r.refundStatus));
      const casePaid=requests.filter(r=>r.state==='completed');
      const signals=[raw,...lines.map(l=>l.raw_payload || {})];
      const paymentStates=signals.flatMap(p=>[p.orderPaymentStatus,p.order?.orderPaymentStatus,p.api_order_status?.payment_status]).map(upper);
      const finance=[...new Map(signals.flatMap(p=>array(p.ebayFinance?.transactions))
        .filter(t=>upper(t.transactionType)==='REFUND' && (!t.orderNumber || t.orderNumber===order.order_number))
        .map(t=>[t.transactionId || JSON.stringify(t),t])).values()];
      const financeUnconfirmed=finance.filter(t=>upper(t.transactionStatus)!=='FAILED');
      const full=paymentStates.some(s=>['FULLY_REFUNDED','REFUNDED'].includes(s));
      const partial=paymentStates.includes('PARTIALLY_REFUNDED');
      const pending=refunds.some(r=>upper(r.refundStatus)==='PENDING') || requests.some(r=>r.state==='pending') || paymentStates.some(s=>['REFUND_PENDING','PENDING_REFUND'].includes(s));
      const failed=refunds.some(r=>upper(r.refundStatus)==='FAILED') || requests.some(r=>r.state==='failed') || finance.some(t=>upper(t.transactionStatus)==='FAILED');
      let source='', entries=[], unknown=false;
      // One authoritative set per order. Return-case details often repeat fulfillment refunds.
      if(paid.length){entries=paid.map(r=>({...money(r.amount),at:r.refundDate}));source='eBay order refund records';}
      else if(casePaid.length && !identityConflict){entries=casePaid.map(r=>({cents:r.cents,currency:r.currency,at:r.refundedAt}));source='eBay completed return refunds';}
      else if(full && gross.cents!=null){entries=[{...gross,at:''}];source='eBay full-refund status applied to saved order total';}
      const known=entries.filter(r=>r.cents!=null && r.cents>=0 && r.currency===gross.currency);
      const refundCents=known.reduce((sum,r)=>sum+r.cents,0);
      unknown=identityConflict || known.length!==entries.length || (!entries.length && (financeUnconfirmed.length>0 || partial || full));
      if(paid.length && casePaid.some(r=>r.cents==null || r.currency!==gross.currency))unknown=true;
      if(paid.length && casePaid.reduce((sum,r)=>sum+(r.cents||0),0)>refundCents)unknown=true;
      if(full && gross.cents!=null && refundCents!==gross.cents)unknown=true;
      if(gross.cents!=null && refundCents>gross.cents)unknown=true;
      const refundSignal=entries.length>0 || finance.length>0 || partial || full;
      const label=unknown?'Refund recorded - amount needs verification':refundCents>0?(full || refundCents===gross.cents?'Full refund completed':'Partial refund completed'):
        pending?'Refund pending':failed?'Refund failed':requests.some(r=>r.state==='requested')?'Return / refund requested':requests.length?'Case closed - refund not confirmed':'No refund recorded';
      const timing=refundTiming(order,lines,requests,entries,finance,refundSignal || pending || failed,identityConflict);
      return {id:order.id,orderNumber:order.order_number,lines,gross,requests,refunds,refundCents,unknown,source,refundSignal,pending,failed,label,timing,
        netCents:unknown || gross.cents==null ? null : gross.cents-refundCents,
        refundedDates:[...new Set(entries.map(e=>e.at).filter(Boolean))],
        scope:lines.length>1?'Order total across all items; counted once. Refunds are not allocated between items.':'Order total.',
        note:identityConflict?'The linked case and order have different buyer usernames. Verify the buyer association before using the totals.':unknown?'Buyer refund amount is missing or inconsistent. Net spent is not confirmed. Seller fee-adjusted debits are not used as buyer refunds.':''};
    });
    const unmatched=cases.filter(c=>!records.orders.some(o=>caseMatchesOrder(c,o)));
    const currencies=[...new Set(orders.map(o=>o.gross.currency))];
    return {orders,unmatched,totals:currencies.map(currency=>{
      const same=orders.filter(o=>o.gross.currency===currency);
      return {currency,gross:same.every(o=>o.gross.cents!=null)?same.reduce((s,o)=>s+o.gross.cents,0):null,
        refunds:same.reduce((s,o)=>s+o.refundCents,0),unknown:same.some(o=>o.unknown)||unmatched.length>0,
        net:same.every(o=>o.netCents!=null)&&!unmatched.length?same.reduce((s,o)=>s+o.netCents,0):null};
    }),requestedOrders:orders.filter(o=>o.requests.some(r=>r.state==='requested')||o.pending).length,
      refundedOrders:orders.filter(o=>o.refundCents>0).length,unverifiedOrders:orders.filter(o=>o.unknown).length};
  }
  function forLine(financial,line,baseUrl) {
    const order=financial.orders.find(o=>o.id===line.order_id);
    if(!order)return null;
    const requests=order.requests.filter(r=>!r.lineIds.length || r.lineIds.includes(line.id)).map(r=>({ ...r,
      scope:r.lineIds.includes(line.id)?'Matched to this item':'Order-level case; affected item not confirmed',
      url:new URL(`ebay-returns.html?caseId=${encodeURIComponent(r.id)}`,baseUrl).href}));
    const itemRefundConfirmed=requests.some(r=>r.lineIds.includes(line.id) && r.state==='completed' && r.cents>0 && r.currency===order.gross.currency)
      || (!order.unknown && order.refundCents>0 && (order.lines.length===1 || order.netCents===0));
    return {...order,requests,itemRefundConfirmed};
  }
  function totalText(financial,key) {
    return financial.totals.map(t=>key==='net' && t.net==null?'Not confirmed':`${formatted(t[key],t.currency)}${key==='refunds'&&t.unknown?' confirmed; more unverified':''}`).join(' + ') || 'Not recorded';
  }
  function detailLines(f) {
    if(!f)return [];
    const lines=[`Order refund status: ${f.label}`,`${f.scope} Before refunds: ${formatted(f.gross.cents,f.gross.currency)} | Completed refunds: ${formatted(f.refundCents,f.gross.currency)}${f.unknown?' confirmed only':''} | Net spent: ${f.netCents==null?'Not confirmed':formatted(f.netCents,f.gross.currency)}`];
    if(f.timing?.flags.length) {
      lines.splice(1,0,`Refund / cancellation timing: ${f.timing.label}`);
      if(f.timing.shippedAt?.length)lines.push(`Recorded shipment: ${f.timing.shippedAt.map(timingDate).join(', ')}`);
      if(f.timing.completedAt)lines.push(`System completion: ${timingDate(f.timing.completedAt)} (not proof of shipment)`);
      for(const event of f.timing.events)lines.push(`${event.kind}${event.caseNumber?` (case ${event.caseNumber})`:''}: ${timingDate(event.at)} - ${timingLabels[event.category]}. ${event.basis}`);
    }
    if(f.note)lines.push(f.note);
    if(f.source)lines.push(`Refund source: ${f.source}${f.refundedDates.length?` | Issued: ${f.refundedDates.map(date).join(', ')}`:''}`);
    if(f.pending)lines.push('An additional refund is pending confirmation; it is not included in completed refunds.');
    if(f.failed)lines.push('A failed refund is recorded; it is not included in completed refunds.');
    for(const r of f.requests){
      lines.push(`${nice(r.kind)} ${r.caseNumber}: ${r.label}. ${r.scope}.`);
      lines.push(`Requested: ${date(r.requestedAt)}${r.state==='completed'?` | Refunded: ${formatted(r.cents,r.currency || f.gross.currency)} | Issued: ${date(r.refundedAt)}`:r.requestedAmount?` | Case amount (not paid): ${r.requestedAmount}`:''}`);
      lines.push(`eBay case: ${nice(r.ebayStatus)} | System case: ${nice(r.systemStatus)}${r.closedAt?` | Closed: ${date(r.closedAt)}`:''}${r.receivedAt?` | Return received: ${date(r.receivedAt)}`:''}`);
      if(r.reason)lines.push(`Reason: ${nice(r.reason).slice(0,280)}${r.reason.length>280?'... (see case)':''}`);
      if(r.syncedAt)lines.push(`Case last synced: ${date(r.syncedAt)}`);
    }
    return lines;
  }
  const api={model,forLine,totalText,detailLines,caseRefund,caseLineIds,formatted,timingCounts,timingText};
  root.OGBuyerRefundReport=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
