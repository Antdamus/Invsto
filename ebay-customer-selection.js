(function(root){
  'use strict';
  const buyer=root.OGBuyerReport||(typeof require==='function'?require('./ebay-buyer-report.js'):null);
  const refunds=root.OGBuyerRefundReport||(typeof require==='function'?require('./buyer-report-refunds.js'):null);
  const cents=v=>v==null||v===''?null:Number.isFinite(Number(v))?Math.round(Number(v)*100):null;
  const sum=values=>values.every(v=>v!=null)?values.reduce((a,b)=>a+b,0):null;
  const money=v=>v==null?'Needs verification':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v/100);
  const list=v=>[...new Set(String(v||'').split(/[\s,]+/).filter(Boolean))];
  const date=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(v))+' Eastern':'Date not supplied';
  function itemizedRefund(finance,selected,buyerName=''){
    const paid=finance.requests.filter(r=>r.state==='completed'&&r.cents>0);
    if(!paid.length||paid.some(r=>r.currency!=='USD'||(buyerName&&r.case.buyer_username&&r.case.buyer_username.trim().toLowerCase()!==buyerName.trim().toLowerCase())))return null;
    // Fulfillment's refund amount can be the seller debit after fee credits.
    // Accept that difference only when every exact return reference and debit
    // matches the completed, itemized return evidence. Never estimate it.
    const orderRefunds=finance.refunds||[];
    const reconciled=orderRefunds.length===paid.length&&orderRefunds.length>0&&new Set(orderRefunds.map(r=>r.refundReferenceId)).size===paid.length&&orderRefunds.every(r=>{
      const matched=paid.find(p=>String(p.caseNumber)===String(r.refundReferenceId));
      const actual=matched?.case.raw_payload?.ebayDetail?.refundInfo?.actualRefundDetail;
      const debit=actual?.netChargeAmount;
      return matched&&/^(REFUNDED|SUCCESS|SUCCEEDED|COMPLETED)$/.test(r.refundStatus)&&r.amount?.currency==='USD'&&(cents(r.amount.value)===matched.cents||(debit?.currency==='USD'&&cents(r.amount.value)===cents(debit.value)));
    });
    if((finance.unknown||paid.reduce((s,r)=>s+r.cents,0)!==finance.refundCents)&&!reconciled)return null;
    const allocations=[];
    for(const r of paid){
      if(r.lineIds.length!==1)return null;
      const detail=r.case.raw_payload?.ebayDetail,actual=detail?.refundInfo?.actualRefundDetail;
      const parts=actual?.actualRefund?.itemizedRefundDetail;
      if(!Array.isArray(parts)||!parts.length)return null;
      let item=0,shipping=0,total=0;
      for(const p of parts){
        const value=cents(p.refundAmount?.value);
        if(value==null||value<0||p.refundAmount?.currency!=='USD')return null;
        total+=value;
        if(p.refundFeeType==='PURCHASE_PRICE')item+=value;
        else if(p.refundFeeType==='ORIGINAL_SHIPPING')shipping+=value;
        else if(value!==0)return null;
      }
      if(total!==r.cents)return null;
      const movements=(detail.moneyMovementInfo||[]).filter(m=>m.status==='SUCCESS'&&/^(PAYPAL_)?(PARTIAL_)?REFUND$/.test(m.moneyMovementType));
      const movement=movements.length===1?movements[0]:null;
      const buyerTotal=movement?.actualAmount?.currency==='USD'?cents(movement.actualAmount.value):null;
      if(selected.has(r.lineIds[0]))allocations.push({lineId:r.lineIds[0],item,shipping,buyerTotal,caseNumber:r.caseNumber,at:r.refundedAt||movement?.creationDate?.value||''});
    }
    return {item:allocations.reduce((s,a)=>s+a.item,0),shipping:allocations.reduce((s,a)=>s+a.shipping,0),allocations};
  }
  function select(records,params){
    const orders=list(params.get('orders')),ids=list(params.get('lines')),excluded=list(params.get('excludeItems'));
    if(!orders.length&&!ids.length&&!excluded.length)return null;
    for(const n of orders)if(!records.orders.some(o=>o.order_number===n))throw Error(`Selected order ${n} is not saved for this buyer.`);
    for(const id of ids)if(!records.lines.some(l=>l.id===id))throw Error('A selected item is no longer available for this buyer. Review the selection.');
    const selectedOrders=new Set(records.orders.filter(o=>!orders.length||orders.includes(o.order_number)).map(o=>o.id));
    const lines=records.lines.filter(l=>selectedOrders.has(l.order_id)&&(!ids.length||ids.includes(l.id))&&!excluded.includes(String(l.item_number)));
    if(!lines.length)throw Error('Choose at least one item for the report.');
    const orderIds=new Set(lines.map(l=>l.order_id)),orderRows=records.orders.filter(o=>orderIds.has(o.id));
    const orderNumbers=new Set(orderRows.map(o=>o.order_number));
    // Retain sibling lines only as financial evidence; the model hides them below.
    return {ids:lines.map(l=>l.id),auction:params.get('amounts')==='auction',client:params.get('audience')==='customer',records:{...records,orders:orderRows,lines:records.lines.filter(l=>orderIds.has(l.order_id)),returnCases:(records.returnCases||[]).filter(c=>c.order_id?orderIds.has(c.order_id):orderNumbers.has(c.order_number))}};
  }
  function attach(model,selection){
    const records=selection.records,selected=new Set(selection.ids);
    model.rows=model.rows.filter(r=>selected.has(r.id));
    model.selection={};model.title='Selected purchases';model.scope='selected';
    model.clientFacing=Boolean(selection.client);
    if(selection.auction){model.amountLabel='Auction winning amount';model.amountNotice='Auction winning amounts are the buyer\'s original item prices. Shipping and eBay-collected sales tax are listed separately. Completed refunds are shown separately from the original payment.';}
    const original=refunds.model(records),totals=[];
    for(const order of records.orders){
      const allLines=records.lines.filter(l=>l.order_id===order.id),lines=allLines.filter(l=>selected.has(l.id));
      const api=order.raw_payload?.order||{},finance=original.orders.find(o=>o.id===order.id),allSelected=lines.length===allLines.length;
      const amounts=lines.map(l=>{
        const matches=(api.lineItems||[]).filter(a=>String(a.legacyItemId)===String(l.item_number));
        const a=matches.length===1?matches[0]:l.raw_payload?.line;
        const currencies=[a?.lineItemCost?.currency,a?.total?.currency,...(a?.ebayCollectAndRemitTaxes||[]).map(t=>t.amount?.currency),buyer.itemPrice(l).currency].filter(Boolean);
        if(currencies.some(c=>c!=='USD'))throw Error('Selected-item financial totals currently require USD purchases. Use the full-history report to review other currencies.');
        const item=cents(a?.lineItemCost?.value)??cents(buyer.itemPrice(l).total);
        const beforeTax=cents(a?.total?.value);
        const shipping=beforeTax!=null&&item!=null?beforeTax-item:null;
        const tax=Array.isArray(a?.ebayCollectAndRemitTaxes)?sum(a.ebayCollectAndRemitTaxes.map(t=>cents(t.amount?.value))):null;
        return {id:l.id,item,shipping,tax};
      });
      const item=sum(amounts.map(a=>a.item)),shipping=sum(amounts.map(a=>a.shipping)),tax=sum(amounts.map(a=>a.tax));
      const full=['FULLY_REFUNDED','REFUNDED'].includes(api.orderPaymentStatus)||finance.label==='Full refund completed';
      const canceled=/^(CANCELED|CANCELLED|CANCEL_COMPLETE|CANCEL_COMPLETED|CANCEL_CLOSED_WITH_REFUND)$/.test(api.cancelStatus?.cancelState||'');
      const allocation=itemizedRefund(finance,selected,order.buyer_username);
      const validAllocation=allocation&&amounts.every(a=>{
        const parts=allocation.allocations.filter(p=>p.lineId===a.id);
        return a.item!=null&&a.shipping!=null&&parts.reduce((s,p)=>s+p.item,0)<=a.item&&parts.reduce((s,p)=>s+p.shipping,0)<=a.shipping;
      });
      const uncertain=(finance.unknown&&!validAllocation)||(!full&&(finance.refundCents>0||api.orderPaymentStatus==='PARTIALLY_REFUNDED')&&!validAllocation);
      // Never guess which item/shipping component an order-level partial refund reduced.
      const deducted=uncertain?null:full||canceled?item:validAllocation?allocation.item:0;
      const shippingRefund=uncertain?null:full||canceled?shipping:validAllocation?allocation.shipping:0;
      const net=deducted==null||item==null?null:item-deducted;
      const checked=order.raw_payload?.ebay_order_evidence?.checked_at||order.raw_payload?.buyer_history_synced_at;
      const paidTotal=sum([item,shipping,tax]);
      const recordedBuyerRefund=validAllocation?sum(allocation.allocations.map(a=>a.buyerTotal)):null;
      const buyerRefund=validAllocation&&recordedBuyerRefund!=null&&tax!=null&&recordedBuyerRefund>=deducted+shippingRefund&&recordedBuyerRefund<=deducted+shippingRefund+tax?recordedBuyerRefund:!uncertain&&!full&&!canceled&&finance.refundCents===0?0:null;
      const entry={order:order.order_number,item,shipping,tax,deducted,shippingRefund,net,checked,full,canceled,uncertain,buyerRefund,paidTotal};totals.push(entry);
      for(const row of model.rows.filter(r=>r.orderId===order.id)){
        const a=amounts.find(a=>a.id===row.id);row.selectionAmount=a;
        const rowDeducted=validAllocation?allocation.allocations.filter(p=>p.lineId===row.id).reduce((s,p)=>s+p.item,0):deducted;
        if(a.item!=null)row.price={...row.price,total:a.item/100,currency:'USD'};
        row.selectionStatus=uncertain?'Refund allocation needs verification':full?'Fully refunded':canceled?'Canceled':rowDeducted>0?'Partial refund completed':finance.pending?'Refund pending':'No completed refund recorded';
        row.groups=[];
        row.refund={...row.refund,lines,scope:'Selected items + shipping; eBay-collected tax is shown separately.'+(!allSelected?' Other items in this order are excluded.':'')+(validAllocation?` Item refund: ${money(deducted)}; shipping refund: ${money(shippingRefund)}.`:''),gross:{cents:sum([item,shipping]),currency:'USD'},refundCents:uncertain?row.refund?.refundCents:sum([deducted,shippingRefund]),netCents:uncertain?null:sum([item,shipping])-sum([deducted,shippingRefund]),unknown:uncertain,requests:allSelected?row.refund?.requests||[]:(row.refund?.requests||[]).filter(q=>q.lineIds?.some(id=>selected.has(id)))};
        if(validAllocation)for(const part of allocation.allocations.filter(p=>p.lineId===row.id)){
          row.timeline.push({label:'Refund completed / itemized by eBay',text:`${money(part.item)} item + ${money(part.shipping)} shipping / Return ${part.caseNumber}${part.at?' / '+new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(part.at)):' / Date not supplied'}`,at:Date.parse(part.at)||Date.parse(model.preparedAt),tone:'overdue'});
        }
        if(checked&&Number.isFinite(Date.parse(checked)))row.timeline.push({label:'eBay payment and status checked',text:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(checked)),at:Date.parse(checked),tone:'normal'});
        row.timeline.sort((a,b)=>a.at-b.at);
        if(model.clientFacing){
          row.notes=[];row.review='';row.groups=[];
          row.timeline=row.timeline.filter(e=>!/^(System line completed|Report snapshot|Snapshot|eBay payment and status checked)/.test(e.label));
          row.customerRefundLines=[row.selectionStatus,`Original item: ${money(a.item)} / Shipping: ${money(a.shipping)} / Sales tax: ${money(a.tax)}`];
          if(validAllocation){
            const parts=allocation.allocations.filter(p=>p.lineId===row.id);
            const lineItemRefund=sum(parts.map(p=>p.item)),lineShippingRefund=sum(parts.map(p=>p.shipping));
            row.customerRefundLines.push(`Item refunded: ${money(lineItemRefund)} / Shipping refunded: ${money(lineShippingRefund)}`);
            if(buyerRefund!=null&&lines.length===1)row.customerRefundLines.push(`Total refunded to buyer, including tax: ${money(buyerRefund)}`);
            row.customerRefundLines.push(`Item amount after refund: ${money(a.item-lineItemRefund)}`);
            for(const part of parts)row.customerRefundLines.push(`Return ${part.caseNumber} / Refund completed ${date(part.at)}`);
          }else if(uncertain)row.customerRefundLines.push('The exact refund allocation is not yet confirmed.');
          row.refund={label:row.selectionStatus,itemRefundConfirmed:!uncertain&&Boolean(rowDeducted>0),requests:[],unknown:uncertain,refundSignal:rowDeducted>0};
        }
      }
    }
    const item=sum(totals.map(t=>t.item)),deducted=sum(totals.map(t=>t.deducted)),net=sum(totals.map(t=>t.net)),shipping=sum(totals.map(t=>t.shipping)),tax=sum(totals.map(t=>t.tax));
    model.selection={totals,item,deducted,net,shipping,tax,paid:sum([item,shipping,tax]),uncertain:totals.some(t=>t.uncertain)};
    model.count=model.rows.length;model.orderCount=new Set(model.rows.map(r=>r.orderId)).size;model.itemValue=money(item);
    model.pending=model.rows.filter(r=>r.pending).length;model.closed=model.rows.filter(r=>r.state.kind==='closed').length;model.unknown=model.count-model.pending-model.closed;
    model.overdue=model.rows.filter(r=>r.pending&&r.deadline.level==='overdue').length;model.today=model.rows.filter(r=>r.pending&&r.deadline.level==='today').length;
    model.labeled=model.rows.filter(r=>r.pending&&r.shippingLabel.attached).length;model.unlabeled=model.pending-model.labeled;
    model.unknownPrices=model.rows.filter(r=>r.price.total==null).length;model.missingOrders=[];
    model.financialStats=[[selection.auction?'Original auction amounts':'Selected item sales',money(item),`${model.count} selected lines / before eBay fees`],['Refunds / cancellations',money(deducted),'Confirmed item deductions; each item counted once'],[selection.auction?'After item refunds':'Item balance',money(net),'Before eBay fees / not store proceeds'],['Original shipping',money(shipping),'Before shipping refunds / separate from item prices'],['Original sales tax',money(tax),'Collected by eBay / not seller income'],['Original buyer payment',money(sum([item,shipping,tax])),'Selected items, shipping and tax / before refunds']];
    model.financialNotes='Only the selected item lines are included. Shipping and eBay-collected sales tax are shown separately. Item balance is before selling fees, postage and product costs; it is not profit or a bank payout. Completed refunds and cancellations reduce the selected items once. An order-level partial refund without an exact item allocation makes the item balance unconfirmed. Refund requests and handwritten notes are not proof that money was returned. Dates use Eastern time; paper receipts may show a different calendar date. Refresh this report after updates.';
    if(model.clientFacing){
      const buyerRefund=sum(totals.map(t=>t.buyerRefund)),paid=model.selection.paid;
      Object.assign(model.selection,{buyerRefund,buyerPaidAfterRefund:paid!=null&&buyerRefund!=null?paid-buyerRefund:null});
      model.financialStats=[['Auction winning amounts',money(item),`${model.count} selected items / excludes shipping and tax`],['Item refunds',money(deducted),'Completed item refunds / counted once'],['Items after refunds',money(net),'Original item amounts less item refunds'],['Original buyer payment',money(paid),`Includes ${money(shipping)} shipping and ${money(tax)} sales tax`],['Total returned to buyer',money(buyerRefund),'Completed refunds, including shipping and tax'],['Payment after refunds',money(model.selection.buyerPaidAfterRefund),'Original buyer payment less completed refunds']];
      model.financialNotes='This statement covers only the selected purchases. Auction winning amounts are the original item prices. Original buyer payment includes shipping and sales tax; completed refunds are deducted once. Refund requests alone are not counted as completed refunds. All dates use Eastern time. Order closure does not establish carrier delivery. Prepared from saved eBay records; regenerate after updates.';
      model.customer={name:model.customer.name,firstPurchase:model.customer.firstPurchase,lastPurchase:model.customer.lastPurchase};
    }
    return model;
  }
  function shipping(model,evidence){
    for(const row of model.rows){
      const order=evidence?.results?.find(o=>o.orderNumber===row.orderNumber);
      if(!order||order.error)continue;
      const ids=(order.lineItems||[]).filter(l=>String(l.legacyItemId)===String(row.item)).map(l=>l.lineItemId);
      const shipments=(order.fulfillments||[]).filter(s=>(s.lineItems||[]).some(l=>ids.includes(l.lineItemId)));
      for(const s of shipments)row.timeline.push({label:`Shipment recorded by eBay / ${s.shippingCarrierCode||'Carrier'}`,text:`${s.shippedDate?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(s.shippedDate)):'Date not supplied'} / Tracking ${s.shipmentTrackingNumber||'not supplied'} / Not a delivery confirmation`,at:Date.parse(s.shippedDate)||Date.parse(model.preparedAt),tone:'normal'});
      if(shipments.length)row.timeline=row.timeline.filter(e=>e.label!=='Recorded ship date').sort((a,b)=>a.at-b.at);
    }
  }
  const api={select,attach,shipping,list,money,itemizedRefund};root.OGCustomerSelection=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
