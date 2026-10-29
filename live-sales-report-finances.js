(function(root){
  'use strict';
  const number=v=>v==null||v===''||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
  const cents=v=>number(v)==null?null:Math.round(Number(v)*100);
  // Never silently mix a foreign-currency fee with the report's USD sale amounts.
  const usd=v=>v?.currency==='USD'?cents(v.value):null;
  const signedUsd=v=>v?.currency==='USD'&&v.value!=null&&v.value!==''&&Number.isFinite(Number(v.value))?Math.round(Number(v.value)*100):null;
  const sumKnown=values=>values.every(v=>v!=null)?values.reduce((a,b)=>a+b,0):null;
  function allocate(total,weights,keys){
    if(total==null||!weights.length)return null;
    if(weights.length===1)return [total];
    if(weights.some(w=>w==null||w<0))return null;
    const sum=weights.reduce((a,b)=>a+b,0),shares=weights.map(w=>sum?total*w/sum:total/weights.length);
    const result=shares.map(Math.floor),remaining=total-result.reduce((a,b)=>a+b,0);
    const ranked=shares.map((v,i)=>({i,remainder:v-result[i],key:String(keys[i])})).sort((a,b)=>b.remainder-a.remainder||a.key.localeCompare(b.key));
    for(let i=0;i<remaining;i++)result[ranked[i].i]++;
    return result;
  }
  function netTax(line){
    const taxes=line.ebayCollectAndRemitTaxes;
    if(!Array.isArray(taxes))return null;
    return sumKnown(taxes.map(t=>t.collectionMethod==='NET'?usd(t.amount):t.collectionMethod==='GROSS'?0:null));
  }
  function orderShipping(pricing){
    const gross=usd(pricing?.deliveryCost),discount=pricing?.deliveryDiscount==null?0:signedUsd(pricing.deliveryDiscount);
    return gross!=null&&discount!=null&&gross+discount>=0?gross+discount:null;
  }
  function forItem(attempt,evidence={},settings={}){
    const percent=number(settings.fee_percent)??5.5,fixed=cents(settings.fee_fixed)??30,postage=cents(settings.shipping_per_sale);
    const price=cents(attempt.amount),order=evidence.order||{},fin=order.financials||{},raw=evidence.line?.raw_payload?.line||{};
    const lines=Array.isArray(fin.lineItems)?fin.lineItems:[],keys=lines.map((l,i)=>l.lineItemId||l.legacyItemId||String(i));
    let index=lines.findIndex(l=>raw.lineItemId&&l.lineItemId===raw.lineItemId);
    if(index<0){const matches=lines.map((l,i)=>({l,i})).filter(({l})=>String(l.legacyItemId||'')===String(evidence.line?.item_number||attempt.listing_id||'')&&l.legacyItemId);if(matches.length===1)index=matches[0].i;}
    if(index<0&&lines.length===1)index=0;
    const mapped=index>=0,line=mapped?lines[index]:raw;
    const itemWeights=lines.map(l=>usd(l.discountedLineItemCost)??usd(l.lineItemCost));
    const sharedShipping=allocate(orderShipping(fin.pricingSummary),itemWeights,keys);
    const lineShipping=lines.map((l,i)=>usd(l.deliveryCost?.shippingCost)??sharedShipping?.[i]??null);
    const checkoutWeights=lines.map(l=>{const total=usd(l.total),tax=netTax(l);return total!=null&&tax!=null?total+tax:null;});
    const partialWeights=lines.map((l,i)=>itemWeights[i]==null?null:itemWeights[i]+(lineShipping[i]??0)+(netTax(l)??0));
    const weights=checkoutWeights.every(v=>v!=null)?checkoutWeights:partialWeights;
    const allocateToLine=total=>mapped?allocate(total,weights,keys)?.[index]??null:null;
    const shipping=mapped?lineShipping[index]:usd(line.deliveryCost?.shippingCost);
    const feeBasis=usd(fin.totalFeeBasisAmount)??sumKnown(checkoutWeights.length?checkoutWeights:[null]);
    const actual=usd(fin.totalMarketplaceFee),allocatedActual=allocateToLine(actual);
    const allocatedBasis=allocateToLine(feeBasis);
    // Without a matched checkout, the temporary estimate uses only the known item price.
    const partialBasis=mapped?partialWeights[index]:price==null?null:price+(shipping??0)+(netTax(line)??0);
    const estimate=feeBasis!=null?allocateToLine(Math.round(feeBasis*percent/100)+fixed):
      mapped&&weights.every(v=>v!=null)?allocateToLine(Math.round(weights.reduce((a,b)=>a+b,0)*percent/100)+fixed):
      lines.length>1?null:partialBasis==null?null:Math.round(partialBasis*percent/100)+fixed;
    const fee=allocatedActual??estimate,source=allocatedActual!=null?'actual':fee!=null?'estimated':'unavailable';
    const basisKnown=allocatedBasis!=null,shippingKnown=shipping!=null;
    const complete=source==='actual';
    const note=source==='actual'?'Actual eBay fee from the latest order sync':source==='estimated'?`${percent}% + $${(fixed/100).toFixed(2)} per eBay order`:'Order fee could not be allocated; review the matched order';
    const allocation=lines.length>1?'Order fee allocated across all order lines by checkout amount (item amount if checkout detail is unavailable).':'';
    return {fee,source,percent,fixed,postage,shipping,basis:allocatedBasis??partialBasis,basisKnown,shippingKnown,complete,note,allocation,
      syncedAt:order.updated_at||'',beforePostage:postage==null,
      caveat:!basisKnown&&source!=='actual'?'Shipping / tax may be incomplete; fee estimate updates after order import.':!shippingKnown?'Shipping funds are not yet known; they will appear separately after import.':'',
      revenue:price,
      expenses:fee==null?null:fee+(postage??0)};
  }
  const api={forItem,allocate,usd};root.OGLiveReportFinances=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
