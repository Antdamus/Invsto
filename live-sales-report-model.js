(function(root){
  'use strict';
  const RATE_KEYS=['silver','gold_8','gold_9','gold_10','gold_14','gold_18','gold_21','gold_22','gold_24'];
  const labels={paid:'Confirmed paid',waiting:'Pending payment',failed:'Payment failed',cancelled:'Canceled',review:'Needs review',resolved:'Resolved / excluded'};
  const number=value=>value==null||value===''?null:Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
  const cents=value=>number(value)==null?null:Math.round(Number(value)*100);
  const money=value=>value==null?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);
  const rateMoney=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(value);
  const date=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)):null;
  function buyerProfit(stats,expensesKnown){
    const covered=stats.pricedPaid,total=stats.paid.count,partial=covered>0&&covered<total;
    const missing=[];
    if(stats.missingCosts)missing.push(`${stats.missingCosts} missing base ${stats.missingCosts===1?'cost':'costs'}`);
    if(stats.missingPaidAmounts)missing.push(`${stats.missingPaidAmounts} missing sale ${stats.missingPaidAmounts===1?'amount':'amounts'}`);
    return {amount:covered?(expensesKnown?stats.profit:stats.margin):null,
      label:expensesKnown?'Estimated profit':'Profit before expenses',
      basis:expensesKnown?'After estimated fees and shipping':'Before fees and shipping',
      status:!total?'No paid purchases':!covered?'Unavailable':partial?'Partial':'Complete',
      partial,coverage:`${covered} of ${total} paid purchases included`,missing:missing.join(' · ')};
  }
  function parseTitle(title){
    const text=String(title||'');
    const weights=[...text.matchAll(/(?<![\d.,-])(\d+(?:\.\d+)?)\s*(?:grams?|grs?|g)\b/gi)].map(m=>Number(m[1]));
    const purities=[...text.matchAll(/\b(\d{1,2}(?:\.\d+)?)\s*(?:karats?|carats?|kt|k)\b/gi)].map(m=>Number(m[1]));
    const gold=/\bgold\b/i.test(text)||purities.length>0,silver=/\b(?:silver|sterling)\b/i.test(text);
    const plated=/\b(?:plated|filled|vermeil|tone|colou?r(?:ed)?|gp|gf|hge|overlay)\b/i.test(text);
    const ambiguous=plated||(gold&&silver)||weights.length>1||new Set(purities).size>1||/\d\s*(?:[-–/]|to)\s*\d+(?:\.\d+)?\s*(?:g|grams?)\b/i.test(text)||/\d,\d+\s*(?:g|grams?)\b/i.test(text);
    const material=gold&&!silver?'gold':silver&&!gold?'silver':null;
    const silverPurities=[...text.matchAll(/\b(800|835|850|900|925|950|958|999)(?:\.9)?\b/g)].map(m=>Number(m[1]));
    const unsupportedSilver=material==='silver'&&(silverPurities.some(p=>p!==925)||/\b(?:fine|pure)\s+silver\b/i.test(text));
    const grams=weights.length===1||new Set(weights).size===1?weights[0]:null;
    const purity=material==='gold'?(purities[0]??10):material==='silver'?(silverPurities[0]??925):null;
    const assumed=material==='gold'&&!purities.length||material==='silver'&&!silverPurities.length;
    const assumption=assumed?(material==='gold'?'10K assumed':'925 assumed'):'';
    return {material,grams:grams>0?grams:null,purity:purity>0&&(material==='silver'||purity<=24)?purity:null,assumed,assumption,ambiguous:ambiguous||unsupportedSilver,
      note:unsupportedSilver?'Silver purity is not 925: enter a manual base cost.':ambiguous?'Mixed, plated or ambiguous title: enter a manual base cost.':!material?'Material not specified.':!grams?'Gram weight not specified.':assumed?(material==='gold'?'10K gold assumed because purity is not specified.':'Sterling silver 925 assumed because purity is not specified.'):'Read from item title.'};
  }
  function costFor(a,override={},settings={}){
    const parsed=parseTitle(a.listing_title),mode=override.mode||'auto';
    if(mode==='manual')return {mode,base:cents(override.base_cost),source:'Manual base cost',parsed,note:override.note||''};
    const metal=mode==='metal'?{material:override.material,grams:number(override.grams),purity:override.material==='silver'?925:number(override.purity),assumed:false,ambiguous:false}:parsed;
    const key=metal.material==='gold'?'gold_'+metal.purity:metal.material==='silver'?'silver':null;
    const rate=number(settings.rates?.[key]);
    const ready=!metal.ambiguous&&!!metal.material&&metal.grams>0&&rate!=null&&(metal.material!=='gold'||metal.purity>0);
    const source=ready?`${metal.grams} g × ${rateMoney(rate)}/g · ${metal.material==='gold'?metal.purity+'K gold':'sterling silver 925'}${metal.assumption?' ('+metal.assumption+')':''}${settings.globalRates?.[key]!=null&&!Object.hasOwn(settings.showRates||{},key)?' · Global rate':settings.showRates&&Object.hasOwn(settings.showRates,key)?' · Show override':''}`:mode==='auto'?parsed.note:'Enter a matching metal rate or manual base cost.';
    return {mode,base:ready?Math.round(metal.grams*rate*100):null,source:ready?source:source+(metal.material&&metal.grams>0&&!metal.ambiguous&&rate==null?' Set the matching cost per gram.':''),parsed:metal,note:override.note||''};
  }
  function makeModel(payload,origin='https://antdamus.github.io/Invsto/',now=new Date()){
    const c=payload.connection||{},saved=payload.settings||{rates:{},fee_percent:c.fee_percent,fee_fixed:c.fee_fixed,shipping_per_sale:c.shipping_per_sale};
    const globalRates=payload.global_material_costs?.rates||{};
    const settings={...saved,showRates:saved.rates||{},globalRates,globalUpdatedAt:payload.global_material_costs?.updated_at,rates:{...globalRates,...saved.rates}};
    const feePercent=number(settings.fee_percent),fixed=cents(settings.fee_fixed),shipping=cents(settings.shipping_per_sale);
    const expensesKnown=feePercent!=null&&fixed!=null&&shipping!=null;
    const buyers=new Map();const rows=(payload.attempts||[]).filter(a=>!a.merged_into).map(a=>{
      const evidence=payload.evidence?.[a.id]||{},order=evidence.order||{},line=evidence.line||{};
      const username=String(a.buyer||'').trim()||'Buyer not recorded',key=username.toLowerCase();
      if(!buyers.has(key))buyers.set(key,{key:'buyer-'+Array.from(key,c=>c.codePointAt(0).toString(16)).join('-'),username,name:order.buyer_name||'',rows:[]});
      const customer=buyers.get(key);if(!customer.name&&order.buyer_name)customer.name=order.buyer_name;
      // A hold disqualifies a paid amount; it must not hide an explicit failure or pending payment.
      const state=a.resolved_at?'resolved':a.payment_hold&&a.payment_state==='paid'?'review':Object.hasOwn(labels,a.payment_state)?a.payment_state:'review';
      const price=cents(a.amount),cost=costFor(a,payload.costs?.[a.id],settings),margin=state==='paid'&&price!=null&&cost.base!=null?price-cost.base:null;
      const expenses=price!=null&&expensesKnown?Math.round(price*feePercent/100)+fixed+shipping:null;
      const orderUrl=order.order_number?'https://www.ebay.com/mesh/ord/details?orderid='+encodeURIComponent(order.order_number):'';
      const videoUrl=root.OGBuyerReport?.savedReceiptUrl(line,order,[],[])||'';
      const systemUrl=new URL(['fulfilled','cancelled','canceled','closed'].includes(order.status)?'ebay-order-history.html':'pending-orders.html',origin);
      systemUrl.search=new URLSearchParams({orderId:order.order_number||'',historySearch:order.order_number||'',focusOrder:order.order_number||'',focusLineId:line.id||''}).toString();
      const links=[['eBay listing',a.listing_id?'https://www.ebay.com/itm/'+encodeURIComponent(a.listing_id):''],['eBay order',orderUrl],['Video receipt',videoUrl],['Find receipt in order',!videoUrl?orderUrl:''],['System order',order.order_number?systemUrl.href:''],['Live show',c.event_id?'https://www.ebay.com/ebaylive/events/'+encodeURIComponent(c.event_id):'']].filter(([,url])=>url);
      const row={...a,id:a.id,key:'item-'+a.id,username,customerKey:customer.key,name:order.buyer_name||'',state,stateLabel:labels[state],price,cost,margin,expenses,profit:margin!=null&&expenses!=null?margin-expenses:null,
        quantity:Number.isInteger(Number(line.quantity))&&Number(line.quantity)>0?Number(line.quantity):1,
        time:date(a.sold_at)||(a.win_time_label?`${a.win_time_label} · date unverified`:'Sale time not yet verified'),timeNote:a.sale_time_source==='ebay_activity'?'eBay Activity · minute precision':a.sale_time_source==='ebay_order'?'eBay order timestamp':'',
        orderNumber:order.order_number||'',orderId:order.id||'',photos:evidence.photos||[],links,videoUrl,
        ordinal:a.ordinal||String(a.listing_title||'').match(/^#(\d+)/)?.[1]||'—',title:a.listing_title||'Title not recorded',override:payload.costs?.[a.id]||{}};
      const assessedMargin=row.profit??row.margin;
      row.loss=assessedMargin!=null&&assessedMargin<0?-assessedMargin:0;
      customer.rows.push(row);return row;
    });
    const summarize=list=>{
      const result={items:list.length,expectedItems:0,missingCosts:0,pricedPaid:0,base:0,margin:0,profit:0,missingAmounts:0,missingPaidAmounts:0,lossItems:0,lossAmount:0};
      for(const state of Object.keys(labels))result[state]={count:0,amount:0};
      for(const r of list){result[r.state].count++;if(r.price==null)result.missingAmounts++;else result[r.state].amount+=r.price;
        if(r.loss>0){result.lossItems++;result.lossAmount+=r.loss;}
        if(r.state==='paid'){result.expectedItems+=r.quantity;if(r.price==null)result.missingPaidAmounts++;if(r.cost.base==null)result.missingCosts++;else if(r.price!=null){result.pricedPaid++;result.base+=r.cost.base;result.margin+=r.margin;if(r.profit!=null)result.profit+=r.profit;}}
      }return result;
    };
    const customers=[...buyers.values()].sort((a,b)=>a.username.localeCompare(b.username));
    for(const buyer of customers){buyer.rows.sort((a,b)=>(Date.parse(a.sold_at)||0)-(Date.parse(b.sold_at)||0)||a.title.localeCompare(b.title));buyer.stats=summarize(buyer.rows);}
    // Individual losses stay visible even when other purchases offset them.
    customers.sort((a,b)=>b.stats.lossAmount-a.stats.lossAmount||a.username.localeCompare(b.username));
    return {sessionId:payload.show?.id||c.session_id,show:payload.show||{},title:payload.show?.title||c.stream_metadata?.title||'Live sales report',connection:c,settings,customers,rows,stats:summarize(rows),expensesKnown,lossBasis:expensesKnown?'after estimated fees and shipping':'before fees and shipping',generatedAt:now.toISOString(),updatedAt:payload.server_time||now.toISOString(),date:date(now.toISOString()),unmatched:(payload.unmatched||[]).length,origin};
  }
  const api={RATE_KEYS,labels,number,cents,money,rateMoney,date,parseTitle,costFor,makeModel,buyerProfit};root.OGLiveReportModel=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
