(function(root){
  'use strict';
  const F=root.OGLiveReportFinances||(typeof require==='function'?require('./live-sales-report-finances.js'):null);
  const RATE_KEYS=['silver','gold_8','gold_9','gold_10','gold_14','gold_18','gold_21','gold_22','gold_24'];
  const labels={paid:'Confirmed paid',waiting:'Pending payment',failed:'Payment failed',cancelled:'Canceled',review:'Needs review',resolved:'Resolved / excluded'};
  const number=value=>value==null||value===''?null:Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
  const cents=value=>number(value)==null?null:Math.round(Number(value)*100);
  const money=value=>value==null?'Not set':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);
  const rateMoney=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(value);
  const date=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)):null;
  function profitFor(row,base=row.cost?.base){
    return row.state==='paid'&&row.price!=null&&base!=null&&row.finance?.expenses!=null
      ?row.price-base-row.finance.expenses:null;
  }
  function feeAmountLabel(row){
    const f=row.finance;
    return f.fee==null?'eBay fees: awaiting details':`eBay fees: ${money(f.fee)} · ${f.source==='actual'?'Actual':'Estimated'}`;
  }
  function feeSummary(stats){
    const count=stats.actualFeeItems+stats.estimatedFeeItems,total=stats.actualFees+stats.estimatedFees;
    return {total,value:!count&&stats.missingFees?'Awaiting details':money(total),
      basis:stats.estimatedFeeItems?'Actual + estimated fees':'Actual fees only',
      coverage:`All ${stats.paid.count} paid purchases, including those awaiting base costs${stats.missingFees?' · '+stats.missingFees+' fees awaiting details':''}`};
  }
  function shippingFunds(stats){
    return !stats.shippingKnownItems&&stats.shippingUnknownItems?'Awaiting details':money(stats.shippingCollected)+(stats.shippingUnknownItems?' · partial':'');
  }
  function profitEquation(row,base=row.cost?.base){
    const profit=profitFor(row,base);
    if(profit==null)return '';
    return `${money(row.price)} item sale - ${money(base)} base cost - ${money(row.finance.fee)} eBay fees${row.finance.postage!=null?' - '+money(row.finance.postage)+' postage estimate':''} = ${money(profit)}${row.finance.beforePostage?' before postage':''}. Shipping funds are separate.`;
  }
  function buyerProfit(stats){
    const covered=stats.profitCovered,total=stats.paid.count,partial=covered>0&&covered<total;
    const missing=[];
    if(stats.missingCosts)missing.push(`${stats.missingCosts} missing base ${stats.missingCosts===1?'cost':'costs'}`);
    if(stats.missingPaidAmounts)missing.push(`${stats.missingPaidAmounts} missing sale ${stats.missingPaidAmounts===1?'amount':'amounts'}`);
    if(stats.missingFees)missing.push(`${stats.missingFees} fees need review`);
    return {amount:covered?stats.profit:null,label:stats.estimatedProfit?'Estimated profit after fees':'Profit after fees',
      basis:covered?`${stats.actualProfitFees} actual / ${stats.estimatedProfitFees} estimated fees · ${stats.postagePending?'before postage':'after estimated postage'}`:'No profit calculated yet · shipping funds excluded',
      status:!total?'No paid purchases':!covered?'Unavailable':partial?'Partial':'Complete',
      partial,fees:covered?`eBay fees deducted: ${money(stats.profitFees)}`:'',coverage:`${covered} of ${total} paid purchases included`,missing:missing.join(' · ')};
  }
  function itemProfit(row){
    const f=row.finance,label=f.source!=='actual'||f.postage!=null?'Estimated profit after fees':'Profit after fees';
    const basis=`${f.source==='actual'?'Actual eBay fee':f.source==='estimated'?'Estimated eBay fee':'Fee unavailable'} · ${f.beforePostage?'before postage':'after estimated postage'} · shipping funds excluded`;
    if(row.state!=='paid')return {amount:null,label,basis:'Only confirmed paid purchases count',status:'Excluded'};
    if(row.price==null)return {amount:null,label,basis:'Sale amount is not available',status:'Missing sale amount'};
    if(row.cost.base==null)return {amount:null,label,basis:'Add a cost to calculate profit',status:'Needs base price'};
    return {amount:row.profit,label,basis,status:row.profit==null?'Fee needs review':row.profit<0?'Loss':row.profit>0?'Profit':'Break-even'};
  }
  function parseTitle(title){
    const text=String(title||'');
    const weights=[...text.matchAll(/(?<![\d.,-])(\d+(?:\.\d+)?)\s*(?:grams?|grs?|g)\b/gi)].map(m=>Number(m[1]));
    const purities=[...text.matchAll(/\b(\d{1,2}(?:\.\d+)?)\s*(?:karats?|carats?|kt|k)\b/gi)].map(m=>Number(m[1]));
    const gold=/\bgold\b/i.test(text)||purities.length>0,silver=/\b(?:silver|sterling)\b/i.test(text);
    const otherMaterial=/\b(?:platinum|palladium|copper|brass|bronze|steel|titanium|tungsten|alumin(?:um|ium)|nickel|pewter|rhodium|cobalt|zinc|wood|resin|acrylic|plastic|ceramic|leather|silicone)\b/i.test(text);
    const plated=/\b(?:plated|filled|vermeil|tone|colou?r(?:ed)?|gp|gf|hge|overlay)\b/i.test(text);
    const ambiguous=plated||(gold&&silver)||(otherMaterial&&(gold||silver))||weights.length>1||new Set(purities).size>1||/\d\s*(?:[-–/]|to)\s*\d+(?:\.\d+)?\s*(?:g|grams?)\b/i.test(text)||/\d,\d+\s*(?:g|grams?)\b/i.test(text);
    const grams=weights.length===1||new Set(weights).size===1?weights[0]:null;
    const silverDefault=!gold&&!silver&&!otherMaterial&&!ambiguous&&grams>0;
    const material=gold&&!silver?'gold':(silver&&!gold||silverDefault)?'silver':null;
    const silverPurities=[...text.matchAll(/\b(800|835|850|900|925|950|958|999)(?:\.9)?\b/g)].map(m=>Number(m[1]));
    const unsupportedSilver=material==='silver'&&(silverPurities.some(p=>p!==925)||/\b(?:fine|pure)\s+silver\b/i.test(text));
    const purity=material==='gold'?(purities[0]??10):material==='silver'?(silverPurities[0]??925):null;
    const assumed=silverDefault||material==='gold'&&!purities.length||material==='silver'&&!silverPurities.length;
    const assumption=silverDefault?(purity===925?'Silver 925 assumed':'Silver assumed'):assumed?(material==='gold'?'10K assumed':'925 assumed'):'';
    return {material,grams:grams>0?grams:null,purity:purity>0&&(material==='silver'||purity<=24)?purity:null,assumed,assumption,ambiguous:ambiguous||unsupportedSilver,
      note:unsupportedSilver?'Silver purity is not 925: enter a manual base cost.':ambiguous?'Mixed, plated or ambiguous title: enter a manual base cost.':otherMaterial?'Material is not supported: enter a manual base cost.':silverDefault?'Sterling silver 925 assumed because a gram weight is present but material is not specified.':!material?'Material not specified.':!grams?'Gram weight not specified.':assumed?(material==='gold'?'10K gold assumed because purity is not specified.':'Sterling silver 925 assumed because purity is not specified.'):'Read from item title.'};
  }
  const normalizeTitle=value=>String(value??'').replace(/\s+/g,' ').trim().toLowerCase();
  function titleRuleFor(title,rules=[]){
    const text=normalizeTitle(title);
    const matches=(Array.isArray(rules)?rules:[]).map((r,index)=>({...r,index,normalized:normalizeTitle(r.phrase)}))
      .filter(r=>r.enabled===true&&r.normalized.length>=2&&number(r.base_cost)!=null&&text.includes(r.normalized));
    if(!matches.length)return null;
    const length=Math.max(...matches.map(r=>r.normalized.length)),best=matches.filter(r=>r.normalized.length===length);
    if(new Set(best.map(r=>cents(r.base_cost))).size>1)return {conflict:true,matches:best};
    return {...best[0],matches};
  }
  function costFor(a,override={},settings={}){
    const parsed=parseTitle(a.listing_title),mode=override.mode||'auto';
    if(mode==='manual')return {mode,base:cents(override.base_cost),source:'Manual base cost',parsed,note:override.note||''};
    if(mode==='auto'){
      const rule=titleRuleFor(a.listing_title,settings.titleRules);
      if(rule)return {mode,base:rule.conflict?null:cents(rule.base_cost),rule,
        source:rule.conflict?'Conflicting title rules: '+rule.matches.map(r=>'“'+r.phrase+'”').join(' / ')+'. Set an item cost or revise the rules.':`Title rule: “${rule.phrase}” → ${money(cents(rule.base_cost))} total base cost per auction`,
        parsed:{...parsed,assumed:false,assumption:''},note:override.note||''};
    }
    const metal=mode==='metal'?{material:override.material,grams:number(override.grams),purity:override.material==='silver'?925:number(override.purity),assumed:false,ambiguous:false}:parsed;
    const key=metal.material==='gold'?'gold_'+metal.purity:metal.material==='silver'?'silver':null;
    const rate=number(settings.rates?.[key]);
    const ready=!metal.ambiguous&&!!metal.material&&metal.grams>0&&rate!=null&&(metal.material!=='gold'||metal.purity>0);
    const source=ready?`${metal.grams} g × ${rateMoney(rate)}/g · ${metal.material==='gold'?metal.purity+'K gold':'sterling silver 925'}${metal.assumption?' ('+metal.assumption+')':''}${settings.globalRates?.[key]!=null&&!Object.hasOwn(settings.showRates||{},key)?' · Global rate':settings.showRates&&Object.hasOwn(settings.showRates,key)?' · Show override':''}`:mode==='auto'?parsed.note:'Enter a matching metal rate or manual base cost.';
    return {mode,base:ready?Math.round(metal.grams*rate*100):null,source:ready?source:source+(metal.material&&metal.grams>0&&!metal.ambiguous&&rate==null?' Set the matching cost per gram.':''),parsed:metal,note:override.note||''};
  }
  function categoriesFor(row){
    const parsed=row.cost.mode==='metal'?row.cost.parsed:parseTitle(row.title),title=String(row.title||'');
    const material=!parsed.ambiguous&&['gold','silver'].includes(parsed.material)?parsed.material:'other';
    const earrings=/\b(?:ear[\s-]*rings?|ear{1,4}ings?|er{1,4}ings?|aretes?)\b/i.test(title);
    const watch=/\b(?:watch(?:es)?|wrist[\s-]*watch(?:es)?|time[\s-]*pieces?|chronographs?|reloj(?:es)?|rolex|seiko|citizen|bulova|invicta|tissot|movado|tag\s+heuer)\b/i.test(title);
    const watchAccessory=/\b(?:watch(?:es)?|wristwatch)\s+(?:bands?|straps?|boxes|box|links?|batter(?:y|ies)|tools?)\b/i.test(title)&&!/\b(?:with|includes?)\b/i.test(title);
    return {material,assumedSilver:material==='silver'&&parsed.assumption==='Silver 925 assumed',type:earrings&&!watch?'earrings':watch&&!earrings&&!watchAccessory?'watches':'other'};
  }
  function receiptFor(attempt,connection,evidence={}){
    const line=evidence.line||{},order=evidence.order||{};
    const listing=String(attempt.listing_id||'').trim(),matchedItem=String(line.item_number||'').trim();
    const item=listing||matchedItem;
    // Never attach another order line's saved receipt to this captured auction.
    const saved=(!listing||!matchedItem||listing===matchedItem)
      ?root.OGBuyerReport?.savedReceiptUrl({...line,item_number:item},order,evidence.photos||[],evidence.events||[])||'':'';
    if(saved)return {url:saved,source:'saved'};
    const event=String(attempt.event_id||connection.event_id||'').trim();
    const connectedEvent=String(connection.event_id||'').trim();
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(event)||!/^\d{9,15}$/.test(item)
      ||(connectedEvent&&event!==connectedEvent))return {url:'',source:''};
    // eBay receipts are item-selected show replays, available after the stream ends.
    // Keep this independent of order import, payment state, and whether a screenshot was saved.
    const url=new URL('https://www.ebay.com/ebaylive/events/'+encodeURIComponent(event)+'/stream');
    url.search=new URLSearchParams({playback:'true',selectedItemId:item,itemIds:item}).toString();
    return {url:url.href,source:'live_event'};
  }
  function receiptNote(row){
    return [!row.orderNumber?'Order details are awaiting import / matching.':'',
      row.videoSource==='live_event'?'Opens this item in the show replay. eBay makes video receipts available after the livestream ends.':
      !row.videoUrl?(row.orderNumber?'A direct receipt link is not available yet. Use Find receipt in order to check eBay.':'A direct receipt link will appear when the show and item are identified.'):''].filter(Boolean).join(' ');
  }
  function makeModel(payload,origin='https://antdamus.github.io/Invsto/',now=new Date()){
    const c=payload.connection||{},saved=payload.settings||{rates:{},fee_percent:c.fee_percent,fee_fixed:c.fee_fixed,shipping_per_sale:c.shipping_per_sale};
    const globalRates=payload.global_material_costs?.rates||{};
    const settings={...saved,titleRules:payload.global_material_costs?.title_cost_rules||[],showRates:saved.rates||{},globalRates,globalUpdatedAt:payload.global_material_costs?.updated_at,rates:{...globalRates,...saved.rates}};
    const expensesKnown=true; // Fee defaults are available even while postage is unknown.
    const buyers=new Map();const rows=(payload.attempts||[]).filter(a=>!a.merged_into).map(a=>{
      const evidence=payload.evidence?.[a.id]||{},order=evidence.order||{},line=evidence.line||{};
      const username=String(a.buyer||'').trim()||'Buyer not recorded',key=username.toLowerCase();
      if(!buyers.has(key))buyers.set(key,{key:'buyer-'+Array.from(key,c=>c.codePointAt(0).toString(16)).join('-'),username,name:order.buyer_name||'',rows:[]});
      const customer=buyers.get(key);if(!customer.name&&order.buyer_name)customer.name=order.buyer_name;
      // A hold disqualifies a paid amount; it must not hide an explicit failure or pending payment.
      const state=a.resolved_at?'resolved':a.payment_hold&&a.payment_state==='paid'?'review':Object.hasOwn(labels,a.payment_state)?a.payment_state:'review';
      const price=cents(a.amount),cost=costFor(a,payload.costs?.[a.id],settings),margin=state==='paid'&&price!=null&&cost.base!=null?price-cost.base:null;
      const finance=F.forItem(a,evidence,settings),expenses=finance.expenses;
      const orderUrl=order.order_number?'https://www.ebay.com/mesh/ord/details?orderid='+encodeURIComponent(order.order_number):'';
      const receipt=receiptFor(a,c,evidence),videoUrl=receipt.url;
      const systemUrl=new URL(['fulfilled','cancelled','canceled','closed'].includes(order.status)?'ebay-order-history.html':'pending-orders.html',origin);
      systemUrl.search=new URLSearchParams({orderId:order.order_number||'',historySearch:order.order_number||'',focusOrder:order.order_number||'',focusLineId:line.id||''}).toString();
      const links=[['eBay listing',a.listing_id?'https://www.ebay.com/itm/'+encodeURIComponent(a.listing_id):''],['eBay order',orderUrl],['Video receipt',videoUrl],['Find receipt in order',!videoUrl?orderUrl:''],['System order',order.order_number?systemUrl.href:''],['Live show',c.event_id?'https://www.ebay.com/ebaylive/events/'+encodeURIComponent(c.event_id):'']].filter(([,url])=>url);
      const row={...a,id:a.id,key:'item-'+a.id,username,customerKey:customer.key,name:order.buyer_name||'',state,stateLabel:labels[state],price,cost,margin,finance,expenses,profit:profitFor({state,price,cost,finance}),
        quantity:Number.isInteger(Number(line.quantity))&&Number(line.quantity)>0?Number(line.quantity):1,
        time:date(a.sold_at)||(a.win_time_label?`${a.win_time_label} · date unverified`:'Sale time not yet verified'),timeNote:a.sale_time_source==='ebay_activity'?'eBay Activity · minute precision':a.sale_time_source==='ebay_order'?'eBay order timestamp':'',
        orderNumber:order.order_number||'',orderId:order.id||'',photos:evidence.photos||[],links,videoUrl,videoSource:receipt.source,
        ordinal:a.ordinal||String(a.listing_title||'').match(/^#(\d+)/)?.[1]||'—',title:a.listing_title||'Title not recorded',override:payload.costs?.[a.id]||{}};
      const assessedMargin=row.profit;
      row.loss=assessedMargin!=null&&assessedMargin<0?-assessedMargin:0;
      row.categories=categoriesFor(row);
      customer.rows.push(row);return row;
    });
    const summarize=list=>{
      const result={items:list.length,expectedItems:0,missingCosts:0,pricedPaid:0,base:0,margin:0,profit:0,missingAmounts:0,missingPaidAmounts:0,lossItems:0,lossAmount:0,profitCovered:0,actualFees:0,estimatedFees:0,actualFeeItems:0,estimatedFeeItems:0,actualProfitFees:0,estimatedProfitFees:0,estimatedProfit:0,postagePending:0,missingFees:0,profitItemRevenue:0,profitShipping:0,profitBase:0,profitFees:0,profitPostage:0,profitDeductions:0,shippingCollected:0,shippingKnownItems:0,shippingUnknownItems:0};
      for(const state of Object.keys(labels))result[state]={count:0,amount:0};
      for(const r of list){result[r.state].count++;if(r.price==null)result.missingAmounts++;else result[r.state].amount+=r.price;
        if(r.loss>0){result.lossItems++;result.lossAmount+=r.loss;}
        if(r.state==='paid'){if(r.finance.shippingKnown){result.shippingCollected+=r.finance.shipping;result.shippingKnownItems++;}else result.shippingUnknownItems++;if(r.finance.fee==null){if(r.price!=null)result.missingFees++;}else{const actual=r.finance.source==='actual';result[actual?'actualFees':'estimatedFees']+=r.finance.fee;result[actual?'actualFeeItems':'estimatedFeeItems']++;}result.expectedItems+=r.quantity;if(r.price==null)result.missingPaidAmounts++;if(r.cost.base==null)result.missingCosts++;else if(r.price!=null){result.pricedPaid++;result.base+=r.cost.base;result.margin+=r.margin;if(r.profit!=null){result.profit+=r.profit;result.profitCovered++;result.profitItemRevenue+=r.price;result.profitShipping+=r.finance.shipping??0;result.profitBase+=r.cost.base;result.profitFees+=r.finance.fee;result.profitPostage+=r.finance.postage??0;result.profitDeductions+=r.cost.base+r.finance.expenses;result[r.finance.source==='actual'?'actualProfitFees':'estimatedProfitFees']++;if(r.finance.source!=='actual'||r.finance.postage!=null)result.estimatedProfit++;if(r.finance.beforePostage)result.postagePending++;}}}
      }return result;
    };
    const customers=[...buyers.values()].sort((a,b)=>a.username.localeCompare(b.username));
    for(const buyer of customers){buyer.rows.sort((a,b)=>(Date.parse(a.sold_at)||0)-(Date.parse(b.sold_at)||0)||a.title.localeCompare(b.title));buyer.stats=summarize(buyer.rows);}
    // Individual losses stay visible even when other purchases offset them.
    customers.sort((a,b)=>b.stats.lossAmount-a.stats.lossAmount||a.username.localeCompare(b.username));
    const group=(axis,entries)=>entries.map(([key,label])=>{const items=rows.filter(r=>r.categories[axis]===key);return {key,label,rows:items,stats:summarize(items),assumedSilver:items.filter(r=>r.state==='paid'&&r.categories.assumedSilver).length};});
    const breakdowns={materials:group('material',[['gold','Gold'],['silver','Silver / assumed silver'],['other','Other / unclear material']]),types:group('type',[['earrings','Earrings'],['watches','Watches'],['other','Other / unclear item type']])};
    return {sessionId:payload.show?.id||c.session_id,show:payload.show||{},title:payload.show?.title||c.stream_metadata?.title||'Live sales report',connection:c,settings,customers,rows,breakdowns,stats:summarize(rows),expensesKnown,lossBasis:'after eBay fees; postage excluded unless entered',generatedAt:now.toISOString(),updatedAt:payload.server_time||now.toISOString(),date:date(now.toISOString()),unmatched:(payload.unmatched||[]).length,origin};
  }
  const api={RATE_KEYS,labels,number,cents,money,rateMoney,date,parseTitle,costFor,makeModel,buyerProfit,itemProfit,profitFor,feeAmountLabel,feeSummary,shippingFunds,profitEquation,normalizeTitle,titleRuleFor,receiptFor,receiptNote};root.OGLiveReportModel=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
