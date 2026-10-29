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
      return {id:order.id,orderNumber:order.order_number,lines,gross,requests,refunds,refundCents,unknown,source,refundSignal,pending,failed,label,
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
    return {...order,requests};
  }
  function totalText(financial,key) {
    return financial.totals.map(t=>key==='net' && t.net==null?'Not confirmed':`${formatted(t[key],t.currency)}${key==='refunds'&&t.unknown?' confirmed; more unverified':''}`).join(' + ') || 'Not recorded';
  }
  function detailLines(f) {
    if(!f)return [];
    const lines=[`Order refund status: ${f.label}`,`${f.scope} Before refunds: ${formatted(f.gross.cents,f.gross.currency)} | Completed refunds: ${formatted(f.refundCents,f.gross.currency)}${f.unknown?' confirmed only':''} | Net spent: ${f.netCents==null?'Not confirmed':formatted(f.netCents,f.gross.currency)}`];
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
  const api={model,forLine,totalText,detailLines,caseRefund,caseLineIds,formatted};
  root.OGBuyerRefundReport=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
