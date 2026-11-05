(function(root){
  'use strict';
  const buyer=root.OGBuyerReport||(typeof require==='function'?require('./ebay-buyer-report.js'):null);
  const refunds=root.OGBuyerRefundReport||(typeof require==='function'?require('./buyer-report-refunds.js'):null);
  const cents=v=>v==null||v===''?null:Number.isFinite(Number(v))?Math.round(Number(v)*100):null;
  const sum=values=>values.every(v=>v!=null)?values.reduce((a,b)=>a+b,0):null;
  const money=v=>v==null?'Needs verification':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v/100);
  const list=v=>[...new Set(String(v||'').split(/[\s,]+/).filter(Boolean))];
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
    return {ids:lines.map(l=>l.id),records:{...records,orders:orderRows,lines:records.lines.filter(l=>orderIds.has(l.order_id)),returnCases:(records.returnCases||[]).filter(c=>c.order_id?orderIds.has(c.order_id):orderNumbers.has(c.order_number))}};
  }
  function attach(model,selection){
    const records=selection.records,selected=new Set(selection.ids);
    model.rows=model.rows.filter(r=>selected.has(r.id));
    model.selection={};model.title='Selected purchases';model.scope='selected';
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
      const uncertain=finance.unknown||(!full&&(finance.refundCents>0||api.orderPaymentStatus==='PARTIALLY_REFUNDED'));
      // Never guess which item/shipping component an order-level partial refund reduced.
      const deducted=uncertain?null:full||canceled?item:0;
      const net=deducted==null||item==null?null:item-deducted;
      const checked=order.raw_payload?.ebay_order_evidence?.checked_at||order.raw_payload?.buyer_history_synced_at;
      const entry={order:order.order_number,item,shipping,tax,deducted,net,checked,full,canceled,uncertain};totals.push(entry);
      for(const row of model.rows.filter(r=>r.orderId===order.id)){
        const a=amounts.find(a=>a.id===row.id);row.selectionAmount=a;
        if(a.item!=null)row.price={...row.price,total:a.item/100,currency:'USD'};
        row.selectionStatus=uncertain?'Refund allocation needs verification':full?'Fully refunded':canceled?'Canceled':finance.pending?'Refund pending':'No completed refund recorded';
        row.groups=[];
        row.refund={...row.refund,lines,scope:'Selected items + shipping; eBay-collected tax is shown separately.'+(!allSelected?' Other items in this order are excluded.':''),gross:{cents:sum([item,shipping]),currency:'USD'},refundCents:full?sum([item,shipping]):uncertain?row.refund?.refundCents:0,netCents:uncertain?null:full||canceled?0:sum([item,shipping]),unknown:uncertain,requests:allSelected?row.refund?.requests||[]:(row.refund?.requests||[]).filter(q=>q.lineIds?.some(id=>selected.has(id)))};
        if(checked&&Number.isFinite(Date.parse(checked)))row.timeline.push({label:'eBay payment and status checked',text:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(checked)),at:Date.parse(checked),tone:'normal'});
        row.timeline.sort((a,b)=>a.at-b.at);
      }
    }
    const item=sum(totals.map(t=>t.item)),deducted=sum(totals.map(t=>t.deducted)),net=sum(totals.map(t=>t.net)),shipping=sum(totals.map(t=>t.shipping)),tax=sum(totals.map(t=>t.tax));
    model.selection={totals,item,deducted,net,shipping,tax,paid:sum([item,shipping,tax]),uncertain:totals.some(t=>t.uncertain)};
    model.count=model.rows.length;model.orderCount=new Set(model.rows.map(r=>r.orderId)).size;model.itemValue=money(item);
    model.pending=model.rows.filter(r=>r.pending).length;model.closed=model.rows.filter(r=>r.state.kind==='closed').length;model.unknown=model.count-model.pending-model.closed;
    model.overdue=model.rows.filter(r=>r.pending&&r.deadline.level==='overdue').length;model.today=model.rows.filter(r=>r.pending&&r.deadline.level==='today').length;
    model.labeled=model.rows.filter(r=>r.pending&&r.shippingLabel.attached).length;model.unlabeled=model.pending-model.labeled;
    model.unknownPrices=model.rows.filter(r=>r.price.total==null).length;model.missingOrders=[];
    model.financialStats=[['Selected item sales',money(item),`${model.count} selected lines / ${model.orderCount} orders`],['Refunds / cancellations',money(deducted),'Confirmed item deductions; each item counted once'],['Item balance',money(net),'After confirmed deductions / before fees and postage'],['Shipping collected',money(shipping),'Selected lines only / separate from item sales'],['Sales tax',money(tax),'Collected by eBay / not seller income'],['Original buyer payment',money(sum([item,shipping,tax])),'Selected items, shipping and tax / before refunds']];
    model.financialNotes='Only the selected item lines are included. Shipping and eBay-collected sales tax are shown separately. Item balance is before selling fees, postage and product costs; it is not profit or a bank payout. Completed refunds and cancellations reduce the selected items once. An order-level partial refund without an exact item allocation makes the item balance unconfirmed. Refund requests and handwritten notes are not proof that money was returned. Dates use Eastern time; paper receipts may show a different calendar date. Refresh this report after updates.';
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
  const api={select,attach,shipping,list,money};root.OGCustomerSelection=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
