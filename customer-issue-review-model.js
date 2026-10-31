(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(v)):'Time not recorded';
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
 function makeIssue(packet,entry,baseUrl){
  const buyer=root.OGBuyerReport,evidence=root.OGIssueEvidence,members=packet.members||[],records=members.map(m=>m.case),orders=unique(members.flatMap(m=>m.orders||[])),lines=unique(members.flatMap(m=>m.lines||[]));
  const primary=records.find(c=>c.source_lane==='case')||records.find(c=>c.id===entry.case_id)||records[0]||{},orderMap=new Map(orders.map(o=>[o.id,o]));
  const historyUrl=new URL(`ebay-returns.html?caseId=${encodeURIComponent(entry.case_id)}`,baseUrl).href;
  const events=members.flatMap(m=>m.reference_events||[]),items=lines.map(l=>{const o=orderMap.get(l.order_id)||{},photos=buyer.photosForLine(l,events);return {id:l.id,title:l.item_title||primary.item_title||'Item title not recorded',item:l.item_number,orderId:o.id,orderNumber:o.order_number||primary.order_number,destination:orderDestination({...o,order_number:o.order_number||primary.order_number}),quantity:l.quantity,price:buyer.itemPrice(l),purchased:buyer.purchaseDate(o),state:nice(l.line_status||o.status),photos,videoUrl:buyer.savedReceiptUrl(l,o,photos,events),orderUrl:o.order_number?`https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(o.order_number)}`:'',historyUrl};});
  const files=unique(members.flatMap(m=>evidence.collect({...m,completion_events:(m.completion_events||[]).map(e=>({...e,photo_attachments:(e.photo_attachments||[]).map(p=>({...p,created_at:p.created_at||e.created_at}))}))},items.flatMap(i=>i.photos),[])),f=>`${f.bucket}/${f.path}`);
  // Preserve crop metadata for item screenshots while retaining the original
  // evidence in Invsto. Shipment photos are always shown uncropped.
  const photoMap=new Map(items.flatMap(i=>i.photos).map(p=>[`${p.bucket}/${p.path}`,p]));
  for(const f of files)if(f.group==='item')Object.assign(f,{metadata:photoMap.get(`${f.bucket}/${f.path}`)?.metadata});
  const destinations=shipmentPhotoOrders(members);
  for(const f of files)if(['completion','packaging'].includes(f.group))f.shippingOrders=destinations.get(`${f.bucket}/${f.path}`)||[];
  const messages=unique(members.flatMap(m=>evidence.conversation({...m,case_history:providerHistory(m.case)||m.case_history||[]}).map(e=>({...e,caseNumber:m.case.ebay_return_id}))),e=>JSON.stringify([e.direction,e.message_body,e.sent_at,e.channel==='Buyer chat'?'buyer':e.caseNumber]));
  const timeline=[];const add=(at,title,body,source,actor='',internal=false)=>timeline.push({at,title,body:String(body||''),source,actor,internal,date:date(at)});
  for(const o of orders){add(o.sale_date,'Order purchased',`Order ${o.order_number} · ${buyer.purchaseDate(o)}`,'Saved order');if(o.shipped_on_date)add(o.shipped_on_date,'Shipment date recorded',`Order ${o.order_number}. This is the saved shipment date.`,'Saved order');}
  for(const l of lines)if(l.fulfilled_at)add(l.fulfilled_at,'Item completed in Invsto',l.item_title,'System completion');
  for(const f of files)if(f.created_at)add(f.created_at,'Evidence saved',f.label,`Saved ${f.group} evidence`);
  for(const m of members){const c=m.case;add(c.opened_at,`${nice(c.source_lane)} opened`,`Case ${c.ebay_return_id} · ${c.return_reason||'Reason not recorded'}`,'eBay / saved case');
   if(c.received_at)add(c.received_at,'Return received in Invsto',`Case ${c.ebay_return_id}`,'Internal receiving');
   if(c.closed_at)add(c.closed_at,'Case archived in Invsto',`Case ${c.ebay_return_id}. This is the internal closing date, not necessarily the eBay decision time.`,'Invsto');
   for(const e of [...(m.internal_events||[]),...(m.task_events||[])])if(e.notes)add(e.created_at,`Internal ${nice(e.action)}`,e.notes,`Invsto · case ${c.ebay_return_id}`,e.author_name||e.signed_by_email||'System',true);
  }
  for(const m of messages)add(m.sent_at,m.entry_type==='event'?'Case activity':m.direction==='outbound'?'Our response':m.direction==='inbound'?'Buyer message':'eBay response / activity',m.message_body,`${m.channel} · case ${m.caseNumber}`,m.sender_username);
  const chronological=timeline.sort((a,b)=>(Date.parse(a.at)||Infinity)-(Date.parse(b.at)||Infinity));
  const statusFor=m=>{const c=m.case,d=c.raw_payload?.ebayDetail||{},reason=d.resolution?.reasonForClosure||d.closeInfo?.returnCloseReason||d.sellerOutcome;return {id:c.id,number:c.ebay_return_id,lane:nice(c.source_lane),status:nice(c.ebay_status),outcome:m.outcome,label:outcomes[m.outcome]||'Outcome not recorded',reason:nice(reason),claim:amount(d.claimAmount),refund:nice(m.refund_status),opened:date(c.opened_at),deadline:c.ebay_due_at?date(c.ebay_due_at):'No current deadline recorded',synced:date(c.synced_at),url:caseUrl(c)};};
  const statuses=currentCaseStages(members).map(({member,previous})=>({...statusFor(member),previous:previous.map(statusFor)}));
  const tracking=root.OGIssueReviewTracking.build(members,items,baseUrl,packet.tracking_history||[]);
  const warnings=[];if(members.some(m=>m.case.sync_error||!m.case.synced_at||Date.now()-Date.parse(m.case.synced_at)>86400000))warnings.push('Some eBay information needs refreshing. Last successful sync is shown for each record.');
  if(!items.length)warnings.push('No exact order lines are linked. Review the original order before submitting this issue.');
  if(!messages.length)warnings.push('No written exchanges are saved for these case / order references.');
  return {id:entry.case_id,review:{...entry,...packet.review},buyer:primary.buyer_username||'Buyer not recorded',name:orders.map(o=>o.buyer_name).find(Boolean)||'',title:primary.item_title||items[0]?.title||'Item title not recorded',orderNumbers:[...new Set([...orders.map(o=>o.order_number),...records.map(c=>c.order_number)].filter(Boolean))],historyUrl,items,files,timeline:chronological,statuses,tracking,warnings,messages:messages.length,against:statuses.some(s=>s.outcome==='against_us'),members:records.length};
 }
 const api={esc,date,safe,nice,unique,caseUrl,outcomes,currentCaseStages,orderDestination,shipmentPhotoOrders,makeIssue};root.OGIssueReviewModel=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
