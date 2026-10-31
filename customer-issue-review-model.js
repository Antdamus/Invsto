(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('en-US',{timeZone:/^\d{4}-\d{2}-\d{2}$/.test(v)?'UTC':'America/New_York',weekday:'long',year:'numeric',month:'short',day:'numeric',...(/^\d{4}-\d{2}-\d{2}$/.test(v)?{}:{hour:'numeric',minute:'2-digit',timeZoneName:'short'})}).format(new Date(v)):'Time not recorded';
 function purchaseMoment(order){
  const raw=order.raw_payload||{},imported=raw.first_row?.['Sale Date'],precision=raw.date_precision?.sale_date;
  const dayOnly=precision==='day'||/^\d{4}-\d{2}-\d{2}$/.test(order.sale_date)||(imported&&precision!=='timestamp');
  if(dayOnly){
   // Imported dates have no purchase time. Do not shift their calendar day to Eastern.
   const value=String(imported||order.sale_date||'').trim(),iso=value.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/),csv=value.match(/^([A-Za-z]{3})-(\d{1,2})-(\d{2}|\d{4})$/);
   const month=csv?['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(csv[1].toLowerCase())+1:0;
   const day=iso?.[1]||(month?`${csv[3].length===2?'20':''}${csv[3]}-${String(month).padStart(2,'0')}-${csv[2].padStart(2,'0')}`:'');
   if(!day||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)return null;
   return {at:day,value:date(day),source:'Original purchase · time not recorded'};
  }
  return order.sale_date&&Number.isFinite(Date.parse(order.sale_date))?{at:order.sale_date,value:date(order.sale_date),source:'Original purchase · saved order'}:null;
 }
 const safe=v=>{try{const u=new URL(v);return /^https?:$/.test(u.protocol)?u.href:'';}catch{return '';}};
 const nice=v=>String(v||'Not recorded').replace(/_/g,' ').toLowerCase().replace(/^./,s=>s.toUpperCase());
 const unique=(rows,key=r=>r.id)=>{const seen=new Set();return rows.filter(r=>{const k=key(r);if(!k||seen.has(k))return false;seen.add(k);return true;});};
 function caseUrl(c){const id=encodeURIComponent(c.ebay_return_id||'');if(!id)return '';if(c.source_lane==='payment_dispute')return `https://pmtdispute.ebay.com/dispute/${id}`;if(c.source_lane==='return')return `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${id}`;if(c.source_lane==='inquiry')return `https://www.ebay.com/res/ItemNotReceived/ViewRequest?id=${id}`;if(c.raw_payload?.ebayDetail?.caseId===c.ebay_return_id&&c.raw_payload?.ebayDetail?.caseType==='RETURN')return `https://www.ebay.com/ReturnCase/${id}`;for(const value of [c.raw_payload?.detailsUrl,c.raw_payload?.apiExtractedDetails?.detailsUrl]){const u=safe(value);if(u&&/(^|\.)ebay\.com$/.test(new URL(u).hostname)&&!/(ViewItem|\/itm\/)/i.test(u))return u;}return c.order_number?`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(c.order_number)}`:'';}
 const outcomes={against_us:'Decided against us',final:'Finalized on eBay',open:'Open on eBay',escalated:'Escalated to a case',unfinished:'Follow-up / refund / appeal unfinished',unknown:'Outcome needs verification'};
 function providerHistory(c){const d=c.raw_payload?.ebayDetail||{};if(c.source_lane==='inquiry'&&String(d.inquiryId)===String(c.ebay_return_id))return d.inquiryHistoryDetails?.history||[];if(c.source_lane==='case'&&String(d.caseId)===String(c.ebay_return_id))return d.caseHistoryDetails?.history||[];return null;}
 function amount(v){if(v?.value==null||!Number.isFinite(Number(v.value)))return '';try{return new Intl.NumberFormat('en-US',{style:'currency',currency:v.currency||'USD'}).format(Number(v.value));}catch{return '';}}
 function orderDestination(order={}){
  const raw=order.raw_payload||{},row=raw.first_row||{},text=v=>typeof v==='string'?v.trim():'';
  const imported={fullName:row['Ship To Name'],contactAddress:{addressLine1:row['Ship To Address 1'],addressLine2:row['Ship To Address 2'],city:row['Ship To City'],stateOrProvince:row['Ship To State'],postalCode:row['Ship To Zip'],countryCode:row['Ship To Country']}};
  const candidates=[
   {ship:raw.order?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo,source:'Saved eBay order'},
   {ship:raw.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo,source:'Saved eBay order'},
   {ship:imported,source:'Imported order shipping address'}
  ];
  // Use a single order destination snapshot. A buyer profile or billing address
  // is not evidence of where this purchase was supposed to be shipped.
  const fields=['addressLine1','addressLine2','city','stateOrProvince','postalCode','countryCode'];
  const chosen=candidates.find(c=>fields.some(k=>text(c.ship?.contactAddress?.[k]))),a=chosen?.ship.contactAddress||{};
  const locality=[text(a.city),[text(a.stateOrProvince),text(a.postalCode)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {orderId:order.id,orderNumber:order.order_number||'Not linked',recipient:text(chosen?.ship.fullName),addressLines:[text(a.addressLine1),text(a.addressLine2),locality,text(a.countryCode)].filter(Boolean),source:chosen?.source||''};
 }
 function shipmentPhotoOrders(members){
  const result=new Map(),key=p=>`${p.bucket||p.storage_bucket}/${p.path||p.storage_path}`;
  for(const m of members){
   const orders=m.orders||[],lines=m.lines||[];
   const add=(photos,scope={})=>{
    const ids=scope.order_line_ids?.length?lines.filter(l=>scope.order_line_ids.includes(l.id)).map(l=>l.order_id):scope.order_ids;
    const linked=orders.filter(o=>!Array.isArray(ids)||ids.includes(o.id)).map(orderDestination);
    for(const p of photos||[])result.set(key(p),unique([...(result.get(key(p))||[]),...linked],o=>o.orderId||o.orderNumber));
   };
   for(const e of m.completion_events||[])add(e.photo_attachments,e);
   // Packaging evidence is already scoped to this member's exact order by the RPC.
   add(m.packaging_photos);
  }
  return result;
 }
 function currentCaseStages(members){
  const cases=members.filter(m=>m.case.source_lane==='case');
  const successor=m=>cases.find(next=>m.case.ebay_return_id&&(
   (m.case.source_lane==='inquiry'&&String(next.case.ebay_return_id)===String(m.case.ebay_return_id))||
   (m.case.source_lane==='return'&&String(next.case.raw_payload?.ebayDetail?.returnId||'')===String(m.case.ebay_return_id))));
  return members.filter(m=>!successor(m)).map(m=>({member:m,previous:members.filter(prior=>successor(prior)===m)}));
 }
 const excerpt=(value,max=360)=>{const s=String(value||'').trim();return s.length>max?s.slice(0,max).trimEnd()+'…':s;};
 const dated=rows=>rows.filter(r=>r.at&&Number.isFinite(Date.parse(r.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 function decisionDate(member){
  const c=member.case,d=c.raw_payload?.ebayDetail||{};
  if(!['against_us','final'].includes(member.outcome))return null;
  const id={case:d.caseId,inquiry:d.inquiryId,return:d.returnId,payment_dispute:d.paymentDisputeId}[c.source_lane];
  if(!id||String(id)!==String(c.ebay_return_id))return null;
  const explicit=dated([d.closeDate,d.closedDate].map(v=>({at:v?.value||v})))[0];
  // Only a provider-authored resolution event can supply a missing close date.
  // Buyer/seller messages, lastModifiedDate, sync and internal archive times cannot.
  const resolved=dated((providerHistory(c)||[]).filter(e=>/^(SYSTEM|CSR|EBAY|CUSTOMER_SUPPORT)$/i.test(e.actor)&&/^(?:the )?(?:case|claim|inquiry|return)(?: was| is)? (?:resolved|closed)(?:[.;:]|$)/i.test(String(e.action||'').replace(/_/g,' '))).map(e=>({at:e.date?.value||e.date}))).at(-1);
  const chosen=explicit||resolved;
  return chosen?{at:chosen.at,value:date(chosen.at),source:`eBay ${explicit?'close date':'resolution event'} · ${nice(c.source_lane)} ${c.ebay_return_id}`} : null;
 }
 function keyDates(i){
  const outbound=i.tracking.filter(t=>t.direction==='outbound'),scans=outbound.map(t=>root.OGIssueReviewTracking.milestones(t));
  const summarize=(label,rows,total,missing,source)=>{
   const known=rows.filter(Boolean);
   return {label,value:total>1?`${known.length} of ${total} dates recorded`:known[0]?.value||missing,source:total>1?'Multiple shipments · see shipment records and timeline.':known[0]?.source||source};
  };
  const shipped=scans.map(s=>s.shipped);
  if(outbound.length===1&&!shipped[0]&&i.shipmentDates.length===1)shipped[0]=i.shipmentDates[0];
  const purchases=dated((i.purchaseDates||[]).filter(Boolean)),firstPurchase=purchases[0],multiple=(i.purchaseDates||[]).length>1;
  const result=[
   {label:multiple?'First purchase':'Purchased',value:firstPurchase?.value||'Date not recorded',source:multiple?`Earliest recorded purchase across ${i.purchaseDates.length} linked orders. Each order date appears below.`:firstPurchase?.source||'Original order purchase date not saved.'},
   summarize('Shipped',outbound.length?shipped:i.shipmentDates,outbound.length||i.shipmentDates.length,'Date not recorded','No carrier acceptance or saved shipment date.'),
   summarize('Delivered',scans.map(s=>s.delivered),outbound.length,'Date not recorded',outbound.some(t=>/^delivered$/i.test(t.status))?'Marked delivered by eBay; delivery scan date not saved.':'No outbound delivery scan date saved.'),
   {label:'Issue opened',value:i.openedDate?.value||'Date not recorded',source:'Earliest linked eBay request / case'},
   {label:i.against?'Closed against us':'Closed on eBay',value:i.decisions.length>1?`${i.decisions.filter(Boolean).length} of ${i.decisions.length} decision dates recorded`:i.decisions[0]?.value||(i.statuses.some(s=>['against_us','final'].includes(s.outcome))?'Decision date not recorded':'Not finalized'),source:i.decisions.length>1?'Multiple cases · review the full case timeline.':i.decisions[0]?.source||'No dated eBay closure event saved.',tone:i.against?'against':''}
  ];
  return result;
 }
 function overview(i){
  const outbound=i.tracking.filter(t=>t.direction==='outbound'),delivered=outbound.filter(t=>/^delivered$/i.test(t.status)).length;
  const claims=i.statuses.filter(s=>s.claim),refunds=[...new Set(i.statuses.map(s=>s.refund))];
  const facts=[
   {label:'eBay outcome',value:[...new Set(i.statuses.map(s=>s.label))].join(' / ')||'Not recorded',note:i.statuses.map(s=>`${s.lane} ${s.number}`).join(' · '),tone:i.against?'against':''},
   {label:'Claim amount',value:claims.length===1?claims[0].claim:claims.length?`${claims.length} case amounts`:'Not recorded',note:claims.length>1?claims.map(s=>`${s.number}: ${s.claim}`).join(' · '):'Amount claimed in the case; item price appears below.'},
   {label:'Refund status',value:refunds.join(' / ')||'Not recorded',note:'Saved refund state; a case decision alone does not confirm a refund.'},
   {label:'Outbound tracking',value:outbound.length===1?outbound[0].status:outbound.length?`${delivered} of ${outbound.length} marked delivered`:'Not recorded',note:outbound.length===1?`${outbound[0].statusSource||'Saved tracking'} · tracking ending ${outbound[0].code.slice(-6)}`:outbound.length?'Review each shipment and its item coverage.':'No outbound tracking linked.',tone:delivered&&delivered===outbound.length?'delivered':''}
  ];
  const needs=[];const add=(label,section)=>needs.push({label,section});
  if(!i.review.position?.trim())add('Write our position','position');
  if(!i.review.requested_resolution?.trim())add('Specify the requested resolution','position');
  if(!claims.length)add('Verify the claim amount','decision');
  if(refunds.some(s=>s==='Not recorded'||s==='Unknown')||!refunds.length)add('Verify the refund status','decision');
  if(!outbound.length)add('Find the outbound tracking','purchase');
  else if(outbound.some(t=>!t.history))add('Save the complete carrier history','purchase');
  if(!i.files.some(f=>['completion','packaging'].includes(f.group)&&f.image))add('Review the missing shipment photo preview','photos');
  if(!i.items.length||i.items.some(item=>!item.destination?.addressLines.length))add('Verify the order ship-to address','purchase');
  return {facts,needs,photos:i.files.filter(f=>f.image).length,files:i.files.length,outbound:outbound.length};
 }
 function makeIssue(packet,entry,baseUrl){
  const buyer=root.OGBuyerReport,evidence=root.OGIssueEvidence,members=packet.members||[],records=members.map(m=>m.case),orders=unique(members.flatMap(m=>m.orders||[])),lines=unique(members.flatMap(m=>m.lines||[]));
  const primary=records.find(c=>c.source_lane==='case')||records.find(c=>c.id===entry.case_id)||records[0]||{},orderMap=new Map(orders.map(o=>[o.id,o]));
  const historyUrl=new URL(`ebay-returns.html?caseId=${encodeURIComponent(entry.case_id)}`,baseUrl).href;
  const events=members.flatMap(m=>m.reference_events||[]),items=lines.map(l=>{const o=orderMap.get(l.order_id)||{},photos=buyer.photosForLine(l,events),purchase=purchaseMoment(o);return {id:l.id,title:l.item_title||primary.item_title||'Item title not recorded',item:l.item_number,orderId:o.id,orderNumber:o.order_number||primary.order_number,destination:orderDestination({...o,order_number:o.order_number||primary.order_number}),quantity:l.quantity,price:buyer.itemPrice(l),purchased:purchase?purchase.value+(purchase.source.includes('time not recorded')?' · Time not recorded':''):buyer.purchaseDate(o),state:nice(l.line_status||o.status),photos,videoUrl:buyer.savedReceiptUrl(l,o,photos,events),orderUrl:o.order_number?`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(o.order_number)}`:'',historyUrl};});
  const files=unique(members.flatMap(m=>evidence.collect({...m,completion_events:(m.completion_events||[]).map(e=>({...e,photo_attachments:(e.photo_attachments||[]).map(p=>({...p,created_at:p.created_at||e.created_at}))}))},items.flatMap(i=>i.photos),[])),f=>`${f.bucket}/${f.path}`);
  // Preserve crop metadata for item screenshots while retaining the original
  // evidence in Invsto. Shipment photos are always shown uncropped.
  const photoMap=new Map(items.flatMap(i=>i.photos).map(p=>[`${p.bucket}/${p.path}`,p]));
  for(const f of files)if(f.group==='item')Object.assign(f,{metadata:photoMap.get(`${f.bucket}/${f.path}`)?.metadata});
  const destinations=shipmentPhotoOrders(members);
  for(const f of files)if(['completion','packaging'].includes(f.group))f.shippingOrders=destinations.get(`${f.bucket}/${f.path}`)||[];
  const messages=unique(members.flatMap(m=>evidence.conversation({...m,case_history:providerHistory(m.case)||m.case_history||[]}).map(e=>({...e,caseNumber:m.case.ebay_return_id}))),e=>JSON.stringify([e.direction,e.message_body,e.sent_at,e.channel==='Buyer chat'?'buyer':e.caseNumber]));
  const timeline=[];const add=(at,title,body,source,actor='',internal=false,displayDate='')=>timeline.push({at,title,body:String(body||''),source,actor,internal,date:displayDate||date(at)});
  for(const o of orders){const purchase=purchaseMoment(o);add(purchase?.at||o.sale_date,'Order purchased',`Order ${o.order_number} · ${purchase?.source||buyer.purchaseDate(o)}`,'Saved order','',false,purchase?.value);if(o.shipped_on_date)add(o.shipped_on_date,'Shipment date recorded',`Order ${o.order_number}. This is the saved shipment date.`,'Saved order');}
  for(const l of lines)if(l.fulfilled_at)add(l.fulfilled_at,'Item completed in Invsto',l.item_title,'System completion');
  for(const f of files)if(f.created_at)add(f.created_at,'Evidence saved',f.label,`Saved ${f.group} evidence`);
  for(const m of members){const c=m.case;add(c.opened_at,`${nice(c.source_lane)} opened`,`Case ${c.ebay_return_id} · ${c.return_reason||'Reason not recorded'}`,'eBay / saved case');
   if(c.received_at)add(c.received_at,'Return received in Invsto',`Case ${c.ebay_return_id}`,'Internal receiving');
   if(c.closed_at)add(c.closed_at,'Case archived in Invsto',`Case ${c.ebay_return_id}. This is the internal closing date, not necessarily the eBay decision time.`,'Invsto');
   for(const e of [...(m.internal_events||[]),...(m.task_events||[])])if(e.notes)add(e.created_at,`Internal ${nice(e.action)}`,e.notes,`Invsto · case ${c.ebay_return_id}`,e.author_name||e.signed_by_email||'System',true);
  }
  for(const m of messages)add(m.sent_at,m.entry_type==='event'?'Case activity':m.direction==='outbound'?'Our response':m.direction==='inbound'?'Buyer message':'eBay response / activity',m.message_body,`${m.channel} · case ${m.caseNumber}`,m.sender_username);
  const chronological=timeline.sort((a,b)=>(Date.parse(a.at)||Infinity)-(Date.parse(b.at)||Infinity));
  const statusFor=m=>{const c=m.case,d=c.raw_payload?.ebayDetail||{},reason=d.resolution?.reasonForClosure||d.closeInfo?.returnCloseReason||d.sellerOutcome;return {id:c.id,number:c.ebay_return_id,lane:nice(c.source_lane),status:nice(c.ebay_status),outcome:m.outcome,label:outcomes[m.outcome]||'Outcome not recorded',reason:nice(reason),claim:amount(d.claimAmount),refund:nice(m.refund_status),decision:decisionDate(m),opened:date(c.opened_at),deadline:c.ebay_due_at?date(c.ebay_due_at):'No current deadline recorded',synced:date(c.synced_at),url:caseUrl(c)};};
  const statuses=currentCaseStages(members).map(({member,previous})=>({...statusFor(member),previous:previous.map(statusFor)}));
  const tracking=root.OGIssueReviewTracking.build(members,items,baseUrl,packet.tracking_history||[]);
  const warnings=[];if(members.some(m=>m.case.sync_error||!m.case.synced_at||Date.now()-Date.parse(m.case.synced_at)>86400000))warnings.push('Some eBay information needs refreshing. Last successful sync is shown for each record.');
  if(!items.length)warnings.push('No exact order lines are linked. Review the original order before submitting this issue.');
  if(!messages.length)warnings.push('No written exchanges are saved for these case / order references.');
  const purchaseDates=orders.map(purchaseMoment);
  const shipmentDates=orders.map(o=>o.shipped_on_date&&Number.isFinite(Date.parse(o.shipped_on_date))?{value:date(o.shipped_on_date),source:`Order ${o.order_number} shipment date; carrier acceptance scan not saved`}:null);
  const openedDate=dated(records.map(c=>({at:c.opened_at,value:date(c.opened_at)})))[0]||null;
  const current=currentCaseStages(members),against=current.some(s=>s.member.outcome==='against_us');
  const decisions=current.filter(s=>!against||s.member.outcome==='against_us').map(s=>decisionDate(s.member));
  const latestBuyer=messages.filter(m=>m.direction==='inbound'&&m.entry_type!=='event').sort((a,b)=>(Date.parse(b.sent_at)||0)-(Date.parse(a.sent_at)||0))[0]||null;
  const reason=records.map(c=>c.return_reason).find(r=>r&&!/^(unknown|not recorded)$/i.test(r));
  return {id:entry.case_id,review:{...entry,...packet.review},buyer:primary.buyer_username||'Buyer not recorded',name:orders.map(o=>o.buyer_name).find(Boolean)||'',title:primary.item_title||items[0]?.title||'Item title not recorded',reason:nice(reason),get keyDates(){return keyDates(this);},purchaseDates,shipmentDates,openedDate,decisions,latestBuyer,orderNumbers:[...new Set([...orders.map(o=>o.order_number),...records.map(c=>c.order_number)].filter(Boolean))],historyUrl,items,files,timeline:chronological,statuses,tracking,warnings,messages:messages.length,against,members:records.length};
 }
 const api={esc,date,safe,nice,unique,caseUrl,outcomes,currentCaseStages,orderDestination,shipmentPhotoOrders,excerpt,overview,decisionDate,keyDates,purchaseMoment,makeIssue};root.OGIssueReviewModel=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
